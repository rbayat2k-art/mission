import test from "node:test";
import assert from "node:assert/strict";
import {loadTypescript} from "./helpers/load-typescript.mjs";
const {missionWorkEntryStep:entry}=await loadTypescript(new URL("../lib/employee-mission-flow.ts",import.meta.url));
const mission={status:"in_progress",workflowType:"single",startedAt:"2026-09-09T08:00:00Z",destinationRegisteredAt:"2026-09-09T08:30:00Z"};
test("resuming an arrived mission goes to results, while a new visit needs its own destination",()=>{
  assert.equal(entry(mission),1);
  for(const status of ["open","follow_up","approved","cancelled"])assert.equal(entry({...mission,status}),0);
  assert.equal(entry({...mission,destinationRegisteredAt:null}),0);
  assert.equal(entry({...mission,destinationRegisteredAt:"invalid"}),0);
  assert.equal(entry({...mission,startedAt:"2026-09-10T08:00:00Z"}),0);
});
test("multi-stage resume uses only the current stage and preserves no-location stages",()=>{
  const steps=[{stepNo:1,status:"completed",requiresLocation:true,startedAt:mission.startedAt,arrivedAt:mission.destinationRegisteredAt},{stepNo:2,status:"in_progress",requiresLocation:true,startedAt:mission.startedAt,arrivedAt:null}];
  assert.equal(entry({...mission,workflowType:"multi_stage",currentStepNo:2,steps}),0);
  assert.equal(entry({...mission,workflowType:"multi_stage",currentStepNo:2,steps:[steps[0],{...steps[1],status:"arrived",arrivedAt:mission.destinationRegisteredAt}]}),1);
  assert.equal(entry({...mission,workflowType:"multi_stage",currentStepNo:2,steps:[steps[0],{...steps[1],arrivedAt:mission.destinationRegisteredAt}]}),0);
  assert.equal(entry({...mission,workflowType:"multi_stage",currentStepNo:2,steps:[steps[0],{...steps[1],requiresLocation:false}]}),1);
});
