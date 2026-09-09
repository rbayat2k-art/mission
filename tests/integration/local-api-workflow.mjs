import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {spawnSync} from "node:child_process";
import mysql from "mysql2/promise";
import {loadTypescript} from "../helpers/load-typescript.mjs";

// Deliberately opt-in and tied to the dedicated local data directory. No .env
// loading, remote DB, existing-schema replacement or production URL is allowed.
assert.equal(process.env.DB_HOST,"127.0.0.1");assert.equal(process.env.DB_PORT,"33379");
assert.equal(process.env.DB_NAME,"tapra_audit_api_20260909");
const database=process.env.DB_NAME;
const connection=await mysql.createConnection({host:"127.0.0.1",port:33379,user:process.env.DB_USER,password:process.env.DB_PASSWORD});
const [[server]]=await connection.query("SELECT @@port AS port,@@datadir AS dir");
assert.equal(server.port,33379);
assert.equal(server.dir.replaceAll("\\","/").toLowerCase().replace(/\/$/,""),"c:/projects/taprasystem/work/audit-db-20260909/data");
const credentials={admin:"10000000-0000-4000-8000-000000000001",supervisorA:"10000000-0000-4000-8000-000000000002",supervisorB:"10000000-0000-4000-8000-000000000003",employeeA:"10000000-0000-4000-8000-000000000004",employeeB:"10000000-0000-4000-8000-000000000005"};
const fixturePassword="tapra-fixture-password-not-a-secret";
try{
  if(process.argv[2]==="setup"){
    const [existing]=await connection.query("SELECT SCHEMA_NAME FROM INFORMATION_SCHEMA.SCHEMATA WHERE SCHEMA_NAME=?",[database]);
    assert.equal(existing.length,0,"Refusing to replace an existing schema");
    await connection.query("CREATE DATABASE tapra_audit_api_20260909 CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci");
    const migration=spawnSync(process.execPath,["scripts/migrate.mjs"],{env:process.env,stdio:"pipe",encoding:"utf8"});
    assert.equal(migration.status,0,"Isolated API schema migration failed");
    await connection.changeUser({database});
    const {hashPassword}=await loadTypescript(new URL("../../lib/security.ts",import.meta.url));
    const secret=await hashPassword(fixturePassword);const now=new Date().toISOString();
    for(const [name,id] of Object.entries(credentials)){
      const role=name.startsWith("employee")?"employee":name.startsWith("supervisor")?"supervisor":"admin";
      const supervisor=role==="employee"?credentials[name.endsWith("A")?"supervisorA":"supervisorB"]:null;
      await connection.execute("INSERT INTO users (id,full_name,mobile,username,password_hash,password_salt,role,status,supervisor_id,must_change_password,notification_enabled,created_at) VALUES (?,?,?,?,?,?,?,'active',?,0,1,?)",[id,`Test ${name}`,`0900000000${Object.keys(credentials).indexOf(name)+1}`,`fixture.${name}`,secret.hash,secret.salt,role,supervisor,now]);
    }
    console.log("Isolated schema migrated and five synthetic accounts seeded; credentials not printed.");
  }else if(process.argv[2]==="test"){
    assert.equal(process.env.TAPRA_TEST_BASE_URL,"http://127.0.0.1:3239");
    await connection.changeUser({database});
    const cookies=new Map();const findings=[];
    const call=async(name,path,method="GET",body,extra={})=>{
      const headers={...(cookies.has(name)?{Cookie:cookies.get(name),"X-Tapra-User-Id":credentials[name]}:{}),...extra};
      if(body!==undefined&&!(body instanceof FormData))headers["Content-Type"]="application/json";
      return fetch(process.env.TAPRA_TEST_BASE_URL+path,{method,headers,body:body===undefined?undefined:body instanceof FormData?body:JSON.stringify(body),signal:AbortSignal.timeout(20000)});
    };
    const ok=async(response,statuses=[200,201])=>{assert.ok(statuses.includes(response.status),`Unexpected HTTP ${response.status}`);return response.json()};
    const check=async(name,task)=>{try{await task();findings.push({name,passed:true});console.log(`PASS ${name}`)}catch(error){findings.push({name,passed:false});console.log(`FAIL ${name}: ${error.code||error.message}`)}};
    const point=()=>({latitude:35,longitude:51,accuracy:5,recordedAt:new Date().toISOString()});
    for(const name of Object.keys(credentials)){
      const response=await call(name,"/api/auth/login","POST",{username:`fixture.${name}`,password:fixturePassword});
      const body=await ok(response);assert.equal(body.user.id,credentials[name]);
      cookies.set(name,response.headers.get("set-cookie").split(";")[0]);
    }
    console.log("PASS five real login sessions (tokens remain in memory)");
    const mission=(await ok(await call("admin","/api/missions","POST",{title:"Synthetic two-task mission",assignedTo:credentials.employeeA,workflowType:"task_list",tasks:[{title:"Task one"},{title:"Task two"}]}))).mission;
    await check("foreign employee and supervisor cannot act on the mission",async()=>{
      assert.equal((await call("employeeB",`/api/missions/${mission.id}/start`,"POST",{location:point()})).status,403);
      assert.equal((await call("supervisorB","/api/missions","POST",{title:"denied",assignedTo:credentials.employeeA})).status,403);
      assert.equal((await call("employeeA","/api/notifications","GET",undefined,{"X-Tapra-User-Id":credentials.employeeB})).status,409);
    });
    // Re-runs reuse this fixture's active shift; the server correctly rejects a
    // different clientSessionId attempting to start a second simultaneous shift.
    const shift=await ok(await call("employeeA","/api/work-sessions"));
    if(!shift.current)await ok(await call("employeeA","/api/work-sessions","POST",{action:"start",clientSessionId:randomUUID(),location:point()}));
    await check("concurrent mission start is idempotent in real MariaDB",async()=>{
      const replies=await Promise.all(Array.from({length:10},()=>call("employeeA",`/api/missions/${mission.id}/start`,"POST",{location:point()})));
      for(const reply of replies)await ok(reply);
      const [[count]]=await connection.execute("SELECT COUNT(*) AS n FROM mission_status_events WHERE mission_id=? AND event_type='started'",[mission.id]);assert.equal(count.n,1);
    });
    await ok(await call("employeeA","/api/destinations","POST",{missionId:mission.id,destinationName:"Synthetic destination",...point()}));
    await check("server exposes current-visit arrival and refuses incomplete task lists",async()=>{
      const list=await ok(await call("employeeA","/api/missions"));assert.ok(list.missions.find(item=>item.id===mission.id).destinationRegisteredAt);
      assert.equal((await call("employeeA",`/api/missions/${mission.id}/complete`,"POST",{result:"انجام شد",report:"Synthetic result",endLocation:point()})).status,409);
    });
    await check("20 duplicate task requests create one event and stale edits return 409",async()=>{
      const task=mission.tasks[0],body={result:"انجام شد",report:"Synthetic result",expectedVersion:task.version,clientEventId:randomUUID(),location:point()};
      const replies=await Promise.all(Array.from({length:20},()=>call("employeeA",`/api/missions/${mission.id}/tasks/${task.id}`,"PATCH",body)));
      for(const reply of replies)await ok(reply);
      const [[count]]=await connection.execute("SELECT COUNT(*) AS n FROM mission_task_events WHERE client_event_id=?",[body.clientEventId]);assert.equal(count.n,1);
      assert.equal((await call("employeeA",`/api/missions/${mission.id}/tasks/${task.id}`,"PATCH",{...body,clientEventId:randomUUID(),location:point()})).status,409);
    });
    const task=mission.tasks[1];
    await ok(await call("employeeA",`/api/missions/${mission.id}/tasks/${task.id}`,"PATCH",{result:"نیاز به پیگیری",report:"Synthetic next visit",expectedVersion:task.version,clientEventId:randomUUID(),location:point()}));
    await ok(await call("employeeA",`/api/missions/${mission.id}/complete`,"POST",{result:"نیاز به پیگیری",report:"Synthetic next visit",requestSupervisorAction:false,endLocation:point()}));
    const request=(await ok(await call("employeeA","/api/follow-up-requests","POST",{missionId:mission.id,category:"coordination",requestText:"Synthetic supervisor request"}))).request;
    let replyId;
    await check("20 repeated follow-up messages create one message, audit and notification",async()=>{
      const body={text:"Synthetic manager reply",clientMessageId:randomUUID()};replyId=body.clientMessageId;
      const responses=await Promise.all(Array.from({length:20},()=>call("admin",`/api/follow-up-requests/${request.id}/messages`,"POST",body)));
      for(const response of responses){const saved=await ok(response);assert.equal(saved.message.id,replyId)}
      for(const [sql,args] of [
        ["SELECT COUNT(*) AS n FROM mission_follow_up_messages WHERE id=?",[replyId]],
        ["SELECT COUNT(*) AS n FROM notifications WHERE dedupe_key=?",[`follow-up-message:${replyId}`]],
        ["SELECT COUNT(*) AS n FROM audit_logs WHERE action='follow_up.message_sent' AND JSON_UNQUOTE(JSON_EXTRACT(details,'$.messageId'))=?",[replyId]],
      ]){const [[count]]=await connection.execute(sql,args);assert.equal(count.n,1)}
    });
    await check("manager attachment round-trip and five-account access isolation",async()=>{
      const bytes=Buffer.from("synthetic-private-attachment");const form=new FormData();form.set("missionId",mission.id);form.set("messageId",replyId);form.set("file",new File([bytes],"fixture.txt",{type:"text/plain"}));
      const {attachment}=await ok(await call("admin","/api/attachments","POST",form));
      for(const name of ["admin","supervisorA","employeeA"]){const response=await call(name,`/api/attachments/${attachment.id}`);assert.equal(response.status,200);assert.deepEqual(Buffer.from(await response.arrayBuffer()),bytes)}
      for(const name of ["supervisorB","employeeB"]){assert.equal((await call(name,`/api/attachments/${attachment.id}`)).status,403);assert.equal((await call(name,`/api/follow-up-requests/${request.id}`)).status,403)}
    });
    await check("manager returns follow-up without ending employee daily activity",async()=>{
      await ok(await call("admin",`/api/follow-up-requests/${request.id}/decision`,"POST",{action:"return_to_employee",note:"Synthetic ready for next visit"}));
      const state=await ok(await call("employeeA","/api/work-sessions"));assert.ok(state.current);
      const list=await ok(await call("employeeB","/api/missions"));assert.ok(!list.missions.some(item=>item.id===mission.id));
    });
    await check("private daily weekly monthly reports and real XLSX export",async()=>{
      for(const period of ["daily","weekly","monthly"]){
        for(const name of ["admin","supervisorA"]){const response=await call(name,`/api/reports/performance?period=${period}`);await ok(response)}
        await ok(await call("employeeA",`/api/employee/daily-summary?period=${period}`));
      }
      const response=await call("admin","/api/reports/export?format=xlsx&period=daily");assert.equal(response.status,200);const bytes=Buffer.from(await response.arrayBuffer());assert.equal(bytes.subarray(0,2).toString(),"PK");
    });
    await check("logout revokes the old real session",async()=>{
      await ok(await call("employeeA","/api/auth/logout","POST"));assert.equal((await call("employeeA","/api/auth/me")).status,401);
    });
    console.log(JSON.stringify({checks:findings.length,passed:findings.filter(item=>item.passed).length,failed:findings.filter(item=>!item.passed).map(item=>item.name)}));
    if(findings.some(item=>!item.passed))process.exitCode=1;
  }else throw new Error("Use explicit setup or test mode");
}finally{await connection.end()}
