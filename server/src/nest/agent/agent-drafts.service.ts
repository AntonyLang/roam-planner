import { Injectable, HttpException, OnModuleInit } from '@nestjs/common';
import { z } from 'zod';
import { agentActivitySchema, agentPlanSchema, agentScopeSchema, gcj02ToWgs84, type AgentPlan } from '@trek/shared';
import { DatabaseService } from '../database/database.service';
import { AgentService } from './agent.service';
import type { McpContext } from '../../nest-mcp';
import { stationName } from './rail-legs';
import { agentTransportLegSchema, type AgentTransportLeg } from '@trek/shared';

const id = z.string().min(1).max(128);
// Creation defaults must not turn omitted patch fields into destructive updates.
const activityPatchSchema = agentActivitySchema.omit({ ref: true }).extend({
  currency: agentActivitySchema.shape.currency.removeDefault(),
  transport_mode: agentActivitySchema.shape.transport_mode.removeDefault(),
  notes: agentActivitySchema.shape.notes.removeDefault(),
  evidence_ids: agentActivitySchema.shape.evidence_ids.removeDefault(),
}).partial().strict();
const detailsSchema = z.object(agentPlanSchema.shape).omit({ activities: true }).extend({
  extensions: agentPlanSchema.shape.extensions.removeDefault(),
}).partial().strict();
export const draftChangesSchema = z.object({
  base_version: z.number().int().nonnegative(),
  changes: z.array(z.discriminatedUnion('op', [
    z.object({ op: z.literal('upsert_activity'), activity: agentActivitySchema,
      before_ref: id.optional().describe('可选的当前草稿中其他活动ref；新活动插到该ref前，已有活动更新后移动到该ref前。省略时已有活动保留位置，新活动追加到列表末尾。') }),
    z.object({ op: z.literal('patch_activity'), ref: id, fields: activityPatchSchema }),
    z.object({ op: z.literal('remove_activity'), ref: id }),
    z.object({ op: z.literal('reorder_activities'), refs: z.array(id).max(200) }),
    z.object({ op: z.literal('set_plan_details'), details: detailsSchema.describe('增量设置方案字段；保存候选前必须显式设置scope（旅程中的day_id、day_number及替换范围），不能从approved_scope为空推断替换授权。') }),
    z.object({ op: z.literal('set_routes'), source_ids: z.array(id).max(100) }),
    z.object({ op: z.literal('set_transport_legs'), legs: z.array(agentTransportLegSchema).max(30).describe('显式跨城交通段：train关联出发站与到达站，flight关联出发机场与到达机场；两端为同一天相邻活动，到达活动transport_mode=transit。地图用不同样式的两端示意线，班次是否有来源证实另行显示；航班未知字段省略，不用公路路线代替。') }),
    z.object({ op: z.literal('upsert_note'), ref: id, day_id: z.number().int().positive(), text: z.string().min(1).max(500) }),
    z.object({ op: z.literal('upsert_cost'), ref: id, name: z.string().min(1).max(200), total_price: z.number().nonnegative(), currency: z.string().length(3).default('CNY'), note: z.string().max(500).optional() }),
    z.object({ op: z.literal('upsert_accommodation'), ref: id, place_id: z.number().int().positive().optional(), place_ref: id.optional().describe('已定位酒店活动的ref，活动须有真实坐标；酒店或位置待定时只写住宿说明和upsert_cost，不建立住宿记录，不编造坐标。'), start_day_id: z.number().int().positive(), end_day_id: z.number().int().positive(), notes: z.string().max(1000).optional() }).refine(c => !!c.place_id !== !!c.place_ref, 'Choose existing place_id or draft activity place_ref'),
    z.object({ op: z.literal('remove_extra'), ref: id }),
  ])).min(1).max(200),
  message: z.string().max(2000).default('地图草稿已更新。'),
}).strict();
export const prepareDraftSchema = z.object({
  base_revision: id, approved_scope: agentScopeSchema.nullable(), approved_unlocks: z.array(id),
  revise_adopted_candidate: z.object({ candidate_id: id, candidate_version: z.number().int().positive() }).optional()
    .describe('修改已采用的候选时必填其真实ID和版本。从采用回执恢复现有日程绑定和替换范围，读取当前正式时间、交通与费用，清除已执行的预算、住宿等创建操作；不能与seed混用。'),
  seed: z.record(z.string(), z.unknown()).optional(), seed_seq: z.number().int().nonnegative().default(0),
}).refine(input => !(input.revise_adopted_candidate && input.seed), 'Choose adopted revision or draft seed');
const bindingSchema = z.object({ session_id: id, task_id: id, trip_id: z.number().int().positive(),
  runtime: z.literal('pi-durable').optional(),
  input_revision: z.number().int().positive(), call_id: id,
  receipts: z.array(z.object({ seq: z.number(), kind: z.string(), payload: z.record(z.string(), z.unknown()) })).default([]) });
type Binding = z.infer<typeof bindingSchema>;
type Draft = { version: number; task_id: string; input_revision: number; base_revision: string;
  approved_scope: unknown; approved_unlocks: string[]; seed_seq: number;
  activities: z.infer<typeof agentActivitySchema>[]; routes: string[]; transport_legs?: AgentTransportLeg[]; plan_details: Record<string, unknown>;
  extras: Record<string, { name: string; arguments: Record<string, unknown> }>;
  revision_scope?: z.infer<typeof agentScopeSchema>;
  plan?: AgentPlan; validated?: boolean; checks?: Record<string, unknown>[]; message: string };

@Injectable()
export class AgentDrafts implements OnModuleInit {
  constructor(private readonly db: DatabaseService, private readonly trips: AgentService) {}
  onModuleInit() {
    this.db.connection.exec('CREATE TABLE IF NOT EXISTS agent_drafts (session_id TEXT PRIMARY KEY, trip_id INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE, user_id INTEGER NOT NULL, payload TEXT NOT NULL)');
    this.db.connection.exec('CREATE TABLE IF NOT EXISTS agent_draft_outbox (event_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, task_id TEXT NOT NULL, payload TEXT NOT NULL, delivered_at TEXT)');
  }
  previewPageEdit(raw: Record<string, unknown>, edit: { patches: Record<string, unknown>[]; remove_refs: string[]; order?: string[] }) {
    const activities = z.array(agentActivitySchema).parse(raw.activities);
    const allowed = new Set(['ref','name','day_number','start_time','end_time','notes','cost','transport_mode']);
    for (const patch of edit.patches) {
      const index = activities.findIndex(a => a.ref === patch.ref);
      if (index < 0 || Object.keys(patch).some(k => !allowed.has(k))) throw new HttpException('Invalid page draft fields or ref', 422);
      activities[index] = agentActivitySchema.parse({ ...activities[index], ...patch });
    }
    if (edit.remove_refs.some(ref => !activities.some(a => a.ref === ref))) throw new HttpException('Unknown removed activity ref', 422);
    let remaining = activities.filter(a => !edit.remove_refs.includes(a.ref));
    if (edit.order) {
      const order = edit.order;
      if (order.length !== remaining.length || new Set(order).size !== order.length || order.some(ref => !remaining.some(a => a.ref === ref))) throw new HttpException('Invalid activity order', 422);
      remaining = order.map(ref => remaining.find(a => a.ref === ref)!);
    }
    const previous = raw.plan as Record<string, unknown> | undefined;
    const details = { ...(raw.plan_details as Record<string, unknown> ?? previous ?? {}) }; delete details.activities;
    const metadata = { ...raw }; delete metadata.event_id;
    return { ...metadata, plan: undefined, activities: remaining, plan_details: details, provisional: true,
      routes: edit.remove_refs.length || edit.order ? [] : raw.routes ?? [],
      validated: false, reviewed: false, message: '页面修改已保存，正在重新核对。' };
  }
  private binding(ctx: McpContext): Binding { return bindingSchema.parse(ctx.requestMeta?.['io.liketrek.agent']); }
  private load(bound: Binding, ctx: McpContext): Draft {
    this.trips.snapshot(bound.trip_id, ctx.userId);
    const row = this.db.get<{ trip_id: number; user_id: number; payload: string }>('SELECT * FROM agent_drafts WHERE session_id=?', bound.session_id);
    if (!row || row.trip_id !== bound.trip_id || row.user_id !== ctx.userId) throw new HttpException('Draft not prepared for this session and trip', 409);
    const draft = JSON.parse(row.payload) as Draft;
    if (draft.task_id !== bound.task_id || draft.input_revision !== bound.input_revision) throw new HttpException('Draft requirements changed; prepare the current task first', 409);
    return draft;
  }
  private store(bound: Binding, ctx: McpContext, draft: Draft) {
    this.db.transaction(() => {
      this.db.run('INSERT INTO agent_drafts VALUES (?,?,?,?) ON CONFLICT(session_id) DO UPDATE SET payload=excluded.payload', bound.session_id, bound.trip_id, ctx.userId, JSON.stringify(draft));
      const preview = this.preview(bound, draft);
      if (bound.runtime !== 'pi-durable') this.db.run('INSERT OR IGNORE INTO agent_draft_outbox(event_id,session_id,task_id,payload) VALUES (?,?,?,?)', preview.event_id, bound.session_id, bound.task_id, JSON.stringify(preview));
    });
  }
  private preview(bound: Binding, draft: Draft) {
    return { ...draft, event_id: bound.task_id + ':' + bound.call_id + ':' + draft.version + ':' + String(draft.validated ?? false),
      backend_ref: { session_id: bound.session_id, version: draft.version }, reviewed: false };
  }
  private result<Extra extends Record<string, unknown> = Record<never, never>>(
    bound: Binding, draft: Draft, extra?: Extra,
  ) {
    const reply = { draft_version: draft.version, activity_count: draft.activities.length, message: draft.message, ...extra };
    const preview = this.preview(bound, draft);
    return { content: [{ type: 'text' as const, text: JSON.stringify(reply) }], structuredContent: reply,
      _meta: { 'io.liketrek.agent/events': [{ kind: 'draft_updated', payload: preview }] } };
  }
  prepare(input: z.infer<typeof prepareDraftSchema>, ctx: McpContext) {
    const bound = this.binding(ctx);
    this.trips.draftAccess(bound.trip_id, ctx.userId);
    const snapshot = this.trips.snapshot(bound.trip_id, ctx.userId);
    if (snapshot.revision !== input.base_revision) throw new HttpException('TRIP_REVISION_CONFLICT', 409);
    return this.trips.operation(bound.task_id + ':prepare:' + bound.input_revision + ':' + bound.call_id, ctx.userId, { bound: { ...bound, receipts: [] }, input }, () => {
      const row = this.db.get<{ trip_id: number; user_id: number; payload: string }>('SELECT * FROM agent_drafts WHERE session_id=?', bound.session_id);
      if (row && (row.user_id !== ctx.userId || row.trip_id !== bound.trip_id)) throw new HttpException('Draft session ownership conflict', 403);
      const previous = row ? JSON.parse(row.payload) as Draft : undefined;
      const revision = input.revise_adopted_candidate ? this.adoptedRevision(input.revise_adopted_candidate, bound, ctx) : undefined;
      const seed: Record<string, unknown> | undefined = revision ?? (input.seed && input.seed_seq > (previous?.seed_seq ?? 0) ? input.seed : undefined);
      const draft: Draft = { version: (previous?.version ?? -1) + 1,
        task_id: bound.task_id, input_revision: bound.input_revision, base_revision: input.base_revision,
        approved_scope: input.approved_scope, approved_unlocks: input.approved_unlocks, seed_seq: input.seed_seq,
        activities: seed ? z.array(agentActivitySchema).parse(seed.activities ?? []) : previous?.activities ?? [],
        routes: seed ? z.array(id).parse(seed.routes ?? []) : previous?.routes ?? [],
        transport_legs: seed ? z.array(agentTransportLegSchema).parse(seed.transport_legs ?? (seed.plan as AgentPlan | undefined)?.extensions.transport_legs ?? []) : previous?.transport_legs ?? [],
        plan_details: seed ? (seed.plan_details ?? seed.plan ?? {}) as Record<string, unknown> : previous?.plan_details ?? {},
        extras: revision ? {} : previous?.extras ?? {},
        revision_scope: revision?.plan_details.scope ?? (!seed ? previous?.revision_scope : undefined),
        message: revision ? '已从采用回执恢复正式日程供修订；原预算和住宿已保留，不重复创建。' : '沿用已保存草稿，核对本次要求。' };
      delete draft.plan_details.activities;
      const extensions = draft.plan_details.extensions as Record<string, unknown> | undefined;
      if (!revision && Array.isArray(extensions?.native_operations) && !previous) {
        draft.extras = Object.fromEntries(extensions.native_operations.map((operation, index) => ['restored:' + index, operation]));
      }
      this.store(bound, ctx, draft);
      return this.editableResult(bound, draft);
    });
  }
  private adoptedRevision(input: NonNullable<z.infer<typeof prepareDraftSchema>['revise_adopted_candidate']>, bound: Binding, ctx: McpContext) {
    const { candidate, assignmentIds } = this.trips.adoptionAssignments(input.candidate_id, input.candidate_version, ctx.userId);
    if (candidate.trip_id !== bound.trip_id) throw new HttpException('Candidate belongs to another trip', 422);
    const plan = agentPlanSchema.parse(candidate.plan);
    const ordered = plan.scope.segments.flatMap(segment => plan.activities.filter(a => a.scope_ref === segment.ref));
    if (ordered.length !== assignmentIds.length || new Set(assignmentIds).size !== assignmentIds.length)
      throw new HttpException({ error: 'ADOPTION_RECEIPT_CONFLICT' }, 409);
    const bindings = new Map(ordered.map((a, index) => [a.ref, assignmentIds[index]!]));
    const replaced = new Set(assignmentIds);
    for (const segment of plan.scope.segments) {
      const refs = plan.activities.filter(a => a.scope_ref === segment.ref);
      const ids = refs.map(a => bindings.get(a.ref)!);
      const current = this.db.all<{ id: number }>('SELECT id FROM day_assignments WHERE day_id=? ORDER BY order_index,id', segment.day_id);
      const start = current.findIndex(a => a.id === ids[0]);
      if (!ids.length || start < 0 || ids.some((id, i) => current[start + i]?.id !== id))
        throw new HttpException({ error: 'ADOPTED_SEGMENT_CHANGED', scope_ref: segment.ref,
          message: '原安排已删除、换日、重排或被插入打断，请根据当前日程重新选择修订范围。' }, 409);
      const anchor = current[start - 1]?.id ?? null;
      if (anchor !== null && replaced.has(anchor)) throw new HttpException({ error: 'ADOPTED_SEGMENTS_NEED_MERGE' }, 409);
      segment.replace_assignment_ids = ids;
      segment.insert_after_assignment_id = anchor;
    }
    const known = this.knownSources(bound);
    plan.evidence = plan.evidence.filter(e => known.has(e.source_id));
    plan.activities = ordered.map(activity => {
      const row = this.db.get<{ place_id: number; name: string; lat: number | null; lng: number | null; address: string | null;
        price: number | null; currency: string; duration_minutes: number | null; notes: string | null;
        assignment_time: string | null; assignment_end_time: string | null; incoming_leg_transport_mode: 'walking' | 'transit' | 'driving' | null;
        transport_mode: 'walking' | 'transit' | 'driving' }>(`SELECT p.*,a.place_id,a.notes,a.assignment_time,a.assignment_end_time,a.incoming_leg_transport_mode
          FROM day_assignments a JOIN places p ON p.id=a.place_id WHERE a.id=?`, bindings.get(activity.ref))!;
      return { ...activity, existing_place_id: row.place_id, name: row.name, latitude: row.lat, longitude: row.lng,
        coordinate_system: row.lat == null ? null : 'WGS84' as const, address: row.address,
        start_time: row.assignment_time, end_time: row.assignment_end_time, duration_minutes: row.duration_minutes,
        cost: row.price, currency: row.currency ?? 'CNY', notes: row.notes ?? '',
        transport_mode: row.incoming_leg_transport_mode ?? row.transport_mode,
        evidence_ids: activity.evidence_ids.filter(source => known.has(source)) };
    });
    const routes = z.array(id).parse(plan.extensions.route_source_ids ?? []).filter(source => known.has(source));
    const transport_legs = z.array(agentTransportLegSchema).parse(plan.extensions.transport_legs ?? []);
    // Persisted intent can survive without the old receipt; it is then unverified.
    const { activities, ...plan_details } = plan;
    delete plan_details.extensions.native_operations;
    return { activities, routes, transport_legs, plan_details };
  }
  read(sessionId: string, userId: number) {
    const row = this.db.get<{ trip_id: number; user_id: number; payload: string }>('SELECT * FROM agent_drafts WHERE session_id=?', sessionId);
    if (!row) throw new HttpException('Draft not found', 404);
    this.trips.draftAccess(row.trip_id, userId);
    if (row.user_id !== userId) throw new HttpException('Draft belongs to another user', 403);
    return JSON.parse(row.payload) as Draft;
  }
  get(ctx: McpContext) {
    const bound = this.binding(ctx);
    const draft = this.load(bound, ctx);
    return this.editableResult(bound, draft);
  }
  private editableResult(bound: Binding, draft: Draft) {
    return this.result(bound, draft, { draft: {
      version: draft.version, base_revision: draft.base_revision,
      approved_scope: draft.approved_scope, approved_unlocks: draft.approved_unlocks,
      activities: draft.activities, plan_details: draft.plan_details, routes: draft.routes,
      transport_legs: draft.transport_legs, extras: draft.extras,
    } });
  }
  editPage(sessionId: string, userId: number, input: { base_version: number; patches: Record<string, unknown>[]; remove_refs: string[]; order?: string[] }) {
    const previous = this.read(sessionId, userId);
    if (previous.version !== input.base_version) throw new HttpException('DRAFT_VERSION_CONFLICT', 409);
    const edited = this.previewPageEdit(previous as unknown as Record<string, unknown>, input) as unknown as Draft;
    edited.version = previous.version + 1;
    this.db.run('UPDATE agent_drafts SET payload=? WHERE session_id=?', JSON.stringify(edited), sessionId);
    return edited;
  }
  saveCandidate(version: number, ctx: McpContext) {
    const bound = this.binding(ctx);
    if (bound.runtime !== 'pi-durable') this.validate(version, ctx);
    const draft = this.load(bound, ctx);
    if (draft.version !== version) throw new HttpException({ error: 'DRAFT_VERSION_CONFLICT', current_version: draft.version }, 409);
    if (bound.runtime === 'pi-durable') {
      try { draft.plan = this.buildPlan(draft); }
      catch (error) {
        if (error instanceof z.ZodError) throw new HttpException({
          error: 'DRAFT_PLAN_INVALID', draft_version: draft.version, issues: error.issues,
        }, 422);
        throw error;
      }
      if (draft.revision_scope) {
        for (const segment of draft.plan.scope.segments) {
          const original = draft.revision_scope.segments.find(s => s.ref === segment.ref && s.day_id === segment.day_id);
          if (!original || !segment.replace_assignment_ids.length ||
              segment.replace_assignment_ids.some(id => !original.replace_assignment_ids.includes(id)) ||
              (original.start_time && (!segment.start_time || segment.start_time < original.start_time)) ||
              (original.end_time && (!segment.end_time || segment.end_time > original.end_time)))
            throw new HttpException({ error: 'ADOPTED_REVISION_SCOPE_EXPANDED' }, 422);
        }
      }
      draft.checks = []; delete draft.validated;
      this.store(bound, ctx, draft);
    } else if (!draft.validated || !draft.plan) throw new HttpException({ error: 'DRAFT_INVALID', checks: draft.checks }, 422);
    const result = this.trips.save(ctx.userId, { operation_id: bound.call_id, candidate_id: 'c:' + bound.session_id,
      candidate_version: draft.version + 1, trip_id: bound.trip_id, session_id: bound.session_id, task_id: bound.task_id,
      input_revision: bound.input_revision, base_revision: draft.base_revision, approved_unlocks: draft.approved_unlocks,
      plan: draft.plan!, runtime: 'pi-durable' });
    return { content: [{ type: 'text' as const, text: JSON.stringify(result) }], structuredContent: result,
      _meta: { 'io.liketrek.agent/events': [{ kind: 'candidate_saved', payload: result }] } };
  }
  apply(input: z.infer<typeof draftChangesSchema>, ctx: McpContext) {
    const bound = this.binding(ctx);
    this.trips.draftAccess(bound.trip_id, ctx.userId);
    return this.trips.operation(bound.task_id + ':draft:' + bound.call_id, ctx.userId, { bound: { ...bound, receipts: [] }, input }, () => {
      const draft = this.load(bound, ctx);
      if (draft.version !== input.base_version) throw new HttpException({ error: 'DRAFT_VERSION_CONFLICT', current_version: draft.version }, 409);
      for (const change of input.changes) {
        if (change.op === 'upsert_activity') {
          const index = draft.activities.findIndex(a => a.ref === change.activity.ref);
          if (change.before_ref) {
            if (change.before_ref === change.activity.ref) throw new HttpException({
              error: 'ACTIVITY_ORDER_SELF_ANCHOR', message: 'before_ref 必须指向另一条活动。',
              activity_ref: change.activity.ref, before_ref: change.before_ref,
            }, 422);
            const anchorIndex = draft.activities.findIndex(a => a.ref === change.before_ref);
            if (anchorIndex < 0) throw new HttpException({
              error: 'ACTIVITY_ORDER_ANCHOR_NOT_FOUND', message: 'before_ref 必须指向当前草稿中已存在的活动。',
              activity_ref: change.activity.ref, before_ref: change.before_ref,
            }, 422);
            if (index >= 0) draft.activities.splice(index, 1);
            const insertionIndex = draft.activities.findIndex(a => a.ref === change.before_ref);
            draft.activities.splice(insertionIndex, 0, change.activity);
          } else if (index < 0) draft.activities.push(change.activity);
          else draft.activities[index] = change.activity;
        } else if (change.op === 'patch_activity' || change.op === 'remove_activity') {
          const index = draft.activities.findIndex(a => a.ref === change.ref);
          if (index < 0) throw new HttpException('Unknown activity ref', 422);
          if (change.op === 'remove_activity') draft.activities.splice(index, 1);
          else draft.activities[index] = agentActivitySchema.parse({ ...draft.activities[index], ...change.fields });
        } else if (change.op === 'reorder_activities') {
          if (change.refs.length !== draft.activities.length || new Set(change.refs).size !== change.refs.length || change.refs.some(ref => !draft.activities.some(a => a.ref === ref))) throw new HttpException('Order must contain every remaining ref exactly once', 422);
          draft.activities = change.refs.map(ref => draft.activities.find(a => a.ref === ref)!);
        } else if (change.op === 'set_plan_details') {
          if (change.details.extensions && ('native_operations' in change.details.extensions || 'transport_legs' in change.details.extensions)) throw new HttpException('Use atomic transport, note, cost and accommodation operations', 422);
          const previousEvidence = (draft.plan_details.evidence ?? []) as { source_id: string }[];
          draft.plan_details = { ...draft.plan_details, ...change.details };
          if (change.details.evidence) draft.plan_details.evidence = [...previousEvidence.filter(e => !change.details.evidence!.some(n => n.source_id === e.source_id)), ...change.details.evidence];
        } else if (change.op === 'set_routes') draft.routes = change.source_ids;
        else if (change.op === 'set_transport_legs') draft.transport_legs = change.legs;
        else if (change.op === 'remove_extra') { if (!draft.extras[change.ref]) throw new HttpException('Unknown extra ref', 422); delete draft.extras[change.ref]; }
        else {
          const { op, ref, ...args } = change;
          draft.extras[ref] = op === 'upsert_note' ? { name: 'create_day_note', arguments: { tripId: bound.trip_id, dayId: change.day_id, text: change.text } }
            : op === 'upsert_cost' ? { name: 'create_budget_item', arguments: { ...args, tripId: bound.trip_id, member_ids: [] } }
            : { name: 'create_accommodation', arguments: { ...args, tripId: bound.trip_id } };
        }
      }
      const snapshot = this.trips.snapshot(bound.trip_id, ctx.userId);
      const known = this.knownSources(bound);
      for (const activity of draft.activities) {
        if (!(snapshot.days as { day_number: number }[]).some(d => d.day_number === activity.day_number)) throw new HttpException('Activity day outside trip', 422);
        if (bound.runtime !== 'pi-durable' && activity.latitude != null && !activity.existing_place_id && !activity.evidence_ids.some(s => known.has(s))) throw new HttpException('Located activity requires recorded source evidence', 422);
      }
      draft.version++; draft.message = input.message; delete draft.plan; draft.validated = false;
      this.store(bound, ctx, draft);
      return this.result(bound, draft, { changed: input.changes.map(c => c.op) });
    });
  }
  private knownSources(bound: Binding) {
    const known = new Set<string>();
    for (const row of bound.receipts) {
      if (row.kind === 'tool_result' && row.payload.success === true) known.add('tool:' + row.payload.call_id);
      if (row.kind === 'user_message' || row.kind === 'user_answer') known.add('user:' + row.seq);
      if (row.kind === 'trip_context') {
        const snapshot = row.payload.snapshot as { revision?: string } | undefined;
        if (snapshot?.revision) known.add('snapshot:' + snapshot.revision);
      }
    }
    return known;
  }
  private buildPlan(draft: Draft): AgentPlan {
    const extensions = { ...(draft.plan_details.extensions as Record<string, unknown> ?? {}),
      route_source_ids: draft.routes, transport_legs: draft.transport_legs ?? [], native_operations: Object.values(draft.extras) };
    return agentPlanSchema.parse({ ...draft.plan_details, activities: draft.activities, extensions });
  }
  validate(version: number, ctx: McpContext) {
    const bound = this.binding(ctx), draft = this.load(bound, ctx);
    if (draft.version !== version) throw new HttpException({ error: 'DRAFT_VERSION_CONFLICT', current_version: draft.version }, 409);
    const checks: Record<string, unknown>[] = [];
    const check = (rule: string, test: () => void) => { try { test(); checks.push({ rule, status: 'pass' }); } catch (error) { checks.push({ rule, status: 'fail', reason: error instanceof HttpException ? error.getResponse() : String(error) }); } };
    let plan: AgentPlan | undefined;
    check('plan_contract', () => {
      const extras = Object.values(draft.extras);
      const extensions: Record<string, unknown> = { ...(draft.plan_details.extensions as Record<string, unknown> ?? {}), route_source_ids: draft.routes, transport_legs: draft.transport_legs ?? [] };
      extensions.native_operations = extras;
      plan = agentPlanSchema.parse({ ...draft.plan_details, activities: draft.activities, extensions });
      if (!plan.activities.length) { plan = undefined; throw new Error('完整方案至少需要一个安排'); }
    });
    if (plan) {
      const actual = plan;
      const snapshot = this.trips.snapshot(bound.trip_id, ctx.userId);
      check('trip_revision', () => { if (snapshot.revision !== draft.base_revision) throw new Error('TRIP_REVISION_CONFLICT'); });
      check('scope_and_locks', () => {
        this.trips.validateScope({ plan: actual, approved_unlocks: draft.approved_unlocks }, snapshot);
        if (draft.approved_scope) {
          const approved = agentScopeSchema.parse(draft.approved_scope);
          for (const s of actual.scope.segments) {
            const outer = approved.segments.find(a => a.day_id === s.day_id && s.replace_assignment_ids.every(n => a.replace_assignment_ids.includes(n)));
            if (!outer || (outer.start_time && (!s.start_time || s.start_time < outer.start_time)) || (outer.end_time && (!s.end_time || s.end_time > outer.end_time))) throw new Error('Approved scope cannot expand without user permission');
          }
        }
      });
      check('native_operations', () => { this.trips.validateNativeOperations({ trip_id: bound.trip_id, plan: actual }, ctx.userId); });
      check('accommodation_sources', () => {
        for (const op of Object.values(draft.extras).filter(o => o.name === 'create_accommodation')) {
          if (!op.arguments.place_ref) continue;
          const target = actual.activities.find(a => a.ref === op.arguments.place_ref);
          if (!target) throw new Error('住宿缺少对应的酒店地点');
          if (target.existing_place_id) continue;
          const verified = bound.receipts.some(r => r.kind === 'tool_result' && r.payload.success === true && target.evidence_ids.includes('tool:' + r.payload.call_id) && ['query_venues','query_places'].includes(String(r.payload.remote_name ?? r.payload.name)) &&
            ((sourceData(r.payload).result as { items?: (Point & { name: string })[] })?.items ?? []).some(p => p.name && target.name.includes(p.name) && distance(target, { ...p, coordinate_system: p.coordinate_system ?? String(sourceData(r.payload).coordinate_system) }) <= 100));
          if (!verified) throw new Error('住宿名称与位置必须来自对应酒店查询结果，不能只引用无关依据');
        }
      });
      check('references', () => {
        const known = this.knownSources(bound);
        const routeSources = new Set(bound.receipts.filter(r => r.kind === 'tool_result' && (r.payload.remote_name ?? r.payload.name) === 'query_routes' && r.payload.success === true).map(r => 'tool:' + r.payload.call_id));
        if (actual.evidence.some(e => !known.has(e.source_id)) || draft.routes.some(s => !routeSources.has(s))) throw new Error('Unrecorded evidence or invalid route reference');
      });
      check('hard_constraints', () => { if (actual.constraints.some(c => c.kind === 'hard' && c.status !== 'satisfied')) throw new Error('Hard constraint violated or unknown'); });
      check('rail_legs', () => {
        const legs = draft.transport_legs ?? [];
        const pairs = new Set<string>();
        for (const leg of legs) {
          const from = actual.activities.find(a => a.ref === leg.from_ref), to = actual.activities.find(a => a.ref === leg.to_ref);
          if (!from || !to || from.day_number !== to.day_number || actual.activities.indexOf(to) !== actual.activities.indexOf(from) + 1) throw new Error('铁路段必须连接同一天相邻的出发站和到达站');
          if (pairs.has(leg.from_ref + ':' + leg.to_ref)) throw new Error('铁路段重复');
          pairs.add(leg.from_ref + ':' + leg.to_ref);
          if (to.transport_mode !== 'transit') throw new Error('铁路段到达站的交通方式必须为公共交通，不能用驾车代替');
          if (leg.mode === 'flight') continue; // A planned schematic makes no timetable or booking claim.
          const day = (snapshot.days as { day_number: number; date: string }[]).find(d => d.day_number === from.day_number);
          if (day?.date !== leg.date) throw new Error('铁路日期与行程日期不同');
          const row = bound.receipts.find(r => r.kind === 'tool_result' && r.payload.success === true && 'tool:' + r.payload.call_id === leg.source_id && (r.payload.remote_name ?? r.payload.name) === 'query_transport');
          const data = row ? sourceData(row.payload).result as { date?: string; items?: { train_code: string; from_station: string; to_station: string; start_time: string; arrive_time: string }[] } : undefined;
          if (data?.date !== leg.date || !data.items?.some(t => t.train_code === leg.train_code && stationName(t.from_station) === stationName(leg.from_station) && stationName(t.to_station) === stationName(leg.to_station) && t.start_time === leg.departure_time && t.arrive_time === leg.arrival_time)) throw new Error('铁路车次、站名或时刻没有对应的查询依据');
          for (const [stop, station] of [[from, leg.from_station], [to, leg.to_station]] as const) {
            const verified = bound.receipts.some(r => r.kind === 'tool_result' && r.payload.success === true && stop.evidence_ids.includes('tool:' + r.payload.call_id) && (r.payload.remote_name ?? r.payload.name) === 'query_places' &&
              ((sourceData(r.payload).result as { items?: (Point & { name: string })[] })?.items ?? []).some(p => stationName(p.name) === stationName(station) && distance(stop, { ...p, coordinate_system: p.coordinate_system ?? String(sourceData(r.payload).coordinate_system) }) <= 100));
            const native = (snapshot.places as { id: number; name: string; lat: number; lng: number }[]).find(p => p.id === stop.existing_place_id);
            if (!verified && !(native && stationName(native.name) === stationName(station) && distance(stop, { latitude: native.lat, longitude: native.lng, coordinate_system: 'WGS84' }) <= 100)) throw new Error('铁路站点坐标与已查证车站不一致');
          }
          if (!actual.evidence.some(e => e.source_id === leg.source_id)) throw new Error('铁路来源未写入方案依据');
          if (!from.end_time || !to.start_time || minutes(leg.departure_time) - minutes(from.end_time) < 20 || minutes(to.start_time) - minutes(leg.arrival_time) < 10 || leg.arrival_time <= leg.departure_time) throw new Error('铁路段需预留至少20分钟候车、10分钟出站，跨日列车暂不支持');
        }
        for (const activity of actual.activities) {
          if (/乘.{0,12}(?:高铁|动车|火车)|[GDC]\d{2,}|(?:高铁|动车|火车)(?:前往|抵达|出发|行程)/.test(activity.name + ' ' + activity.notes) && !legs.some(l => l.from_ref === activity.ref || l.to_ref === activity.ref)) throw new Error('铁路安排需要明确出发站、到达站和车次段，不能只写在地点说明中');
        }
      });
      for (const day of new Set(actual.activities.map(a => a.day_number))) {
        const stops = actual.activities.filter(a => a.day_number === day);
        for (const [index, next] of stops.entries()) {
          const previous = stops[index - 1];
          if (!previous) continue;
          check('time_order_and_transfer:' + previous.ref + ':' + next.ref, () => {
            if (previous.start_time && next.start_time && previous.start_time > next.start_time) throw new Error('Activity order conflicts with time');
            if (previous.end_time && next.start_time && previous.end_time > next.start_time) throw new Error('Activities overlap');
            if (draft.transport_legs?.some(l => l.from_ref === previous.ref && l.to_ref === next.ref)) return;
            if (distance(previous, next) <= 100) return;
            const calls = new Map(bound.receipts.filter(r => r.kind === 'tool_call').map(r => [r.payload.call_id, r.payload.arguments as Record<string, unknown>]));
            const routes = bound.receipts.filter(r => r.kind === 'tool_result' && (r.payload.remote_name ?? r.payload.name) === 'query_routes' && r.payload.success === true && draft.routes.includes('tool:' + r.payload.call_id));
            const found = routes.map(r => ({ args: calls.get(r.payload.call_id), result: sourceData(r.payload).result as { duration_s?: number } | undefined }))
              .find(r => r.args && r.args.mode === next.transport_mode && distance(previous, r.args.origin as Point) <= 100 && distance(next, r.args.destination as Point) <= 100 && (r.result?.duration_s ?? 0) > 0);
            if (!found) throw new Error('缺少实际起终点、方向和交通方式对应的路线依据');
            if (!previous.end_time || !next.start_time) throw new Error('缺少时间，无法验证转场');
            const required = Math.ceil(found.result!.duration_s! / 60) + (next.transport_mode === 'transit' ? 10 : 5);
            if (minutes(next.start_time) - minutes(previous.end_time) < required) throw new Error('转场时间不足，含等车或步行缓冲需要 ' + required + ' 分钟');
          });
        }
      }
      checks.push({ rule: 'cost', status: actual.activities.some(a => a.cost == null) ? 'unknown' : 'pass',
        totals: Object.fromEntries([...new Set(actual.activities.map(a => a.currency))].map(c => [c, actual.activities.filter(a => a.currency === c).reduce((sum, a) => sum + (a.cost ?? 0), 0)])) });
      draft.plan = actual;
    }
    draft.checks = checks; draft.validated = !checks.some(c => c.status === 'fail');
    this.store(bound, ctx, draft);
    return this.result(bound, draft, { valid: draft.validated, checks });
  }
}
type Point = { latitude?: number | null; longitude?: number | null; coordinate_system?: string | null };
function distance(a: Point, b?: Point) {
  if (!b || a.latitude == null || a.longitude == null || b.latitude == null || b.longitude == null) return Infinity;
  const point = (p: Point) => p.coordinate_system === 'GCJ02' ? gcj02ToWgs84(p.latitude!, p.longitude!) : { lat: p.latitude!, lng: p.longitude! };
  const x = point(a), y = point(b);
  return Math.hypot((x.lat - y.lat) * 111320, (x.lng - y.lng) * 111320 * Math.cos(x.lat * Math.PI / 180));
}
function minutes(value: string) { const [h, m] = value.split(':').map(Number); return h! * 60 + m!; }
function sourceData(payload: Record<string, unknown>): Record<string, unknown> {
  let value = (payload.original ?? payload.decoded ?? payload.result ?? {}) as Record<string, unknown>;
  for (let i = 0; i < 3 && !value.result && value.data && typeof value.data === 'object'; i++) value = value.data as Record<string, unknown>;
  return value;
}
