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

test("automatic Android CI stays read-only, branch-complete, local-backend-only and never publishes",async()=>{
  const [workflow,gradle,manifest,main,service,notifications,readme]=await Promise.all([
    read("../.github/workflows/android-apk.yml"),read("../android/app/build.gradle"),read("../android/app/src/main/AndroidManifest.xml"),
    read("../android/app/src/main/java/ir/taprasystem/employee/MainActivity.java"),read("../android/app/src/main/java/ir/taprasystem/employee/LocationTrackingService.java"),
    read("../android/app/src/main/java/ir/taprasystem/employee/NativeNotificationHelper.java"),read("../android/README.md"),
  ]);
  assert.match(workflow,/branches: \[main, "codex\/\*\*"\]/);
  assert.match(workflow,/permissions:\s+contents: read/);
  assert.doesNotMatch(workflow,/gh release|contents: write|\bpublish:/);
  const automatic=workflow.slice(workflow.indexOf("  build-debug:"),workflow.indexOf("  release-build:"));
  assert.match(automatic,/api-level: \[23, 29, 35\]/);
  assert.match(automatic,/tapraDebugBackendUrl=http:\/\/10\.0\.2\.2:3000/);
  assert.match(automatic,/mariadb:10\.11/);
  assert.equal((automatic.match(/inputs\.signed_release_asset_id == '' && inputs\.signed_release_apk_base64 == '' && inputs\.signed_release_sha256 == ''/g)||[]).length,2);
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

test("Android UI capture preserves battery and startup gates after recovered tooling failures",async()=>{
  const source=await read("../.github/workflows/android-apk.yml");
  const workflow=source.slice(source.indexOf("  build-debug:"),source.indexOf("  release-build:"));
  assert.match(workflow,/python3 -B -m unittest discover -s tests\/android -p 'test_capture_ui\.py' -v/);
  assert.equal((workflow.match(/python3 -B scripts\/android\/capture_ui\.py /g)||[]).length,2);
  assert.match(workflow,/capture_ui\.py tapra-battery-gate-api/);
  assert.match(workflow,/grep -q "تنظیم باتری برای ورود الزامی است" tapra-battery-gate-api/);
  assert.match(workflow,/deviceidle whitelist \+ir\.taprasystem\.employee/);
  const finalCapture=workflow.slice(workflow.indexOf("capture_ui.py tapra-ui-api"));
  assert.match(finalCapture,/صفحه سامانه بارگذاری نشد\|در حال بازکردن راهکار/);
  assert.match(finalCapture,/verify_login_screen\.py --xml tapra-ui-api/);
  assert.match(finalCapture,/--expect "\$\{\{ matrix\.api-level == 35 && 'login' \|\| 'obsolete-webview' \}\}"/);
  assert.match(finalCapture,/adb logcat -d -t 800 > android-logcat-post-capture-api/);
  assert.match(finalCapture,/FATAL EXCEPTION/);
  assert.match(finalCapture,/adb shell dumpsys activity activities \| grep -q "ir\.taprasystem\.employee\/\.MainActivity"/);
});

test("production release CI builds and exports only an unsigned, production-configured APK for local signing",async()=>{
  const workflow=await read("../.github/workflows/android-apk.yml");
  const release=workflow.slice(workflow.indexOf("  release-build:"),workflow.indexOf("  signed-release-smoke:"));
  assert.match(release,/inputs\.signed_release_asset_id == '' && inputs\.signed_release_apk_base64 == '' && inputs\.signed_release_sha256 == ''/);
  assert.match(release,/java-version: "17"/);
  assert.match(release,/gradle-version: "8\.11\.1"/);
  assert.match(release,/-PtapraBackendUrl=https:\/\/taprasystem\.ir :app:lintRelease :app:testReleaseUnitTest :app:assembleRelease/);
  for(const check of [
    'public static final boolean DEBUG = false;',
    'public static final String BASE_URL = "https://taprasystem.ir";',
    'public static final String APPLICATION_ID = "ir.taprasystem.employee";',
    'public static final int VERSION_CODE = 23;',
    'public static final String VERSION_NAME = "1.2.4";',
  ]) assert.ok(release.includes(check),`Missing generated release config assertion: ${check}`);
  assert.match(release,/aapt" dump badging "\$apk"/);
  assert.match(release,/aapt" dump xmltree "\$apk" AndroidManifest\.xml/);
  assert.match(release,/sdkVersion:'23'/);
  assert.match(release,/targetSdkVersion:'35'/);
  assert.match(release,/\^application-debuggable/);
  assert.match(release,/android:usesCleartextTraffic/);
  assert.match(release,/sha256sum tapra-employee-release-unsigned\.apk/);
  assert.match(release,/name: tapra-employee-release-unsigned-\$\{\{ github\.sha \}\}/);
  assert.match(release,/signed=false/);
  assert.doesNotMatch(release,/\$\{\{\s*secrets\.|\bkeytool\b|apksigner"?\s+sign\b|--ks\b|--key-pass\b|--ks-pass\b|gh release|contents: write/);
});

test("signed release smoke accepts only explicit validated public APK sources without signing secrets",async()=>{
  const workflow=await read("../.github/workflows/android-apk.yml");
  const preparation=await read("../scripts/android/prepare_signed_apk.py");
  const release=workflow.slice(workflow.indexOf("  signed-release-smoke:"));
  assert.match(workflow,/workflow_dispatch:\s+inputs:\s+signed_release_asset_id:/);
  assert.match(release,/github\.event_name == 'workflow_dispatch'/);
  assert.match(release,/inputs\.signed_release_asset_id != '' \|\| inputs\.signed_release_apk_base64 != '' \|\| inputs\.signed_release_sha256 != ''/);
  assert.match(release,/SIGNED_RELEASE_SHA256: \$\{\{ inputs\.signed_release_sha256 \}\}/);
  assert.match(preparation,/re\.fullmatch\(r"\[1-9\]\[0-9\]\{0,19\}", asset\)/);
  assert.match(preparation,/re\.fullmatch\(r"\[0-9a-fA-F\]\{64\}", checksum\)/);
  assert.match(preparation,/REPOSITORY = "rbayat2k-art\/mission"/);
  assert.match(preparation,/os\.environ\.get\("GITHUB_EVENT_PATH", ""\)/);
  assert.match(preparation,/bool\(asset\) == bool\(payload\)/);
  assert.match(preparation,/base64\.b64decode\(payload, validate=True\)/);
  assert.match(preparation,/MAX_ENCODED_CHARS = 64_000/);
  assert.match(preparation,/MAX_PAYLOAD_BYTES = 48_000/);
  assert.match(preparation,/APPROVED_PAYLOAD_SHA256 = "2f4b707a78b7157f6577b77541ad6c2f923bfa67a060ab4d5ad866acc54b04ac"/);
  assert.match(preparation,/"AndroidManifest\.xml", "classes\.dex"/);
  assert.match(release,/GH_TOKEN: \$\{\{ github\.token \}\}/);
  assert.match(release,/GH_HOST: github\.com/);
  assert.match(preparation,/"gh", "api", "--hostname", "github\.com"/);
  assert.match(preparation,/f"repos\/\{REPOSITORY\}\/releases\/assets\/\{asset\}"/);
  assert.match(release,/python3 -B scripts\/android\/prepare_signed_apk\.py/);
  assert.match(release,/python3 -B -m unittest discover -s tests\/android -p 'test_prepare_signed_apk\.py' -v/);
  assert.equal((release.match(/sha256sum --check --strict/g)||[]).length,1);
  assert.doesNotMatch(release,/\w+: \$\{\{ inputs\.signed_release_apk_base64 \}\}/);
  assert.doesNotMatch(release,/\$\{\{\s*secrets\.|\bkeytool\b|apksigner"?\s+sign\b|--ks\b|--key-pass\b|--ks-pass\b|\bgradle\b/);
  assert.doesNotMatch(release,/\b(?:adb\s+uninstall|pm\s+(?:uninstall|clear))\b/);
  assert.doesNotMatch(release,/\b(?:curl|fetch|POST|PATCH|DELETE)\b|DB_PASSWORD|INITIAL_ADMIN_PASSWORD/);
  const steps=release.slice(release.indexOf("    steps:"));
  assert.doesNotMatch(steps,/\$\{\{\s*inputs\./);
  const upload=release.slice(release.indexOf("      - name: Retain non-secret"));
  assert.doesNotMatch(upload,/path:[\s\S]*\.apk/);
});

test("signed release smoke checks exact final manifest, signature, and packaged HTTPS-only policy",async()=>{
  const workflow=await read("../.github/workflows/android-apk.yml");
  const release=workflow.slice(workflow.indexOf("  signed-release-smoke:"));
  assert.match(release,/apksigner" verify --verbose --print-certs --min-sdk-version 23 apk\/final\.apk/);
  assert.match(release,/resources value --config default --name network_security_config --type xml apk\/final\.apk/);
  assert.match(release,/"\$network_config" =~ \^res\/\[A-Za-z0-9_\/-\]\+\\\.xml\$/);
  assert.match(release,/resources xml --file "\$network_config" apk\/final\.apk/);
  assert.doesNotMatch(release,/resources xml --file \/?res\/xml\/network_security_config\.xml/);
  for(const assertion of [
    "manifest.get('package') == 'ir.taprasystem.employee'",
    "manifest.get(android + 'versionCode') == '23'",
    "manifest.get(android + 'versionName') == '1.2.4'",
    "sdk.get(android + 'minSdkVersion') == '23'",
    "sdk.get(android + 'targetSdkVersion') == '35'",
    "app.get(android + 'debuggable', 'false') == 'false'",
    "app.get(android + 'testOnly', 'false') == 'false'",
    "app.get(android + 'usesCleartextTraffic') == 'false'",
    "app.get(android + 'allowBackup') == 'false'",
    "len(network) == 1 and network[0].tag == 'base-config'",
    "network[0].get('cleartextTrafficPermitted') == 'false'",
    "len(certificates) == 1 and certificates[0].get('src') == 'system'",
  ]) assert.ok(release.includes(assertion),`Missing release policy: ${assertion}`);
});

test("signed APK smoke is disposable-emulator-only and preserves identity and grants on same-key replacement",async()=>{
  const workflow=await read("../.github/workflows/android-apk.yml");
  const release=workflow.slice(workflow.indexOf("  signed-release-smoke:"));
  assert.match(release,/api-level: \[23, 29, 35\]/);
  assert.match(release,/force-avd-creation: true/);
  assert.match(release,/-no-snapshot/);
  assert.match(release,/getprop ro\.kernel\.qemu/);
  assert.match(release,/Expected a fresh emulator with no TAPRA installation/);
  assert.equal((release.match(/adb install apk\/final\.apk/g)||[]).length,1);
  assert.equal((release.match(/adb install -r apk\/final\.apk/g)||[]).length,1);
  assert.match(release,/pm grant ir\.taprasystem\.employee android\.permission\.ACCESS_COARSE_LOCATION/);
  assert.match(release,/pm grant ir\.taprasystem\.employee android\.permission\.ACCESS_FINE_LOCATION/);
  assert.match(release,/\[ "\$TEST_API_LEVEL" -ge 33 \]; then adb shell pm grant ir\.taprasystem\.employee android\.permission\.POST_NOTIFICATIONS/);
  assert.match(release,/capture_ui\.py apk\/signed-release-battery\.xml/);
  assert.match(release,/grep -q "تنظیم باتری برای ورود الزامی است" apk\/signed-release-battery\.xml/);
  for(const stage of ["before","after"]){
    assert.ok(release.includes(`capture_ui.py apk/signed-release-login-${stage}.xml`));
    assert.ok(release.includes(`verify_login_screen.py --xml apk/signed-release-login-${stage}.xml --png apk/signed-release-screen-${stage}.png`));
    assert.ok(release.includes(`"صفحه سامانه بارگذاری نشد|در حال بازکردن راهکار" apk/signed-release-login-${stage}.xml`));
    assert.ok(release.includes(`"FATAL EXCEPTION" apk/signed-release-logcat-${stage}.txt`));
  }
  for(const state of ["uid","permissions","whitelist"]){
    assert.ok(release.includes(`cmp apk/signed-release-${state}-before.txt apk/signed-release-${state}-after.txt`));
  }
  assert.match(release,/python3 -B -m unittest discover -s tests\/android -p 'test_package_identity\.py' -v/);
  for(const stage of ["before","after"]){
    assert.ok(release.includes(`adb shell dumpsys activity activities > apk/signed-release-android-user-${stage}.txt`));
    assert.ok(release.includes(`package_identity.py apk/signed-release-package-${stage}.txt apk/signed-release-android-user-${stage}.txt > apk/signed-release-uid-${stage}.txt`));
  }
  assert.doesNotMatch(release,/sed -n 's\/\^\[\[:space:\]\]\*userId=/);
  assert.doesNotMatch(release,/adb shell am get-current-user/);
  const replacement=release.slice(release.indexOf("            adb install -r apk/final.apk"));
  assert.doesNotMatch(replacement,/pm grant|whitelist \+|am force-stop/);
  const afterLaunch=replacement.indexOf("adb shell am start -W");
  const afterScreen=replacement.indexOf("verify_login_screen.py --xml apk/signed-release-login-after.xml");
  const afterForeground=replacement.indexOf('adb shell dumpsys activity activities | grep -q "ir.taprasystem.employee/.MainActivity"');
  const afterUserCapture=replacement.indexOf("adb shell dumpsys activity activities > apk/signed-release-android-user-after.txt");
  const afterIdentityComparison=replacement.indexOf("cmp apk/signed-release-uid-before.txt apk/signed-release-uid-after.txt");
  assert.ok(afterLaunch>=0&&afterScreen>afterLaunch&&afterForeground>afterScreen&&afterUserCapture>afterForeground&&afterIdentityComparison>afterUserCapture,
    "Replacement kills the app: prove its foreground user only after relaunch and positive screen verification");
  for(const immediateCheck of [
    "adb shell dumpsys package ir.taprasystem.employee > apk/signed-release-package-after.txt",
    "cmp apk/signed-release-permissions-before.txt apk/signed-release-permissions-after.txt",
    "cmp apk/signed-release-whitelist-before.txt apk/signed-release-whitelist-after.txt",
  ])assert.ok(replacement.indexOf(immediateCheck)>=0&&replacement.indexOf(immediateCheck)<afterLaunch,
    "Replacement package, grants and whitelist evidence must be checked before relaunch");
  assert.equal((release.match(/adb shell dumpsys activity activities \| grep -q "ir\.taprasystem\.employee\/\.MainActivity"/g)||[]).length,2);
});

test("screen verification distinguishes actual API35 login from stock obsolete-WebView rejection",async()=>{
  const [workflow,helper]=await Promise.all([read("../.github/workflows/android-apk.yml"),read("../scripts/android/verify_login_screen.py")]);
  assert.equal((workflow.match(/verify_login_screen\.py --xml /g)||[]).length,3);
  assert.equal((workflow.match(/--expect "\$\{\{ matrix\.api-level == 35 && 'login' \|\| 'obsolete-webview' \}\}"/g)||[]).length,3);
  assert.equal((workflow.match(/stock obsolete-WebView rejection/g)||[]).length,2);
  assert.equal((workflow.match(/python3 -B -m unittest discover -s tests\/android -p 'test_verify_login_screen\.py' -v/g)||[]).length,2);
  assert.equal((workflow.match(/adb shell dumpsys webviewupdate/g)||[]).length,3);
  assert.match(workflow,/if: matrix\.api-level == 35\s+run: sudo apt-get update && sudo apt-get install --no-install-recommends -y tesseract-ocr tesseract-ocr-fas tesseract-ocr-eng/);
  assert.match(workflow,/android-screen-api-\*\.ocr\.txt/);
  for(const label of ["ورود به پنل کارمند","نام کاربری","رمز عبور","ورود به پنل","نمایشگر وب گوشی نیاز به به‌روزرسانی دارد"])assert.ok(helper.includes(label));
  assert.match(helper,/"fas\+eng", "--psm", "11"/);
  assert.match(helper,/successful login compatibility is NOT established/);
  assert.doesNotMatch(workflow,/adb exec-out screencap -p >/);
});
