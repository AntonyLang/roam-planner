import { McpController, Tool, type McpContext, TOOL_ANNOTATIONS_READONLY, TOOL_ANNOTATIONS_WRITE, ok, errorResult } from '../../nest-mcp';
import { z } from 'zod';
import { agentSaveSchema } from '@trek/shared';
import { AgentService } from './agent.service';
import { HttpException } from '@nestjs/common';
import { AgentDrafts, draftChangesSchema, prepareDraftSchema } from './agent-drafts.service';

@McpController()
export class AgentMcp {
  constructor(private readonly service: AgentService, private readonly drafts: AgentDrafts) {}
  private draftResult(run: () => unknown) {
    try { return run(); }
    catch (error) { return errorResult(error instanceof HttpException ? JSON.stringify(error.getResponse()) : error instanceof Error ? error.message : 'Draft operation failed'); }
  }
  @Tool({ name: 'prepare_trip_draft', description: '按最新旅程 snapshot 的 base_revision 准备或继续当前会话草稿，返回与get_trip_draft同构的可编辑draft，可直接按其version、已有ref和plan_details修改，无需紧接着重复get。修改已采用的安排时，先list_planning_candidates确认adopted_at，使用revise_adopted_candidate恢复正式日程绑定和替换范围，避免再次追加日程或重复预算住宿；新增日期或扩大范围须按用户要求另行准备scope。approved_scope 可为空，approved_unlocks 只填已获用户同意解锁的安排；读取 get_planning_snapshot 后按任务需要调用。', inputSchema: prepareDraftSchema, annotations: { ...TOOL_ANNOTATIONS_WRITE, idempotentHint: true }, access: { group: 'trips', mode: 'write' } })
  prepare(input: z.infer<typeof prepareDraftSchema>, ctx: McpContext) { return this.draftResult(() => this.drafts.prepare(input, ctx)); }
  @Tool({ name: 'apply_trip_draft_changes', description: '把查证和选择落实为用户可见的地点、交通、住宿、用餐和说明；逐批保存草稿并更新地图，不采用正式旅程。upsert_activity修改已有ref时保留其位置，新ref默认追加到活动列表末尾；可选before_ref用于将新活动插到该ref之前，或将已有活动更新后移到该ref之前，必须引用当时草稿中已有的其他活动ref。只需插入或移动一项时使用before_ref；需要指定完整顺序时使用reorder_activities，并传入草稿中全部保留活动ref各一次、不可遗漏或重复，refs数组顺序即活动列表顺序（同一天内决定行程先后）。patch/remove_activity用于地点及时间，set_plan_details用于范围、约束、依据和解释，set_routes只收实际市内转场的路线引用。铁路必须用两个相邻活动表示出发站和到达站、到达站transport_mode=transit；set_transport_legs关联两站ref、铁路source_id、真实站名、日期、车次及出发到达时刻。出发站活动在发车至少20分钟前结束，到达站活动在到达至少10分钟后开始；不要拿公路路线代替列车。upsert_accommodation通过已有place_id或已定位酒店活动place_ref落实住宿日期和理由（两者选一，未预订）；餐馆落实为用餐活动，upsert_note/cost补充说明和费用。操作受base_version约束，冲突时读取当前上下文；改完校验当前版本。', inputSchema: draftChangesSchema, annotations: TOOL_ANNOTATIONS_WRITE, _meta: { 'io.liketrek.agent/phases': ['execute'] }, access: { group: 'trips', mode: 'write' } })
  apply(input: z.infer<typeof draftChangesSchema>, ctx: McpContext) { return this.draftResult(() => this.drafts.apply(input, ctx)); }
  @Tool({ name: 'validate_trip_draft', description: '用于交付前或修改后核对实际草稿，检查时间、交通方式、真实方向转场、铁路车次和站点、费用、来源、范围及固定安排。校验指定draft_version，返回valid、checks和该版本的draft_updated事件seq；成功后提交该seq，避免重写整份方案。版本与依据未变时复用有效回执，不为形式重复校验。关键未知先查证或询问，不能把填写satisfied当成事实。不会采用或改变正式旅程。', inputSchema: { draft_version: z.number().int().nonnegative() }, annotations: TOOL_ANNOTATIONS_READONLY, _meta: { 'io.liketrek.agent/phases': ['execute', 'review'] }, access: { group: 'trips', mode: 'read' } })
  validate({ draft_version }: { draft_version: number }, ctx: McpContext) { return this.draftResult(() => this.drafts.validate(draft_version, ctx)); }
  @Tool({ name: 'get_trip_draft', description: '只读当前会话已准备的可编辑草稿；draft 返回 version、base_revision、approved_scope、approved_unlocks、activities、plan_details、routes、transport_legs 和 extras。用于查看现有活动ref及实际缺失字段，再按当前版本修改；不会保存、校验或采用草稿，也不会补默认范围。', inputSchema: {}, annotations: TOOL_ANNOTATIONS_READONLY, access: { group: 'trips', mode: 'read' } })
  getDraft(_input: Record<string, never>, ctx: McpContext) { return this.draftResult(() => this.drafts.get(ctx)); }
  @Tool({ name: 'save_trip_draft_candidate', description: '将指定版本的实际草稿保存为用户可采用的候选。当前 C 规划直接保存候选，由用户在页面采用。', inputSchema: { draft_version: z.number().int().nonnegative() }, annotations: TOOL_ANNOTATIONS_WRITE, access: { group: 'trips', mode: 'write' } })
  saveDraft({ draft_version }: { draft_version: number }, ctx: McpContext) { return this.draftResult(() => this.drafts.saveCandidate(draft_version, ctx)); }
  @Tool({ name: 'get_planning_snapshot', description: 'Read trip, conditions, days, places, bookings and content revision. Use this before planning or saving.', inputSchema: { trip_id: z.number().int().positive() }, annotations: TOOL_ANNOTATIONS_READONLY, access: { group: 'trips', mode: 'read' } })
  snapshot({ trip_id }: { trip_id: number }, ctx: McpContext) { return ok(this.service.snapshot(trip_id, ctx.userId)); }
  @Tool({ name: 'list_planning_candidates', description: '读取旅程候选列表，默认返回ID、版本、采用时间、目标及活动／日期摘要，便于找到已采用版本供prepare_trip_draft修订。需要比较保存时的完整方案、活动和依据时设include_plan=true，并用candidate_id和candidate_version选择版本；返回的是已保存快照，不是当前可编辑草稿。', inputSchema: {
    trip_id: z.number().int().positive(), include_plan: z.boolean().default(false),
    candidate_id: z.string().min(1).max(128).optional(), candidate_version: z.number().int().positive().optional(),
  }, annotations: TOOL_ANNOTATIONS_READONLY, access: { group: 'trips', mode: 'read' } })
  list({ trip_id, include_plan = false, candidate_id, candidate_version }: {
    trip_id: number; include_plan?: boolean; candidate_id?: string; candidate_version?: number;
  }, ctx: McpContext) {
    const candidates = this.service.list(trip_id, ctx.userId).filter(candidate =>
      (!candidate_id || candidate.candidate_id === candidate_id) && (candidate_version === undefined || candidate.candidate_version === candidate_version));
    return ok({ projection: include_plan ? 'full' : 'summary', candidates: include_plan ? candidates : candidates.map(candidate => ({
      candidate_id: candidate.candidate_id, candidate_version: candidate.candidate_version, trip_id: candidate.trip_id,
      adopted_at: candidate.adopted_at, goal: candidate.plan.goal, activity_count: candidate.plan.activities.length,
      days: candidate.plan.scope.segments.map(segment => ({ day_id: segment.day_id, day_number: segment.day_number })),
    })) });
  }
  @Tool({ name: 'save_planning_candidate', description: 'Save a reviewed candidate only, without adopting it. Fixed policy code calls this with a stable operation_id.', inputSchema: agentSaveSchema, annotations: TOOL_ANNOTATIONS_WRITE, access: { group: 'trips', mode: 'write' } })
  save(input: z.infer<typeof agentSaveSchema>, ctx: McpContext) {
    try { return ok(this.service.save(ctx.userId, input)); }
    catch (error) { return errorResult(error instanceof HttpException ? JSON.stringify(error.getResponse()) : error instanceof Error ? error.message : 'Save failed'); }
  }
}
