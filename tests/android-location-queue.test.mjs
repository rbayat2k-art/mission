import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const servicePath = new URL("../android/app/src/main/java/ir/taprasystem/employee/LocationTrackingService.java", import.meta.url);
const activityPath = new URL("../android/app/src/main/java/ir/taprasystem/employee/MainActivity.java", import.meta.url);

test("Android GPS points carry the authoritative work-session ID", async () => {
  const [service, activity] = await Promise.all([readFile(servicePath, "utf8"), readFile(activityPath, "utf8")]);
  assert.match(service, /point\.put\("workSessionId", trackingWorkSessionId\)/);
  assert.match(service, /EXTRA_WORK_SESSION_ID/);
  assert.match(activity, /putExtra\(LocationTrackingService\.EXTRA_WORK_SESSION_ID, safeWorkSessionId\)/);
});

test("Android removes only accepted, duplicate, and permanently rejected queue IDs", async () => {
  const service = await readFile(servicePath, "utf8");
  const terminalMethod = service.slice(service.indexOf("private synchronized void removeTerminal"), service.indexOf("private String queueKey"));
  assert.match(terminalMethod, /acceptedIds/);
  assert.match(terminalMethod, /duplicateIds/);
  assert.match(terminalMethod, /permanentRejected/);
  assert.match(terminalMethod, /retryableRejected/);
  assert.match(terminalMethod, /ids\.removeAll\(retryableIds\)/);
});

test("Android queue, restart metadata, and requests stay scoped to the authenticated account", async () => {
  const [service, activity] = await Promise.all([readFile(servicePath, "utf8"), readFile(activityPath, "utf8")]);
  assert.match(service, /requestedUserId\.equals\(activeUserId\)/);
  assert.match(service, /preferences\.getString\("tracking_user_id", ""\)/);
  assert.match(service, /preferences\.getString\("tracking_work_session_id", ""\)/);
  assert.match(service, /"location_queue_user_" \+ userId/);
  assert.match(service, /setRequestProperty\("X-Tapra-User-Id", expectedUserId\)/);
  assert.match(activity, /!previousUserId\.equals\(safeUserId\)/);
  assert.match(activity, /setTrackingActive\(false, ""\)/);
  assert.match(activity, /NativeNotificationHelper\.switchUser\(this, safeUserId\)/);
});
