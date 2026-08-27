import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { nonLocationOutboxResponseAction } from "../lib/offline-client.ts";

const read = path => readFile(new URL(path, import.meta.url), "utf8");

test("non-location 409 is a retained conflict while retry and terminal responses remain distinct", () => {
  assert.equal(nonLocationOutboxResponseAction(200), "sent");
  assert.equal(nonLocationOutboxResponseAction(400), "discard");
  assert.equal(nonLocationOutboxResponseAction(401), "retry");
  assert.equal(nonLocationOutboxResponseAction(409), "conflict");
  assert.equal(nonLocationOutboxResponseAction(503), "retry");
});

test("flush stops before deletion on a non-location conflict and reports it to the UI", async () => {
  const [offline, page] = await Promise.all([read("../lib/offline-client.ts"), read("../app/page.tsx")]);
  assert.match(offline, /conflicts\.push\(\{ queueId: entry\.id, url: entry\.url, status: 409 \}\);\s*break;/);
  assert.match(offline, /return \{ sent, remaining: await getOutboxCount\(\), conflicts \}/);
  assert.match(page, /setSyncConflicts\(result\.conflicts\)/);
  assert.match(page, /اطلاعات آفلاین حذف نشده است/);
  assert.match(page, /window\.location\.reload\(\)/);
});

test("a retained conflict can only be discarded explicitly before server refresh and continued flush", async () => {
  const page = await read("../app/page.tsx");
  assert.match(page, /window\.confirm\("این تغییر محلی با اطلاعات جدید سرور تداخل دارد\./);
  assert.match(page, /if \(!confirmed\) return;/);
  assert.match(page, /await removeQueuedItem\(conflict\.queueId\);[\s\S]*await loadEmployeeData\(\);[\s\S]*const continued = await syncQueued\(\);/);
  assert.match(page, /if \(continued\.conflicts\.length === 0\) notify/);
  assert.match(page, /setSyncConflicts\(current => current\.filter\(item => item\.queueId !== conflict\.queueId\)\)/);
  assert.match(page, />حذف تغییر محلی</);
  assert.match(page, />تازه‌سازی صفحه</);
});

test("follow-up restart consumes the server-refreshed task versions before the first task save", async () => {
  const [page, start] = await Promise.all([read("../app/page.tsx"), read("../app/api/missions/[id]/start/route.ts")]);
  assert.match(start, /tasks:outcome\.tasks/);
  assert.match(page, /tasks:result\?\.mission\.tasks \?\?/);
  assert.match(page, /api<\{mission:\{id:string;status:string;startedAt:string;tasks\?:ApiMissionTask\[\]\}\}>/);
});
