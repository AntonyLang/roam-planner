import { z } from 'zod';

const id = z.string().min(1).max(128);
const positiveId = z.number().int().positive();
const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
export const agentSegmentSchema = z.strictObject({
  ref: id,
  day_id: positiveId,
  day_number: positiveId,
  replace_assignment_ids: z.array(positiveId),
  insert_after_assignment_id: positiveId.nullable(),
  start_time: clock.nullable(),
  end_time: clock.nullable(),
  description: z.string().min(1),
}).superRefine((segment, ctx) => {
  if (new Set(segment.replace_assignment_ids).size !== segment.replace_assignment_ids.length)
    ctx.addIssue({ code: 'custom', message: 'Replacement assignment ids must be unique' });
  if (segment.insert_after_assignment_id !== null && segment.replace_assignment_ids.includes(segment.insert_after_assignment_id))
    ctx.addIssue({ code: 'custom', message: 'Insertion anchor must be preserved' });
  if (segment.start_time && segment.end_time && segment.end_time <= segment.start_time)
    ctx.addIssue({ code: 'custom', message: 'Segment must remain within one day' });
});
export const agentScopeSchema = z.strictObject({
  segments: z.array(agentSegmentSchema).min(1),
  description: z.string().min(1),
});
export const agentConstraintSchema = z.object({
  description: z.string().min(1), kind: z.enum(['hard', 'soft']),
  status: z.enum(['satisfied', 'violated', 'unknown']), explanation: z.string(),
});
export const agentEvidenceSchema = z.object({
  source_id: id, claim: z.string(), excerpt: z.string(),
  url: z.string().optional().nullable(), observed_at: z.string().optional().nullable(),
  limitations: z.string().default(''),
});
export const agentActivitySchema = z.object({
  ref: id, name: z.string().min(1).max(200), day_number: z.number().int().positive(),
  scope_ref: id,
  existing_place_id: z.number().int().positive().optional().nullable(),
  start_time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional().nullable().describe('本活动在该地点开始的时间；与前一活动结束之间须留出实际转场和等候余量，不能把路上时间计入本活动。未知时省略或null。'),
  end_time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional().nullable().describe('本活动在该地点结束的时间；未知时省略或null。到机场的目标时间不等于航班起飞时间，未定航班不能编造结束时刻。'),
  duration_minutes: z.number().int().nonnegative().optional().nullable(),
  cost: z.number().nonnegative().optional().nullable().describe('本活动全部同行者合计的预计费用，不是人均价。人均单价、人数和计算依据写在notes，未知时省略；正式预算条目独立管理。'), currency: z.string().length(3).default('CNY'),
  latitude: z.number().min(-90).max(90).optional().nullable(),
  longitude: z.number().min(-180).max(180).optional().nullable(),
  coordinate_system: z.enum(['WGS84', 'GCJ02']).optional().nullable(),
  address: z.string().optional().nullable(), transport_mode: z.enum(['walking', 'transit', 'driving']).default('walking').describe('从前一活动到达本活动的交通方式：walking步行；transit公交、地铁或跨城铁路/航段；driving驾车或打车。须与实际选用的query_routes.mode一致；铁路和航段另用set_transport_legs表示，不用公路路线代替。'),
  notes: z.string().default(''), evidence_ids: z.array(id).default([]),
});
export const agentPlanSchema = z.object({
  goal: z.string().min(1),
  scope: agentScopeSchema,
  activities: z.array(agentActivitySchema), constraints: z.array(agentConstraintSchema),
  evidence: z.array(agentEvidenceSchema), tradeoffs: z.array(z.string()),
  unknowns: z.array(z.string()), explanation: z.string(),
  extensions: z.record(z.string(), z.unknown()).default({}),
}).superRefine((plan, ctx) => {
  const refs = plan.activities.map(a => a.ref);
  if (new Set(refs).size !== refs.length) ctx.addIssue({ code: 'custom', message: 'Activity refs must be unique' });
  const segmentRefs = plan.scope.segments.map(s => s.ref);
  if (new Set(segmentRefs).size !== segmentRefs.length) ctx.addIssue({ code: 'custom', message: 'Scope refs must be unique' });
  const replaced = plan.scope.segments.flatMap(s => s.replace_assignment_ids);
  if (new Set(replaced).size !== replaced.length) ctx.addIssue({ code: 'custom', message: 'An assignment can only be replaced once' });
  const evidenceIds = new Set(plan.evidence.map(e => e.source_id));
  for (const a of plan.activities) {
    const segment = plan.scope.segments.find(s => s.ref === a.scope_ref);
    if (!segment || segment.day_number !== a.day_number) ctx.addIssue({ code: 'custom', message: 'Activity outside scope' });
    if (segment?.start_time && a.start_time && a.start_time < segment.start_time) ctx.addIssue({ code: 'custom', message: 'Activity starts outside selected window' });
    if (segment?.end_time && a.end_time && a.end_time > segment.end_time) ctx.addIssue({ code: 'custom', message: 'Activity ends outside selected window' });
    if (a.evidence_ids.some(e => !evidenceIds.has(e))) ctx.addIssue({ code: 'custom', message: 'Activity refers to missing evidence' });
    if ((a.latitude == null) !== (a.longitude == null)) ctx.addIssue({ code: 'custom', message: 'Coordinates must be a pair' });
    if (a.latitude != null && !a.coordinate_system) ctx.addIssue({ code: 'custom', message: 'Coordinate system required' });
    if (a.start_time && a.end_time && a.end_time <= a.start_time) ctx.addIssue({ code: 'custom', message: 'Overnight activities require an explicit future extension' });
  }
});
export const agentReviewSchema = z.object({
  candidate_id: id, candidate_version: z.number().int().positive(),
  plan_hash: id, base_revision: id,
  verdict: z.enum(['pass', 'revise', 'ask_user']), reasons: z.array(z.string()),
  question: z.string().default(''),
  critical_unknowns: z.array(z.string()).default([]),
});
export const agentSaveSchema = z.object({
  operation_id: id, candidate_id: id, candidate_version: z.number().int().positive(),
  trip_id: z.number().int().positive(), task_id: id, base_revision: id,
  input_revision: positiveId,
  approved_unlocks: z.array(id).default([]),
  plan: agentPlanSchema, review: agentReviewSchema.optional(),
  runtime: z.literal('pi-durable').optional(), session_id: id.optional(),
}).superRefine((data, ctx) => {
  if (!data.review && data.runtime !== 'pi-durable')
    ctx.addIssue({ code: 'custom', message: 'Passing review is required for the legacy runtime' });
  if (data.review && (data.review.verdict !== 'pass' || data.review.critical_unknowns.length > 0 || data.review.candidate_id !== data.candidate_id || data.review.candidate_version !== data.candidate_version || data.review.base_revision !== data.base_revision))
    ctx.addIssue({ code: 'custom', message: 'Passing review must match candidate identity and version' });
});
export const agentAdoptSchema = z.object({ operation_id: id, candidate_version: z.number().int().positive() });
export const agentConditionsSchema = z.object({ requirements: z.record(z.string(), z.unknown()) });
export type AgentPlan = z.infer<typeof agentPlanSchema>;
export type AgentSave = z.infer<typeof agentSaveSchema>;

export const agentDraftEditSchema = z.object({
  base_seq: positiveId,
  patches: z.array(z.record(z.string(),z.unknown())).max(100).default([]),
  remove_refs: z.array(id).max(100).default([]),
  order: z.array(id).max(200).optional(),
});

export const agentMessageSchema = z.object({
  request_id: id, session_id: id.optional(), trip_id: z.number().int().positive().optional(),
  engine_id: z.enum(['workflow', 'main']).optional(),
  message: z.string().min(1).max(20000),
  selection: agentScopeSchema.optional(),
  draft_edit: agentDraftEditSchema.optional(),
});
export const agentAnswerSchema = z.object({ request_id: id, decision_id: id, answer: z.string().min(1).max(20000), choice: z.enum(['approve', 'decline']).optional(), answers: z.array(z.object({question_id:z.string().min(1).max(80),option_id:z.string().max(80).nullable().optional(),text:z.string().min(1).max(5000)}).strict()).min(1).max(3).optional() });
export const agentRetrySchema = z.object({ request_id: id, token_limit: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional() });
export const agentChangeSchema = z.object({ request_id: id, session_id: id, trip_id: z.number().int().positive(), changes: z.array(z.record(z.string(), z.unknown())).min(1) });
