package ir.taprasystem.employee;

import android.Manifest;
import android.app.Activity;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.Settings;
import android.view.View;
import android.webkit.CookieManager;
import android.webkit.GeolocationPermissions;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import java.util.ArrayList;
import java.util.List;

public class MainActivity extends Activity {
    private static final String APP_URL = "https://taprasystem.ir/";
    private static final int PERMISSION_REQUEST = 41;
    private static final int FILE_CHOOSER_REQUEST = 42;

    private WebView webView;
    private ValueCallback<Uri[]> filePathCallback;
    private boolean receiverRegistered;

    private final BroadcastReceiver trackingReceiver = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            if (LocationTrackingService.ACTION_SESSION_ENDED.equals(intent.getAction()) && webView != null) {
                webView.post(() -> webView.evaluateJavascript("window.location.reload()", null));
            }
        }
    };

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        configureSystemBars();
        webView = new WebView(this);
        webView.setLayoutDirection(View.LAYOUT_DIRECTION_RTL);
        setContentView(webView);
        configureWebView();
        registerTrackingReceiver();
        requestRuntimePermissions();

        if (savedInstanceState == null) {
            webView.loadUrl(APP_URL);
        } else {
            webView.restoreState(savedInstanceState);
        }
    }

    private void configureSystemBars() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR);
        }
    }

    private void configureWebView() {
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(true);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setUserAgentString(settings.getUserAgentString() + " TapraAndroid/1.0.0");
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) WebView.setSafeBrowsingEnabled(true);

        CookieManager cookies = CookieManager.getInstance();
        cookies.setAcceptCookie(true);
        cookies.setAcceptThirdPartyCookies(webView, false);

        webView.addJavascriptInterface(new AndroidBridge(), "TapraAndroid");
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return openExternalWhenNeeded(request.getUrl());
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, String url) {
                return openExternalWhenNeeded(Uri.parse(url));
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                super.onPageFinished(view, url);
                CookieManager.getInstance().flush();
                view.evaluateJavascript("window.dispatchEvent(new CustomEvent('tapra-native-ready'))", null);
            }
        });
        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onGeolocationPermissionsShowPrompt(String origin, GeolocationPermissions.Callback callback) {
                boolean trusted = origin != null && (origin.equals("https://taprasystem.ir") || origin.equals("https://www.taprasystem.ir"));
                boolean granted = trusted && hasLocationPermission();
                callback.invoke(origin, granted, false);
                if (trusted && !granted) requestRuntimePermissions();
            }

            @Override
            public boolean onShowFileChooser(WebView webView, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (filePathCallback != null) filePathCallback.onReceiveValue(null);
                filePathCallback = callback;
                Intent intent = params.createIntent();
                intent.setAction(Intent.ACTION_OPEN_DOCUMENT);
                intent.addCategory(Intent.CATEGORY_OPENABLE);
                intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
                try {
                    startActivityForResult(intent, FILE_CHOOSER_REQUEST);
                } catch (Exception error) {
                    filePathCallback = null;
                    Toast.makeText(MainActivity.this, "انتخاب فایل در این گوشی در دسترس نیست", Toast.LENGTH_LONG).show();
                    return false;
                }
                return true;
            }
        });
        webView.setDownloadListener((url, userAgent, contentDisposition, mimeType, contentLength) -> {
            try {
                startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
            } catch (Exception error) {
                Toast.makeText(this, "برنامه‌ای برای بازکردن فایل پیدا نشد", Toast.LENGTH_LONG).show();
            }
        });
    }

    private boolean openExternalWhenNeeded(Uri uri) {
        String host = uri.getHost();
        boolean trusted = "https".equalsIgnoreCase(uri.getScheme()) &&
            ("taprasystem.ir".equalsIgnoreCase(host) || "www.taprasystem.ir".equalsIgnoreCase(host));
        if (trusted) return false;
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, uri));
        } catch (Exception error) {
            Toast.makeText(this, "بازکردن این پیوند ممکن نیست", Toast.LENGTH_SHORT).show();
        }
        return true;
    }

    private void requestRuntimePermissions() {
        List<String> permissions = new ArrayList<>();
        if (!hasLocationPermission()) permissions.add(Manifest.permission.ACCESS_FINE_LOCATION);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            permissions.add(Manifest.permission.POST_NOTIFICATIONS);
        }
        if (!permissions.isEmpty()) requestPermissions(permissions.toArray(new String[0]), PERMISSION_REQUEST);
    }

    private boolean hasLocationPermission() {
        return checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED ||
            checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED;
    }

    private void setTrackingActive(boolean active) {
        if (active && !hasLocationPermission()) {
            requestRuntimePermissions();
            Toast.makeText(this, "برای ثبت فعالیت، دسترسی موقعیت دقیق را مجاز کنید", Toast.LENGTH_LONG).show();
            return;
        }
        Intent serviceIntent = new Intent(this, LocationTrackingService.class)
            .setAction(active ? LocationTrackingService.ACTION_START : LocationTrackingService.ACTION_STOP);
        if (active && Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) startForegroundService(serviceIntent);
        else startService(serviceIntent);
    }

    private void registerTrackingReceiver() {
        IntentFilter filter = new IntentFilter(LocationTrackingService.ACTION_SESSION_ENDED);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            registerReceiver(trackingReceiver, filter, Context.RECEIVER_NOT_EXPORTED);
        } else {
            registerReceiver(trackingReceiver, filter);
        }
        receiverRegistered = true;
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != FILE_CHOOSER_REQUEST || filePathCallback == null) return;
        Uri[] results = null;
        if (resultCode == RESULT_OK && data != null) {
            if (data.getClipData() != null) {
                int count = data.getClipData().getItemCount();
                results = new Uri[count];
                for (int i = 0; i < count; i++) results[i] = data.getClipData().getItemAt(i).getUri();
            } else if (data.getData() != null) {
                results = new Uri[]{data.getData()};
            }
        }
        filePathCallback.onReceiveValue(results);
        filePathCallback = null;
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        webView.saveState(outState);
        super.onSaveInstanceState(outState);
    }

    @Override
    public void onBackPressed() {
        if (webView.canGoBack()) webView.goBack();
        else super.onBackPressed();
    }

    @Override
    protected void onDestroy() {
        if (receiverRegistered) unregisterReceiver(trackingReceiver);
        super.onDestroy();
    }

    private final class AndroidBridge {
        @JavascriptInterface
        public void setTrackingActive(boolean active) {
            runOnUiThread(() -> MainActivity.this.setTrackingActive(active));
        }

        @JavascriptInterface
        public boolean isNativeApp() {
            return true;
        }

        @JavascriptInterface
        public boolean isLocationPermissionGranted() {
            return hasLocationPermission();
        }

        @JavascriptInterface
        public void openLocationSettings() {
            runOnUiThread(() -> {
                Intent intent = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                    Uri.fromParts("package", getPackageName(), null));
                startActivity(intent);
            });
        }
    }
}
