import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import ts from "typescript";

const read = path => fs.readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("execution rank helper validates 1 through 9 and sorts unranked last", () => {
  const source = read("lib/mission-execution-rank.ts");
  const output = ts.transpileModule(source, { compilerOptions:{ module:ts.ModuleKind.ES2022, target:ts.ScriptTarget.ES2022 } }).outputText;
  assert.match(output, /MIN_EXECUTION_RANK = 1/);
  assert.match(output, /MAX_EXECUTION_RANK = 9/);
  assert.match(output, /POSITIVE_INFINITY/);
});

test("execution rank migration is additive and repeatable", () => {
  const schema = read("db/mysql-schema.sql");
  const runtime = read("db/runtime.ts");
  const migrate = read("scripts/migrate.mjs");
  for (const source of [schema, runtime, migrate]) {
    assert.match(source, /execution_rank/);
    assert.match(source, /execution_rank_version/);
    assert.match(source, /idx_missions_execution_rank/);
  }
  assert.doesNotMatch(migrate, /DROP\s+(COLUMN|TABLE).*execution_rank/i);
});

test("rank endpoint is role scoped, transactional, versioned, and audited", () => {
  const route = read("app/api/missions/[id]/execution-rank/route.ts");
  assert.match(route, /requireRole\(request,\["owner","admin","supervisor"\]\)/);
  assert.match(route, /assigneeSupervisorId!==auth\.user\.id/);
  assert.match(route, /FOR UPDATE/);
  assert.match(route, /execution_rank_version=execution_rank_version\+1/);
  assert.match(route, /expectedVersion/);
  assert.match(route, /mission\.execution_rank_updated/);
  assert.match(route, /status:409/);
});

test("employee-created missions are unranked and ranking is presentation-only", () => {
  const missions = read("app/api/missions/route.ts");
  const page = read("app/page.tsx");
  assert.match(missions, /source === "employee" \? \{ executionRank:null \}/);
  assert.match(page, /className="execution-rank-tag"/);
  assert.match(page, /missionExecutionRank/);
  assert.match(page, /execution_rank/);
  assert.match(page, /Array\.from\(\{length:9\}/);
  assert.match(page, /اولویت انجام/);
});

test("rank has no scoring or GPS side effects", () => {
  const endpoint = read("app/api/missions/[id]/execution-rank/route.ts");
  assert.doesNotMatch(endpoint, /score_(pending|confirmed|penalty)/);
  assert.doesNotMatch(endpoint, /location_points|mission_destinations|work_sessions/);
});
