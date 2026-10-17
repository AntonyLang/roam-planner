export { agentRailLegSchema as railLegSchema } from '@trek/shared';
export type { AgentRailLeg as RailLeg } from '@trek/shared';
export const stationName = (name: string) => name.replace(/\s/g, '').replace(/站$/, '');
export const clockMinutes = (time: string) => { const [h, m] = time.split(':').map(Number); return h! * 60 + m!; };
