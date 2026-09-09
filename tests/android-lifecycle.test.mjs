import assert from "node:assert/strict";
import { readFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

const native = new URL("../android/app/src/main/java/ir/taprasystem/employee/",import.meta.url);

test("native lifecycle rejects late replies after account/shift changes and process destruction", async t => {
  const javaHome = process.env.TAPRA_TEST_JAVA_HOME || process.env.JAVA_HOME;
  const executable = name => javaHome ? join(javaHome,"bin",`${name}${process.platform === "win32" ? ".exe" : ""}`) : name;
  const probe = spawnSync(executable("javac"),["-version"],{encoding:"utf8"});
  if (probe.error?.code === "ENOENT") return t.skip("JDK compiler unavailable; set TAPRA_TEST_JAVA_HOME for native policy tests");
  assert.equal(probe.status,0,probe.stderr);
  const output = await mkdtemp(join(tmpdir(),"tapra-native-lifecycle-"));
  const compiled = spawnSync(executable("javac"),["-encoding","UTF-8","-d",output,
    fileURLToPath(new URL("TrackingRequestScope.java",native)),
    fileURLToPath(new URL("android/TrackingRequestScopeTest.java",import.meta.url)),
  ],{encoding:"utf8"});
  assert.equal(compiled.status,0,compiled.stderr);
  const result = spawnSync(executable("java"),["-cp",output,"ir.taprasystem.employee.TrackingRequestScopeTest"],{encoding:"utf8"});
  assert.equal(result.status,0,result.stderr);
  assert.match(result.stdout,/lifecycle assertions passed/);
});

test("Android runtime asks for paired location permissions and registers disabled GPS providers", async () => {
  const activity = await readFile(new URL("MainActivity.java",native),"utf8");
  const service = await readFile(new URL("LocationTrackingService.java",native),"utf8");
  assert.match(activity,/permissions\.add\(Manifest\.permission\.ACCESS_FINE_LOCATION\);\s*permissions\.add\(Manifest\.permission\.ACCESS_COARSE_LOCATION\)/);
  const registration = service.slice(service.indexOf("private void startTracking()"),service.indexOf("public void onLocationChanged"));
  assert.match(registration,/getAllProviders\(\)\.contains\(LocationManager\.GPS_PROVIDER\)/);
  assert.doesNotMatch(registration,/isProviderEnabled/);
});

test("native network replies preserve dispatch identity through headers, queue acknowledgements and notifications", async () => {
  const service = await readFile(new URL("LocationTrackingService.java",native),"utf8");
  const notifications = await readFile(new URL("NativeNotificationHelper.java",native),"utf8");
  assert.match(service,/removeTerminal\(response, scope\.userId\)/);
  assert.match(service,/postJson\(HEARTBEAT_ENDPOINT, requestBody\.toString\(\), cookies, scope\.userId\)/);
  assert.match(service,/if \(isCurrentRequest\(scope\)\) stopTrackingForServerEnd\(\)/);
  assert.match(service,/if \(isCurrentRequest\(scope\)\) stopTracking\(false\)/);
  assert.match(service,/NativeNotificationHelper\.showForUser\(\s*this,\s*scope\.userId/);
  assert.match(notifications,/static synchronized boolean showForUser/);
  assert.match(notifications,/!expectedUserId\.equals\(activeUserId\(context\)\)/);
});
