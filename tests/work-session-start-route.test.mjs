import assert from "node:assert/strict";
import test from "node:test";
import { loadTypescript } from "./helpers/load-typescript.mjs";

const locationPolicy = await loadTypescript(new URL("../lib/mission-location.ts", import.meta.url));

const auth = { user:{ id:"employee-test", role:"employee", fullName:"Test Employee" } };

function makeDb({ replay = null, active = null } = {}) {
  const statements=[];
  return {
    statements,
    prepare(sql){
      let values=[];
      return {
        bind(...args){values=args;return this;},
        async first(){
          if(sql.includes("WHERE id = ?")&&sql.includes("FROM work_sessions"))return replay;
          if(sql.includes("FROM work_sessions")&&sql.includes("status = 'active'"))return active;
          return null;
        },
        async run(){return {meta:{changes:1}};},
        sql,values,
      };
    },
    async batch(items){statements.push(...items);},
  };
}

async function loadRoute(db, activity = { reconciliations:0 }) {
  return loadTypescript(new URL("../app/api/work-sessions/route.ts", import.meta.url), {
    "../../../db/runtime":{ensureDatabase:async()=>db},
    "../../../lib/auth":{requireRole:async()=>auth},
    "../../../lib/employee-daily-summary":{getEmployeeDailySummary:async()=>({})},
    "../../../lib/mission-location":locationPolicy,
    "../../../lib/work-session-policy":{
      getDailyWorkMetrics:async()=>({regularMinutes:0}),
      GPS_GAP_GRACE_MINUTES:30,OVERTIME_START_MINUTES:540,SELF_REPORTED_START_PENALTY:3,
      reconcileNineHourLimit:async()=>{activity.reconciliations+=1;return {autoEnded:false}},tehranDayBounds:()=>({start:new Date().toISOString()}),tehranTimeTodayToIso:()=>null,
    },
    "../../../lib/score-ledger":{pushScoreLedgerEntry:async()=>{}},
  });
}

function startRequest({point,clientSessionId="5df4d5b2-f7b5-48c4-b343-d481ae9c6142",clientTime=new Date().toISOString()}={}) {
  return new Request("https://tapra.test/api/work-sessions",{
    method:"POST",headers:{"Content-Type":"application/json","X-Tapra-Client-Time":clientTime},
    body:JSON.stringify({action:"start",clientSessionId,location:point}),
  });
}

test("server accepts fresh 49m and exactly 100m fixes once and keeps response private",async()=>{
  for(const accuracy of [49,100]){
    const db=makeDb();const route=await loadRoute(db);const now=Date.now();
    const response=await route.POST(startRequest({point:{latitude:35.7,longitude:51.4,accuracy,recordedAt:new Date(now-2_000).toISOString()},clientTime:new Date(now).toISOString()}));
    assert.equal(response.status,201);
    assert.match(response.headers.get("cache-control"),/private, no-store/);
    const body=await response.json();assert.equal(body.session.id,"5df4d5b2-f7b5-48c4-b343-d481ae9c6142");
    assert.equal(db.statements.length,3);
  }
});

test("server rejects stale accurate 49m with a safe diagnostic and writes no session",async()=>{
  const db=makeDb(),activity={reconciliations:0};const route=await loadRoute(db,activity);const now=Date.now();
  const response=await route.POST(startRequest({point:{latitude:35.7,longitude:51.4,accuracy:49,recordedAt:new Date(now-3*60_000).toISOString()},clientTime:new Date(now).toISOString()}));
  assert.equal(response.status,400);
  const body=await response.json();
  assert.equal(body.code,"LOCATION_STALE");
  assert.equal(body.diagnostics.accuracyMeters,49);
  assert.equal(body.diagnostics.timestampValid,true);
  assert.equal("latitude" in body.diagnostics,false);assert.equal("longitude" in body.diagnostics,false);
  assert.equal(db.statements.length,0);
  assert.equal(activity.reconciliations,0);
});

test("server diagnoses client clocks five minutes slow or fast without weakening GPS age",async()=>{
  for(const offset of [-5,5]){
    const db=makeDb();const route=await loadRoute(db);const now=Date.now();
    const response=await route.POST(startRequest({point:{latitude:35.7,longitude:51.4,accuracy:49,recordedAt:new Date(now-1_000).toISOString()},clientTime:new Date(now-offset*60_000).toISOString()}));
    assert.equal(response.status,400);
    assert.equal((await response.json()).code,"LOCATION_CLOCK_SKEW");
    assert.equal(db.statements.length,0);
  }
});

test("same active client session replay succeeds before its original fix ages out",async()=>{
  const startedAt="2026-09-24T09:00:00.000Z";
  const db=makeDb({replay:{id:"5df4d5b2-f7b5-48c4-b343-d481ae9c6142",userId:"employee-test",status:"active",startedAt,workType:"regular"}});
  const route=await loadRoute(db);const now=Date.now();
  const response=await route.POST(startRequest({point:{latitude:35.7,longitude:51.4,accuracy:49,recordedAt:new Date(now-10*60_000).toISOString()}}));
  assert.equal(response.status,200);assert.equal((await response.json()).replayed,true);assert.equal(db.statements.length,0);
});

test("different start ID receives a distinct active-session conflict without creating a duplicate",async()=>{
  const db=makeDb({active:{id:"existing-session",startedAt:"2026-09-24T09:00:00.000Z",workType:"regular"}}),activity={reconciliations:0};
  const route=await loadRoute(db,activity);const now=Date.now();
  const response=await route.POST(startRequest({point:{latitude:35.7,longitude:51.4,accuracy:49,recordedAt:new Date(now-3*60_000).toISOString()}}));
  assert.equal(response.status,409);const body=await response.json();assert.equal(body.code,"ACTIVE_WORK_SESSION_EXISTS");assert.equal(body.session.id,"existing-session");assert.equal(db.statements.length,0);assert.equal(activity.reconciliations,0);
});
