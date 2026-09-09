import test from "node:test";
import assert from "node:assert/strict";
import { loadTypescript } from "./helpers/load-typescript.mjs";

async function harness() {
  const rows = ["a", "b"].flatMap(userId => Array.from({length:61}, (_,index) => ({id:`${userId}-${index}`,userId,readAt:null})));
  let writes=0;
  const db={prepare(sql){return{bind(...args){return{
    async all(){assert.match(sql,/WHERE user_id = \?.*LIMIT 50/);return{results:rows.filter(row=>row.userId===args[0]).slice(0,50)}},
    async first(){return{count:sql.includes("FROM notifications")?rows.filter(row=>row.userId===args[0]&&!row.readAt).length:0}},
    async run(){writes++;assert.match(sql,/user_id = \?/);const [now,id,userId]=args;rows.filter(row=>!row.readAt&&(args.length===2?row.userId===id:row.id===id&&row.userId===userId)).forEach(row=>{row.readAt=now});return{}}
  }}}}};
  const api=await loadTypescript(new URL("../app/api/notifications/route.ts",import.meta.url),{
    "../../../db/runtime":{ensureDatabase:async()=>db},
    "../../../lib/auth":{requireRole:async request=>{
      const id=request.headers.get("x-test-user")||"a";
      return request.headers.get("x-tapra-user-id")!==id?{error:Response.json({error:"account changed"},{status:409})}:{user:{id,role:"employee"}};
    }},
  });
  const request=(method,user="a",body,expected=user)=>new Request("http://local.test/api/notifications",{method,headers:{"x-test-user":user,"x-tapra-user-id":expected,"content-type":"application/json"},...(body!==undefined?{body:JSON.stringify(body)}:{})});
  return{api,request,rows,writes:()=>writes};
}

test("notification count includes unread records outside the latest 50 and never crosses accounts",async()=>{
  const h=await harness();
  const response=await h.api.GET(h.request("GET"));
  const body=await response.json();
  assert.equal(body.unreadCount,61);assert.equal(body.notifications.length,50);
  assert.ok(body.notifications.every(row=>row.userId==="a"));assert.equal(response.headers.get("cache-control"),"private, no-store");
  assert.equal((await h.api.PATCH(h.request("PATCH","b",{id:"a-0"}))).status,200);
  assert.equal(h.rows.find(row=>row.id==="a-0").readAt,null);
  await h.api.PATCH(h.request("PATCH","a",{id:"a-0"}));
  assert.equal((await(await h.api.GET(h.request("GET"))).json()).unreadCount,60);
  await h.api.PATCH(h.request("PATCH","b",{markAll:true}));
  assert.equal(h.rows.filter(row=>row.userId==="b"&&!row.readAt).length,0);
  assert.equal(h.rows.filter(row=>row.userId==="a"&&!row.readAt).length,60);
});

test("malformed markAll and changed account never mark notifications read",async()=>{
  const h=await harness();
  for(const body of [null,[],{}, {markAll:"false"},{markAll:1},{markAll:false},{id:{}},{id:""}])assert.equal((await h.api.PATCH(h.request("PATCH","a",body))).status,400);
  assert.equal((await h.api.PATCH(h.request("PATCH","b",{markAll:true},"a"))).status,409);
  assert.equal(h.writes(),0);
});
