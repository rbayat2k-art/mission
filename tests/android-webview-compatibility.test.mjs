import assert from "node:assert/strict";
import { readFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

const native = new URL("../android/app/src/main/java/ir/taprasystem/employee/", import.meta.url);
const activitySource = () => readFile(new URL("MainActivity.java", native), "utf8");
const method = (source, start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));

test("compiled native WebView policy rejects obsolete/unknown engines and keeps battery first", async t => {
  const javaHome = process.env.TAPRA_TEST_JAVA_HOME || process.env.JAVA_HOME;
  const executable = name => javaHome ? join(javaHome, "bin", `${name}${process.platform === "win32" ? ".exe" : ""}`) : name;
  const probe = spawnSync(executable("javac"), ["-version"], { encoding: "utf8" });
  if (probe.error?.code === "ENOENT") return t.skip("JDK compiler unavailable; set TAPRA_TEST_JAVA_HOME for native policy tests");
  assert.equal(probe.status, 0, probe.stderr);
  const output = await mkdtemp(join(tmpdir(), "tapra-webview-compatibility-"));
  const compiled = spawnSync(executable("javac"), ["-encoding", "UTF-8", "-d", output,
    fileURLToPath(new URL("WebViewCompatibility.java", native)),
    fileURLToPath(new URL("android/WebViewCompatibilityTest.java", import.meta.url)),
  ], { encoding: "utf8" });
  assert.equal(compiled.status, 0, compiled.stderr);
  const result = spawnSync(executable("java"), ["-cp", output, "ir.taprasystem.employee.WebViewCompatibilityTest"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /WebView compatibility assertions passed: \d+/);
});

test("native gate reads the actual instance UA before loading and rechecks lifecycle/navigation", async () => {
  const activity = await activitySource();
  assert.match(activity, /String actualWebViewUserAgent = actualWebViewUserAgent\(webView\)/);
  const actualUserAgent = method(activity, "private String actualWebViewUserAgent", "private boolean canUseWebContent");
  assert.match(actualUserAgent, /return view\.getSettings\(\)\.getUserAgentString\(\)/);
  assert.match(actualUserAgent, /catch \(RuntimeException unavailableEngine\)\s*\{\s*return null;/);
  const requirements = method(activity, "private boolean enforceApplicationRequirements()", "private boolean canUseWebContent");
  assert.match(requirements, /WebViewCompatibility\.startupGate\(batteryExempt,\s*batteryExempt \? actualWebViewUserAgent\(webView\) : null\)/);
  assert.ok(requirements.indexOf("Gate.BATTERY_REQUIRED") < requirements.indexOf("Gate.WEBVIEW_UPDATE_REQUIRED"));
  assert.ok(requirements.indexOf("showWebViewUpdateRequirement()") < requirements.indexOf("webView.setVisibility(View.VISIBLE)"));
  const load = method(activity, "private void loadApplication", "private String currentSafeUrl");
  assert.ok(load.indexOf("if (!enforceApplicationRequirements()) return;") < load.indexOf("webView.loadUrl"));
  const resume = method(activity, "protected void onResume()", "protected void onNewIntent");
  assert.match(resume, /boolean recheckRestoredPage = batteryGateVisible && applicationLoadStarted;/);
  assert.ok(resume.indexOf("if (!enforceBatteryAccessGate()) return;") < resume.indexOf("webView.onResume()"));
  assert.match(resume, /else if \(recheckRestoredPage\) recheckPageAfterBatteryGate\(\)/);
  assert.match(method(activity, "protected void onNewIntent", "protected void onPause"), /if \(enforceBatteryAccessGate\(\)\) loadApplication/);
  assert.match(method(activity, "public void onBackPressed", "protected void onDestroy"), /canUseWebContent\(webView\) && webView\.canGoBack\(\)/);
  assert.match(method(activity, "private boolean openExternalWhenNeeded", "private boolean isTrustedWebOrigin"), /if \(!enforceApplicationRequirements\(\)\) return true;/);
});

test("blocked callbacks cannot hide the native gate, recover the page, or clear user data", async () => {
  const activity = await activitySource();
  const verify = method(activity, "private void verifyRenderedPage", "private void scheduleLoadWatchdog");
  assert.equal((verify.match(/if \(mainFrameFailed \|\| !canUseWebContent\(view\)\) return;/g) || []).length, 2);
  assert.match(verify, /if \(verifiedPageGeneration != pageLoadGeneration\) return;/);
  assert.match(activity, /if \(completedPageGeneration == pageLoadGeneration\) verifyRenderedPage\(view\)/);
  const recovery = method(activity, "private void recoverFromBlankPage", "private void loadApplication");
  assert.ok(recovery.indexOf("if (!canUseWebContent(webView)) return;") < recovery.indexOf("webView.clearCache"));
  for (const signature of ["private void showLoading", "private void showLoadError"]) {
    assert.match(activity.slice(activity.indexOf(signature)), /^[^{]+\{\s*if \(!canUseWebContent\(webView\)\) return;/);
  }
  const blocked = method(activity, "private void showWebViewUpdateRequirement", "private void showBatteryRequirement");
  assert.match(blocked, /نمایشگر وب گوشی نیاز به به‌روزرسانی دارد/);
  assert.match(blocked, /کامل ببندید و دوباره باز کنید/);
  assert.match(blocked, /webView\.stopLoading\(\)/);
  assert.match(blocked, /webView\.onPause\(\)/);
  assert.match(blocked, /WebViewCompatibility\.UPDATE_URL/);
  assert.doesNotMatch(blocked, /clearCache|clearHistory|CookieManager|WebStorage|getSharedPreferences|setTrackingActive|loadApplication|loadUrl/);
  const battery = method(activity, "private void showBatteryRequirement", "private int dp");
  assert.doesNotMatch(battery, /stopLoading|onPause|clearCache|clearHistory/);
  assert.match(battery, /if \(!batteryGateVisible\) pageLoadGeneration\+\+/);
  assert.match(blocked, /if \(!webViewCompatibilityGateVisible\) pageLoadGeneration\+\+/);
  assert.match(activity, /view\.destroy\(\);\s*if \(view == webView\) webView = null;/);
  assert.match(activity, /webView\.post\(\(\) -> \{\s*if \(canUseWebContent\(webView\)\) webView\.evaluateJavascript\("window\.location\.reload\(\)"/);
  const eligibility = method(activity, "private boolean canUseWebContent", "private void showWebViewUpdateRequirement");
  assert.match(eligibility, /!isFinishing\(\) && !isDestroyed\(\)/);
  assert.match(eligibility, /!batteryGateVisible && !webViewCompatibilityGateVisible/);
});

test("restoring the battery gate rechecks and rearms the current page without hard reload", async () => {
  const activity = await activitySource();
  const recheck = method(activity, "private void recheckPageAfterBatteryGate", "protected void onNewIntent");
  assert.match(recheck, /if \(!canUseWebContent\(webView\)\) return;/);
  assert.match(recheck, /mainFrameFailed = false/);
  assert.match(recheck, /scheduleLoadWatchdog\(\)/);
  assert.match(recheck, /if \(webView\.getProgress\(\) == 100\) verifyRenderedPage\(webView\)/);
  assert.doesNotMatch(recheck, /loadUrl|loadApplication|\.reload\(|clearCache|CookieManager|WebStorage/);
  const load = method(activity, "private void loadApplication", "private String currentSafeUrl");
  assert.match(load, /pageLoadGeneration\+\+/);
  const started = method(activity, "public void onPageStarted", "public void onPageCommitVisible");
  assert.match(started, /pageLoadGeneration\+\+/);
});

test("TLS failures remain fail-closed and explain system trust and updates", async () => {
  const activity = await activitySource();
  const ssl = method(activity, "public void onReceivedSslError", "public boolean onRenderProcessGone");
  assert.match(ssl, /handler\.cancel\(\)/);
  assert.match(ssl, /گواهی‌های مورد اعتماد سیستم/);
  assert.match(ssl, /به‌روزرسانی Android و Android System WebView/);
  assert.doesNotMatch(activity, /handler\.proceed\(|SslErrorHandler[^;]*\.proceed\(/);
  assert.match(activity, /MIXED_CONTENT_NEVER_ALLOW/);
});
