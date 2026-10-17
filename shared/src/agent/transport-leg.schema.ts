import { z } from 'zod';

const ref = z.string().min(1);
const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const agentRailLegSchema = z.strictObject({
  from_ref: ref, to_ref: ref, mode: z.literal('train'),
  source_id: ref, train_code: ref, from_station: ref, to_station: ref,
  date, departure_time: clock, arrival_time: clock,
});
export const agentFlightLegSchema = z.strictObject({
  from_ref: ref, to_ref: ref, mode: z.literal('flight'),
  from_airport: ref, to_airport: ref,
  source_id: ref.optional(), flight_code: ref.optional(),
  date: date.optional(), departure_time: clock.optional(), arrival_time: clock.optional(),
}).describe('连接出发机场与到达机场的计划航段；地图只显示两端示意线，不代表实际航路、班次核实或已预订。未知航班与时刻可省略，不编造。');
export const agentTransportLegSchema = z.discriminatedUnion('mode', [agentRailLegSchema, agentFlightLegSchema]);
export type AgentRailLeg = z.infer<typeof agentRailLegSchema>;
export type AgentTransportLeg = z.infer<typeof agentTransportLegSchema>;
