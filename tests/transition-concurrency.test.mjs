import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("score-changing transitions serialize state and fail closed on stale writes", async () => {
  const paths = [
    "../app/api/approvals/[id]/decision/route.ts",
    "../app/api/follow-up-requests/[id]/decision/route.ts",
    "../app/api/missions/[id]/cancel/route.ts",
    "../app/api/missions/[id]/complete/route.ts",
    "../app/api/missions/[id]/start/route.ts",
    "../app/api/missions/[id]/trace/route.ts",
  ];
  for (const path of paths) {
    const source = await read(path);
    assert.match(source, /FOR UPDATE/, `${path} must lock the transition row`);
    assert.match(source, /meta\.changes/, `${path} must verify the conditional write`);
    assert.match(source, /TransitionConflict/, `${path} must expose an internal conflict path`);
    assert.match(source, /status:\s*409/, `${path} must fail closed for a stale transition`);
  }
});

test("approval and follow-up ledger mirrors execute inside the same transaction", async () => {
  for (const path of [
    "../app/api/approvals/[id]/decision/route.ts",
    "../app/api/follow-up-requests/[id]/decision/route.ts",
    "../app/api/missions/[id]/cancel/route.ts",
    "../app/api/missions/[id]/complete/route.ts",
    "../app/api/missions/[id]/trace/route.ts",
  ]) {
    const source = await read(path);
    assert.match(source, /transaction\.batch\(statements\)/);
  }
  const database = await read("../lib/server-database.ts");
  assert.match(database, /class MySqlTransaction[\s\S]*async batch/);
  assert.match(database, /statement\.runWith<T>\(this\.connection\)/);
});

test("score ledger ignores only duplicate keys and never masks other database failures", async () => {
  const [helper, backfill] = await Promise.all([
    read("../lib/score-ledger.ts"),
    read("../scripts/backfill-score-ledger.mjs"),
  ]);
  for (const source of [helper, backfill]) {
    assert.match(source, /ON DUPLICATE KEY UPDATE idempotency_key = VALUES\(idempotency_key\)/);
    assert.doesNotMatch(source, /INSERT IGNORE/);
  }
});
