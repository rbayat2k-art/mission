import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { loadTypescript } from "../helpers/load-typescript.mjs";

// Called only by the disposable-schema harness. No .env, HTTP server, real
// credentials or runtime initialization is loaded. Auth is injected; both SELECTs
// from the actual route execute unchanged on the real MariaDB/MySQL connection.
export async function verifyMissionAssigneeHistory(connection) {
  const [[{ database }]] = await connection.query("SELECT DATABASE() AS `database`");
  assert.match(database, /^tapra_(?:ci|mariadb|mysql84)(?:_[a-z0-9]+)*_(?:fresh|legacy)$/i,
    "Assignee fixtures require a dedicated CI schema");
  const rules = await loadTypescript(new URL("../../lib/mission-assignee-order.ts", import.meta.url));
  const counts = async () => {
    const [[row]] = await connection.query(`SELECT
      (SELECT COUNT(*) FROM users) AS users,
      (SELECT COUNT(*) FROM missions) AS missions,
      (SELECT COUNT(*) FROM audit_logs) AS auditLogs`);
    return row;
  };
  const before = await counts();
  const base = Date.now();
  const daysAgo = days => new Date(base - days * 86_400_000).toISOString();
  const users = {};
  await connection.beginTransaction();
  try {
    async function user(name, role = "employee", supervisor = null, status = "active") {
      const id = randomUUID();
      users[name] = { id, role, status };
      await connection.execute(`INSERT INTO users
        (id, full_name, mobile, username, password_hash, password_salt, role, status, supervisor_id, must_change_password, created_at)
        VALUES (?, ?, ?, ?, 'synthetic-hash', 'synthetic-salt', ?, ?, ?, 0, ?)`,
      [id, `CI ${name}`, id.replaceAll("-", ""), `ci.assignee.${id}`, role, status, supervisor, daysAgo(60)]);
      return id;
    }
    const managerA = await user("managerA", "admin");
    const managerB = await user("managerB", "admin");
    const owner = await user("owner", "owner");
    const supervisorA = await user("supervisorA", "supervisor");
    const supervisorB = await user("supervisorB", "supervisor");
    const frequent = await user("frequent", "employee", supervisorA);
    const tieRecent = await user("tieRecent", "employee", supervisorA);
    const tieOlder = await user("tieOlder", "employee", supervisorA);
    const latest = await user("latest", "employee", supervisorA);
    const noHistory = await user("noHistory", "employee", supervisorA);
    const outside = await user("outside", "employee", supervisorB);
    const inactive = await user("inactive", "employee", supervisorA, "inactive");
    const nonEmployee = await user("nonEmployee", "supervisor", supervisorA);

    async function audit(missionId, actor, assignee, createdAt, options = {}) {
      await connection.execute(`INSERT INTO audit_logs
        (id, actor_id, action, entity_type, entity_id, details, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`, [randomUUID(), actor,
        options.action ?? "mission.created", options.entityType ?? "mission", missionId,
        options.details ?? JSON.stringify({ assignedTo: assignee }), createdAt]);
    }
    async function mission(actor, assignee, days, options = {}) {
      const id = randomUUID();
      const createdAt = daysAgo(days);
      // A surviving audit with no mission row represents a deleted registration.
      if (!options.deleted) {
        await connection.execute(`INSERT INTO missions
          (id, title, description, source, status, priority, created_by, assigned_to, created_at)
          VALUES (?, 'Synthetic assignee history', '', 'manager', ?, 'normal', ?, ?, ?)`,
        [id, options.status ?? "open", actor, options.currentAssignee ?? assignee, createdAt]);
      }
      if (!options.noAudit) await audit(id, actor, assignee, createdAt, options);
      return id;
    }

    const duplicated = await mission(managerA, frequent, 29);
    await audit(duplicated, managerA, frequent, daysAgo(29));
    await mission(managerA, frequent, 10);
    await mission(managerA, frequent, 5, { status: "approved" });
    for (const days of [8, 1]) await mission(managerA, tieRecent, days);
    for (const days of [9, 2]) await mission(managerA, tieOlder, days);
    await mission(managerA, latest, 0.5);
    await mission(managerA, outside, 3);
    await mission(managerA, inactive, 0.25);

    // None of these legacy/invalid/non-creation events may earn history credit.
    for (const details of ["{broken-json", "", "{}", '{"assignedTo":null}',
      '{"assignedTo":42}', JSON.stringify({ assignedTo: [noHistory] }),
      JSON.stringify({ assignedTo: frequent })]) {
      await mission(managerA, noHistory, 0.1, { details });
    }
    await mission(managerA, noHistory, 0.1, { noAudit: true });
    await mission(managerA, noHistory, 0.1, { action: "mission.updated" });
    await mission(managerA, noHistory, 0.1, { entityType: "work_session" });
    await mission(managerA, noHistory, 31);
    await mission(managerA, noHistory, -1);
    await mission(managerA, noHistory, 0.1, { status: "cancelled" });
    await mission(managerA, noHistory, 0.1, { deleted: true });
    const reassigned = await mission(managerA, frequent, 0.1, { currentAssignee: noHistory });
    await audit(reassigned, managerB, noHistory, daysAgo(0.05), { action: "mission.updated" });

    // Other actors have different counts; neither creation nor reassignment by a
    // different manager may be attributed to manager A (or to the editing actor).
    for (const days of [4, 2]) await mission(managerB, noHistory, days);
    await mission(managerB, frequent, 7);
    await mission(owner, noHistory, 6);
    for (const days of [7, 4]) await mission(supervisorA, frequent, days);
    await mission(supervisorA, latest, 3);
    for (const days of [6, 2, 1]) await mission(supervisorA, outside, days);
    await mission(supervisorA, inactive, 1);
    await mission(supervisorA, nonEmployee, 1);
    await mission(supervisorB, outside, 5);
    await mission(supervisorB, frequent, 1);

    async function expectHistory(accountName, expected, scopedIds) {
      const account = users[accountName];
      const reads = [];
      const db = {
        prepare(sql) {
          assert.match(sql.trim(), /^SELECT /i, "The assignee route must remain read-only");
          return {
            args: [],
            bind(...args) { return { ...this, args }; },
            async all() {
              const [results] = await connection.execute(sql, this.args);
              reads.push({ sql, args: this.args, results });
              return { results };
            },
          };
        },
      };
      const { GET } = await loadTypescript(new URL("../../app/api/missions/assignees/route.ts", import.meta.url), {
        "../../../../db/runtime": { ensureDatabase: async () => db },
        "../../../../lib/mission-assignee-order": rules,
        "../../../../lib/auth": { requireRole: async (_request, roles) => {
          assert.ok(roles.includes(account.role));
          return { user: account };
        } },
      });
      const response = await GET(new Request("http://127.0.0.1/api/missions/assignees?accountId=other-manager", {
        headers: { "X-Tapra-User-Id": account.id },
      }));
      assert.equal(response.status, 200);
      const payload = await response.json();
      assert.equal(payload.orderMode, "recent", "Real SQL must succeed; name fallback cannot pass the integration gate");
      assert.equal(payload.accountId, account.id);
      assert.equal(payload.historyDays, 30);
      assert.equal(reads.length, 2);
      const historyRead = reads.find(read => read.sql.includes("FROM audit_logs"));
      assert.ok(historyRead, "The real audit history SELECT must execute");
      assert.equal(historyRead.args[0], account.id);
      assert.equal(Date.parse(historyRead.args[2]) - Date.parse(historyRead.args[1]), 30 * 86_400_000);
      assert.deepEqual(historyRead.results.map(row => row.assignedTo).sort(), Object.keys(expected).sort(),
        "SQL itself must exclude another actor, invalid history and out-of-scope users");
      const byId = new Map(payload.assignees.map(assignee => [assignee.id, assignee]));
      const fixtureIds = new Set(Object.values(users).map(user => user.id));
      const actualIds = payload.assignees.filter(assignee => fixtureIds.has(assignee.id)).map(assignee => assignee.id);
      const expectedIds = scopedIds ?? Object.values(users).filter(user => user.status === "active").map(user => user.id);
      assert.deepEqual([...actualIds].sort(), [...expectedIds].sort());
      if (scopedIds) assert.equal(payload.assignees.length, scopedIds.length);
      for (const [id, assignee] of byId) {
        const [count, days] = expected[id] ?? [0, null];
        assert.equal(assignee.recentAssignmentCount, count, `${accountName}: wrong assignment count for ${id}`);
        assert.equal(assignee.lastAssignedAt, days === null ? null : daysAgo(days), `${accountName}: wrong recency for ${id}`);
      }
      return payload;
    }

    const managerResult = await expectHistory("managerA", {
      [frequent]: [3, 5], [tieRecent]: [2, 1], [tieOlder]: [2, 2], [latest]: [1, 0.5], [outside]: [1, 3],
    });
    assert.deepEqual(managerResult.assignees.slice(0, 5).map(user => user.id),
      [frequent, tieRecent, tieOlder, latest, outside], "Real history must rank frequency before recency");
    await expectHistory("managerB", { [noHistory]: [2, 2], [frequent]: [1, 7] });
    await expectHistory("owner", { [noHistory]: [1, 6] });
    await expectHistory("supervisorA", { [frequent]: [2, 4], [latest]: [1, 3] },
      [frequent, tieRecent, tieOlder, latest, noHistory]);
    await expectHistory("supervisorB", { [outside]: [1, 5] }, [outside]);
  } finally {
    await connection.rollback();
  }
  assert.deepEqual(await counts(), before, "Assignee fixtures must leave the existing schema data unchanged");
  console.log("Assignee history integration passed: real SQL, five actor scopes, invalid JSON, exclusions and ranking");
}
