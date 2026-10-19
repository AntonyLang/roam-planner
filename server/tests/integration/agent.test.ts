import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { HttpException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { TestingModule } from '@nestjs/testing';
import { createHash } from 'node:crypto';
import { db } from '../../src/db/database';
import { AgentModule } from '../../src/nest/agent/agent.module';
import { AgentService } from '../../src/nest/agent/agent.service';
import { AgentDrafts, draftChangesSchema, prepareDraftSchema } from '../../src/nest/agent/agent-drafts.service';
import { AgentMcp } from '../../src/nest/agent/agent.mcp';
import { createTestRegistry, type McpContext } from '../../src/nest-mcp';
import { createAttachHarness } from '../unit/nest-mcp/harness';
import { agentPlanSchema, type AgentSave } from '@trek/shared';

function digest(value: unknown): string {
  const canonical = (v: unknown): string => {
    if (typeof v === 'number') { const bytes = Buffer.alloc(8); bytes.writeDoubleBE(v); return 'n' + bytes.toString('hex'); }
    if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
    if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canonical((v as Record<string, unknown>)[k])).join(',') + '}';
    return JSON.stringify(v);
  };
  return createHash('sha256').update(canonical(value)).digest('hex');
}

let module: TestingModule;
let service: AgentService;
let count = 0;
function draftFixture() {
  const f = fixture();
  const drafts = module.get(AgentDrafts);
  const place = db.prepare('SELECT place_id FROM day_assignments WHERE id=?').get(f.activities[1]) as { place_id: number };
  f.candidate.plan.activities[0]!.existing_place_id = place.place_id;
  const ctx: McpContext = { userId: f.user, scopes: null, isStaticToken: false, requestMeta: {
    'io.liketrek.agent': { session_id: 'draft-session-' + f.trip, task_id: 'draft-task-' + f.trip,
      trip_id: f.trip, input_revision: 1, call_id: 'prepare', receipts: [] } } };
  const prepared = drafts.prepare({ base_revision: f.candidate.base_revision, approved_scope: f.candidate.plan.scope, approved_unlocks: [], seed_seq: 0 }, ctx);
  const { activities, ...details } = f.candidate.plan;
  const input = draftChangesSchema.parse({ base_version: prepared.structuredContent.draft_version,
    changes: [{ op: 'upsert_activity', activity: activities[0] }, { op: 'set_plan_details', details }] });
  return { ...f, drafts, ctx, input };
}
describe('Versioned backend draft operations', () => {
  function rejectsDomainError(run: () => unknown, code: string) {
    try { run(); expect.unreachable('Expected domain conflict'); }
    catch (error) { expect(error).toBeInstanceOf(HttpException); expect((error as HttpException).getResponse()).toMatchObject({ error: code }); }
  }
  function adoptedDraft() {
    const f = draftFixture();
    const bound = f.ctx.requestMeta!['io.liketrek.agent'] as Record<string, unknown>;
    bound.runtime = 'pi-durable'; bound.call_id = 'initial-apply';
    f.drafts.apply(draftChangesSchema.parse({ ...f.input, changes: [...f.input.changes,
      { op: 'patch_activity', ref: 'new-stop', fields: { cost: 80 } },
      { op: 'upsert_cost', ref: 'ticket', name: 'Three tickets', total_price: 240 },
      { op: 'upsert_accommodation', ref: 'stay', place_ref: 'new-stop', start_day_id: f.day, end_day_id: f.day },
    ] }), f.ctx);
    bound.call_id = 'initial-save-' + f.trip;
    const saved = f.drafts.saveCandidate(1, f.ctx).structuredContent;
    const adopted = service.adopt(saved.candidate_id, saved.candidate_version, 'initial-adopt-' + f.trip, f.user);
    // A later idempotent adoption has no assignment_ids; the original receipt remains authoritative.
    service.adopt(saved.candidate_id, saved.candidate_version, 'already-adopted-' + f.trip, f.user);
    bound.call_id = 'revise-prepare'; bound.input_revision = 2;
    const prepare = () => f.drafts.prepare(prepareDraftSchema.parse({
      base_revision: service.snapshot(f.trip, f.user).revision, approved_scope: null, approved_unlocks: [],
      revise_adopted_candidate: { candidate_id: saved.candidate_id, candidate_version: saved.candidate_version },
    }), f.ctx);
    return { ...f, bound, saved, adopted, prepare };
  }

  it('revises adopted assignments from the receipt and current values without duplicating budget or accommodation', () => {
    const f = adoptedDraft();
    const before = service.snapshot(f.trip, f.user);
    const id = f.adopted.assignment_ids![0]!;
    db.prepare('UPDATE day_assignments SET assignment_time=?,notes=? WHERE id=?').run('14:30', 'manual note', id);
    const prepared = f.prepare();
    const draft = prepared.structuredContent.draft;
    expect(draft.activities[0]).toMatchObject({ existing_place_id: f.candidate.plan.activities[0]!.existing_place_id,
      start_time: '14:30', notes: 'manual note', cost: 80, coordinate_system: 'WGS84' });
    expect(draft.plan_details.scope).toMatchObject({ segments: [{ replace_assignment_ids: [id], insert_after_assignment_id: f.activities[0] }] });
    expect(draft.extras).toEqual({});
    expect(service.snapshot(f.trip, f.user).assignments).toHaveLength(3);
    f.bound.call_id = 'revise-apply';
    f.drafts.apply(draftChangesSchema.parse({ base_version: draft.version,
      changes: [{ op: 'patch_activity', ref: 'new-stop', fields: { cost: 240, transport_mode: 'driving' } }] }), f.ctx);
    f.bound.call_id = 'revise-save';
    const saved = f.drafts.saveCandidate(draft.version + 1, f.ctx).structuredContent;
    const adopted = service.adopt(saved.candidate_id, saved.candidate_version, 'revision-adopt-' + f.trip, f.user);
    expect(adopted.assignment_ids).toEqual([id]);
    expect(service.adopt(saved.candidate_id, saved.candidate_version, 'revision-adopt-' + f.trip, f.user)).toEqual(adopted);
    const after = service.snapshot(f.trip, f.user);
    expect(after.assignments).toHaveLength(3);
    expect(after.related.budget_items).toEqual(before.related.budget_items);
    expect(after.related.reservations).toEqual(before.related.reservations);
    expect(after.related.day_accommodations).toHaveLength(1);
    expect(after.related.day_accommodations).toEqual(before.related.day_accommodations);
    const place = (after.places as { id: number; price: number; lat: number; lng: number }[]).find(p => p.id === draft.activities[0]!.existing_place_id)!;
    expect(place).toMatchObject({ price: 240, lat: 36.01, lng: 120 });
    expect(after.assignments).toEqual(expect.arrayContaining([expect.objectContaining({ id, incoming_leg_transport_mode: 'driving' })]));
  });

  it('continues an adopted draft without requiring the model to opt into replacement and reuses its stay',()=>{
    const f=adoptedDraft();
    const before=service.snapshot(f.trip,f.user);
    const prepared=f.drafts.prepare(prepareDraftSchema.parse({base_revision:before.revision,approved_scope:null,approved_unlocks:[]}),f.ctx);
    const draft=prepared.structuredContent.draft;
    expect(draft.extras).toEqual({});
    expect(draft.plan_details.scope.segments[0].replace_assignment_ids).toEqual(f.adopted.assignment_ids);
    f.bound.call_id='direct-revision';
    f.drafts.apply(draftChangesSchema.parse({base_version:draft.version,changes:[
      {op:'patch_activity',ref:'new-stop',fields:{notes:'下午回酒店休息'}},
      {op:'upsert_accommodation',ref:'stay',place_ref:'new-stop',start_day_id:f.day,end_day_id:f.day,notes:'三人一间双床房'},
    ]}),f.ctx);
    f.bound.call_id='direct-revision-save';
    const saved=f.drafts.saveCandidate(draft.version+1,f.ctx).structuredContent;
    const result=service.adopt(saved.candidate_id,saved.candidate_version,'direct-revision-adopt-'+f.trip,f.user);
    const after=service.snapshot(f.trip,f.user);
    expect(result.assignment_ids).toEqual(f.adopted.assignment_ids);
    expect(after.places).toHaveLength(before.places.length);
    expect(after.assignments).toHaveLength(before.assignments.length);
    expect(after.related.day_accommodations).toHaveLength(1);
    expect(after.related.reservations).toHaveLength((before.related.reservations as unknown[]).length);
    expect(after.related.budget_items).toEqual(before.related.budget_items);
    expect(after.related.day_accommodations).toEqual([expect.objectContaining({notes:'三人一间双床房'})]);
    expect(after.related.reservations).toEqual([expect.objectContaining({notes:'三人一间双床房',status:'pending'})]);
  });

  it('persists confirmation per user and exact card content',()=>{
    const f=fixture();
    expect(service.confirmations(f.trip,f.user).keys).toEqual([]);
    service.confirm(f.trip,f.user,'hotel:two-beds');service.confirm(f.trip,f.user,'hotel:two-beds');
    expect(service.confirmations(f.trip,f.user).keys).toEqual(['hotel:two-beds']);
    expect(()=>service.confirm(f.trip,999999,'other')).toThrow();
  });

  it('rejects missing adopted bindings and revision scope changed into an append', () => {
    const f = adoptedDraft();
    f.prepare();
    f.bound.call_id = 'continue-revision'; f.bound.input_revision = 3;
    const prepared = f.drafts.prepare(prepareDraftSchema.parse({ base_revision: service.snapshot(f.trip, f.user).revision,
      approved_scope: null, approved_unlocks: [] }), f.ctx);
    f.bound.call_id = 'unsafe-scope';
    const scope = structuredClone(prepared.structuredContent.draft.plan_details.scope) as AgentSave['plan']['scope'];
    scope.segments[0]!.replace_assignment_ids = [];
    f.drafts.apply(draftChangesSchema.parse({ base_version: prepared.structuredContent.draft_version,
      changes: [{ op: 'set_plan_details', details: { scope } }] }), f.ctx);
    f.bound.call_id = 'unsafe-save';
    rejectsDomainError(() => f.drafts.saveCandidate(prepared.structuredContent.draft_version + 1, f.ctx), 'ADOPTED_REVISION_SCOPE_EXPANDED');
    db.prepare('DELETE FROM day_assignments WHERE id=?').run(f.adopted.assignment_ids![0]);
    f.bound.call_id = 'missing-binding';
    rejectsDomainError(() => f.prepare(), 'ADOPTED_SEGMENT_CHANGED');
  });

  it('restores binding order by segment traversal and rejects a manually split adopted segment', () => {
    const f = draftFixture();
    const first = f.candidate.plan.activities[0]!;
    const second = { ...first, ref: 'second-stop', existing_place_id: null, name: 'Second' };
    const nextDay = Number(db.prepare('INSERT INTO days(trip_id,day_number,date) VALUES(?,?,?)').run(f.trip, 2, '2026-10-02').lastInsertRowid);
    const later = { ...first, ref: 'later-stop', existing_place_id: null, name: 'Later', scope_ref: 'later', day_number: 2 };
    f.candidate.plan.scope.segments.push({ ...f.candidate.plan.scope.segments[0]!, ref: 'later', day_id: nextDay,
      day_number: 2, replace_assignment_ids: [], insert_after_assignment_id: null });
    f.candidate.plan.activities = [later, first, second];
    service.save(f.user, { ...f.candidate, base_revision: service.snapshot(f.trip, f.user).revision, review: undefined, runtime: 'pi-durable' });
    const adopted = service.adopt(f.candidate.candidate_id, 1, 'ordered-adopt-' + f.trip, f.user);
    const bound = f.ctx.requestMeta!['io.liketrek.agent'] as Record<string, unknown>;
    bound.call_id = 'ordered-restore';
    const prepare = () => f.drafts.prepare(prepareDraftSchema.parse({ base_revision: service.snapshot(f.trip, f.user).revision,
      approved_scope: null, approved_unlocks: [], revise_adopted_candidate: { candidate_id: f.candidate.candidate_id, candidate_version: 1 } }), f.ctx);
    const restored = prepare().structuredContent.draft;
    expect(restored.activities.map(a => a.ref)).toEqual(['new-stop', 'second-stop', 'later-stop']);
    expect(restored.activities.map(a => a.existing_place_id)).toEqual(adopted.assignment_ids!.map(id =>
      (db.prepare('SELECT place_id FROM day_assignments WHERE id=?').get(id) as { place_id: number }).place_id));
    db.prepare('UPDATE day_assignments SET order_index=order_index*2 WHERE day_id=?').run(f.day);
    db.prepare('INSERT INTO day_assignments(day_id,place_id,order_index) VALUES(?,?,?)').run(f.day, first.existing_place_id, 3);
    bound.call_id = 'split-restore';
    rejectsDomainError(prepare, 'ADOPTED_SEGMENT_CHANGED');
  });

  it('keeps costs of shared places outside a revision unchanged on adoption failure', () => {
    const f = adoptedDraft();
    const placeId = f.candidate.plan.activities[0]!.existing_place_id!;
    db.prepare('UPDATE day_assignments SET place_id=? WHERE id=?').run(placeId, f.activities[2]);
    const prepared = f.prepare();
    f.bound.call_id = 'shared-price-change';
    f.drafts.apply(draftChangesSchema.parse({ base_version: prepared.structuredContent.draft_version,
      changes: [{ op: 'patch_activity', ref: 'new-stop', fields: { cost: 240 } }] }), f.ctx);
    f.bound.call_id = 'shared-price-save';
    const saved = f.drafts.saveCandidate(prepared.structuredContent.draft_version + 1, f.ctx).structuredContent;
    const before = service.snapshot(f.trip, f.user);
    rejectsDomainError(() => service.adopt(saved.candidate_id, saved.candidate_version, 'shared-price-adopt-' + f.trip, f.user), 'SHARED_PLACE_COST');
    expect(service.snapshot(f.trip, f.user).revision).toBe(before.revision);
  });

  it('rejects contradictory prices on two activities at one place instead of letting array order choose the cost', () => {
    const f = draftFixture();
    const first = { ...f.candidate.plan.activities[0]!, cost: 240 };
    const second = { ...first, ref: 'second-visit', cost: 80 };
    service.save(f.user, { ...f.candidate, review: undefined, runtime: 'pi-durable',
      plan: { ...f.candidate.plan, activities: [first, second] } });
    const before = service.snapshot(f.trip, f.user);
    rejectsDomainError(() => service.adopt(f.candidate.candidate_id, 1, 'conflicting-price-' + f.trip, f.user), 'CONFLICTING_PLACE_COSTS');
    expect(service.snapshot(f.trip, f.user).revision).toBe(before.revision);
  });

  it('persists a planned flight schematic without inventing a timetable, booking or source', () => {
    const f=draftFixture();
    const bound=f.ctx.requestMeta!['io.liketrek.agent'] as Record<string,unknown>;
    bound.runtime='pi-durable';
    const from={...f.candidate.plan.activities[0]!,ref:'departure-airport',name:'出发机场',existing_place_id:null};
    const to={...from,ref:'arrival-airport',name:'到达机场',transport_mode:'transit' as const};
    const leg={mode:'flight',from_ref:from.ref,to_ref:to.ref,from_airport:from.name,to_airport:to.name};
    f.drafts.apply(draftChangesSchema.parse({...f.input,changes:[
      {op:'upsert_activity',activity:from},{op:'upsert_activity',activity:to},
      ...f.input.changes.filter(change=>change.op==='set_plan_details'),{op:'set_transport_legs',legs:[leg]},
    ]}),f.ctx);
    const saved=f.drafts.saveCandidate(1,f.ctx).structuredContent;
    expect(saved.plan.extensions.transport_legs).toEqual([leg]);
    expect(f.drafts.get(f.ctx).structuredContent.draft.transport_legs).toEqual([leg]);
    expect(db.prepare('SELECT adopted_at FROM agent_candidates WHERE candidate_id=? AND version=?').get(saved.candidate_id,saved.candidate_version)).toEqual({adopted_at:null});
    service.adopt(saved.candidate_id,saved.candidate_version,'flight-adopt-'+f.trip,f.user);
    const transport=db.prepare("SELECT type,status,metadata,reservation_time FROM reservations WHERE trip_id=? AND type='flight'").get(f.trip) as any;
    expect(transport).toMatchObject({type:'flight',status:'pending',reservation_time:null});
    expect(JSON.parse(transport.metadata)).toMatchObject({departure_airport:'出发机场',arrival_airport:'到达机场'});
    expect(JSON.parse(transport.metadata).flight_number).toBeUndefined();
  });
  it('prepare exposes the editable draft and preserves it when continuing without inventing scope', () => {
    const f = draftFixture();
    const bound = f.ctx.requestMeta!['io.liketrek.agent'] as Record<string, unknown>;
    const before = f.drafts.get(f.ctx).structuredContent.draft;
    expect(before.plan_details).toEqual({});
    bound.call_id = 'continue-empty'; bound.input_revision = 2;
    const empty = f.drafts.prepare({ base_revision: f.candidate.base_revision, approved_scope: null, approved_unlocks: [], seed_seq: 0 }, f.ctx);
    expect(empty.structuredContent.draft).toEqual(f.drafts.get(f.ctx).structuredContent.draft);
    expect(empty.structuredContent.draft.approved_scope).toBeNull();
    expect(empty.structuredContent.draft.plan_details).not.toHaveProperty('scope');
    bound.call_id = 'apply-retained';
    f.drafts.apply({ ...f.input, base_version: empty.structuredContent.draft_version }, f.ctx);
    const retained = f.drafts.get(f.ctx).structuredContent.draft;
    bound.call_id = 'continue-retained'; bound.input_revision = 3;
    const continued = f.drafts.prepare({ base_revision: f.candidate.base_revision, approved_scope: null, approved_unlocks: [], seed_seq: 0 }, f.ctx);
    expect(continued.structuredContent.draft).toEqual({ ...retained, version: retained.version + 1 });
    expect(continued.structuredContent.draft).toEqual(f.drafts.get(f.ctx).structuredContent.draft);
    expect(service.list(f.trip, f.user)).toEqual([]);
  });

  it('appends by default and honors explicit before_ref insertion and movement without sorting wall times', () => {
    const f = draftFixture();
    const bound = f.ctx.requestMeta!['io.liketrek.agent'] as Record<string, unknown>;
    bound.runtime = 'pi-durable'; bound.call_id = 'apply-order-base';
    f.drafts.apply(f.input, f.ctx);
    const base = f.candidate.plan.activities[0]!;
    const start = { ...base, existing_place_id: null, name: 'Start', start_time: '13:00', end_time: '13:05' };
    const departure = { ...base, ref: 'departure', existing_place_id: null, name: 'Departure local time', start_time: '14:20', end_time: '15:00' };
    const arrival = { ...base, ref: 'arrival', existing_place_id: null, name: 'Arrival local time', start_time: '13:10', end_time: '14:00' };
    const readActivities = () => {
      const row = db.prepare('SELECT payload FROM agent_drafts WHERE session_id=?').get(bound.session_id) as { payload: string };
      return JSON.parse(row.payload).activities as { ref: string }[];
    };

    bound.call_id = 'apply-order-append';
    f.drafts.apply(draftChangesSchema.parse({ base_version: 1, changes: [
      { op: 'upsert_activity', activity: start },
      { op: 'upsert_activity', activity: departure },
    ] }), f.ctx);
    expect(readActivities().map(a => a.ref)).toEqual(['new-stop', 'departure']);

    bound.call_id = 'apply-order-insert';
    f.drafts.apply(draftChangesSchema.parse({ base_version: 2, changes: [
      { op: 'upsert_activity', activity: arrival, before_ref: 'departure' },
    ] }), f.ctx);
    expect(readActivities().map(a => a.ref)).toEqual(['new-stop', 'arrival', 'departure']);

    bound.call_id = 'apply-order-move';
    f.drafts.apply(draftChangesSchema.parse({ base_version: 3, changes: [
      { op: 'upsert_activity', activity: departure, before_ref: 'arrival' },
    ] }), f.ctx);
    expect(readActivities().map(a => a.ref)).toEqual(['new-stop', 'departure', 'arrival']);
    bound.call_id = 'save-wall-time-rollback';
    expect(() => f.drafts.saveCandidate(4, f.ctx)).not.toThrow();

    const candidateId = 'c:' + bound.session_id;
    const candidate = service.get(candidateId, 5, f.user);
    expect(candidate.plan.activities.map(a => a.ref)).toEqual(['new-stop', 'departure', 'arrival']);
    service.adopt(candidateId, 5, 'adopt-wall-time-rollback-' + f.trip, f.user);
    const adopted = db.prepare(`SELECT p.name, a.assignment_time, a.order_index FROM day_assignments a
      JOIN places p ON p.id=a.place_id WHERE a.day_id=? AND p.name IN (?, ?, ?) ORDER BY a.order_index`)
      .all(f.day, 'Start', 'Departure local time', 'Arrival local time') as { name: string; assignment_time: string | null; order_index: number }[];
    expect(adopted).toEqual([
      { name: 'Start', assignment_time: '13:00', order_index: 1 },
      { name: 'Departure local time', assignment_time: '14:20', order_index: 2 },
      { name: 'Arrival local time', assignment_time: '13:10', order_index: 3 },
    ]);
  });

  it('rejects unknown and self before_ref anchors without persisting draft changes', () => {
    const f = draftFixture();
    const bound = f.ctx.requestMeta!['io.liketrek.agent'] as Record<string, unknown>;
    bound.runtime = 'pi-durable'; bound.call_id = 'apply-anchor-base';
    f.drafts.apply(f.input, f.ctx);
    const readPayload = () => (db.prepare('SELECT payload FROM agent_drafts WHERE session_id=?')
      .get(bound.session_id) as { payload: string }).payload;
    const original = readPayload();
    const base = f.candidate.plan.activities[0]!;
    const rejectAnchor = (callId: string, activity: typeof base, beforeRef: string, errorCode: string) => {
      bound.call_id = callId;
      let failure: unknown;
      try {
        f.drafts.apply(draftChangesSchema.parse({ base_version: 1, changes: [
          { op: 'upsert_activity', activity, before_ref: beforeRef },
        ] }), f.ctx);
      } catch (error) { failure = error; }
      expect(failure).toBeInstanceOf(HttpException);
      expect((failure as HttpException).getStatus()).toBe(422);
      expect((failure as HttpException).getResponse()).toMatchObject({ error: errorCode, before_ref: beforeRef });
      expect(readPayload()).toBe(original);
    };

    rejectAnchor('apply-unknown-anchor', { ...base, ref: 'new-stop', name: 'New activity' }, 'missing-ref', 'ACTIVITY_ORDER_ANCHOR_NOT_FOUND');
    rejectAnchor('apply-self-anchor', base, base.ref, 'ACTIVITY_ORDER_SELF_ANCHOR');
  });

  it('reads a saved candidate version from list after the editable draft changes', async () => {
    const f = draftFixture();
    const bound = f.ctx.requestMeta!['io.liketrek.agent'] as Record<string, unknown>;
    bound.runtime = 'pi-durable'; bound.call_id = 'apply-saved-version';
    f.drafts.apply(f.input, f.ctx);

    bound.call_id = 'save-version-x';
    const saved = f.drafts.saveCandidate(1, f.ctx).structuredContent as Record<string, any>;
    expect(saved).toMatchObject({ candidate_id: 'c:' + bound.session_id, candidate_version: 2, status: 'saved' });
    const savedPlan = structuredClone(saved.plan);

    bound.call_id = 'edit-current-draft';
    f.drafts.apply(draftChangesSchema.parse({ base_version: 1, changes: [
      { op: 'patch_activity', ref: 'new-stop', fields: { name: 'Current draft only', start_time: '16:00', end_time: '17:00' } },
    ] }), f.ctx);
    const current = f.drafts.get(f.ctx).structuredContent as { draft: { activities: { name: string; start_time: string }[] } };
    expect(current.draft.activities[0]).toMatchObject({ name: 'Current draft only', start_time: '16:00' });

    const registry = createTestRegistry([module.get(AgentMcp)], { accessPolicy: () => true });
    const harness = await createAttachHarness(registry, { userId: f.user });
    try {
      const summary = await harness.client.callTool({ name: 'list_planning_candidates', arguments: { trip_id: f.trip }, _meta: f.ctx.requestMeta });
      const summaryText = summary.content.find(item => item.type === 'text') as { type: 'text'; text: string };
      const summaries = JSON.parse(summaryText.text);
      expect(summaries).toMatchObject({ projection: 'summary', candidates: [{ candidate_id: saved.candidate_id,
        candidate_version: saved.candidate_version, adopted_at: null, activity_count: 1 }] });
      expect(summaries.candidates[0]).not.toHaveProperty('plan');
      const listed = await harness.client.callTool({ name: 'list_planning_candidates', arguments: { trip_id: f.trip,
        include_plan: true, candidate_id: String(saved.candidate_id), candidate_version: Number(saved.candidate_version) }, _meta: f.ctx.requestMeta });
      expect(listed.isError).not.toBe(true);
      const listText = listed.content.find(item => item.type === 'text');
      expect(listText?.type).toBe('text');
      const candidates = JSON.parse((listText as { type: 'text'; text: string }).text).candidates as Record<string, any>[];
      const readBack = candidates.find(candidate => candidate.candidate_id === saved.candidate_id && candidate.candidate_version === saved.candidate_version);
      expect(readBack).toBeDefined();
      expect(readBack!.plan).toEqual(savedPlan);
      expect(readBack!.plan.activities[0]).toMatchObject({ name: 'Replacement', start_time: '14:00' });
      expect(readBack!.adopted_at).toBeNull();
    } finally { await harness.cleanup(); }
  });

  it('lets get_trip_draft expose a missing scope and activity ref, then saves after scope is set explicitly', async () => {
    const f = draftFixture();
    const bound = f.ctx.requestMeta!['io.liketrek.agent'] as Record<string, unknown>;
    bound.runtime = 'pi-durable'; bound.call_id = 'apply-only-activity';
    const activity = f.candidate.plan.activities[0]!;
    f.drafts.apply(draftChangesSchema.parse({ base_version: 0, changes: [
      { op: 'upsert_activity', activity },
    ] }), f.ctx);

    const sessionId = String(bound.session_id);
    const readPayload = () => (db.prepare('SELECT payload FROM agent_drafts WHERE session_id=?')
      .get(sessionId) as { payload: string }).payload;
    const payloadBeforeRead = readPayload();
    const assignmentsBeforeRead = db.prepare('SELECT * FROM day_assignments WHERE day_id=? ORDER BY order_index').all(f.day);
    const operationCountBeforeRead = db.prepare('SELECT count(*) AS n FROM agent_operations').get() as { n: number };
    const candidateCountBeforeRead = db.prepare('SELECT count(*) AS n FROM agent_candidates WHERE candidate_id=?')
      .get('c:' + sessionId) as { n: number };
    const registry = createTestRegistry([module.get(AgentMcp)], { accessPolicy: () => true });
    const harness = await createAttachHarness(registry, { userId: f.user });
    try {
      const read = await harness.client.callTool({ name: 'get_trip_draft', arguments: {}, _meta: f.ctx.requestMeta });
      expect(read.isError).not.toBe(true);
      const visible = read.structuredContent as { draft_version: number; draft: Record<string, unknown> };
      expect(visible.draft_version).toBe(1);
      expect(visible.draft).toMatchObject({
        version: 1, base_revision: f.candidate.base_revision,
        approved_scope: f.candidate.plan.scope, approved_unlocks: [], activities: [activity],
        plan_details: {}, routes: [], extras: {},
      });
      expect(visible.draft).not.toHaveProperty('plan_details.scope');
      const content = read.content.find(item => item.type === 'text');
      expect(content?.type).toBe('text');
      expect(JSON.parse((content as { type: 'text'; text: string }).text).draft).toEqual(visible.draft);
      expect(readPayload()).toBe(payloadBeforeRead);
      expect(db.prepare('SELECT count(*) AS n FROM agent_operations').get()).toEqual(operationCountBeforeRead);
      expect(db.prepare('SELECT count(*) AS n FROM agent_candidates WHERE candidate_id=?').get('c:' + sessionId)).toEqual(candidateCountBeforeRead);
      expect(db.prepare('SELECT * FROM day_assignments WHERE day_id=? ORDER BY order_index').all(f.day)).toEqual(assignmentsBeforeRead);

      const { activities: _activities, ...details } = f.candidate.plan;
      bound.call_id = 'apply-explicit-scope';
      const updated = await harness.client.callTool({ name: 'apply_trip_draft_changes', arguments: {
        base_version: 1, changes: [{ op: 'set_plan_details', details }], message: '明确设置计划范围',
      }, _meta: f.ctx.requestMeta });
      expect(updated.isError).not.toBe(true);
      expect((updated.structuredContent as { draft_version: number }).draft_version).toBe(2);

      bound.call_id = 'save-after-explicit-scope';
      const saved = await harness.client.callTool({ name: 'save_trip_draft_candidate', arguments: { draft_version: 2 }, _meta: f.ctx.requestMeta });
      expect(saved.isError).not.toBe(true);
      const candidate = service.get('c:' + sessionId, 3, f.user);
      expect(candidate.plan.scope).toEqual(details.scope);
      expect(candidate.plan.activities).toEqual([activity]);
      expect(candidate.adopted_at).toBeNull();
      expect(db.prepare('SELECT * FROM day_assignments WHERE day_id=? ORDER BY order_index').all(f.day)).toEqual(assignmentsBeforeRead);
    } finally { await harness.cleanup(); }
  });

  it('returns a structured plan validation MCP error without writes, then saves after explicit evidence repair', async () => {
    const f = draftFixture();
    const bound = f.ctx.requestMeta!['io.liketrek.agent'] as Record<string, unknown>;
    bound.runtime = 'pi-durable';
    const sessionId = String(bound.session_id);
    const candidateId = 'c:' + sessionId;
    const { activities, ...details } = f.candidate.plan;
    const { evidence: _evidence, ...incompleteDetails } = details;
    const invalidInput = draftChangesSchema.parse({ ...f.input,
      changes: f.input.changes.map(change => change.op === 'set_plan_details'
        ? { ...change, details: incompleteDetails } : change),
    });
    const expectedValidation = agentPlanSchema.safeParse({ ...incompleteDetails, activities,
      extensions: { ...incompleteDetails.extensions, route_source_ids: [], transport_legs: [], native_operations: [] },
    });
    expect(expectedValidation.success).toBe(false);
    if (expectedValidation.success) throw new Error('Expected the incomplete plan to fail its schema');

    const readDraftPayload = () => (db.prepare('SELECT payload FROM agent_drafts WHERE session_id=?')
      .get(sessionId) as { payload: string }).payload;
    const candidateCount = () => db.prepare('SELECT count(*) AS n FROM agent_candidates WHERE candidate_id=?')
      .get(candidateId) as { n: number };
    const formalAssignments = db.prepare('SELECT * FROM day_assignments WHERE day_id=? ORDER BY order_index').all(f.day);
    const registry = createTestRegistry([module.get(AgentMcp)], { accessPolicy: () => true });
    const harness = await createAttachHarness(registry, { userId: f.user });
    try {
      bound.call_id = 'apply-invalid-plan';
      const applied = await harness.client.callTool({ name: 'apply_trip_draft_changes', arguments: invalidInput, _meta: f.ctx.requestMeta });
      expect(applied.isError).not.toBe(true);
      expect((applied.structuredContent as { draft_version: number }).draft_version).toBe(1);
      const draftBeforeFailedSave = readDraftPayload();
      const operationsBeforeFailedSave = db.prepare('SELECT count(*) AS n FROM agent_operations').get() as { n: number };
      const candidatesBeforeFailedSave = candidateCount();

      bound.call_id = 'save-invalid-plan';
      const failed = await harness.client.callTool({ name: 'save_trip_draft_candidate', arguments: { draft_version: 1 }, _meta: f.ctx.requestMeta });
      expect(failed.isError).toBe(true);
      const failureText = failed.content.find(item => item.type === 'text');
      expect(failureText?.type).toBe('text');
      const failure = JSON.parse((failureText as { type: 'text'; text: string }).text);
      expect(failure).toEqual({ error: 'DRAFT_PLAN_INVALID', draft_version: 1, issues: expectedValidation.error.issues });
      expect(readDraftPayload()).toBe(draftBeforeFailedSave);
      expect(db.prepare('SELECT count(*) AS n FROM agent_operations').get()).toEqual(operationsBeforeFailedSave);
      expect(candidateCount()).toEqual(candidatesBeforeFailedSave);
      expect(db.prepare('SELECT * FROM day_assignments WHERE day_id=? ORDER BY order_index').all(f.day)).toEqual(formalAssignments);

      bound.call_id = 'apply-explicit-evidence-repair';
      const repaired = await harness.client.callTool({ name: 'apply_trip_draft_changes', arguments: {
        base_version: 1, changes: [{ op: 'set_plan_details', details }], message: '显式修复计划依据',
      }, _meta: f.ctx.requestMeta });
      expect(repaired.isError).not.toBe(true);
      expect((repaired.structuredContent as { draft_version: number }).draft_version).toBe(2);

      bound.call_id = 'save-repaired-plan';
      const saved = await harness.client.callTool({ name: 'save_trip_draft_candidate', arguments: { draft_version: 2 }, _meta: f.ctx.requestMeta });
      expect(saved.isError).not.toBe(true);
      const candidate = service.get(candidateId, 3, f.user);
      expect(candidate.plan.evidence).toEqual(details.evidence);
      expect(candidate.adopted_at).toBeNull();
      expect(candidateCount().n).toBe(1);
      expect(db.prepare('SELECT * FROM day_assignments WHERE day_id=? ORDER BY order_index').all(f.day)).toEqual(formalAssignments);
    } finally { await harness.cleanup(); }
  });

  it('saves a C draft with unverified sources and unresolved constraints without legacy quality checks', () => {
    const f = draftFixture();
    const bound = f.ctx.requestMeta!['io.liketrek.agent'] as Record<string, unknown>;
    bound.runtime = 'pi-durable'; bound.call_id = 'apply-native';
    const { activities, ...details } = f.candidate.plan;
    const activity = { ...activities[0]!, existing_place_id: null, evidence_ids: ['unverified-source'] };
    f.drafts.apply(draftChangesSchema.parse({ ...f.input, changes: [
      { op: 'upsert_activity', activity },
      { op: 'set_plan_details', details: { ...details,
        evidence: [{ source_id:'unverified-source', claim:'Unverified fixture claim', excerpt:'' }],
        constraints: [{ kind:'hard', description:'Not researched yet', status:'unknown', explanation:'Pending research' }] } },
    ] }), f.ctx);
    bound.call_id = 'save-native';
    expect(() => f.drafts.saveCandidate(1, f.ctx)).not.toThrow();
    const saved = service.get('c:' + bound.session_id, 2, f.user);
    expect(saved.plan.activities[0]!.evidence_ids).toEqual(['unverified-source']);
    expect(saved.plan.constraints[0]!.status).toBe('unknown');
    bound.call_id = 'stale-native';
    expect(() => f.drafts.saveCandidate(0, f.ctx)).toThrow();
  });
  it('preserves omitted activity and plan fields through partial MCP updates', () => {
    const f = draftFixture();
    const bound = f.ctx.requestMeta!['io.liketrek.agent'] as Record<string, unknown>;
    bound.receipts = [{ seq: 1, kind: 'tool_result', payload: { call_id: 'place', success: true } }];
    const activity = { ...f.candidate.plan.activities[0], existing_place_id: null,
      currency: 'USD', transport_mode: 'driving', notes: 'Keep transfer instructions', evidence_ids: ['tool:place'] };
    const { activities: _activities, ...details } = f.candidate.plan;
    f.drafts.apply(draftChangesSchema.parse({ ...f.input, changes: [
      { op: 'upsert_activity', activity },
      { op: 'set_plan_details', details: { ...details,
        extensions: { custom_detail: 'Keep detail' }, evidence: [{ source_id: 'tool:place', claim: 'Located', excerpt: '' }] } },
    ] }), f.ctx);
    bound.call_id = 'partial-update';
    const patch = draftChangesSchema.parse({ base_version: 1, changes: [
      { op: 'patch_activity', ref: 'new-stop', fields: { start_time: '14:15' } },
      { op: 'set_plan_details', details: { explanation: 'Updated explanation' } },
    ] });
    f.drafts.apply(patch, f.ctx);
    const read = () => JSON.parse((db.prepare('SELECT payload FROM agent_drafts WHERE session_id=?')
      .get('draft-session-' + f.trip) as { payload: string }).payload);
    expect(read().activities[0]).toEqual({ ...activity, start_time: '14:15' });
    expect(read().plan_details.extensions).toEqual({ custom_detail: 'Keep detail' });
    expect(read().plan_details.explanation).toBe('Updated explanation');
    bound.call_id = 'explicit-clear';
    f.drafts.apply(draftChangesSchema.parse({ base_version: 2, changes: [
      { op: 'patch_activity', ref: 'new-stop', fields: { notes: '', cost: null } },
      { op: 'set_plan_details', details: { extensions: {} } },
    ] }), f.ctx);
    expect(read().activities[0]).toMatchObject({ notes: '', cost: null, currency: 'USD', transport_mode: 'driving', evidence_ids: ['tool:place'] });
    expect(read().plan_details.extensions).toEqual({});
  });
  it('rolls back the entire batch, preserves versions and rejects stale updates', () => {
    const f = draftFixture();
    const bad = draftChangesSchema.parse({ ...f.input, changes: [...f.input.changes, { op: 'remove_activity', ref: 'missing' }] });
    expect(() => f.drafts.apply(bad, f.ctx)).toThrow();
    const row = db.prepare('SELECT payload FROM agent_drafts WHERE session_id=?').get('draft-session-' + f.trip) as { payload: string };
    expect(JSON.parse(row.payload).activities).toEqual([]);
    const result = f.drafts.apply(f.input, f.ctx);
    expect(f.drafts.apply(f.input, f.ctx)).toEqual(result);
    const bound = f.ctx.requestMeta!['io.liketrek.agent'] as Record<string, unknown>;
    bound.call_id = 'another-call';
    expect(() => f.drafts.apply(f.input, f.ctx)).toThrow();
    expect(f.drafts.validate(1, f.ctx).structuredContent.valid).toBe(true);
    const formal = db.prepare('SELECT id FROM day_assignments WHERE day_id=?').all(f.day);
    expect(formal).toHaveLength(3);
  });
  it('checks fixed bookings and unknown hard constraints on the selected version', () => {
    const f = draftFixture();
    f.drafts.apply(f.input, f.ctx);
    db.prepare('UPDATE day_assignments SET reservation_status=? WHERE id=?').run('confirmed', f.activities[1]);
    const result = f.drafts.validate(1, f.ctx).structuredContent;
    expect(result.valid).toBe(false);
    expect(result.checks).toEqual(expect.arrayContaining([expect.objectContaining({ rule: 'scope_and_locks', status: 'fail' })]));
  });
  it('restores a page edit while invalidating prior validation and retaining original data', () => {
    const f = draftFixture();
    const baseline = { activities: f.candidate.plan.activities, plan: f.candidate.plan, validated: true, routes: ['tool:route'] };
    const preview = f.drafts.previewPageEdit(baseline, { patches: [{ ref: 'new-stop', name: 'Edited on page' }], remove_refs: [] });
    expect(preview.validated).toBe(false);
    expect(preview.activities[0]!.name).toBe('Edited on page');
    expect(baseline.activities[0]!.name).toBe('Replacement');
    expect(() => f.drafts.previewPageEdit(baseline, { patches: [{ ref: 'new-stop', evidence_ids: ['made-up'] }], remove_refs: [] })).toThrow();
  });
  it('requires direction-specific routes and sufficient transfer buffers', () => {
    const f = draftFixture();
    const origin = { latitude: 36.1, longitude: 120.1, coordinate_system: 'WGS84' };
    const destination = { latitude: 36.12, longitude: 120.12, coordinate_system: 'WGS84' };
    const binding = f.ctx.requestMeta!['io.liketrek.agent'] as Record<string, unknown>;
    const route = { seq: 2, kind: 'tool_result', payload: { name: 'query_routes', remote_name: 'query_routes', call_id: 'route', success: true, original: { result: { duration_s: 1800 } } } };
    binding.receipts = [{ seq: 1, kind: 'tool_call', payload: { call_id: 'route', arguments: { origin: destination, destination: origin, mode: 'walking' } } }, route];
    const first = f.candidate.plan.activities[0]!;
    const input = draftChangesSchema.parse({ ...f.input, changes: [...f.input.changes,
      { op: 'upsert_activity', activity: { ...first, ...destination, ref: 'next', start_time: '16:00', end_time: '16:30' } },
      { op: 'set_routes', source_ids: ['tool:route'] }] });
    f.drafts.apply(input, f.ctx);
    expect(f.drafts.validate(1, f.ctx).structuredContent.valid).toBe(false);
    binding.receipts = [{ seq: 1, kind: 'tool_call', payload: { call_id: 'route', arguments: { origin, destination, mode: 'walking' } } }, route];
    expect(f.drafts.validate(1, f.ctx).structuredContent.valid).toBe(true);
    route.payload.original.result.duration_s = 3600;
    expect(f.drafts.validate(1, f.ctx).structuredContent.valid).toBe(false);
    expect(db.prepare('SELECT count(*) AS n FROM agent_draft_outbox WHERE session_id=?').get('draft-session-' + f.trip)).toMatchObject({ n: 3 });
  });
  it('receives isolated binding metadata through actual MCP tool calls', async () => {
    const f = draftFixture();
    const registry = createTestRegistry([module.get(AgentMcp)], { accessPolicy: () => true });
    const harness = await createAttachHarness(registry, { userId: f.user });
    try {
      const result = await harness.client.callTool({ name: 'apply_trip_draft_changes', arguments: f.input, _meta: f.ctx.requestMeta });
      expect(result.isError).not.toBe(true);
      expect((result.structuredContent as { draft_version: number }).draft_version).toBe(1);
      const withoutContext = await harness.client.callTool({ name: 'validate_trip_draft', arguments: { draft_version: 1 } });
      expect(withoutContext.isError).toBe(true);
    } finally { await harness.cleanup(); }
  });
  it('saves a Durable draft without review and checks page versions before adoption', async () => {
    const f = draftFixture();
    const bound = f.ctx.requestMeta!['io.liketrek.agent'] as Record<string, unknown>;
    bound.runtime = 'pi-durable'; bound.call_id = 'apply-c';
    f.drafts.apply(f.input, f.ctx);
    const outboxBefore = db.prepare('SELECT count(*) AS n FROM agent_draft_outbox WHERE session_id=?').get(bound.session_id);
    const registry = createTestRegistry([module.get(AgentMcp)], { accessPolicy: () => true });
    const harness = await createAttachHarness(registry, { userId: f.user });
    try {
      bound.call_id = 'save-c';
      const saved = await harness.client.callTool({ name: 'save_trip_draft_candidate', arguments: { draft_version: 1 }, _meta: f.ctx.requestMeta });
      expect(saved.isError).not.toBe(true);
      const candidate = service.get('c:' + bound.session_id, 2, f.user);
      expect(candidate).toMatchObject({ runtime: 'pi-durable', session_id: bound.session_id, candidate_version: 2 });
      expect(candidate.review).toBeUndefined();
      expect(db.prepare('SELECT id FROM day_assignments WHERE day_id=?').all(f.day)).toHaveLength(3);
      const edited = f.drafts.editPage(String(bound.session_id), f.user, { base_version: 1,
        patches: [{ ref: 'new-stop', name: '页面调整后的安排' }], remove_refs: [] });
      expect(edited.version).toBe(2); expect(edited.validated).toBe(false);
      bound.call_id = 'stale-c';
      const stale = await harness.client.callTool({ name: 'save_trip_draft_candidate', arguments: { draft_version: 1 }, _meta: f.ctx.requestMeta });
      expect(stale.isError).toBe(true);
      bound.call_id = 'save-edited-c';
      const latest = await harness.client.callTool({ name: 'save_trip_draft_candidate', arguments: { draft_version: 2 }, _meta: f.ctx.requestMeta });
      expect(latest.isError).not.toBe(true);
      service.adopt('c:' + bound.session_id, 3, 'adopt-c-' + f.trip, f.user);
      expect(db.prepare('SELECT count(*) AS n FROM agent_draft_outbox WHERE session_id=?').get(bound.session_id)).toEqual(outboxBefore);
    } finally { await harness.cleanup(); }
  });
  it('binds rail travel to verified stations and times without demanding a road substitute', () => {
    const f=draftFixture(); const bound=f.ctx.requestMeta!['io.liketrek.agent'] as Record<string,unknown>;
    const first={...f.candidate.plan.activities[0]!,name:'出发站',notes:'候车',existing_place_id:null,evidence_ids:['tool:stations'],end_time:'14:15'};
    const next={...first,ref:'arrival',name:'到达站',longitude:122.1,start_time:'15:45',end_time:'16:00',transport_mode:'transit',notes:'出站'};
    const leg={from_ref:first.ref,to_ref:next.ref,mode:'train',source_id:'tool:rail',train_code:'C1234',from_station:'出发',to_station:'到达',date:'2026-10-01',departure_time:'14:35',arrival_time:'15:35'};
    bound.receipts=[
      {seq:1,kind:'tool_result',payload:{name:'query_places',call_id:'stations',success:true,original:{coordinate_system:'WGS84',result:{items:[{name:'出发站',latitude:first.latitude,longitude:first.longitude},{name:'到达站',latitude:next.latitude,longitude:next.longitude}]}}}},
      {seq:2,kind:'tool_result',payload:{name:'query_transport',call_id:'rail',success:true,original:{result:{date:leg.date,items:[{train_code:leg.train_code,from_station:'出发',to_station:'到达',start_time:leg.departure_time,arrive_time:leg.arrival_time}]}}}},
    ];
    const {activities:_a,...details}=f.candidate.plan;
    f.drafts.apply(draftChangesSchema.parse({...f.input,changes:[{op:'upsert_activity',activity:first},{op:'upsert_activity',activity:next},
      {op:'set_plan_details',details:{...details,evidence:[{source_id:'tool:stations',claim:'车站',excerpt:''},{source_id:'tool:rail',claim:'车次',excerpt:''}]}},
      {op:'set_transport_legs',legs:[leg]}]}),f.ctx);
    expect(f.drafts.validate(1,f.ctx).structuredContent.valid).toBe(true);
    bound.call_id='wrong-train';
    f.drafts.apply(draftChangesSchema.parse({base_version:1,changes:[{op:'set_transport_legs',legs:[{...leg,train_code:'G9999'}]}]}),f.ctx);
    expect(f.drafts.validate(2,f.ctx).structuredContent.valid).toBe(false);
    bound.call_id='wrong-mode';
    f.drafts.apply(draftChangesSchema.parse({base_version:2,changes:[{op:'set_transport_legs',legs:[leg]},{op:'patch_activity',ref:next.ref,fields:{transport_mode:'driving'}}]}),f.ctx);
    expect(f.drafts.validate(3,f.ctx).structuredContent.valid).toBe(false);
    bound.call_id='missing-station';
    f.drafts.apply(draftChangesSchema.parse({base_version:3,changes:[{op:'patch_activity',ref:next.ref,fields:{transport_mode:'transit'}},{op:'set_transport_legs',legs:[{...leg,to_station:'另一站'}]}]}),f.ctx);
    expect(f.drafts.validate(4,f.ctx).structuredContent.valid).toBe(false);
  });
  it('rejects a train hidden in a departure stop even if a driving transfer exists', () => {
    const f=draftFixture();
    const input=draftChangesSchema.parse({...f.input,changes:[...f.input.changes,{op:'patch_activity',ref:'new-stop',fields:{name:'青岛站乘C6496高铁'}}]});
    f.drafts.apply(input,f.ctx);
    expect(f.drafts.validate(1,f.ctx).structuredContent.checks).toEqual(expect.arrayContaining([expect.objectContaining({rule:'rail_legs',status:'fail'})]));
  });
  it('materializes a queried hotel through a draft place reference only on adoption', () => {
    const f=draftFixture(); const bound=f.ctx.requestMeta!['io.liketrek.agent'] as Record<string,unknown>;
    bound.receipts=[{seq:1,kind:'tool_result',payload:{name:'query_venues',call_id:'hotel',success:true,original:{coordinate_system:'WGS84',result:{items:[{name:'查得的酒店',latitude:36.1,longitude:120.1}]}}}}];
    const activity={...f.candidate.plan.activities[0]!,existing_place_id:null,name:'查得的酒店',evidence_ids:['tool:hotel']};
    const {activities:_a,...details}=f.candidate.plan;
    const input=draftChangesSchema.parse({...f.input,changes:[{op:'upsert_activity',activity},
      {op:'set_plan_details',details:{...details,evidence:[{source_id:'tool:hotel',claim:'酒店位置',excerpt:''}]}},
      {op:'upsert_accommodation',ref:'stay',place_ref:activity.ref,start_day_id:f.day,end_day_id:f.day,notes:'靠近活动区域；房态未知，未预订'}]});
    f.drafts.apply(input,f.ctx); expect(f.drafts.validate(1,f.ctx).structuredContent.valid).toBe(true);
    const draft=JSON.parse((db.prepare('SELECT payload FROM agent_drafts WHERE session_id=?').get('draft-session-'+f.trip) as {payload:string}).payload);
    f.candidate.plan=draft.plan; f.candidate.review.plan_hash=digest(draft.plan);
    const before=db.prepare('SELECT count(*) AS n FROM places WHERE trip_id=?').get(f.trip);
    service.save(f.user,f.candidate); expect(db.prepare('SELECT count(*) AS n FROM places WHERE trip_id=?').get(f.trip)).toEqual(before);
    service.adopt(f.candidate.candidate_id,1,'adopt-stay-'+f.trip,f.user);
    const stay=db.prepare('SELECT p.name,r.status FROM day_accommodations a JOIN places p ON p.id=a.place_id JOIN reservations r ON r.accommodation_id=a.id WHERE a.trip_id=?').get(f.trip);
    expect(stay).toMatchObject({name:'查得的酒店',status:'pending'});
  });
  it('rejects an accommodation name borrowed from unrelated query evidence', () => {
    const f=draftFixture(); const bound=f.ctx.requestMeta!['io.liketrek.agent'] as Record<string,unknown>;
    bound.receipts=[{seq:1,kind:'tool_result',payload:{name:'query_venues',call_id:'hotel',success:true,original:{coordinate_system:'WGS84',result:{items:[{name:'真实酒店',latitude:36.1,longitude:120.1}]}}}}];
    const first={...f.candidate.plan.activities[0]!,name:'编造酒店',existing_place_id:null,evidence_ids:['tool:hotel']};
    const {activities:_a,...details}=f.candidate.plan;
    f.drafts.apply(draftChangesSchema.parse({...f.input,changes:[{op:'upsert_activity',activity:first},
      {op:'set_plan_details',details:{...details,evidence:[{source_id:'tool:hotel',claim:'酒店',excerpt:''}]}},
      {op:'upsert_accommodation',ref:'stay',place_ref:first.ref,start_day_id:f.day,end_day_id:f.day}]}),f.ctx);
    expect(f.drafts.validate(1,f.ctx).structuredContent.checks).toEqual(expect.arrayContaining([expect.objectContaining({rule:'accommodation_sources',status:'fail'})]));
  });
});
beforeAll(async () => {
  module = await Test.createTestingModule({ imports: [AgentModule] }).compile();
  await module.init();
  service = module.get(AgentService);
});
afterAll(async () => { await module.close(); });

function fixture() {
  const suffix = String(++count);
  const user = Number(db.prepare('INSERT INTO users(username,email,password_hash,role) VALUES(?,?,?,?)').run('agent-test-' + suffix, 'agent-test-' + suffix + '@example.invalid', 'test', 'admin').lastInsertRowid);
  const trip = Number(db.prepare('INSERT INTO trips(user_id,title,currency) VALUES(?,?,?)').run(user, 'Local segment acceptance', 'CNY').lastInsertRowid);
  const day = Number(db.prepare('INSERT INTO days(trip_id,day_number,date) VALUES(?,?,?)').run(trip, 1, '2026-10-01').lastInsertRowid);
  const activities = ['Morning', 'Afternoon', 'Dinner'].map((name, index) => {
    const place = Number(db.prepare('INSERT INTO places(trip_id,name,lat,lng) VALUES(?,?,?,?)').run(trip, name, 36 + index / 100, 120).lastInsertRowid);
    return Number(db.prepare('INSERT INTO day_assignments(day_id,place_id,order_index,notes) VALUES(?,?,?,?)').run(day, place, index, 'preserve-' + name).lastInsertRowid);
  });
  const plan: AgentSave['plan'] = {
    goal: 'Replace afternoon only',
    scope: { description: 'Afternoon segment', segments: [{ ref: 'afternoon', day_id: day, day_number: 1, replace_assignment_ids: [activities[1]!], insert_after_assignment_id: activities[0]!, start_time: '13:00', end_time: '17:00', description: 'Afternoon only' }] },
    activities: [{ ref: 'new-stop', scope_ref: 'afternoon', name: 'Replacement', day_number: 1, start_time: '14:00', end_time: '15:00', currency: 'CNY', coordinate_system: 'WGS84', latitude: 36.1, longitude: 120.1, transport_mode: 'walking', notes: 'candidate-only', evidence_ids: [] }],
    constraints: [], evidence: [], tradeoffs: [], unknowns: [], explanation: 'Test-only fixture', extensions: {},
  };
  const revision = service.snapshot(trip, user).revision;
  const candidate: AgentSave & { review: NonNullable<AgentSave['review']> } = {
    operation_id: 'save-' + suffix, candidate_id: 'candidate-' + suffix, candidate_version: 1, trip_id: trip, task_id: 'test-' + suffix,
    base_revision: revision, input_revision: 1, approved_unlocks: [], plan,
    review: { candidate_id: 'candidate-' + suffix, candidate_version: 1, plan_hash: digest(plan), base_revision: revision, verdict: 'pass', reasons: ['fixture'], question: '', critical_unknowns: [] },
  };
  return { user, trip, day, activities, candidate };
}

describe('Reviewed local candidates', () => {
  it('saves without changing formal assignments, then atomically replaces only the selected segment', () => {
    const f = fixture();
    const before = db.prepare('SELECT * FROM day_assignments WHERE day_id=? ORDER BY order_index').all(f.day);
    const saved = service.save(f.user, f.candidate);
    expect(service.save(f.user, f.candidate)).toEqual(saved);
    expect(db.prepare('SELECT * FROM day_assignments WHERE day_id=? ORDER BY order_index').all(f.day)).toEqual(before);
    const adopted = service.adopt(f.candidate.candidate_id, 1, 'adopt-' + f.trip, f.user);
    expect(service.adopt(f.candidate.candidate_id, 1, 'adopt-' + f.trip, f.user)).toEqual(adopted);
    const after = db.prepare('SELECT * FROM day_assignments WHERE day_id=? ORDER BY order_index').all(f.day) as Record<string, unknown>[];
    expect(after).toHaveLength(3);
    expect(after[0]).toEqual(before[0]);
    expect(after[2]).toEqual(before[2]);
    expect(after[1]!.id).not.toBe(f.activities[1]);
    expect(after[1]!.notes).toBe('candidate-only');
  });

  it('rejects manual changes made after review, including changes outside the selected segment', () => {
    const f = fixture();
    service.save(f.user, f.candidate);
    db.prepare('UPDATE day_assignments SET notes=? WHERE id=?').run('manually edited morning', f.activities[0]);
    expect(() => service.adopt(f.candidate.candidate_id, 1, 'adopt-' + f.trip, f.user)).toThrow();
    expect(db.prepare('SELECT id FROM day_assignments WHERE day_id=?').all(f.day)).toHaveLength(3);
  });

  it('protects confirmed bookings and explicitly locked arrangements', () => {
    const f = fixture();
    db.prepare('INSERT INTO reservations(trip_id,day_id,assignment_id,title,status,type) VALUES(?,?,?,?,?,?)').run(f.trip, f.day, f.activities[1], 'Booked visit', 'confirmed', 'activity');
    f.candidate.base_revision = service.snapshot(f.trip, f.user).revision;
    f.candidate.review.base_revision = f.candidate.base_revision;
    expect(() => service.save(f.user, f.candidate)).toThrow();
    f.candidate.approved_unlocks = ['assignment:' + f.activities[1]];
    expect(service.save(f.user, f.candidate).status).toBe('saved');
  });

  it('rejects a review of different content and unresolved hard constraints', () => {
    const f = fixture();
    f.candidate.plan.activities[0]!.name = 'Changed after review';
    expect(() => service.save(f.user, f.candidate)).toThrow();
    f.candidate.review.plan_hash = digest(f.candidate.plan);
    f.candidate.plan.constraints = [{ description: 'Must catch train', kind: 'hard', status: 'unknown', explanation: 'Travel time missing' }];
    f.candidate.review.plan_hash = digest(f.candidate.plan);
    expect(() => service.save(f.user, f.candidate)).toThrow();
  });

  it('keeps a confirmed reservation linked when its explicitly unlocked assignment changes time at the same place', () => {
    const f = fixture();
    const row = db.prepare('SELECT place_id FROM day_assignments WHERE id=?').get(f.activities[1]) as { place_id: number };
    const reservation = Number(db.prepare('INSERT INTO reservations(trip_id,day_id,assignment_id,title,status,type) VALUES(?,?,?,?,?,?)').run(f.trip, f.day, f.activities[1], 'Booked visit', 'confirmed', 'activity').lastInsertRowid);
    f.candidate.plan.activities[0]!.existing_place_id = row.place_id;
    f.candidate.approved_unlocks = ['assignment:' + f.activities[1]];
    f.candidate.base_revision = service.snapshot(f.trip, f.user).revision;
    f.candidate.review.base_revision = f.candidate.base_revision;
    f.candidate.review.plan_hash = digest(f.candidate.plan);
    service.save(f.user, f.candidate);
    const result = service.adopt(f.candidate.candidate_id, 1, 'adopt-' + f.trip, f.user);
    expect(result.assignment_ids).toContain(f.activities[1]);
    expect(db.prepare('SELECT assignment_id,status FROM reservations WHERE id=?').get(reservation)).toEqual({ assignment_id: f.activities[1], status: 'confirmed' });
    expect(db.prepare('SELECT assignment_time FROM day_assignments WHERE id=?').get(f.activities[1])).toEqual({ assignment_time: '14:00' });
  });

  it('rejects an anchor or assignment from another day and conflicting operation reuse', () => {
    const f = fixture();
    const other = fixture();
    f.candidate.plan.scope.segments[0]!.insert_after_assignment_id = other.activities[0]!;
    f.candidate.review.plan_hash = digest(f.candidate.plan);
    expect(() => service.save(f.user, f.candidate)).toThrow();
    f.candidate.plan.scope.segments[0]!.insert_after_assignment_id = f.activities[0]!;
    f.candidate.review.plan_hash = digest(f.candidate.plan);
    service.save(f.user, f.candidate);
    expect(() => service.save(f.user, { ...f.candidate, candidate_id: 'different' })).toThrow();
  });
});
