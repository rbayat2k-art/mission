import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const read = path => readFile(new URL(path, import.meta.url), "utf8");

async function loadTaskRules() {
  const source = await read("../lib/mission-tasks.ts");
  const javascript = ts.transpileModule(source, {
    compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022},
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(javascript).toString("base64")}`);
}

test("task-list rules accept 2..10 ordered tasks and exact result vocabulary", async () => {
  const rules = await loadTaskRules();
  assert.equal(rules.MIN_MISSION_TASKS, 2);
  assert.equal(rules.MAX_MISSION_TASKS, 10);
  assert.deepEqual([...rules.MISSION_TASK_RESULTS], ["انجام شد", "انجام نشد", "نیاز به پیگیری"]);
  assert.match(rules.normalizeMissionTasks([{title:"کار اول"}]).error, /2/);
  const normalized = rules.normalizeMissionTasks([{title:"کار اول"},{title:"کار دوم",description:"شرح"}]);
  assert.equal(normalized.tasks.length, 2);
  assert.deepEqual(normalized.tasks.map(task=>task.taskNo), [1,2]);
  assert.equal(rules.normalizeMissionTaskResult("انجام شد", "").result, "انجام شد");
  assert.equal(rules.normalizeMissionTaskResult("انجام نشد", "ن").report, "ن");
  assert.equal(rules.normalizeMissionTaskResult("نیاز به پیگیری", "مراجعه بعدی").report, "مراجعه بعدی");
  assert.equal(rules.deriveMissionTaskOutcome([{status:"completed",result:"انجام شد"},{status:"completed",result:"انجام شد"}]).result, "انجام شد");
  assert.equal(rules.deriveMissionTaskOutcome([{status:"completed",result:"انجام شد"},{status:"follow_up",result:"نیاز به پیگیری"}]).result, "نیاز به پیگیری");
  assert.equal(rules.deriveMissionTaskOutcome([{status:"completed",result:"انجام شد"},{status:"follow_up",result:"انجام نشد"}]).result, "انجام نشد");
  assert.match(rules.deriveMissionTaskOutcome([{status:"completed",result:"انجام شد"},{status:"open",result:null}]).error, /۱/);
});

test("schema is additive, idempotent, and preserves an append-only task history", async () => {
  const [schema,runtime,migrate] = await Promise.all([
    read("../db/mysql-schema.sql"),
    read("../db/runtime.ts"),
    read("../scripts/migrate.mjs"),
  ]);
  assert.match(schema, /CREATE TABLE IF NOT EXISTS mission_tasks/);
  assert.match(schema, /CREATE TABLE IF NOT EXISTS mission_task_events/);
  assert.match(schema, /UNIQUE KEY uq_mission_task_no \(mission_id, task_no\)/);
  assert.match(schema, /version INT NOT NULL DEFAULT 0/);
  assert.match(schema, /UNIQUE KEY uq_mission_task_event_client \(client_event_id\)/);
  assert.match(schema, /fk_mission_task_events_task[\s\S]*REFERENCES mission_tasks\(id\)/);
  for (const source of [runtime,migrate]) {
    assert.match(source, /db\/mysql-schema\.sql/);
    assert.match(source, /split\("-- statement-breakpoint"\)/);
  }
  const appSources = await Promise.all([
    read("../app/api/missions/route.ts"),
    read("../app/api/missions/[id]/route.ts"),
    read("../app/api/missions/[id]/tasks/[taskId]/route.ts"),
    read("../app/api/missions/[id]/start/route.ts"),
    read("../app/api/missions/[id]/cancel/route.ts"),
  ]);
  assert.doesNotMatch(appSources.join("\n"), /DELETE FROM mission_task_events|UPDATE mission_task_events/);
});

test("task result endpoint is assignee-only and enforces session, destination, GPS and race safety", async () => {
  const source = await read("../app/api/missions/[id]/tasks/[taskId]/route.ts");
  assert.match(source, /mission\.assignedTo !== auth\.user\.id/);
  assert.match(source, /started_at<=\?/);
  assert.match(source, /ended_at IS NULL OR ended_at>=\?/);
  assert.match(source, /FROM mission_destinations\s+WHERE mission_id=\? AND user_id=\?/);
  assert.match(source, /24 \* 60 \* 60_000/);
  assert.match(source, /MAX_TRUSTED_LOCATION_ACCURACY_METERS|parseMissionLocation/);
  assert.match(source, /FROM missions WHERE id=\? FOR UPDATE/);
  assert.match(source, /FROM mission_tasks WHERE id=\? AND mission_id=\? FOR UPDATE/);
  assert.match(source, /expectedVersion/);
  assert.match(source, /clientEventId/);
  assert.match(source, /WHERE client_event_id=\?/);
  assert.match(source, /version=version\+1/);
  assert.match(source, /meta\.changes/);
  assert.match(source, /TaskTransitionConflict/);
  assert.match(source, /status:409/);
  assert.match(source, /INSERT INTO mission_task_events/);
  assert.match(source, /result_updated/);
});

test("completion, restart and cancellation keep mission-level metrics and task invariants", async () => {
  const [complete,start,cancel,report] = await Promise.all([
    read("../app/api/missions/[id]/complete/route.ts"),
    read("../app/api/missions/[id]/start/route.ts"),
    read("../app/api/missions/[id]/cancel/route.ts"),
    read("../lib/performance-report.ts"),
  ]);
  assert.match(complete, /deriveMissionTaskOutcome\(tasks\.results\)/);
  assert.match(complete, /mission\.workflowType !== "task_list" && !allowedResults\.includes\(workResult\)/);
  assert.match(complete, /lockedTasks[\s\S]*FOR UPDATE/);
  assert.match(complete, /deriveMissionTaskOutcome\(lockedTasks\.results\)/);
  assert.match(start, /WHERE mission_id=\? AND status='follow_up' FOR UPDATE/);
  assert.match(start, /follow_up_reopened/);
  assert.match(start, /start_cancelled_restore/);
  assert.doesNotMatch(start, /status='completed'[\s\S]*SET status='open'/);
  assert.match(cancel, /status NOT IN \('completed','cancelled'\)/);
  assert.match(cancel, /event_type[\s\S]*'cancelled'/);
  assert.match(report, /taskTotal/);
  assert.match(report, /taskCompleted/);
  assert.match(report, /taskFollowUp/);
  assert.doesNotMatch(report, /completedCount[^\n]*task/);
});

test("manager and employee UI expose a compact task-list workflow", async () => {
  const [page,styles,trace] = await Promise.all([
    read("../app/page.tsx"),
    read("../app/globals.css"),
    read("../app/api/missions/[id]/trace/route.ts"),
  ]);
  assert.match(page, /یک مقصد \+ چند کار/);
  assert.match(page, /missionTasks\.length < 2 \|\| missionTasks\.length > 10/);
  assert.match(page, /function MissionTaskChecklist/);
  assert.match(page, /sendJsonOrQueue<\{task:ApiMissionTask\}>/);
  assert.match(page, /getOutboxCount\(employeeUserId\)/);
  assert.match(page, /disabled=\{tasks\.some\(task=>task\.status==="open"\)\}/);
  assert.match(page, /نتیجه این کار با حفظ سابقه اصلاح شد/);
  assert.match(page, /mission-task-progress-inline/);
  assert.match(styles, /min-height:48px/);
  assert.match(trace, /FROM mission_tasks WHERE mission_id=\? ORDER BY task_no/);
  assert.match(trace, /tasks:taskRows/);
});

test("legacy single and multi-stage paths remain explicitly separate", async () => {
  const [create,edit,complete,page] = await Promise.all([
    read("../app/api/missions/route.ts"),
    read("../app/api/missions/[id]/route.ts"),
    read("../app/api/missions/[id]/complete/route.ts"),
    read("../app/page.tsx"),
  ]);
  assert.match(create, /body\.workflowType === "multi_stage" \? "multi_stage" : body\.workflowType === "task_list" \? "task_list" : "single"/);
  assert.match(complete, /mission\.workflowType === "multi_stage"/);
  assert.match(complete, /mission\.workflowType === "task_list"/);
  assert.match(page, /missionWorkflowType !== "multi_stage"/);
  assert.match(page, /missionWorkflowType === "task_list"/);
  assert.match(edit, /SELECT status, execution_rank_version AS executionRankVersion FROM missions WHERE id=\? FOR UPDATE/);
  assert.match(edit, /MissionEditConflict/);
  assert.match(edit, /status:409/);
});
