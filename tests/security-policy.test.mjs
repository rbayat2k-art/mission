import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("only trusted GPS points affect coverage, live maps and performance reports", async () => {
  const [locationPolicy, locations, locationBatch, workPolicy, summary, performance, destination, trace] = await Promise.all([
    readFile(new URL("../lib/mission-location.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/locations/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/location-batch.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/work-session-policy.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/employee-daily-summary.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/performance-report.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/destinations/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/missions/[id]/trace/route.ts", import.meta.url), "utf8"),
  ]);

  assert.match(locationPolicy, /MAX_TRUSTED_LOCATION_ACCURACY_METERS = 100/);
  assert.match(locations, /classifyLocationBatch/);
  assert.match(locations, /accuracy_cm <= \?/);
  assert.match(locationBatch, /outside_session_window/);
  assert.match(workPolicy, /accuracy_cm <= \?/);
  assert.match(summary, /accuracy_cm <= \?/);
  assert.match(performance, /accuracy_cm <= \?/);
  assert.match(destination, /body\.accuracy! <= 100/);
  assert.match(trace, /accuracy_cm <= 10000/);
});

test("login throttling and private attachment responses have safe browser behavior", async () => {
  const [login, limiter, attachment] = await Promise.all([
    readFile(new URL("../app/api/auth/login/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/login-rate-limit.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/attachments/[id]/route.ts", import.meta.url), "utf8"),
  ]);
  assert.match(login, /status:429/);
  assert.match(login, /Retry-After/);
  assert.match(login, /AAAAAAAAAAAAAAAAAAAAAA==/);
  assert.match(limiter, /MAX_ACCOUNT_ATTEMPTS/);
  assert.match(limiter, /MAX_IP_ATTEMPTS/);
  assert.match(attachment, /private, no-store, max-age=0/);
  assert.match(attachment, /Pragma/);
});
