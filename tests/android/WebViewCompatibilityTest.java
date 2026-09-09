package ir.taprasystem.employee;

public final class WebViewCompatibilityTest {
    private static int assertions;

    private static void check(boolean value, String message) {
        assertions++;
        if (!value) throw new AssertionError(message);
    }

    private static String userAgent(String androidVersion, String chromiumVersion) {
        return "Mozilla/5.0 (Linux; Android " + androidVersion + "; Phone Build/TEST; wv) "
            + "AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/" + chromiumVersion
            + " Mobile Safari/537.36 TapraAndroid/1.2.4";
    }

    public static void main(String[] args) {
        String api23 = userAgent("6.0", "44.0.2403.119");
        String api29 = userAgent("10", "74.0.3729.185");
        String api35 = userAgent("15", "124.0.6367.82");
        check(WebViewCompatibility.chromiumMajor(api23) == 44, "API23 actual engine not parsed");
        check(WebViewCompatibility.chromiumMajor(api29) == 74, "API29 actual engine not parsed");
        check(WebViewCompatibility.chromiumMajor(api35) == 124, "API35 actual engine not parsed");
        check(!WebViewCompatibility.meetsMinimumEngineVersion(api23), "stock API23 engine accepted");
        check(!WebViewCompatibility.meetsMinimumEngineVersion(api29), "stock API29 engine accepted");
        check(WebViewCompatibility.meetsMinimumEngineVersion(api35), "modern engine rejected");
        check(!WebViewCompatibility.meetsMinimumEngineVersion(userAgent("15", "79.0.0.0")),
            "Android OS version bypassed the actual engine floor");
        check(WebViewCompatibility.meetsMinimumEngineVersion(userAgent("6.0", "80.0.0.0")),
            "updated engine was rejected just because Android is old");
        check(WebViewCompatibility.MINIMUM_CHROMIUM_MAJOR == 80, "known-obsolete floor changed");

        String[] unknown = { null, "", " ", "Mozilla/5.0 Version/4.0 Safari/537.36",
            "NotChrome/124.0", "Chromium/124.0", "Chrome/", "Chrome/-80.0", "Chrome/80.bad",
            "Chrome/80.0evil", "Chrome/80.0.0.0.1", "Chrome/999999999999999999999.0",
            "Chrome/74.0 Chrome/124.0", "Chrome/124.0 Chrome/124.0" };
        for (String value : unknown) {
            check(WebViewCompatibility.chromiumMajor(value) == -1, "unknown UA was parsed: " + value);
            check(!WebViewCompatibility.meetsMinimumEngineVersion(value), "unknown UA accepted: " + value);
        }
        check(WebViewCompatibility.chromiumMajor("Chrome/80") == 80, "major-only token not parsed");

        for (String value : new String[] { api23, api29, api35, null }) {
            check(WebViewCompatibility.startupGate(false, value) == WebViewCompatibility.Gate.BATTERY_REQUIRED,
                "compatibility message took priority over battery requirement");
        }
        check(WebViewCompatibility.startupGate(true, api23) == WebViewCompatibility.Gate.WEBVIEW_UPDATE_REQUIRED,
            "battery approval let old API23 WebView load");
        check(WebViewCompatibility.startupGate(true, api29) == WebViewCompatibility.Gate.WEBVIEW_UPDATE_REQUIRED,
            "battery approval let old API29 WebView load");
        check(WebViewCompatibility.startupGate(true, null) == WebViewCompatibility.Gate.WEBVIEW_UPDATE_REQUIRED,
            "unknown engine failed open");
        check(WebViewCompatibility.startupGate(true, api35) == WebViewCompatibility.Gate.READY,
            "approved battery and modern engine did not load");
        // Every resume is reevaluated: updating, revoking battery access, or losing engine identity
        // cannot reuse an earlier READY decision.
        check(WebViewCompatibility.startupGate(true, api29) != WebViewCompatibility.Gate.READY,
            "obsolete engine kept an earlier ready state");
        check(WebViewCompatibility.startupGate(true, api35) == WebViewCompatibility.Gate.READY,
            "engine update did not become eligible");
        check(WebViewCompatibility.startupGate(false, api35) == WebViewCompatibility.Gate.BATTERY_REQUIRED,
            "battery revocation did not block resume");
        check(WebViewCompatibility.startupGate(true, null) != WebViewCompatibility.Gate.READY,
            "missing engine identity reused a ready state");
        check(WebViewCompatibility.UPDATE_URL.equals(
            "https://play.google.com/store/apps/details?id=com.google.android.webview"),
            "update action is not the official Google Play WebView listing");
        System.out.println("WebView compatibility assertions passed: " + assertions);
    }
}
