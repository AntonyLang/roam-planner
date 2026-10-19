import {type AgentPlan,type AgentTransportLeg} from '@trek/shared';

export function plannedTransport(plan:AgentPlan){
  const explicit=(plan.extensions.transport_legs??[]) as AgentTransportLeg[];
  return plan.activities.flatMap((to,index)=>{
    const from=plan.activities[index-1];
    if(!from||from.day_number!==to.day_number)return [];
    const leg=explicit.find(leg=>leg.from_ref===from.ref&&leg.to_ref===to.ref);
    const code=from.notes.match(/\b[GDCZTK]\d{1,5}\b/)?.[0];
    const train=!leg&&/站$/.test(from.name)&&/站$/.test(to.name)&&code&&to.notes.includes(code);
    const ferry=!leg&&to.transport_mode==='transit'&&/港|码头/.test(from.name)&&/港|码头/.test(to.name);
    if(!leg&&!train&&!ferry)return [];
    return [{from,to,type:leg?.mode??(train?'train':'ferry'),
      fromName:leg?.mode==='train'?leg.from_station:leg?.mode==='flight'?leg.from_airport:from.name,
      toName:leg?.mode==='train'?leg.to_station:leg?.mode==='flight'?leg.to_airport:to.name,
      code:leg?.mode==='train'?leg.train_code:leg?.mode==='flight'?leg.flight_code:code,
      date:leg?.date,
      departure:leg?.departure_time??(train?from.notes.match(new RegExp(code+'\\s+([0-2]\\d:[0-5]\\d)'))?.[1]:undefined),
      arrival:leg?.arrival_time??(train?to.notes.match(/到达\s*([0-2]\d:[0-5]\d)/)?.[1]:undefined)}];
  });
}
