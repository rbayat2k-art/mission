import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import mysql from "mysql2/promise";
import { verifyMissionAssigneeHistory } from "./mission-assignee-history.mjs";

const host=process.env.DB_HOST||"127.0.0.1", port=Number(process.env.DB_PORT||3306), user=process.env.DB_USER||"root", password=process.env.DB_PASSWORD||"";
const prefix=process.env.TAPRA_CI_DB_PREFIX||"tapra_ci";
assert.ok(["127.0.0.1","localhost","::1"].includes(host),"Database integration requires a loopback disposable service");
assert.match(prefix,/^tapra_(?:ci|mariadb|mysql84)(?:_[a-z0-9]+)*$/i,"Refusing a non-test database prefix");
assert.ok(prefix.length<=48,"CI database prefix is too long");
const freshDb=`${prefix}_fresh`, legacyDb=`${prefix}_legacy`;
const root=await mysql.createConnection({host,port,user,password});
const run=(script,database,extra={})=>{const result=spawnSync(process.execPath,[script],{cwd:process.cwd(),encoding:"utf8",env:{...process.env,DB_HOST:host,DB_PORT:String(port),DB_USER:user,DB_PASSWORD:password,DB_NAME:database,AUTO_MIGRATE:"false",...extra}});assert.equal(result.status,0,`${script} failed\n${result.stdout}\n${result.stderr}`);};
const migrateTwice=(database)=>{run("scripts/migrate.mjs",database);run("scripts/migrate.mjs",database);};
const digest=(rows)=>createHash("sha256").update(JSON.stringify(rows)).digest("hex");
async function recreate(database){await root.query(`DROP DATABASE IF EXISTS \`${database}\``);await root.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);}
async function verify(database){
  const db=await mysql.createConnection({host,port,user,password,database});
  try{
    const [tables]=await db.query("SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA=?",[database]);
    const names=new Set(tables.map(row=>row.TABLE_NAME));
    for(const name of ["score_ledger_entries","score_ledger_backfill_state","tracking_presence","tracking_alert_states","tracking_alert_transitions","mission_status_events","mission_tasks","mission_task_events"])assert(names.has(name),`missing table ${name}`);
    const [indexes]=await db.query("SELECT TABLE_NAME,INDEX_NAME FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA=?",[database]);
    const keys=new Set(indexes.map(row=>`${row.TABLE_NAME}:${row.INDEX_NAME}`));
    for(const key of ["location_points:idx_location_route_day","notifications:idx_notifications_user_dedupe","attachments:idx_attachments_follow_up_message","missions:idx_missions_execution_rank","mission_tasks:uq_mission_task_no","mission_task_events:idx_mission_task_events_task_time"])assert(keys.has(key),`missing index ${key}`);
    const [missionColumns]=await db.query("SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=? AND TABLE_NAME='missions'",[database]);
    const missionColumnNames=new Set(missionColumns.map(row=>row.COLUMN_NAME));
    for(const column of ["execution_rank","execution_rank_version"])assert(missionColumnNames.has(column),`missing missions.${column}`);
    const [fks]=await db.query("SELECT TABLE_NAME,COLUMN_NAME,REFERENCED_TABLE_NAME FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA=? AND REFERENCED_TABLE_NAME IS NOT NULL",[database]);
    assert(fks.some(row=>row.TABLE_NAME==="missions"&&row.COLUMN_NAME==="cancelled_by"&&row.REFERENCED_TABLE_NAME==="users"),"missing missions.cancelled_by FK");
    assert(fks.some(row=>row.TABLE_NAME==="score_ledger_entries"&&row.COLUMN_NAME==="user_id"&&row.REFERENCED_TABLE_NAME==="users"),"missing ledger user FK");
    assert(fks.some(row=>row.TABLE_NAME==="mission_tasks"&&row.COLUMN_NAME==="mission_id"&&row.REFERENCED_TABLE_NAME==="missions"),"missing mission task mission FK");
    assert(fks.some(row=>row.TABLE_NAME==="mission_task_events"&&row.COLUMN_NAME==="mission_task_id"&&row.REFERENCED_TABLE_NAME==="mission_tasks"),"missing task event task FK");
    await verifyMissionAssigneeHistory(db);
  }finally{await db.end();}
}
try{
  await recreate(freshDb);migrateTwice(freshDb);await verify(freshDb);
  const fresh=await mysql.createConnection({host,port,user,password,database:freshDb});
  const employee=randomUUID(),mission=randomUUID(),session=randomUUID(),created="2020-01-01T08:00:00.000Z";
  await fresh.execute("INSERT INTO users (id,full_name,mobile,username,password_hash,password_salt,role,status,must_change_password,created_at) VALUES (?,'CI Employee','09000000001','ci.employee','hash','salt','employee','active',0,?)",[employee,created]);
  await fresh.execute("INSERT INTO missions (id,title,description,source,status,priority,created_by,assigned_to,score_pending,score_confirmed,score_penalty,created_at) VALUES (?,'CI scored mission','','employee','approved','normal',?,?,2,5,1,?)",[mission,employee,employee,created]);
  await fresh.execute("INSERT INTO work_sessions (id,user_id,status,started_at,ended_at,start_source,end_source,work_type,approval_status,score_penalty,created_at) VALUES (?,?,'ended',?,?,'live','manual','regular','approved',2,?)",[session,employee,created,"2020-01-01T09:00:00.000Z",created]);
  await fresh.end();
  const cutoff=new Date(Date.now()-1000).toISOString(), backfillEnv={SCORE_LEDGER_BACKFILL_CUTOFF:cutoff,SCORE_LEDGER_BACKFILL_MAINTENANCE:"confirmed"};
  run("scripts/backfill-score-ledger.mjs",freshDb,backfillEnv);
  const first=await mysql.createConnection({host,port,user,password,database:freshDb});const [[firstLedger]]=await first.query("SELECT COUNT(*) AS count,COALESCE(SUM(points_delta),0) AS total FROM score_ledger_entries");await first.end();
  run("scripts/backfill-score-ledger.mjs",freshDb,backfillEnv);
  const second=await mysql.createConnection({host,port,user,password,database:freshDb});const [[secondLedger]]=await second.query("SELECT COUNT(*) AS count,COALESCE(SUM(points_delta),0) AS total FROM score_ledger_entries");await second.end();
  assert.deepEqual(secondLedger,firstLedger,"backfill second run changed ledger");

  await recreate(legacyDb);migrateTwice(legacyDb);
  const legacy=await mysql.createConnection({host,port,user,password,database:legacyDb});const legacyUser=randomUUID(),legacyMission=randomUUID();
  await legacy.execute("INSERT INTO users (id,full_name,mobile,username,password_hash,password_salt,role,status,must_change_password,created_at) VALUES (?,'Legacy Employee','09000000002','legacy.employee','hash','salt','employee','active',0,?)",[legacyUser,created]);
  await legacy.execute("INSERT INTO missions (id,title,description,source,status,priority,created_by,assigned_to,created_at) VALUES (?,'Legacy preserved mission','preserve-me','employee','open','normal',?,?,?)",[legacyMission,legacyUser,legacyUser,created]);
  const [before]=await legacy.query("SELECT id,title,description,status,assigned_to FROM missions ORDER BY id"), beforeHash=digest(before);
  const [cancelFks]=await legacy.query("SELECT CONSTRAINT_NAME FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA=? AND TABLE_NAME='missions' AND COLUMN_NAME='cancelled_by' AND REFERENCED_TABLE_NAME='users'",[legacyDb]);
  for(const row of cancelFks)await legacy.query(`ALTER TABLE missions DROP FOREIGN KEY \`${row.CONSTRAINT_NAME}\``);
  await legacy.query("DROP TABLE mission_task_events,mission_tasks,tracking_alert_transitions,tracking_alert_states,tracking_presence,score_ledger_backfill_state,score_ledger_entries");await legacy.end();
  migrateTwice(legacyDb);await verify(legacyDb);
  const upgraded=await mysql.createConnection({host,port,user,password,database:legacyDb});const [after]=await upgraded.query("SELECT id,title,description,status,assigned_to FROM missions ORDER BY id");await upgraded.end();
  assert.equal(after.length,before.length);assert.equal(digest(after),beforeHash,"legacy rows changed during upgrade");
  console.log(`Database integration passed for ${freshDb} and ${legacyDb}`);
}finally{
  await root.query(`DROP DATABASE IF EXISTS \`${freshDb}\``).catch(()=>undefined);await root.query(`DROP DATABASE IF EXISTS \`${legacyDb}\``).catch(()=>undefined);await root.end();
}
