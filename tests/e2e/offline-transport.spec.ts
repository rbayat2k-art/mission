import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import ts from "typescript";

declare global {
  interface Window { auditOutbox: typeof import("../../lib/offline-client"); }
}

const source = readFileSync(new URL("../../lib/offline-client.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { target:ts.ScriptTarget.ES2018, module:ts.ModuleKind.CommonJS },
}).outputText;

async function installHarness(page:Page) {
  await page.route("**/offline-audit", route => route.fulfill({ contentType:"text/html", body:"<!doctype html><html><body>Local outbox test</body></html>" }));
  await page.goto("/offline-audit");
  await page.addScriptTag({ content:`(() => { const exports = {}; ${compiled}\nwindow.auditOutbox = exports; })();` });
}

async function seed(page:Page, accountId="account-a") {
  return page.evaluate(async accountId => {
    return new Promise<number>((resolve,reject) => {
      const open = indexedDB.open("rahkar-offline-v1",1);
      open.onupgradeneeded = () => open.result.createObjectStore("outbox",{ keyPath:"id", autoIncrement:true });
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const db = open.result;
        const tx = db.transaction("outbox","readwrite");
        const request = tx.objectStore("outbox").add({ accountId, kind:"json", url:"/api/integrity", method:"POST", body:{ type:"gps_unavailable" }, createdAt:new Date().toISOString() });
        tx.oncomplete = () => { db.close(); resolve(Number(request.result)); };
        tx.onabort = () => { db.close(); reject(tx.error); };
      };
    });
  }, accountId);
}

test.beforeEach(async ({ page }) => installHarness(page));

test("429 retains the exact queue item across reload and a manual retry can finish it", async ({ page }) => {
  let status = 429;
  const headers:string[] = [];
  await page.route("**/api/integrity", route => {
    headers.push(route.request().headers()["x-tapra-user-id"]);
    return route.fulfill({ status, contentType:"application/json", body:"{}" });
  });
  const queueId = await seed(page);
  const first = await page.evaluate(() => window.auditOutbox.flushOutbox("account-a"));
  expect(first).toMatchObject({ sent:0, remaining:1 });
  await page.reload();
  await page.addScriptTag({ content:`(() => { const exports = {}; ${compiled}\nwindow.auditOutbox = exports; })();` });
  expect(await page.evaluate(() => window.auditOutbox.getOutboxCount("account-a"))).toBe(1);
  expect(queueId).toBeGreaterThan(0);
  status = 200;
  expect(await page.evaluate(() => window.auditOutbox.flushOutbox("account-a"))).toMatchObject({ sent:1, remaining:0 });
  expect(headers).toEqual(["account-a","account-a"]);
});

test("simultaneous sync triggers send an operation only once", async ({ page }) => {
  let attempts = 0;
  await page.route("**/api/integrity", async route => {
    attempts++;
    await new Promise(resolve => setTimeout(resolve,100));
    await route.fulfill({ contentType:"application/json", body:"{}" });
  });
  await seed(page);
  await page.evaluate(() => Promise.all([
    window.auditOutbox.flushOutbox("account-a"), window.auditOutbox.flushOutbox("account-a"),
  ]));
  expect(attempts).toBe(1);
});

test("rejected report stays blocked across refresh until the user explicitly removes that queue ID", async ({ page }) => {
  let attempts=0;
  await page.route("**/api/integrity", route => {
    attempts++;
    return route.fulfill({ status:422, contentType:"application/json", body:'{"error":"private report must not leak"}' });
  });
  const id=await seed(page);
  await seed(page,"account-b");
  const result=await page.evaluate(() => window.auditOutbox.flushOutbox("account-a"));
  expect(result).toMatchObject({ sent:0, remaining:1, conflicts:[{ queueId:id, status:422, reapplyable:false }] });
  expect(JSON.stringify(result)).not.toContain("private report");
  await page.reload();
  await page.addScriptTag({ content:`(() => { const exports = {}; ${compiled}\nwindow.auditOutbox = exports; })();` });
  expect(await page.evaluate(() => window.auditOutbox.flushOutbox("account-a"))).toMatchObject({sent:0,remaining:1});
  expect(attempts).toBe(1);
  await page.evaluate(id=>window.auditOutbox.removeQueuedItem(id,"account-a"),id);
  expect(await page.evaluate(() => window.auditOutbox.getOutboxCount("account-a"))).toBe(0);
  expect(await page.evaluate(() => window.auditOutbox.getOutboxCount("account-b"))).toBe(1);
});

test("changed session cannot consume another account's queue and does not create a false version conflict", async ({ page }) => {
  let sessionUser = "account-b";
  const applied:string[] = [];
  await page.route("**/api/integrity", route => {
    const owner = route.request().headers()["x-tapra-user-id"];
    if (owner !== sessionUser) return route.fulfill({ status:409, contentType:"application/json", body:'{"code":"ACCOUNT_CONTEXT_CHANGED"}' });
    applied.push(owner);
    return route.fulfill({ contentType:"application/json", body:"{}" });
  });
  await seed(page);
  await seed(page,"account-b");
  expect(await page.evaluate(() => window.auditOutbox.flushOutbox("account-a"))).toMatchObject({ sent:0, remaining:1, conflicts:[] });
  expect(applied).toEqual([]);
  expect(await page.evaluate(() => window.auditOutbox.flushOutbox("account-b"))).toMatchObject({ sent:1, remaining:0 });
  sessionUser = "account-a";
  expect(await page.evaluate(() => window.auditOutbox.flushOutbox("account-a"))).toMatchObject({ sent:1, remaining:0 });
  expect(applied).toEqual(["account-b","account-a"]);
});

test("two tabs sharing a queue cannot submit the same item concurrently", async ({ page, context }) => {
  let attempts = 0;
  await context.route("**/api/integrity", async route => {
    attempts++;
    await new Promise(resolve => setTimeout(resolve,100));
    await route.fulfill({ contentType:"application/json", body:"{}" });
  });
  const second = await context.newPage();
  await installHarness(second);
  await seed(page);
  await Promise.all([page,second].map(tab=>tab.evaluate(()=>window.auditOutbox.flushOutbox("account-a"))));
  expect(attempts).toBe(1);
  await second.close();
});

test("old engines without Web Locks still sync and coalesce same-page triggers", async ({ page }) => {
  let attempts = 0;
  await page.route("**/api/integrity", async route => {
    attempts++;
    await new Promise(resolve => setTimeout(resolve,50));
    await route.fulfill({ contentType:"application/json", body:"{}" });
  });
  await seed(page);
  await page.evaluate(() => {
    Object.defineProperty(navigator,"locks",{value:undefined, configurable:true});
    return Promise.all([window.auditOutbox.flushOutbox("account-a"),window.auditOutbox.flushOutbox("account-a")]);
  });
  expect(attempts).toBe(1);
});

test("online JSON and file uploads both declare their originating account", async ({ page }) => {
  const received:string[] = [];
  await page.route("**/api/**", route => {
    received.push(route.request().headers()["x-tapra-user-id"]);
    return route.fulfill({ contentType:"application/json", body:"{}" });
  });
  await page.evaluate(async () => {
    await window.auditOutbox.sendJsonOrQueue("account-a","/api/integrity","POST",{});
    await window.auditOutbox.sendFileOrQueue("account-a","/api/attachments",{ missionId:"fixture" },new File(["fixture"],"test.txt",{type:"text/plain"}));
  });
  expect(received).toEqual(["account-a","account-a"]);
});

test("an aborted IndexedDB transaction never reports the mutation as saved", async ({ page, context }) => {
  await seed(page);
  await context.setOffline(true);
  const saved = await page.evaluate(async () => {
    const originalAdd = IDBObjectStore.prototype.add;
    IDBObjectStore.prototype.add = function(...args:Parameters<IDBObjectStore["add"]>) {
      const request = originalAdd.apply(this,args);
      request.addEventListener("success",() => this.transaction.abort());
      return request;
    };
    try {
      await window.auditOutbox.sendJsonOrQueue("account-a","/api/integrity","POST",{});
      return true;
    } catch { return false; }
    finally { IDBObjectStore.prototype.add = originalAdd; }
  });
  expect(saved).toBe(false);
  await context.setOffline(false);
  expect(await page.evaluate(() => window.auditOutbox.getOutboxCount("account-a"))).toBe(1);
});

test("disconnect queues a mutation and reconnect sends it with its original identity", async ({ page, context }) => {
  const received:string[] = [];
  await page.route("**/api/integrity", route => {
    received.push(route.request().headers()["x-tapra-user-id"]);
    return route.fulfill({ contentType:"application/json", body:"{}" });
  });
  await context.setOffline(true);
  expect(await page.evaluate(() => window.auditOutbox.sendJsonOrQueue("account-a","/api/integrity","POST",{}))).toMatchObject({ queued:true });
  expect(received).toHaveLength(0);
  await context.setOffline(false);
  expect(await page.evaluate(() => window.auditOutbox.flushOutbox("account-a"))).toMatchObject({ sent:1, remaining:0 });
  expect(received).toEqual(["account-a"]);
});
