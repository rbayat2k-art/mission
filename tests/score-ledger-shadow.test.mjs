import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { prepareScoreLedgerEntry, scoreDelta, scoreLedgerIdempotencyKey } from "../lib/score-ledger.ts";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("score deltas and idempotency keys are deterministic and signed", () => {
  assert.equal(scoreDelta(2, 12), 10);
  assert.equal(scoreDelta(12, 0), -12);
  const identity = { source:"approval_decision", sourceEventId:"approval-1", bucket:"pending", reasonCode:"approval_approved" };
  assert.equal(scoreLedgerIdempotencyKey(identity), scoreLedgerIdempotencyKey({ ...identity }));
  assert.notEqual(scoreLedgerIdempotencyKey(identity), scoreLedgerIdempotencyKey({ ...identity, bucket:"confirmed" }));
});

test("helper emits only non-zero duplicate-key-only statements with shadow metadata", () => {
  const calls = [];
  const database = { prepare(sql) { return { bind(...values) { calls.push({ sql, values }); return { sql, values }; } }; } };
  const common = { userId:"u1", missionId:"m1", actorId:"a1", reasonCode:"mission_completed", source:"mission_complete", sourceEventId:"e1", occurredAt:"2026-08-27T00:00:00.000Z" };
  assert.equal(prepareScoreLedgerEntry(database, { ...common, bucket:"pending", pointsDelta:0 }), null);
  prepareScoreLedgerEntry(database, { ...common, bucket:"pending", pointsDelta:12 });
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /^INSERT INTO score_ledger_entries/);
  assert.match(calls[0].sql, /ON DUPLICATE KEY UPDATE idempotency_key = VALUES\(idempotency_key\)/);
  assert.doesNotMatch(calls[0].sql, /INSERT IGNORE/);
  assert.match(calls[0].values.at(-1), /"shadowMode":true/);
});

test("pending approval transfer and reversal arithmetic preserve the mirrored balance", () => {
  const balances = { pending:0, confirmed:0, penalty:0 };
  const apply = (bucket, delta) => { balances[bucket] += delta; };
  apply("pending", 12);
  apply("pending", scoreDelta(12, 0));
  apply("confirmed", scoreDelta(0, 12));
  assert.deepEqual(balances, { pending:0, confirmed:12, penalty:0 });
  apply("confirmed", scoreDelta(12, 0));
  assert.deepEqual(balances, { pending:0, confirmed:0, penalty:0 });
});

test("schema is additive and supports unique idempotency plus reversal references", async () => {
  const [schema, runtime, migrate] = await Promise.all([read("../db/mysql-schema.sql"), read("../db/runtime.ts"), read("../scripts/migrate.mjs")]);
  assert.match(schema, /CREATE TABLE IF NOT EXISTS score_ledger_entries/);
  assert.match(schema, /points_delta INT NOT NULL/);
  assert.match(schema, /bucket VARCHAR\(24\) NOT NULL/);
  assert.match(schema, /idempotency_key CHAR\(64\) NOT NULL UNIQUE/);
  assert.match(schema, /reversal_of CHAR\(36\) NULL/);
  assert.match(schema, /fk_score_ledger_reversal/);
  for (const upgrader of [runtime, migrate]) {
    assert.match(upgrader, /mysql-schema\.sql/);
    assert.match(upgrader, /split\("-- statement-breakpoint"\)/);
    assert.match(upgrader, /for \(const statement of statements\)/);
  }
});

test("opening backfill is resumable, bounded and safe to run twice", async () => {
  const backfill = await read("../scripts/backfill-score-ledger.mjs");
  assert.match(backfill, /const pageSize = 250/);
  assert.match(backfill, /WHERE id > \? AND id <= \? AND created_at <= \? ORDER BY id LIMIT \$\{pageSize\}/);
  assert.doesNotMatch(backfill, /LIMIT \?/);
  assert.match(backfill, /COALESCE\(SUM\(points_delta\),0\) AS total/);
  assert.match(backfill, /const delta = desired - Number\(existing\.get\(bucket\) \|\| 0\)/);
  assert.match(backfill, /SCORE_LEDGER_BACKFILL_CUTOFF/);
  assert.match(backfill, /SCORE_LEDGER_BACKFILL_MAINTENANCE/);
  assert.match(backfill, /GET_LOCK\('tapra:score-ledger-opening-backfill'/);
  assert.match(backfill, /reconciliation failed after opening backfill/);
  assert.match(backfill, /ON DUPLICATE KEY UPDATE idempotency_key = VALUES\(idempotency_key\)/);
  assert.doesNotMatch(backfill, /INSERT IGNORE/);
  assert.match(backfill, /opening_backfill_v1/);
  assert.match(backfill, /score_ledger_backfill_state/);
  assert.match(backfill, /opening-v1/);
  assert.doesNotMatch(backfill, /UPDATE\s+score_ledger_entries|DELETE\s+FROM\s+score_ledger_entries/i);
});

test("all existing score-changing paths mirror entries without ledger mutation", async () => {
  const paths = [
    "../app/api/missions/[id]/complete/route.ts",
    "../app/api/approvals/[id]/decision/route.ts",
    "../app/api/follow-up-requests/[id]/decision/route.ts",
    "../app/api/missions/[id]/trace/route.ts",
    "../app/api/missions/[id]/start/route.ts",
    "../app/api/missions/[id]/cancel/route.ts",
    "../app/api/work-sessions/route.ts",
  ];
  const sources = await Promise.all(paths.map(read));
  for (const source of sources) {
    assert.match(source, /ScoreLedgerEntry/);
    assert.doesNotMatch(source, /UPDATE\s+score_ledger_entries|DELETE\s+FROM\s+score_ledger_entries/i);
  }
});

test("reconciliation is owner/admin-only, read-only and no-store", async () => {
  const route = await read("../app/api/admin/score-ledger/reconciliation/route.ts");
  assert.match(route, /requireRole\(request, \["owner", "admin"\]\)/);
  assert.match(route, /sourceOfTruth: "current_score_columns"/);
  assert.match(route, /private, no-store, max-age=0/);
  assert.doesNotMatch(route, /UPDATE|DELETE|INSERT/i);
});

test("shadow ledger does not feed current employee UI or performance reports", async () => {
  const sources = await Promise.all([
    read("../app/page.tsx"), read("../lib/performance-report.ts"), read("../lib/performance-xlsx.ts"), read("../lib/employee-daily-summary.ts"),
  ]);
  for (const source of sources) assert.doesNotMatch(source, /score_ledger_entries|score-ledger|scoreLedger/i);
});
