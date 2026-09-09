import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  evaluateTrackingPresence,
  TRACKING_ALERT_REPEAT_MS,
  trackingNotificationDecision,
} from "../lib/tracking-alert-policy.mjs";
import { validTrackingWorkSessionId } from "../lib/tracking-heartbeat.ts";

const minute = 60_000;
const now = new Date("2026-08-27T12:00:00.000Z");
const ago = (minutes, extraMs = 0) => new Date(now.getTime() - minutes * minute - extraMs).toISOString();

test("tracking thresholds use a deterministic server clock", () => {
  assert.equal(evaluateTrackingPresence({ startedAt: ago(4, 59_000) }, now).contact.state, "normal");
  assert.equal(evaluateTrackingPresence({ startedAt: ago(5) }, now).contact.state, "warning");
  assert.equal(evaluateTrackingPresence({ startedAt: ago(15) }, now).contact.state, "high");
  assert.equal(evaluateTrackingPresence({ startedAt: ago(9, 59_000) }, now).trustedGps.state, "warning");
  assert.equal(evaluateTrackingPresence({ startedAt: ago(10) }, now).trustedGps.state, "high");
});

test("recovery is immediate and unchanged alerts repeat only after 30 minutes", () => {
  assert.deepEqual(trackingNotificationDecision("high", "normal", ago(1), now), { notify: true, reason: "recovered" });
  assert.deepEqual(trackingNotificationDecision("warning", "warning", new Date(now.getTime() - TRACKING_ALERT_REPEAT_MS + 1).toISOString(), now), { notify: false, reason: "unchanged" });
  assert.deepEqual(trackingNotificationDecision("warning", "warning", new Date(now.getTime() - TRACKING_ALERT_REPEAT_MS).toISOString(), now), { notify: true, reason: "repeat" });
});

test("heartbeat is account and active-session scoped and never advances authoritative GPS", async () => {
  const heartbeat = await readFile(new URL("../app/api/tracking/heartbeat/route.ts", import.meta.url), "utf8");
  assert.match(heartbeat, /requireRole\(request, \["employee", "supervisor", "admin", "owner"\]\)/);
  assert.match(heartbeat, /expectedUserId !== auth\.user\.id/);
  assert.match(heartbeat, /status: 409/);
  assert.match(heartbeat, /ws\.id = \? AND ws\.user_id = \? AND ws\.status = 'active' AND u\.status = 'active'/);
  assert.equal(validTrackingWorkSessionId("7a9f2b1c-1234-4abc-8def-1234567890ab"), true);
  for (const malformed of [
    "7a9f2b1c1234-4abc-8def-1234567890ab",
    "7a9f2b1c-1234-4abc8-def-1234567890ab",
    "7a9f2b1c-1234-1abc-8def-1234567890ab",
    "7a9f2b1c-1234-4abc-7def-1234567890ab",
  ]) assert.equal(validTrackingWorkSessionId(malformed), false);
  assert.match(heartbeat, /validTrackingWorkSessionId\(workSessionId\)/);
  assert.match(heartbeat, /const receivedAt = new Date\(\)\.toISOString\(\)/);
  assert.match(heartbeat, /last_contact_at = VALUES\(last_contact_at\)/);
  assert.doesNotMatch(heartbeat, /last_trusted_gps_at = VALUES/);
  assert.match(heartbeat, /scoreImpact: false/);
  assert.match(heartbeat, /sessionStatus: "active"/);
  assert.match(heartbeat, /nextHeartbeatSeconds: 60/);
  assert.match(heartbeat, /private, no-store, max-age=0/);
});

test("only accepted trusted GPS for the current active session advances GPS presence", async () => {
  const locations = await readFile(new URL("../app/api/locations/route.ts", import.meta.url), "utf8");
  assert.match(locations, /const acceptedPoints = classification\.candidates\.filter/);
  assert.match(locations, /point\.accuracy <= MAX_TRUSTED_LOCATION_ACCURACY_METERS/);
  assert.match(locations, /if \(activeSession\?\.id === sessionId\)/);
  assert.match(locations, /last_contact_at = VALUES\(last_contact_at\)/);
  assert.match(locations, /latestTrusted\?\.recordedAt \?\? null/);
  assert.match(locations, /last_trusted_gps_at = IF/);
  assert.match(locations, /last_trusted_gps_received_at = IF\(VALUES\(last_trusted_gps_at\) IS NULL/);
});

test("fresh and upgraded databases receive idempotent additive tracking tables", async () => {
  const [schema, runtime, migration] = await Promise.all([
    readFile(new URL("../db/mysql-schema.sql", import.meta.url), "utf8"),
    readFile(new URL("../db/runtime.ts", import.meta.url), "utf8"),
    readFile(new URL("../scripts/migrate.mjs", import.meta.url), "utf8"),
  ]);
  for (const table of ["tracking_presence", "tracking_alert_states", "tracking_alert_transitions"]) {
    assert.match(schema, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
  }
  assert.match(schema, /score_impact TINYINT\(1\) NOT NULL DEFAULT 0/);
  assert.match(schema, /UNIQUE INDEX idx_notifications_user_dedupe \(user_id, dedupe_key\)/);
  for (const upgrade of [runtime, migration]) {
    assert.match(upgrade, /COLUMN_NAME[^\n]+dedupe_key/);
    assert.match(upgrade, /INDEX_NAME[^\n]+idx_notifications_user_dedupe/);
    assert.match(upgrade, /if \(!notificationDedupe/);
  }
});

test("checker is locked, deduplicated, manager-scoped and has no score/work impact", async () => {
  const checker = await readFile(new URL("../scripts/check-tracking-alerts.mjs", import.meta.url), "utf8");
  assert.match(checker, /GET_LOCK\(\?, 0\)/);
  assert.match(checker, /RELEASE_LOCK\(\?\)/);
  assert.match(checker, /ws\.status = 'active' AND u\.status = 'active'/);
  assert.match(checker, /manager\.role IN \('owner', 'admin'\)/);
  assert.match(checker, /manager\.id = employee\.supervisor_id/);
  assert.match(checker, /session_ended_or_user_inactive/);
  assert.match(checker, /INSERT IGNORE INTO tracking_alert_transitions/);
  assert.match(checker, /INSERT IGNORE INTO notifications/);
  assert.match(checker, /tracking_contact_stale/);
  assert.match(checker, /tracking_gps_stale/);
  assert.match(checker, /UPDATE integrity_events SET status = 'resolved'/);
  assert.match(checker, /scoreImpact: false/);
  assert.match(checker, /ارتباطی از دستگاه دریافت نشده/);
  assert.match(checker, /score_impact, notification_sent/);
  assert.match(checker, /VALUES \(\?, \?, \?, \?, \?, \?, \?, \?, \?, \?, 0,/);
  assert.doesNotMatch(checker, /UPDATE\s+(?:work_sessions|missions)/i);
  assert.doesNotMatch(checker, /score_penalty|score_confirmed|score_pending/i);
});

test("web and Android heartbeats remain user and work-session scoped", async () => {
  const [page, service] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../android/app/src/main/java/ir/taprasystem/employee/LocationTrackingService.java", import.meta.url), "utf8"),
  ]);
  assert.match(page, /api\("\/api\/tracking\/heartbeat", \{ method:"POST", body:JSON\.stringify\(\{ workSessionId \}\) \}\)/);
  assert.match(page, /if \(!signedIn \|\| !working \|\| !workSessionId\) return/);
  assert.match(service, /HEARTBEAT_ENDPOINT = BASE_URL \+ "\/api\/tracking\/heartbeat"/);
  assert.match(service, /new JSONObject\(\)\.put\("workSessionId", scope\.workSessionId\)/);
  assert.match(service, /setRequestProperty\("X-Tapra-User-Id", expectedUserId\)/);
  assert.match(service, /trackingUserId\.equals\(NativeNotificationHelper\.activeUserId\(this\)\)/);
  assert.match(page, /ارتباطی از دستگاه دریافت نشده/);
});

test("presence recovery has a documented maximum one-minute checker delay", async () => {
  const [deploy, runbook] = await Promise.all([
    readFile(new URL("../deploy.sh", import.meta.url), "utf8"),
    readFile(new URL("../deploy/README.md", import.meta.url), "utf8"),
  ]);
  assert.match(deploy, /TRACKING_CRON="\* \* \* \* \*/);
  assert.match(deploy, /scripts\/check-tracking-alerts\.mjs/);
  assert.match(runbook, /worst-case recovery delay is\s+60 seconds/);
  assert.match(runbook, /never change work time\s+or score/);
});
