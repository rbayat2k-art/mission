import assert from "node:assert/strict";
import test from "node:test";
import { loadTypescript } from "./helpers/load-typescript.mjs";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

test("native blank-page check recognizes a successfully decoded image document", async () => {
  const java = await readFile(new URL("../android/app/src/main/java/ir/taprasystem/employee/MainActivity.java",import.meta.url),"utf8");
  const method = java.slice(java.indexOf("private void verifyRenderedPage"));
  const expressionSource = method.slice(method.indexOf("view.evaluateJavascript("),method.indexOf("rendered ->"));
  const expression = [...expressionSource.matchAll(/"(?:\\.|[^"\\])*"/g)].map(match=>JSON.parse(match[0])).join("");
  const rendered = document => vm.runInNewContext(expression,{document});
  assert.equal(rendered({body:{innerText:""},contentType:"image/png",images:[{complete:true,naturalWidth:100}]}),true);
  assert.equal(rendered({body:{innerText:""},contentType:"image/png",images:[{complete:true,naturalWidth:0}]}),false);
  assert.equal(rendered({body:{innerText:""},contentType:"text/html",images:[]}),false);
  assert.equal(rendered({body:{innerText:"Application ready"},contentType:"text/html",images:[]}),true);
});

test("manager upload reaches assigned employee unchanged, remains private, and rejects other accounts", async () => {
  let user = {id:"manager",role:"admin"};
  let stored;
  const bytes = new Map();
  const db = { prepare(sql) { return { bind(...args) { return {
    async first() { return sql.includes("FROM attachments") ? stored : {assignedTo:"employee-a",assigneeSupervisorId:"supervisor-a",status:"open"}; },
    async all() { return {results:stored ? [stored] : []}; },
    async run() { stored = {id:args[0],missionId:args[1],objectKey:args[3],fileName:args[4],contentType:args[5],assignedTo:"employee-a",assigneeSupervisorId:"supervisor-a"}; },
  }; } }; } };
  const auth = { requireRole:async request => !user ? {error:Response.json({error:"unauthorized"},{status:401})}
    : request.headers.get("X-Tapra-User-Id") && request.headers.get("X-Tapra-User-Id") !== user.id ? {error:Response.json({code:"ACCOUNT_CONTEXT_CHANGED"},{status:409})} : {user} };
  const storage = { fileStorage:{ put:async(key,value)=>bytes.set(key,value), get:async key=>bytes.has(key)?{body:bytes.get(key)}:null, delete:async key=>bytes.delete(key) } };
  const upload = await loadTypescript(new URL("../app/api/attachments/route.ts",import.meta.url), {"../../../db/runtime":{ensureDatabase:async()=>db},"../../../lib/auth":auth,"../../../lib/file-storage":storage});
  const download = await loadTypescript(new URL("../app/api/attachments/[id]/route.ts",import.meta.url), {"../../../../db/runtime":{ensureDatabase:async()=>db},"../../../../lib/auth":auth,"../../../../lib/file-storage":storage});
  const content = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRtYAAAAASUVORK5CYII=","base64");
  const form = new FormData(); form.set("missionId","mission-fixture");form.set("file",new File([content],"تصویر.png",{type:"image/png"}));
  assert.equal((await upload.POST(new Request("http://local/api/attachments",{method:"POST",body:form}))).status,201);
  const request = () => new Request("http://local/api/attachments/fixture",{headers:{"X-Tapra-User-Id":user?.id??"employee-a"}});
  const ctx = {params:Promise.resolve({id:stored.id})};
  user={id:"employee-a",role:"employee"};
  const result=await download.GET(request(),ctx);
  assert.equal(result.status,200);
  assert.deepEqual(Buffer.from(await result.arrayBuffer()),content);
  assert.match(result.headers.get("cache-control"),/private, no-store/);
  assert.equal(result.headers.get("content-type"),"image/png");
  for (const account of [{id:"employee-b",role:"employee"},{id:"supervisor-b",role:"supervisor"}]) {
    user=account;assert.equal((await download.GET(request(),ctx)).status,403);
  }
  user=null;assert.equal((await download.GET(request(),ctx)).status,401);
  user={id:"employee-a",role:"employee"};bytes.clear();assert.equal((await download.GET(request(),ctx)).status,404);
});
