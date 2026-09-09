type MissionFlow = {
  status?:string; backendStatus?:string; workflowType?:string; startedAt?:string|null;
  destinationRegisteredAt?:string|null; currentStepNo?:number;
  steps?:{stepNo:number;status:string;requiresLocation:boolean|number;arrivedAt?:string|null;startedAt?:string|null}[];
};

// Presentation only: destination evidence must belong to the current active
// visit. Opening a mission never creates GPS, completion or scoring records.
export function missionWorkEntryStep(mission:MissionFlow):0|1 {
  const status=mission.backendStatus??mission.status;
  const step=mission.workflowType==="multi_stage"?mission.steps?.find(item=>item.stepNo===(mission.currentStepNo??1)):undefined;
  if(step&&!step.requiresLocation)return 1;
  if(status!=="in_progress")return 0;
  // A reopened stage may retain its previous arrival timestamp for history.
  // Only the server's arrived state confirms arrival in the active stage visit.
  if(mission.workflowType==="multi_stage"&&step?.status!=="arrived")return 0;
  const arrived=step?.arrivedAt??(mission.workflowType==="multi_stage"?null:mission.destinationRegisteredAt);
  const started=step?.startedAt??mission.startedAt;
  if(!arrived||!started)return 0;
  const from=Date.parse(started),to=Date.parse(arrived);
  return Number.isFinite(from)&&Number.isFinite(to)&&to>=from?1:0;
}
