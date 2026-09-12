import assert from "node:assert/strict";
import test from "node:test";
import { loadTypescript } from "./helpers/load-typescript.mjs";

const rules = await loadTypescript(new URL("../lib/mission-assignee-order.ts", import.meta.url));
const option = (id, count = 0, last = null, name = id) => ({ id, fullName: name, username: id, role: "employee", recentAssignmentCount: count, lastAssignedAt: last });

test("assignees rank recent frequency, then latest assignment, without mutating input", () => {
  const input = [option("none"), option("latest", 1, "2026-09-12"), option("frequent-old", 3, "2026-09-10"), option("frequent-new", 3, "2026-09-11")];
  const before = structuredClone(input);
  assert.deepEqual(rules.sortMissionAssignees(input).map(user => user.id), ["frequent-new", "frequent-old", "latest", "none"]);
  assert.deepEqual(input, before);
});

test("equal or missing history falls back to Persian name, username, then stable ID", () => {
  const input = [option("z", 0, null, "مینا"), option("b", 0, null, "احمد"), option("a", 0, null, "احمد")];
  assert.deepEqual(rules.sortMissionAssignees(input).map(user => user.id), ["a", "b", "z"]);
  assert.deepEqual(rules.sortMissionAssignees([]), []);
});

async function harness({ role = "admin", accountId = "manager-a", signedIn = true, historyFails = false } = {}) {
  const reads = [];
  const now = new Date();
  const userRows = [
    { id: "employee-b", fullName: "بهرام", username: "bahram", role: "employee" },
    { id: "employee-a", fullName: "احمد", username: "ahmad", role: "employee" },
    { id: "employee-c", fullName: "پریسا", username: "parisa", role: "employee" },
  ];
  const history = [
    { assignedTo: "employee-b", recentAssignmentCount: "4", lastAssignedAt: now.toISOString() },
    { assignedTo: "employee-a", recentAssignmentCount: "2", lastAssignedAt: now.toISOString() },
    { assignedTo: "outside-scope", recentAssignmentCount: "999", lastAssignedAt: now.toISOString() },
  ];
  let dbCalls = 0;
  const db = { prepare(sql) {
    assert.match(sql.trim(), /^SELECT /, "read-only feature must never write");
    return { args: [], bind(...args) { return { ...this, args }; }, async all() {
      reads.push({ sql, args: this.args });
      if (sql.includes("FROM users")) return { results: userRows };
      if (sql.includes("FROM audit_logs")) {
        if (historyFails) throw new Error("PRIVATE DATABASE ERROR SENTINEL");
        return { results: history };
      }
      throw new Error("Unexpected query");
    } };
  } };
  const routeModule = await loadTypescript(new URL("../app/api/missions/assignees/route.ts", import.meta.url), {
    "../../../../db/runtime": { ensureDatabase: async () => { dbCalls++; return db; } },
    "../../../../lib/mission-assignee-order": rules,
    "../../../../lib/auth": { requireRole: async (request, roles) => {
      assert.deepEqual(roles, ["owner", "admin", "supervisor"]);
      if (!signedIn) return { error: Response.json({ error: "unauthorized" }, { status: 401 }) };
      if (request.headers.get("x-tapra-user-id") && request.headers.get("x-tapra-user-id") !== accountId) return { error: Response.json({ error: "account changed" }, { status: 409 }) };
      if (!roles.includes(role)) return { error: Response.json({ error: "forbidden" }, { status: 403 }) };
      return { user: { id: accountId, role } };
    } },
  });
  const get = (expectedId = accountId) => routeModule.GET(new Request("http://localhost/api/missions/assignees?accountId=attacker&userId=attacker", { headers: { "x-tapra-user-id": expectedId } }));
  return { get, reads, userRows, history, databaseCalls: () => dbCalls };
}

for (const role of ["owner", "admin", "supervisor"]) {
  test(`${role} suggestions are private, actor-bound, allowlisted and read-only`, async () => {
    const state = await harness({ role });
    const response = await state.get();
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    const data = await response.json();
    assert.equal(data.accountId, "manager-a");
    assert.equal(data.historyDays, 30);
    assert.equal(data.orderMode, "recent");
    assert.deepEqual(data.assignees.map(user => user.id), ["employee-b", "employee-a", "employee-c"]);
    assert.deepEqual(Object.keys(data.assignees[0]).sort(), ["id", "fullName", "username", "role", "recentAssignmentCount", "lastAssignedAt"].sort());
    const [users, history] = state.reads;
    assert.match(users.sql, /status = 'active'/);
    assert.match(history.sql, /a\.actor_id = \?/);
    assert.match(history.sql, /a\.action = 'mission.created'/);
    assert.match(history.sql, /a\.entity_type = 'mission'/);
    assert.match(history.sql, /JOIN missions m ON m.id = a.entity_id/);
    assert.match(history.sql, /m\.status <> 'cancelled'/);
    assert.match(history.sql, /JSON_VALID\(a\.details\)/);
    assert.match(history.sql, /'\$\.assignedTo'\)\) = m\.assigned_to/);
    assert.match(history.sql, /COUNT\(DISTINCT m.id\)/);
    assert.equal(history.args[0], "manager-a");
    assert.equal(Date.parse(history.args[2]) - Date.parse(history.args[1]), 30 * 86_400_000);
    assert.equal(state.reads.some(read => read.args.includes("attacker")), false);
    if (role === "supervisor") {
      assert.match(users.sql, /role = 'employee' AND supervisor_id = \?/);
      assert.deepEqual(users.args, ["manager-a"]);
      assert.match(history.sql, /u.role = 'employee' AND u.supervisor_id = \?/);
      assert.equal(history.args[3], "manager-a");
    } else {
      assert.equal(users.args.length, 0);
      assert.equal(history.args.length, 3);
    }
  });
}

test("unauthenticated, employee and stale-account requests stop before history reads", async () => {
  for (const scenario of [{ signedIn: false, status: 401 }, { role: "employee", status: 403 }, { expectedId: "manager-b", status: 409 }]) {
    const state = await harness(scenario);
    const response = await state.get(scenario.expectedId);
    assert.equal(response.status, scenario.status);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.equal(state.databaseCalls(), 0);
  }
});

test("history failure explicitly falls back to names without raw error leakage", async () => {
  const state = await harness({ historyFails: true });
  const response = await state.get();
  const data = await response.json();
  assert.equal(data.orderMode, "name");
  assert.deepEqual(data.assignees.map(user => user.id), ["employee-a", "employee-b", "employee-c"]);
  assert.ok(data.assignees.every(user => user.recentAssignmentCount === 0 && user.lastAssignedAt === null));
  assert.doesNotMatch(JSON.stringify(data), /SENTINEL|audit_logs|GPS|password|cookie|session/i);
});

test("empty active scope returns no employee IDs even when history exists", async () => {
  const state = await harness({ role: "supervisor" });
  state.userRows.splice(0);
  const data = await (await state.get()).json();
  assert.deepEqual(data.assignees, []);
});

test("different manager requests compute separate history and return their own context", async () => {
  for (const accountId of ["manager-a", "manager-b"]) {
    const state = await harness({ accountId });
    const data = await (await state.get()).json();
    assert.equal(data.accountId, accountId);
    assert.equal(state.reads[1].args[0], accountId);
  }
});
