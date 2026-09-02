import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = path => readFile(new URL(path, import.meta.url), "utf8");

test("browser outbox entries are scoped to the authenticated account", async () => {
  const offline = await read("../lib/offline-client.ts");

  assert.match(
    offline,
    /accountId\?:\s*string/,
    "Legacy records must remain readable while all new records receive an account owner.",
  );
  assert.match(
    offline,
    /flushOutbox\(accountId:\s*string\)/,
    "Outbox flushing must require the current authenticated account and must not send entries owned by another account.",
  );
  assert.match(offline, /filter\(entry => entry\.accountId === currentAccountId\)/);
  assert.match(offline, /if \(!entry\.id \|\| entry\.accountId\) return null/);
  assert.match(offline, /claimQuarantinedItem/);
  assert.match(offline, /removeQuarantinedItem/);
});

test("a retained conflict exposes safe diagnostics and an explicit reapply path", async () => {
  const [offline, page] = await Promise.all([
    read("../lib/offline-client.ts"),
    read("../app/page.tsx"),
  ]);

  assert.match(
    offline,
    /serverError.*clientEventId.*expectedVersion|clientEventId.*expectedVersion.*serverError/s,
    "Conflict state must retain safe request metadata and the server reason without exposing private payloads.",
  );
  assert.match(
    page,
    /اعمال مجدد تغییر/,
    "Important local data needs a reapply-on-latest-version option in addition to refresh and discard.",
  );
  assert.match(offline, /entry\.conflict\.serverCode === "TASK_VERSION_CONFLICT"/);
  assert.match(page, /دریافت اطلاعات جدید سرور/);
  assert.match(page, /تعارض \$\{syncConflicts\[0\]\.position/);
  assert.doesNotMatch(page, /syncConflicts\[0\][\s\S]{0,500}(report|latitude|longitude|password)/i);
});

test("a persisted conflict is blocked on reload and sensitive operations cannot auto-reapply", async () => {
  const offline = await read("../lib/offline-client.ts");
  assert.match(offline, /const blocked = conflictDescription\(entry/);
  assert.match(offline, /if \(blocked\) \{ conflicts\.push\(blocked\); break; \}/);
  assert.match(offline, /reapplyable:operation === "mission_task_result" && entry\.conflict\.serverCode === "TASK_VERSION_CONFLICT"/);
  assert.match(offline, /اعمال مجدد خودکار برای این نوع عملیات مجاز نیست/);
});
