import { toLlmContent, type Tool as McpTool, type CallToolResult } from '@earendil-works/pi-mcp';
import { defineExtension, section, type ToolExecutionApi, type ToolExecutionResult } from '@earendil-works/pi-durable';
import type { JsonValue } from '@earendil-works/chord';
import type { Context } from '@earendil-works/chord/context';
import { loadSkillsFromDir, formatSkillsForPrompt } from '@earendil-works/pi-coding-agent';
import { AgentRole, TravelContext } from '../documents.ts';
const jsonValue=(value:unknown):JsonValue=>JSON.parse(JSON.stringify(value));
export const travelCoreTools=new Set(['get_planning_snapshot','prepare_trip_draft','get_trip_draft','apply_trip_draft_changes','save_trip_draft_candidate','list_planning_candidates']);
export async function invokeTravelMcp(server:string,remote:McpTool,args:Record<string,unknown>,api:ToolExecutionApi,context:Context,call:(metadata?:Record<string,unknown>)=>Promise<CallToolResult>,
  onReceipts?: (receipts: readonly unknown[]) => void | Promise<void>):Promise<ToolExecutionResult>{
            const role = await api.snapshot(AgentRole, api.conversationId, context);
            const mainId = role?.mainId ?? api.conversationId;
            const travel = await api.snapshot(TravelContext, mainId, context);
            const binding = server !== 'trek' || travel?.tripId === null || travel?.tripId === undefined ? {} : {
              runtime: 'pi-durable', session_id: String(mainId), task_id: String(mainId), trip_id: travel.tripId,
              input_revision: 1, call_id: String(api.taskId), receipts: travel.receipts,
            };
            const result = await call(binding);
            const original = result._meta?.['io.liketrek.agent/original'] ?? result.structuredContent ?? result;
            const events = result._meta?.['io.liketrek.agent/events'] as { kind: string; payload: Record<string, JsonValue> }[] | undefined;
            await api.commit(async tx => {
              const data = await tx.doc(TravelContext, mainId);
              const seq = data.receipts.length + 1;
              data.receipts.push({ seq, kind: 'tool_call', payload: { call_id: String(api.taskId), name: remote.name, arguments: jsonValue(args) } },
                { seq: seq + 1, kind: 'tool_result', payload: { call_id: String(api.taskId), remote_name: remote.name, success: !result.isError,
                  original: jsonValue(original), decoded: jsonValue(result.structuredContent ?? null) } });
              if (remote.name === 'get_planning_snapshot' && !result.isError) {
                data.receipts.push({ seq: seq + 2, kind: 'trip_context', payload: { snapshot: jsonValue(result.structuredContent ?? original) } });
              }
              for (const event of events ?? []) if (event.kind === 'draft_updated') data.draft = jsonValue(event.payload);
              if (remote.name === 'save_trip_draft_candidate' && !result.isError) data.candidate = jsonValue(result.structuredContent);
            }, context);
            if (onReceipts) await onReceipts((await api.snapshot(TravelContext, mainId, context))?.receipts ?? []);
            let output = toLlmContent(result);
            if (server === 'trek' && remote.name === 'save_trip_draft_candidate' && !result.isError) {
              const candidate = result.structuredContent as { candidate_id: string; candidate_version: number; status: string };
              output = [...output.filter(block => block.type !== 'text'), { type: 'text',
                text: `候选 ${candidate.candidate_id} v${candidate.candidate_version}，状态：${candidate.status}，待用户在页面采用。` }];
            }
            if (!result.isError) output.push({ type: 'text' as const, text: '证据引用：tool:' + api.taskId });
            return { output,
              isError: result.isError, details: jsonValue({ server, remoteName: remote.name, original, events: events ?? [] }) };
}

export const TREK_DELIVERY_INSTRUCTIONS = '旅程、旅行资金预算、草稿和采用由 TREK 管理。通过 TREK 草稿工具保存安排，交付候选使用 save_trip_draft_candidate，由用户在页面正式采用。';

export function createTrekDeliveryExtension() {
  return defineExtension({ name: 'trek-delivery',
    sections: [section('trek-delivery', () => TREK_DELIVERY_INSTRUCTIONS)] });
}

export function createTravelExtension(skillsDir: string, options: { includeCatalog?: boolean } = {}) {
  const skills=options.includeCatalog === false ? undefined : loadSkillsFromDir({dir:skillsDir,source:'travel'});
  return defineExtension({name:'travel',sections:[
    section('travel-role',()=> '你是旅游规划 Agent。依据用户目标和已有安排发现、比较体验与候选，用合适来源核实交通、开放和天气。研究范围、补查、分工与写入时机由主 Agent 判断。用户沟通与子 Agent 协作统一经过主 Agent。'),
    ...(skills ? [section('skills',()=>formatSkillsForPrompt(skills.skills))] : []),
  ]});
}
