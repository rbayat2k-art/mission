import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = path => readFile(new URL(path, import.meta.url), "utf8");

test("permanent Android key setup is explicit, outside Git, protected and locally backed up", async () => {
  const source = await read("../scripts/android/Initialize-TapraSigning.ps1");
  assert.match(source, /Signing material must remain outside the repository/);
  assert.match(source, /Signing target already exists/);
  assert.match(source, /SetAccessRuleProtection\(\$true, \$false\)/);
  assert.match(source, /RandomNumberGenerator/);
  assert.match(source, /Export-Clixml/);
  assert.match(source, /-storepass:env TAPRA_SIGNING_PASSWORD/);
  assert.match(source, /Copy-Item -LiteralPath \$source -Destination \$destination/);
  assert.match(source, /Signing backup verification failed/);
  assert.doesNotMatch(source, /Write-(?:Output|Host).*\$password/);
});

test("release signer fails closed and verifies identity without a signing-key fallback", async () => {
  const source = await read("../scripts/android/Sign-TapraRelease.ps1");
  assert.match(source, /No new key will be generated/);
  assert.match(source, /Release output already exists/);
  assert.match(source, /application-debuggable/);
  assert.match(source, /usesCleartextTraffic/);
  assert.match(source, /env:TAPRA_SIGNING_PASSWORD/);
  assert.match(source, /--v1-signing-enabled true --v2-signing-enabled true --v3-signing-enabled true/);
  assert.match(source, /certificate does not match the permanent signing identity/);
  assert.match(source, /--min-sdk-version 23/);
  assert.ok(source.indexOf("& $align -p 4") < source.indexOf("'\" sign --ks"));
  assert.doesNotMatch(source, /genkeypair|adb uninstall|pm clear/);
});

test("employee release backend is fixed and secret signing formats stay ignored", async () => {
  const gradle = await read("../android/app/build.gradle");
  const ignore = await read("../.gitignore");
  assert.match(gradle, /productionBackendUrl != 'https:\/\/taprasystem\.ir'/);
  assert.match(gradle, /throw new GradleException/);
  for (const suffix of ["*.jks", "*.keystore", "*.p12", "*.pfx", "*.dpapi.xml"]) {
    assert.ok(ignore.split(/\r?\n/).includes(suffix));
  }
});
