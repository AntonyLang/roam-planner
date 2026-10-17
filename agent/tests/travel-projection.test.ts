import test from 'node:test';
import assert from 'node:assert/strict';
import { toLlmContent } from '@earendil-works/pi-mcp';
import { AgentRole, TravelContext } from '../src/documents.ts';
import { invokeTravelMcp } from '../src/extensions/travel.ts';

function fixture() {
  const state = { tripId: 51, inputRevision: 1, receipts: [], draft: null as unknown, candidate: null as unknown };
  const api: any = {
    conversationId: 'session-c6', taskId: 'save-c6-vx',
    snapshot: async (document: unknown) => document === TravelContext ? state : document === AgentRole ? null : undefined,
    commit: async (change: (tx: { doc: () => Promise<typeof state> }) => Promise<void>) => change({ doc: async () => state }),
  };
  return { api, state };
}

const candidate = {
  candidate_id: 'c:session-c6', candidate_version: 4, trip_id: 51, status: 'saved',
  plan: {
    activities: [{ ref: 'old-stop', name: '保存版本里的老地点', start_time: '09:15', end_time: '10:45', cost: 280 }],
    plan_details: { total_cost: 280, currency: 'CNY' },
  },
};

test('successful TREK save projects only model text and preserves the saved version for later list readback', async () => {
  const { api, state } = fixture();
  const savedEvent = { kind: 'candidate_saved', payload: candidate };
  const saveResult = {
    content: [{ type: 'text' as const, text: JSON.stringify(candidate) }],
    structuredContent: candidate,
    _meta: { 'io.liketrek.agent/events': [savedEvent], receipt_marker: 'keep-me' },
  };
  const receiptUpdates: unknown[] = [];
  const saved = await invokeTravelMcp('trek', { name: 'save_trip_draft_candidate' } as any, { draft_version: 3 }, api, {} as any,
    async () => saveResult as any, receipts => { receiptUpdates.push(receipts); });

  assert.equal(saved.output.filter(block => block.type === 'text').map(block => block.type === 'text' ? block.text : '').join('\n'),
    '候选 c:session-c6 v4，状态：saved，待用户在页面采用。\n证据引用：tool:save-c6-vx');
  assert.ok(!saved.output.some(block => block.type === 'text' && block.text.includes('保存版本里的老地点')));
  assert.deepEqual(state.candidate, candidate);
  assert.deepEqual(saveResult.structuredContent, candidate);
  assert.deepEqual(saveResult._meta, { 'io.liketrek.agent/events': [savedEvent], receipt_marker: 'keep-me' });
  assert.deepEqual((saved.details as any).original, candidate);
  assert.deepEqual((saved.details as any).events, [savedEvent]);
  assert.deepEqual(state.receipts.at(-1)?.payload, {
    call_id: 'save-c6-vx', remote_name: 'save_trip_draft_candidate', success: true,
    original: candidate, decoded: candidate,
  });
  assert.deepEqual(receiptUpdates.at(-1), state.receipts);

  api.taskId = 'edit-current-draft';
  const editedDraft = { version: 5, activities: [{ ref: 'old-stop', name: '只在当前草稿里的新地点', start_time: '16:30', cost: 910 }] };
  const draftEvent = { kind: 'draft_updated', payload: editedDraft };
  await invokeTravelMcp('trek', { name: 'apply_trip_draft_changes' } as any, { base_version: 4 }, api, {} as any,
    async () => ({ content: [{ type: 'text', text: '草稿已修改' }], structuredContent: { draft_version: 5 },
      _meta: { 'io.liketrek.agent/events': [draftEvent] } }) as any);
  assert.deepEqual(state.draft, editedDraft);

  api.taskId = 'list-candidates';
  const listResult = { candidates: [candidate] };
  const listed = await invokeTravelMcp('trek', { name: 'list_planning_candidates' } as any, { trip_id: 51 }, api, {} as any,
    async () => ({ content: [{ type: 'text', text: JSON.stringify(listResult) }], structuredContent: listResult }) as any);
  const listText = listed.output.filter(block => block.type === 'text').map(block => block.type === 'text' ? block.text : '').join('\n');
  assert.ok(listText.includes('保存版本里的老地点'));
  assert.ok(listText.includes('09:15'));
  assert.ok(listText.includes('280'));
  const version = listResult.candidates.find(row => row.candidate_id === 'c:session-c6' && row.candidate_version === 4);
  assert.deepEqual(version?.plan, candidate.plan);
  assert.equal(state.draft && (state.draft as any).activities[0].name, '只在当前草稿里的新地点');
});

test('save errors, other tools, and a non-TREK tool with the same name keep their existing model output', async () => {
  const cases = [
    { server: 'trek', name: 'save_trip_draft_candidate', result: { isError: true, content: [{ type: 'text' as const, text: 'save failed' }], structuredContent: candidate } },
    { server: 'trek', name: 'get_trip_draft', result: { content: [{ type: 'text' as const, text: 'full current draft' }], structuredContent: { draft: { activities: candidate.plan.activities } } } },
    { server: 'other', name: 'save_trip_draft_candidate', result: { content: [{ type: 'text' as const, text: JSON.stringify(candidate) }], structuredContent: candidate } },
  ];

  for (const { server, name, result } of cases) {
    const { api } = fixture();
    const expected = toLlmContent(result as any);
    if (!result.isError) expected.push({ type: 'text', text: '证据引用：tool:save-c6-vx' });
    const actual = await invokeTravelMcp(server, { name } as any, {}, api, {} as any, async () => result as any);
    assert.deepEqual(actual.output, expected, `${server}.${name} changed unexpectedly`);
  }
});
