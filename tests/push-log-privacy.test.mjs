import assert from "node:assert/strict";
import test from "node:test";
import { loadTypescript } from "./helpers/load-typescript.mjs";

test("push failure logs a status only, never the endpoint, raw response or credentials", async t => {
  const previous = Object.fromEntries(["VAPID_PUBLIC_KEY","VAPID_PRIVATE_KEY"].map(key=>[key,process.env[key]]));
  process.env.VAPID_PUBLIC_KEY="test-placeholder";
  process.env.VAPID_PRIVATE_KEY="test-placeholder";
  t.after(()=>{ for (const [key,value] of Object.entries(previous)) { if(value===undefined)delete process.env[key];else process.env[key]=value; } });
  const calls=[];
  t.mock.method(console,"error",(...args)=>calls.push(args));
  const statements = {
    bind(){return this;},run:async()=>({meta:{changes:1}}),first:async()=>({enabled:true}),
    all:async()=>({results:[{id:"fixture",endpoint:"https://example.invalid/private-device",p256dh:"private-key",auth:"private-auth"}]}),
  };
  const push=await loadTypescript(new URL("../lib/push-notifications.ts",import.meta.url),{
    "../db/runtime":{ensureDatabase:async()=>({prepare:()=>statements})},
    "web-push":{default:{setVapidDetails(){},sendNotification:async()=>{throw {statusCode:503,endpoint:"private-device",body:"private-provider-body"};}}},
  });
  const result=await push.createUserNotification("fixture",{type:"test",title:"test",message:"test"});
  assert.equal(result.delivered,0);
  assert.deepEqual(calls,[["push delivery failed",{statusCode:503}]]);
});
