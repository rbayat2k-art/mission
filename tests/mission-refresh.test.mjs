import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { loadTypescript } from "./helpers/load-typescript.mjs";
const { createMissionRefresh } = await loadTypescript(new URL("../lib/mission-refresh.ts", import.meta.url));
const deferred = () => { let resolve; const promise=new Promise(done=>{resolve=done}); return {promise,resolve}; };

test("focus, entry and notification reads coalesce into one request", async () => {
  const response=deferred();let reads=0;const applied=[];
  const refresher=createMissionRefresh({read:()=>{reads++;return response.promise},apply:value=>applied.push(value),revision:()=>0});
  const first=refresher.refresh();assert.equal(refresher.refresh(),first);
  response.resolve(["new"]);await first;assert.equal(reads,1);assert.deepEqual(applied,[["new"]]);refresher.dispose();
});
test("logout/disposal aborts and rejects late prior-account data", async () => {
  const response=deferred();let signal;const applied=[];
  const refresher=createMissionRefresh({read:arg=>{signal=arg;return response.promise},apply:value=>applied.push(value),revision:()=>0});
  const pending=refresher.refresh();await Promise.resolve();refresher.dispose();
  assert.equal(signal.aborted,true);response.resolve(["account-a"]);await pending;await refresher.refresh();assert.deepEqual(applied,[]);
});
test("older GET cannot overwrite a just-completed mission", async () => {
  const response=deferred();let revision=0;let current="completed";
  const refresher=createMissionRefresh({read:()=>response.promise,apply:value=>{current=value},revision:()=>revision});
  const pending=refresher.refresh();revision++;response.resolve("open");await pending;assert.equal(current,"completed");refresher.dispose();
});
test("failed reads keep existing data and permit the next retry", async () => {
  let fail=true;let current="existing";
  const refresher=createMissionRefresh({read:async()=>{if(fail)throw new Error("offline");return "new"},apply:value=>{current=value},revision:()=>0});
  await assert.rejects(refresher.refresh(),/offline/);assert.equal(current,"existing");fail=false;await refresher.refresh();assert.equal(current,"new");refresher.dispose();
});
test("timeout aborts the network request and allows recovery", async () => {
  let applied=false;
  const refresher=createMissionRefresh({read:signal=>new Promise((_,reject)=>signal.addEventListener("abort",()=>reject(new Error("timeout")))),apply:()=>{applied=true},revision:()=>0,timeoutMs:5});
  await assert.rejects(refresher.refresh(),/timeout/);assert.equal(applied,false);refresher.dispose();
});
test("employee live reads are private, read-only and independent of work status", async () => {
  const page=await readFile(new URL("../app/page.tsx",import.meta.url),"utf8");
  const route=await readFile(new URL("../app/api/missions/route.ts",import.meta.url),"utf8");
  const bootstrap=await readFile(new URL("../app/components/PushNotificationBootstrap.tsx",import.meta.url),"utf8");
  const effect=page.slice(page.indexOf("const refresh = createMissionRefresh"),page.indexOf("const discardSyncConflict"));
  assert.match(effect,/cache:"no-store"/);assert.match(effect,/"X-Tapra-User-Id":employeeUserId/);
  assert.match(effect,/setInterval\(update, 10_000\)/);assert.doesNotMatch(effect,/!working|sendJsonOrQueue|location\.reload|localStorage/);
  assert.match(effect,/refresh.dispose\(\)/);assert.match(effect,/visibilitychange/);assert.match(effect,/detail\?\.userId === employeeUserId/);
  assert.match(route,/"Cache-Control":"private, no-store"/);
  assert.match(bootstrap,/if \(fresh.length\) window.dispatchEvent/);
});
