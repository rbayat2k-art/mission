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

test("both migrated CI schemas gate the real assignee history SQL without allowing fallback", async () => {
  const [harness, integration] = await Promise.all([
    read("./integration/mysql-schema.mjs"), read("./integration/mission-assignee-history.mjs"),
  ]);
  assert.match(harness, /import \{ verifyMissionAssigneeHistory \} from "\.\/mission-assignee-history\.mjs"/);
  assert.match(harness, /await verifyMissionAssigneeHistory\(db\)/);
  assert.match(harness, /await verify\(freshDb\)/);
  assert.match(harness, /await verify\(legacyDb\)/);
  assert.match(integration, /app\/api\/missions\/assignees\/route\.ts/);
  assert.match(integration, /await connection\.execute\(sql, this\.args\)/);
  assert.match(integration, /assert\.equal\(payload\.orderMode, "recent"/);
  assert.match(integration, /await connection\.beginTransaction\(\)/);
  assert.match(integration, /finally \{\s+await connection\.rollback\(\)/);
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
  const runtime=await read("../db/runtime.ts");
  assert.match(runtime,/process\.env\.NODE_ENV !== "production" && process\.env\.AUTO_MIGRATE === "true"/);
});

test("Android UI tooling recovery cannot bypass application assertions", async () => {
  const workflow = await read("../.github/workflows/android-apk.yml");
  assert.match(workflow, /python3 -B -m unittest discover -s tests\/android -p 'test_capture\*\.py' -v/);
  assert.match(workflow, /capture_app_ui\.py tapra-battery-gate-api-.* --expect battery/);
  assert.match(workflow, /capture_app_ui\.py tapra-ui-api-.* --expect page/);
  assert.doesNotMatch(workflow, /adb shell uiautomator dump|capture_app_ui[^\n]*\|\| true|continue-on-error/);
  assert.match(workflow, /grep -q "تنظیم باتری برای ورود الزامی است"/);
  assert.match(workflow, /FATAL EXCEPTION/);
  assert.match(workflow, /if grep -Eq "صفحه سامانه بارگذاری نشد\|در حال بازکردن راهکار"/);
  assert.match(workflow, /Preserve emulator UI evidence\s+if: always\(\)/);
});
