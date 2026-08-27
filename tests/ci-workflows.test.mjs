import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read=(path)=>readFile(new URL(path,import.meta.url),"utf8");

test("database CI gates MariaDB 10.11 and MySQL 8.4 with the real migration harness",async()=>{
  const [workflow,harness,migration,schema]=await Promise.all([read("../.github/workflows/verify.yml"),read("./integration/mysql-schema.mjs"),read("../scripts/migrate.mjs"),read("../db/mysql-schema.sql")]);
  assert.match(workflow,/image: mariadb:10\.11/);
  assert.match(workflow,/image: mysql:8\.4/);
  assert.equal((workflow.match(/node tests\/integration\/mysql-schema\.mjs/g)||[]).length,2);
  assert.match(harness,/migrateTwice\(freshDb\)/);
  assert.match(harness,/migrateTwice\(legacyDb\)/);
  assert.match(harness,/backfill second run changed ledger/);
  assert.match(harness,/legacy rows changed during upgrade/);
  assert.match(migration,/fk_missions_cancelled_by/);
  assert.match(schema,/CONSTRAINT fk_missions_cancelled_by FOREIGN KEY \(cancelled_by\)/);
});

test("Android CI is read-only, branch-complete, local-backend-only and never publishes",async()=>{
  const [workflow,gradle,manifest,main,service,notifications,readme]=await Promise.all([
    read("../.github/workflows/android-apk.yml"),read("../android/app/build.gradle"),read("../android/app/src/main/AndroidManifest.xml"),
    read("../android/app/src/main/java/ir/taprasystem/employee/MainActivity.java"),read("../android/app/src/main/java/ir/taprasystem/employee/LocationTrackingService.java"),
    read("../android/app/src/main/java/ir/taprasystem/employee/NativeNotificationHelper.java"),read("../android/README.md"),
  ]);
  assert.match(workflow,/branches: \[main, "codex\/\*\*"\]/);
  assert.match(workflow,/permissions:\s+contents: read/);
  assert.doesNotMatch(workflow,/gh release|contents: write|\bpublish:/);
  assert.match(workflow,/api-level: \[23, 29, 35\]/);
  assert.match(workflow,/tapraDebugBackendUrl=http:\/\/10\.0\.2\.2:3000/);
  assert.match(workflow,/mariadb:10\.11/);
  assert.match(gradle,/buildConfigField 'String', 'BASE_URL'/);
  assert.match(manifest,/usesCleartextTraffic="\$\{usesCleartextTraffic\}"/);
  for(const source of [main,service,notifications])assert.match(source,/BuildConfig\.BASE_URL/);
  assert.match(readme,/APK گردش‌کار CI یک خروجی Debug آزمایشی است/);
});

test("automatic runtime migration is disabled in deployment examples",async()=>{
  for(const source of [await read("../.env.example"),await read("../deploy/CPANEL_DEPLOYMENT.md")])assert.match(source,/AUTO_MIGRATE=false/);
});
