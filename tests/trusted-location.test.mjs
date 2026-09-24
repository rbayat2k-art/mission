import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { loadTypescript } from "./helpers/load-typescript.mjs";

const policy = await loadTypescript(new URL("../lib/mission-location.ts", import.meta.url));
const now = Date.parse("2026-09-24T10:00:00.000Z");
const point = (changes = {}) => ({ latitude:35.7, longitude:51.4, accuracy:49, recordedAt:new Date(now - 5_000).toISOString(), ...changes });

test("trusted-location policy accepts fresh 49m and exactly 100m fixes", () => {
  assert.equal(policy.validateTrustedLocation(point(), { nowMs:now }).code, null);
  assert.equal(policy.validateTrustedLocation(point({ accuracy:100 }), { nowMs:now }).code, null);
});

test("trusted-location policy rejects stale accurate fixes and excessive accuracy", () => {
  assert.equal(policy.validateTrustedLocation(point({ recordedAt:new Date(now - 121_000).toISOString() }), { nowMs:now }).code, "LOCATION_STALE");
  assert.equal(policy.validateTrustedLocation(point({ accuracy:100.01 }), { nowMs:now }).code, "LOCATION_ACCURACY_TOO_LOW");
});

test("trusted-location policy rejects malformed coordinates, coercible values, timestamps and distant future", () => {
  assert.equal(policy.validateTrustedLocation(point({ latitude:"35.7" }), { nowMs:now }).code, "LOCATION_INVALID_COORDINATES");
  assert.equal(policy.validateTrustedLocation(point({ longitude:181 }), { nowMs:now }).code, "LOCATION_INVALID_COORDINATES");
  assert.equal(policy.validateTrustedLocation(point({ accuracy:null }), { nowMs:now }).code, "LOCATION_INVALID_ACCURACY");
  assert.equal(policy.validateTrustedLocation(point({ recordedAt:"not-a-date" }), { nowMs:now }).code, "LOCATION_INVALID_TIMESTAMP");
  assert.equal(policy.validateTrustedLocation(point({ recordedAt:new Date(now + 121_000).toISOString() }), { nowMs:now }).code, "LOCATION_FUTURE_TIMESTAMP");
  assert.equal(policy.validateTrustedLocation(null, { nowMs:now }).code, "LOCATION_MISSING");
});

test("device clock offset of minus or plus five minutes has a distinct safe reason", () => {
  for (const offset of [-5, 5]) {
    const clientTime = now - offset * 60_000;
    assert.equal(policy.validateTrustedLocation(point(), { nowMs:now, clientTimeMs:clientTime }).code, "LOCATION_CLOCK_SKEW");
  }
  assert.equal(policy.validateTrustedLocation(point(), { nowMs:now, clientTimeMs:now - 30_000 }).code, null);
});

test("work-start location diagnostics expose no coordinates and distinguish client clock skew", async () => {
  const route = await readFile(new URL("../app/api/work-sessions/route.ts", import.meta.url), "utf8");
  assert.match(route, /locationRejection\(body\.location, nowDate, clientTimeFromRequest\(request\)\)/);
  assert.match(route, /LOCATION_STALE/);
  assert.match(route, /LOCATION_CLOCK_SKEW/);
  assert.match(route, /diagnostics: validation\.diagnostics/);
  assert.doesNotMatch(route, /diagnostics:\s*\{[^}]*latitude|diagnostics:\s*\{[^}]*longitude/s);
  assert.ok(route.indexOf("const replay = await db.prepare") < route.indexOf("const locationError = locationRejection"), "idempotent replay is checked before a now-stale location");
  assert.match(route, /ACTIVE_WORK_SESSION_EXISTS/);
});
