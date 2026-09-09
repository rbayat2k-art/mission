package ir.taprasystem.employee;

import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Rejects known-obsolete engines; meeting this floor is not a compatibility guarantee. */
final class WebViewCompatibility {
    static final int MINIMUM_CHROMIUM_MAJOR = 80;
    static final String UPDATE_URL =
        "https://play.google.com/store/apps/details?id=com.google.android.webview";
    private static final Pattern CHROME_VERSION = Pattern.compile(
        "(?:^|\\s)Chrome/([0-9]+)(?:\\.[0-9]+){0,3}(?=\\s|$)");

    enum Gate { BATTERY_REQUIRED, WEBVIEW_UPDATE_REQUIRED, READY }

    private WebViewCompatibility() {}

    static int chromiumMajor(String actualWebViewUserAgent) {
        if (actualWebViewUserAgent == null) return -1;
        Matcher matcher = CHROME_VERSION.matcher(actualWebViewUserAgent);
        if (!matcher.find()) return -1;
        String major = matcher.group(1);
        if (matcher.find()) return -1; // An ambiguous or overridden UA is not trusted.
        try {
            return Integer.parseInt(major);
        } catch (NumberFormatException invalidVersion) {
            return -1;
        }
    }

    static boolean meetsMinimumEngineVersion(String actualWebViewUserAgent) {
        return chromiumMajor(actualWebViewUserAgent) >= MINIMUM_CHROMIUM_MAJOR;
    }

    static Gate startupGate(boolean batteryExempt, String actualWebViewUserAgent) {
        if (!batteryExempt) return Gate.BATTERY_REQUIRED;
        return meetsMinimumEngineVersion(actualWebViewUserAgent)
            ? Gate.READY : Gate.WEBVIEW_UPDATE_REQUIRED;
    }
}
