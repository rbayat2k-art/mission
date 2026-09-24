import assert from "node:assert/strict";
import test from "node:test";
import { loadTypescript } from "./helpers/load-typescript.mjs";

const identity = await loadTypescript(new URL("../lib/deployment-identity.ts", import.meta.url), {
  "./app-version": { APP_VERSION: "2.10.5" },
});
const testSha = "abcdef0123456789".repeat(2) + "abcdef01";
const safeIdentity = {
  version: "2.10.5",
  commit: testSha,
  environment: "staging",
};

test("deployment identity exposes only a validated version, full commit SHA, and known environment", () => {
  const result = identity.getDeploymentIdentity({
    APP_VERSION: "2.10.5",
    APP_COMMIT_SHA: testSha.toUpperCase(),
    APP_ENVIRONMENT: "Staging",
    DB_PASSWORD: "must-not-leak",
    API_KEY: "must-not-leak-either",
  });

  assert.deepEqual(result, {
    version: "2.10.5",
    commit: testSha,
    environment: "staging",
  });
  assert.deepEqual(Object.keys(result).sort(), ["commit", "environment", "version"]);
  assert.equal(JSON.stringify(result).includes("must-not-leak"), false);
});

test("invalid deployment metadata falls back without reflecting arbitrary environment values", () => {
  assert.deepEqual(identity.getDeploymentIdentity({
    APP_VERSION: "password=hidden",
    APP_COMMIT_SHA: "not-a-git-sha-secret",
    APP_ENVIRONMENT: "production;DB_PASSWORD=hidden",
  }), {
    version: "2.10.5",
    commit: "unknown",
    environment: "unknown",
  });
});

test("health response exposes only safe identity and disables caching", async () => {
  const route = await loadTypescript(new URL("../app/api/health/route.ts", import.meta.url), {
    "../../../db/runtime": { ensureDatabase: async () => ({ prepare: () => ({ first: async () => ({ ok: 1 }) }) }) },
    "../../../lib/deployment-identity": { getDeploymentIdentity: () => safeIdentity },
  });
  const response = await route.GET();

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), { status: "ok", ...safeIdentity });
});

test("unhealthy health response still identifies the build without exposing runtime config", async () => {
  const route = await loadTypescript(new URL("../app/api/health/route.ts", import.meta.url), {
    "../../../db/runtime": { ensureDatabase: async () => { throw new Error("private DB error"); } },
    "../../../lib/deployment-identity": { getDeploymentIdentity: () => safeIdentity },
  });
  const response = await route.GET();

  assert.equal(response.status, 503);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), { status: "unhealthy", ...safeIdentity });
});
