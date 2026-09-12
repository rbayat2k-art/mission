import assert from "node:assert/strict";
import * as nodeCrypto from "node:crypto";
import test from "node:test";
import { loadTypescript } from "./helpers/load-typescript.mjs";

const taskRules = await loadTypescript(new URL("../lib/mission-tasks.ts", import.meta.url));
const locationRules = await loadTypescript(new URL("../lib/mission-location.ts", import.meta.url));
const followUpRules = await loadTypescript(new URL("../lib/follow-up.ts", import.meta.url));
const scoreRules = await loadTypescript(new URL("../lib/score-ledger.ts", import.meta.url), { "node:crypto": nodeCrypto });
const statusRules = await loadTypescript(new URL("../lib/mission-status-events.ts", import.meta.url), {
  "./server-database": { database: { prepare() { throw new Error("Unexpected geocode database access"); } } },
  "./app-version": { APP_VERSION: "test" },
});

const workflows = ["single", "multi_stage", "task_list"];
const reportCases = [
  { name: "omitted", fields: {}, expected: "" },
  { name: "null", fields: { report: null }, expected: "" },
  { name: "empty", fields: { report: "" }, expected: "" },
  { name: "whitespace", fields: { report: " \n\t " }, expected: "" },
  { name: "one character", fields: { report: "ن" }, expected: "ن" },
  { name: "trimmed text", fields: { report: " \n گزارش نتیجه ثبت شد \t" }, expected: "گزارش نتیجه ثبت شد" },
];

function insertValues(sql, args) {
  const match = sql.match(/^INSERT INTO (\w+)\s*\(([^)]+)\)\s*VALUES\s*\(([^)]+)\)/);
  assert.ok(match, `Unrecognized fixture insert: ${sql}`);
  const columns = match[2].split(",").map(value => value.trim());
  let argumentIndex = 0;
  const values = match[3].split(",").map(value => {
    const token = value.trim();
    if (token === "?") return args[argumentIndex++];
    if (/^'[^']*'$/.test(token)) return token.slice(1, -1);
    if (/^\d+$/.test(token)) return Number(token);
    throw new Error(`Unrecognized fixture SQL literal: ${token}`);
  });
  assert.equal(columns.length, values.length);
  assert.equal(argumentIndex, args.length);
  return { table: match[1], values: Object.fromEntries(columns.map((column, index) => [column, values[index]])) };
}

function updateValues(sql, args) {
  const match = sql.match(/^UPDATE (missions|mission_steps) SET (.+) WHERE /);
  assert.ok(match, `Unrecognized fixture update: ${sql}`);
  let argumentIndex = 0;
  const values = Object.fromEntries(match[2].split(",").map(assignment => {
    const field = assignment.trim().match(/^(\w+)\s*=\s*(?:\w+\+)?\?$/);
    assert.ok(field, `Unrecognized fixture assignment: ${assignment}`);
    return [field[1], args[argumentIndex++]];
  }));
  return { table: match[1], values, conditionArgs: args.slice(argumentIndex) };
}

// A stateful statement/transaction double, not a MySQL integration test. Real
// route code, normalizers, GPS validation, ledger and event builders run here;
// authentication, SQL execution, geocoding and notification delivery are mocked.
async function completionHarness(workflowType, options = {}) {
  const recordedAt = new Date(Date.now() - 60_000).toISOString();
  const location = { latitude: 35.7, longitude: 51.4, accuracy: 8, recordedAt };
  const mission = {
    id: "mission-optional-report", source: "employee", assignedTo: "employee-a",
    title: "مأموریت آزمایشی", status: "in_progress", startedAt: recordedAt,
    workflowType, currentStepNo: 1, scorePending: 0, scoreConfirmed: 0, scorePenalty: 0,
    startLatitudeE6: 35_700_000, startLongitudeE6: 51_400_000,
    startAccuracyCm: 800, startLocationRecordedAt: recordedAt,
    supervisorId: "supervisor-a", supervisorStatus: "active", ...options.mission,
  };
  const step = {
    id: "step-a", stepNo: 1, title: "مرحله اول", requiresLocation: 1,
    status: "arrived", destinationName: "مقصد ثبت‌شده", startedAt: recordedAt,
    startLatitudeE6: 35_700_000, startLongitudeE6: 51_400_000,
    startAccuracyCm: 800, startLocationRecordedAt: recordedAt,
    destinationLatitudeE6: 35_700_000, destinationLongitudeE6: 51_400_000,
    destinationAccuracyCm: 800, destinationRecordedAt: recordedAt, ...options.step,
  };
  const destination = options.destination === null ? null : {
    destinationName: "مقصد ثبت‌شده", latitudeE6: 35_700_000, longitudeE6: 51_400_000,
    accuracyCm: 800, recordedAt,
  };
  const tasks = options.tasks ?? [
    { status: "completed", result: "انجام شد" },
    { status: "completed", result: "انجام شد" },
  ];
  const mutations = [], notifications = [], enrichments = [];
  let transactionCount = 0, databaseAccessCount = 0;
  const db = {
    prepare(query) {
      const sql = query.replace(/\s+/g, " ").trim();
      return {
        sql, args: [],
        bind(...args) { return { ...this, args }; },
        async first() {
          if (sql.includes("FROM missions m JOIN users")) return options.missingMission ? null : { ...mission };
          if (sql.includes("FROM work_sessions")) return options.activeSession === false ? null : { id: "session-a" };
          if (sql.includes("SELECT COUNT(*) AS count FROM mission_steps")) return { count: options.stepCount ?? 1 };
          if (sql.includes("FROM mission_steps WHERE mission_id=")) return options.missingStep ? null : { ...step };
          if (sql.includes("FROM mission_steps WHERE id=")) return { ...step };
          if (sql.includes("FROM mission_attempts")) return { attemptNo: mutations.filter(item => item.table === "mission_attempts").length + 1 };
          if (sql.includes("FROM missions WHERE id=")) return { ...mission };
          if (sql.includes("FROM mission_destinations")) return destination && { ...destination };
          throw new Error(`Unexpected fixture read: ${sql}`);
        },
        async all() {
          if (sql.includes("FROM mission_tasks WHERE mission_id=")) return { results: tasks.map(task => ({ ...task })) };
          throw new Error(`Unexpected fixture list: ${sql}`);
        },
        async run() {
          if (sql.startsWith("INSERT INTO ")) {
            const mutation = insertValues(sql, this.args);
            assert.ok([
              "mission_attempts", "mission_status_events", "audit_logs", "score_ledger_entries",
              "approvals", "mission_follow_up_requests", "mission_follow_up_messages", "integrity_events",
            ].includes(mutation.table), `Unexpected fixture insert table: ${mutation.table}`);
            mutations.push({ ...mutation, sql, args: this.args });
          } else if (sql.startsWith("UPDATE mission_step_segments SET ")) {
            mutations.push({ table: "mission_step_segments", sql, args: this.args });
          } else {
            const mutation = updateValues(sql, this.args);
            const target = mutation.table === "missions" ? mission : step;
            const [expectedId, expectedStatus, expectedStepNo] = mutation.conditionArgs;
            if (target.id !== expectedId || target.status !== expectedStatus ||
              (expectedStepNo != null && target.currentStepNo !== expectedStepNo)) return { meta: { changes: 0 } };
            const aliases = { current_step_no: "currentStepNo", score_pending: "scorePending", score_confirmed: "scoreConfirmed", score_penalty: "scorePenalty" };
            for (const [key, value] of Object.entries(mutation.values)) target[aliases[key] ?? key] = value;
            mutations.push({ ...mutation, sql, args: this.args });
          }
          return { meta: { changes: 1 } };
        },
      };
    },
    async batch(statements) {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      return results;
    },
    async transaction(work) {
      transactionCount += 1;
      const before = { mission: { ...mission }, step: { ...step }, mutationCount: mutations.length };
      try { return await work(db); }
      catch (error) {
        for (const target of [mission, step]) for (const key of Object.keys(target)) delete target[key];
        Object.assign(mission, before.mission);
        Object.assign(step, before.step);
        mutations.splice(before.mutationCount);
        throw error;
      }
    },
  };
  const route = await loadTypescript(new URL("../app/api/missions/[id]/complete/route.ts", import.meta.url), {
    "../../../../../db/runtime": { ensureDatabase: async () => { databaseAccessCount += 1; return db; } },
    "../../../../../lib/auth": { requireRole: async (request, roles) => {
      if (options.authStatus) return { error: Response.json({ error: "Fixture authentication denied" }, { status: options.authStatus }) };
      const user = options.user ?? { id: "employee-a", role: "employee" };
      assert.ok(roles.includes(user.role));
      assert.equal(request.method, "POST");
      return { user };
    } },
    "../../../../../lib/mission-location": locationRules,
    "../../../../../lib/follow-up": followUpRules,
    "../../../../../lib/mission-tasks": taskRules,
    "../../../../../lib/score-ledger": scoreRules,
    "../../../../../lib/mission-status-events": {
      prepareMissionStatusEvent: statusRules.prepareMissionStatusEvent,
      enrichMissionStatusEventLocation: async (id, input) => { enrichments.push({ id, location: input }); },
    },
    "../../../../../lib/push-notifications": { createUserNotification: async (userId, input) => { notifications.push({ userId, ...input }); } },
  });
  return {
    mission, step, mutations, notifications, enrichments,
    get transactionCount() { return transactionCount; },
    get databaseAccessCount() { return databaseAccessCount; },
    rows(table) { return mutations.filter(item => item.table === table).map(item => item.values); },
    submit(fields = {}) {
      return this.submitBody({ result: "انجام شد", endLocation: location, ...fields });
    },
    submitBody(body) {
      return route.POST(new Request("http://fixture/api/missions/mission-optional-report/complete", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      }), { params: Promise.resolve({ id: mission.id }) });
    },
  };
}

function expectNoMutation(harness) {
  assert.deepEqual(harness.mutations, []);
  assert.deepEqual(harness.notifications, []);
  assert.deepEqual(harness.enrichments, []);
}

function expectStoredReport(harness, workflow, report) {
  assert.equal(harness.rows("missions").length, 1);
  assert.equal(harness.rows("missions")[0].report, report);
  assert.equal(harness.rows("mission_attempts").length, 1);
  assert.equal(harness.rows("mission_attempts")[0].report, report);
  assert.equal(harness.rows("mission_status_events").length, 1);
  const event = harness.rows("mission_status_events")[0];
  assert.equal(JSON.parse(event.metadata).report, report);
  assert.equal(harness.enrichments[0].id, event.id);
  if (workflow === "multi_stage") {
    assert.equal(harness.rows("mission_steps").length, 1);
    assert.equal(harness.rows("mission_steps")[0].report, report);
  }
}

for (const workflow of workflows) {
  for (const outcome of ["انجام شد", "نیاز به پیگیری"]) {
    for (const reportCase of reportCases) {
      test(`${workflow}: ${outcome} accepts ${reportCase.name} report and persists its normalized value`, async () => {
        const harness = await completionHarness(workflow, { tasks: [
          { status: "completed", result: "انجام شد" },
          { status: outcome === "انجام شد" ? "completed" : "follow_up", result: outcome },
        ] });
        const response = await harness.submit({ result: outcome, ...reportCase.fields });
        assert.equal(response.status, 200);
        const payload = await response.json();
        assert.equal(payload.mission.status, outcome === "انجام شد" ? "pending" : "follow_up");
        assert.equal(payload.mission.needsFollowUp, outcome !== "انجام شد");
        assert.equal(payload.mission.requestSupervisorAction, false);
        assert.equal(payload.mission.followUpRequestId, null);
        assert.equal(harness.transactionCount, 1);
        expectStoredReport(harness, workflow, reportCase.expected);
        assert.equal(harness.rows("mission_attempts")[0].result, outcome);
        assert.equal(harness.rows("mission_status_events")[0].result, outcome);
        assert.equal(harness.rows("approvals").length, outcome === "انجام شد" ? 1 : 0);
        assert.deepEqual(harness.rows("mission_follow_up_requests"), []);
        assert.deepEqual(harness.rows("mission_follow_up_messages"), []);
        assert.deepEqual(harness.notifications, []);
      });
    }
  }

  for (const reportCase of reportCases) {
    test(`${workflow}: explicit referral with ${reportCase.name} report creates only meaningful messages`, async () => {
      const harness = await completionHarness(workflow, { tasks: [
        { status: "completed", result: "انجام شد" }, { status: "follow_up", result: "نیاز به پیگیری" },
      ] });
      const response = await harness.submit({ result: "نیاز به پیگیری", requestSupervisorAction: true, followUpCategory: "coordination", ...reportCase.fields });
      assert.equal(response.status, 200);
      const payload = await response.json();
      assert.equal(payload.mission.status, "follow_up");
      assert.equal(payload.mission.requestSupervisorAction, true);
      expectStoredReport(harness, workflow, reportCase.expected);
      assert.equal(harness.rows("mission_follow_up_requests").length, 1);
      const referral = harness.rows("mission_follow_up_requests")[0];
      assert.equal(referral.id, payload.mission.followUpRequestId);
      assert.equal(referral.request_text, reportCase.expected);
      assert.equal(referral.category, "coordination");
      assert.equal(referral.status, "awaiting_supervisor");
      assert.equal(referral.supervisor_id, "supervisor-a");
      assert.equal(referral.assigned_to, "supervisor-a");
      const messages = harness.rows("mission_follow_up_messages");
      assert.equal(messages.length, reportCase.expected ? 1 : 0);
      if (reportCase.expected) {
        assert.equal(messages[0].body, reportCase.expected);
        assert.equal(messages[0].request_id, referral.id);
        assert.equal(messages[0].message_type, "text");
      }
      assert.equal(harness.notifications.length, 1);
      assert.equal(harness.notifications[0].userId, "supervisor-a");
      assert.equal(harness.notifications[0].entityId, referral.id);
      assert.equal(harness.notifications[0].type, "follow_up_created");
    });
  }

  test(`${workflow}: malformed report values return 400 without writes`, async () => {
    for (const report of [{ text: "گزارش" }, ["گزارش"], 123, true]) {
      const harness = await completionHarness(workflow);
      const response = await harness.submit({ report });
      assert.equal(response.status, 400, JSON.stringify(report));
      assert.match((await response.json()).error, /متن/);
      assert.equal(harness.transactionCount, 0);
      expectNoMutation(harness);
    }
  });

  test(`${workflow}: result remains mandatory and must be a nonempty string`, async () => {
    for (const result of [undefined, null, "", " \n\t ", {}, [], 123, true]) {
      const harness = await completionHarness(workflow);
      const response = await harness.submit({ result });
      assert.equal(response.status, 400, JSON.stringify(result));
      assert.equal(harness.transactionCount, 0);
      expectNoMutation(harness);
    }
  });

  test(`${workflow}: malformed request bodies return 400 without writes`, async () => {
    for (const body of [null, [], 42, "not an object"]) {
      const harness = await completionHarness(workflow);
      assert.equal((await harness.submitBody(body)).status, 400);
      expectNoMutation(harness);
    }
  });

  test(`${workflow}: optional report does not bypass authorization, active session, GPS or destination`, async () => {
    const blockedCases = [
      { name: "unauthenticated", options: { authStatus: 401 }, status: 401 },
      { name: "forbidden role", options: { authStatus: 403 }, status: 403 },
      { name: "another assignee", options: { user: { id: "employee-b", role: "employee" } }, status: 403 },
      { name: "missing mission", options: { missingMission: true }, status: 404 },
      { name: "no active session", options: { activeSession: false }, status: 409 },
      { name: "missing GPS", fields: { endLocation: undefined }, status: 400 },
      { name: "inaccurate GPS", fields: { endLocation: { latitude: 35.7, longitude: 51.4, accuracy: 101, recordedAt: new Date().toISOString() } }, status: 400 },
      { name: "destination not registered", options: workflow === "multi_stage" ? { step: { status: "in_progress" } } : { destination: null }, status: 409 },
    ];
    for (const blocked of blockedCases) {
      const harness = await completionHarness(workflow, blocked.options);
      assert.equal((await harness.submit(blocked.fields)).status, blocked.status, blocked.name);
      assert.equal(harness.transactionCount, 0, blocked.name);
      if (blocked.options?.authStatus) assert.equal(harness.databaseAccessCount, 0, blocked.name);
      expectNoMutation(harness);
    }
  });

  test(`${workflow}: supervisor referral remains explicit and requires an active supervisor`, async () => {
    const needsFollowUpTasks = [{ status: "completed", result: "انجام شد" }, { status: "follow_up", result: "نیاز به پیگیری" }];
    for (const mission of [{ supervisorId: null }, { supervisorStatus: "inactive" }]) {
      const harness = await completionHarness(workflow, { mission, tasks: needsFollowUpTasks });
      assert.equal((await harness.submit({ result: "نیاز به پیگیری", requestSupervisorAction: true })).status, 409);
      expectNoMutation(harness);
      const withoutReferral = await completionHarness(workflow, { mission, tasks: needsFollowUpTasks });
      assert.equal((await withoutReferral.submit({ result: "نیاز به پیگیری" })).status, 200);
      assert.deepEqual(withoutReferral.rows("mission_follow_up_requests"), []);
      assert.deepEqual(withoutReferral.notifications, []);
    }
    const success = await completionHarness(workflow);
    const response = await success.submit({ requestSupervisorAction: true });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).mission.requestSupervisorAction, false);
    assert.deepEqual(success.rows("mission_follow_up_requests"), []);
    assert.deepEqual(success.notifications, []);
  });

  test(`${workflow}: repeating final completion does not duplicate attempts, scores or approval`, async () => {
    const harness = await completionHarness(workflow);
    assert.equal((await harness.submit()).status, 200);
    assert.equal(harness.mission.status, "pending");
    const before = structuredClone(harness.mutations);
    assert.equal((await harness.submit()).status, 409);
    assert.deepEqual(harness.mutations, before);
    assert.equal(harness.transactionCount, 1);
    assert.equal(harness.rows("mission_attempts").length, 1);
    assert.equal(harness.rows("mission_status_events").length, 1);
    assert.equal(harness.rows("score_ledger_entries").length, 1);
    assert.equal(harness.rows("score_ledger_entries")[0].points_delta, 12);
    assert.equal(harness.rows("approvals").length, 1);
  });
}

for (const workflow of ["single", "multi_stage"]) {
  test(`${workflow}: invalid result vocabulary remains rejected with a blank report`, async () => {
    for (const result of ["invalid-result", "انجام نشد"]) {
      const harness = await completionHarness(workflow);
      assert.equal((await harness.submit({ result, report: "" })).status, 400);
      expectNoMutation(harness);
    }
  });
}

test("task_list: blank report cannot finalize unresolved tasks", async () => {
  const harness = await completionHarness("task_list", { tasks: [
    { status: "completed", result: "انجام شد" }, { status: "open", result: null },
  ] });
  assert.equal((await harness.submit()).status, 409);
  assert.equal(harness.transactionCount, 0);
  expectNoMutation(harness);
});

test("task_list: the stored task outcome cannot be overridden by the client's selected result", async () => {
  const harness = await completionHarness("task_list", { tasks: [
    { status: "completed", result: "انجام شد" }, { status: "follow_up", result: "انجام نشد" },
  ] });
  const response = await harness.submit({ result: "انجام شد", report: "" });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).mission.status, "follow_up");
  assert.equal(harness.rows("missions")[0].result, "انجام نشد");
  assert.equal(harness.rows("mission_attempts")[0].result, "انجام نشد");
});

test("multi_stage: a blank report preserves step progression and the step's attempt history", async () => {
  const harness = await completionHarness("multi_stage", { stepCount: 2 });
  const response = await harness.submit();
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.mission.status, "stage_waiting");
  assert.equal(payload.mission.currentStepNo, 2);
  assert.equal(payload.mission.hasNextStep, true);
  assert.equal(harness.rows("mission_steps")[0].report, "");
  assert.equal(harness.rows("mission_attempts")[0].report, "");
  assert.equal(JSON.parse(harness.rows("mission_status_events")[0].metadata).report, "");
  assert.equal(harness.rows("missions")[0].report, null);
  assert.equal(harness.rows("missions")[0].result, null);
  assert.deepEqual(harness.rows("approvals"), []);
  assert.deepEqual(harness.rows("score_ledger_entries"), []);
});

test("task normalizer accepts optional/short reports for every result, including non-success", () => {
  for (const result of taskRules.MISSION_TASK_RESULTS) {
    for (const reportCase of reportCases) {
      assert.deepEqual(taskRules.normalizeMissionTaskResult(` ${result} `, reportCase.fields.report), {
        result, report: reportCase.expected,
      });
    }
  }
  assert.equal(taskRules.normalizeMissionTaskResult("انجام نشد", ` ${"ن".repeat(4_010)} `).report.length, 4_000);
});

test("task normalizer rejects malformed report types and missing or invalid results", () => {
  for (const result of taskRules.MISSION_TASK_RESULTS) {
    for (const report of [{ text: "گزارش" }, ["گزارش"], 123, true]) {
      assert.match(taskRules.normalizeMissionTaskResult(result, report).error, /متن/);
    }
  }
  for (const result of [undefined, null, "", "  ", {}, [], 123, true, "invalid-result", "تعطیل بود"]) {
    assert.ok(taskRules.normalizeMissionTaskResult(result, "").error);
  }
});

async function taskResultHarness() {
  const recordedAt = new Date().toISOString();
  const task = {
    id: "task-a", taskNo: 1, title: "کار اول", description: "", status: "open",
    result: null, report: null, version: 0, completedAt: null, updatedAt: recordedAt,
  };
  const mutations = [];
  let databaseAccessCount = 0;
  const db = {
    prepare(query) {
      const sql = query.replace(/\s+/g, " ").trim();
      return {
        args: [], bind(...args) { return { ...this, args }; },
        async first() {
          if (sql.includes("FROM missions WHERE id=")) return { id: "mission-a", assignedTo: "employee-a", status: "in_progress", workflowType: "task_list" };
          if (sql.includes("FROM mission_tasks WHERE id=")) return { ...task };
          if (sql.includes("FROM mission_task_events WHERE client_event_id=")) {
            const prior = mutations.find(item => item.table === "mission_task_events" && item.values.client_event_id === this.args[0])?.values;
            return prior ? { id: prior.id, missionId: prior.mission_id, missionTaskId: prior.mission_task_id, actorId: prior.actor_id } : null;
          }
          if (sql.includes("FROM mission_destinations WHERE mission_id=")) return { id: "destination-a", recordedAt: new Date(Date.now() - 60_000).toISOString() };
          if (sql.includes("FROM work_sessions WHERE user_id=")) return { id: "session-a" };
          throw new Error(`Unexpected task fixture read: ${sql}`);
        },
        async run() {
          if (sql.startsWith("UPDATE mission_tasks SET ")) {
            const [status, result, report, completedAt, updatedAt, id, missionId, expectedStatus, expectedVersion] = this.args;
            if (id !== task.id || missionId !== "mission-a" || task.status !== expectedStatus || task.version !== expectedVersion) return { meta: { changes: 0 } };
            const values = { status, result, report, completedAt, updatedAt, version: expectedVersion + 1 };
            Object.assign(task, values);
            mutations.push({ table: "mission_tasks", values });
          } else {
            const mutation = insertValues(sql, this.args);
            assert.ok(["mission_task_events", "audit_logs"].includes(mutation.table));
            mutations.push(mutation);
          }
          return { meta: { changes: 1 } };
        },
      };
    },
    async batch(statements) {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      return results;
    },
    async transaction(work) {
      const before = { task: { ...task }, mutationCount: mutations.length };
      try { return await work(db); }
      catch (error) {
        Object.assign(task, before.task);
        mutations.splice(before.mutationCount);
        throw error;
      }
    },
  };
  const route = await loadTypescript(new URL("../app/api/missions/[id]/tasks/[taskId]/route.ts", import.meta.url), {
    "../../../../../../db/runtime": { ensureDatabase: async () => { databaseAccessCount += 1; return db; } },
    "../../../../../../lib/auth": { requireRole: async () => ({ user: { id: "employee-a", role: "employee" } }) },
    "../../../../../../lib/mission-location": locationRules,
    "../../../../../../lib/mission-tasks": taskRules,
  });
  return {
    task, mutations,
    get databaseAccessCount() { return databaseAccessCount; },
    submit(fields = {}) {
      return route.PATCH(new Request("http://fixture/api/missions/mission-a/tasks/task-a", {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          result: "انجام نشد", expectedVersion: 0, clientEventId: "90f5de22-67cf-4a43-99b6-5aed8ef82b7f",
          location: { latitude: 35.7, longitude: 51.4, accuracy: 8, recordedAt }, ...fields,
        }),
      }), { params: Promise.resolve({ id: "mission-a", taskId: "task-a" }) });
    },
  };
}

for (const result of taskRules.MISSION_TASK_RESULTS) {
  test(`task PATCH: ${result} persists optional and short reports in task and append-only event`, async () => {
    for (const reportCase of reportCases) {
      const harness = await taskResultHarness();
      const response = await harness.submit({ result, ...reportCase.fields });
      assert.equal(response.status, 200, reportCase.name);
      const payload = await response.json();
      assert.equal(payload.task.report, reportCase.expected);
      assert.equal(payload.task.result, result);
      assert.equal(payload.task.status, result === "انجام شد" ? "completed" : "follow_up");
      assert.equal(payload.task.version, 1);
      assert.equal(harness.task.report, reportCase.expected);
      assert.equal(harness.mutations.filter(item => item.table === "mission_tasks").length, 1);
      const events = harness.mutations.filter(item => item.table === "mission_task_events");
      assert.equal(events.length, 1);
      assert.equal(events[0].values.report, reportCase.expected);
      assert.equal(events[0].values.result, result);
      assert.equal(events[0].values.id, payload.eventId);
      assert.equal(events[0].values.event_type, "result_set");
    }
  });
}

test("task PATCH: malformed report and missing/invalid result return 400 before database access", async () => {
  const invalidFields = [
    ...[{ text: "گزارش" }, ["گزارش"], 123, true].map(report => ({ report })),
    ...[undefined, null, "", "  ", {}, [], 123, true, "invalid-result"].map(result => ({ result })),
  ];
  for (const fields of invalidFields) {
    const harness = await taskResultHarness();
    assert.equal((await harness.submit(fields)).status, 400);
    assert.equal(harness.databaseAccessCount, 0);
    assert.deepEqual(harness.mutations, []);
  }
});

test("task PATCH: retrying the same blank-report client event is idempotent", async () => {
  const harness = await taskResultHarness();
  const first = await harness.submit();
  assert.equal(first.status, 200);
  const firstPayload = await first.json();
  const before = structuredClone(harness.mutations);
  const retry = await harness.submit();
  assert.equal(retry.status, 200);
  const retryPayload = await retry.json();
  assert.equal(retryPayload.duplicate, true);
  assert.equal(retryPayload.eventId, firstPayload.eventId);
  assert.equal(retryPayload.task.report, "");
  assert.equal(retryPayload.task.version, 1);
  assert.deepEqual(harness.mutations, before);
});
