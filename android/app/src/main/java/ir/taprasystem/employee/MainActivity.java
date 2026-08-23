package ir.taprasystem.employee;

import android.Manifest;
import android.annotation.SuppressLint;
import android.annotation.TargetApi;
import android.app.Activity;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.net.Uri;
import android.net.http.SslError;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;
import android.provider.Settings;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.GeolocationPermissions;
import android.webkit.JavascriptInterface;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.SslErrorHandler;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;

import java.util.ArrayList;
import java.util.List;

public class MainActivity extends Activity {
    private static final String APP_URL = "https://taprasystem.ir/";
    private static final String INTERNAL_BROADCAST_PERMISSION =
        "ir.taprasystem.employee.permission.INTERNAL_BROADCAST";
    private static final String SAVED_URL_KEY = "tapra:last-safe-url";
    private static final String INSTALLED_VERSION_KEY = "installed_native_version";
    private static final int PERMISSION_REQUEST = 41;
    private static final int FILE_CHOOSER_REQUEST = 42;
    private static final long PAGE_LOAD_TIMEOUT_MS = 30_000L;
    private static final int MAX_AUTOMATIC_RECOVERIES = 2;

    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private WebView webView;
    private LinearLayout statusPanel;
    private ProgressBar statusProgress;
    private TextView statusTitle;
    private TextView statusMessage;
    private Button retryButton;
    private ValueCallback<Uri[]> filePathCallback;
    private GeolocationPermissions.Callback pendingGeolocationCallback;
    private String pendingGeolocationOrigin;
    private boolean receiverRegistered;
    private boolean permissionRequestInFlight;
    private boolean pageCommitted;
    private boolean mainFrameFailed;
    private boolean batteryGateVisible;
    private boolean applicationLoadStarted;
    private String initialApplicationUrl = APP_URL;
    private boolean initialClearCache;
    private int automaticRecoveryCount;

    private final Runnable loadWatchdog = () -> {
        if (!pageCommitted && !mainFrameFailed) recoverFromBlankPage("زمان دریافت صفحه طولانی شد.");
    };

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
        createApplicationShell();
        configureWebView();
        registerTrackingReceiver();
        NativeNotificationHelper.ensureChannel(this);
        requestRuntimePermissions();

        boolean versionChanged = clearStaleCacheAfterUpgrade();
        String savedUrl = savedInstanceState == null ? null : savedInstanceState.getString(SAVED_URL_KEY);
        String notificationUrl = getIntent() == null ? null : getIntent().getDataString();
        initialApplicationUrl = isTrustedWebOrigin(notificationUrl)
            ? notificationUrl : isTrustedWebOrigin(savedUrl) ? savedUrl : APP_URL;
        initialClearCache = versionChanged;
        enforceBatteryAccessGate();
    }

    private void configureSystemBars() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR);
        }
    }

    private void createApplicationShell() {
        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.rgb(239, 244, 252));

        webView = new WebView(this);
        webView.setLayoutDirection(View.LAYOUT_DIRECTION_RTL);
        webView.setBackgroundColor(Color.WHITE);
        root.addView(webView, new FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        statusPanel = new LinearLayout(this);
        statusPanel.setOrientation(LinearLayout.VERTICAL);
        statusPanel.setGravity(Gravity.CENTER);
        statusPanel.setPadding(dp(30), dp(30), dp(30), dp(30));
        statusPanel.setBackgroundColor(Color.rgb(239, 244, 252));

        TextView logo = new TextView(this);
        logo.setText("ر");
        logo.setTextColor(Color.WHITE);
        logo.setTextSize(25);
        logo.setGravity(Gravity.CENTER);
        logo.setBackgroundColor(Color.rgb(55, 103, 233));
        LinearLayout.LayoutParams logoParams = new LinearLayout.LayoutParams(dp(64), dp(64));
        logoParams.bottomMargin = dp(20);
        statusPanel.addView(logo, logoParams);

        statusProgress = new ProgressBar(this);
        LinearLayout.LayoutParams progressParams = new LinearLayout.LayoutParams(dp(42), dp(42));
        progressParams.bottomMargin = dp(18);
        statusPanel.addView(statusProgress, progressParams);

        statusTitle = new TextView(this);
        statusTitle.setText("در حال بازکردن راهکار…");
        statusTitle.setTextColor(Color.rgb(15, 29, 51));
        statusTitle.setTextSize(19);
        statusTitle.setGravity(Gravity.CENTER);
        statusPanel.addView(statusTitle, new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        statusMessage = new TextView(this);
        statusMessage.setText("چند لحظه منتظر بمانید");
        statusMessage.setTextColor(Color.rgb(98, 116, 145));
        statusMessage.setTextSize(13);
        statusMessage.setGravity(Gravity.CENTER);
        statusMessage.setPadding(0, dp(10), 0, dp(18));
        statusPanel.addView(statusMessage, new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        retryButton = new Button(this);
        retryButton.setText("تلاش مجدد");
        retryButton.setTextSize(15);
        retryButton.setTextColor(Color.WHITE);
        retryButton.setBackgroundColor(Color.rgb(55, 103, 233));
        retryButton.setVisibility(View.GONE);
        configurePageRetryButton();
        LinearLayout.LayoutParams retryParams = new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, dp(52));
        retryParams.setMargins(dp(32), 0, dp(32), 0);
        statusPanel.addView(retryButton, retryParams);

        root.addView(statusPanel, new FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        setContentView(root);
    }

    private void configurePageRetryButton() {
        retryButton.setText("تلاش مجدد");
        retryButton.setOnClickListener(view -> {
            automaticRecoveryCount = 0;
            loadApplication(currentSafeUrl(), true);
        });
    }

    private boolean enforceBatteryAccessGate() {
        if (!isBatteryOptimizationExempt()) {
            showBatteryRequirement();
            return false;
        }
        if (batteryGateVisible) {
            batteryGateVisible = false;
            configurePageRetryButton();
            webView.setVisibility(View.VISIBLE);
            statusPanel.setVisibility(View.GONE);
        }
        if (!applicationLoadStarted) {
            applicationLoadStarted = true;
            loadApplication(initialApplicationUrl, initialClearCache);
        }
        return true;
    }

    private void showBatteryRequirement() {
        batteryGateVisible = true;
        mainHandler.removeCallbacks(loadWatchdog);
        webView.setVisibility(View.GONE);
        statusPanel.setVisibility(View.VISIBLE);
        statusProgress.setVisibility(View.GONE);
        statusTitle.setText("تنظیم باتری برای ورود الزامی است");
        statusMessage.setText("برای جلوگیری از قطع موقعیت در زمان فعالیت، مصرف باتری برنامه راهکار را روی «بدون محدودیت» قرار دهید. تا تأیید این تنظیم، ورود به برنامه امکان‌پذیر نیست.");
        retryButton.setText("بازکردن تنظیمات باتری");
        retryButton.setVisibility(View.VISIBLE);
        retryButton.setOnClickListener(view -> requestBatteryOptimizationExemption());
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    private boolean clearStaleCacheAfterUpgrade() {
        String installed = getSharedPreferences("tapra_native_app", MODE_PRIVATE)
            .getString(INSTALLED_VERSION_KEY, "");
        if (BuildConfig.VERSION_NAME.equals(installed)) return false;
        webView.clearCache(true);
        getSharedPreferences("tapra_native_app", MODE_PRIVATE).edit()
            .putString(INSTALLED_VERSION_KEY, BuildConfig.VERSION_NAME).apply();
        return true;
    }

    @SuppressLint("SetJavaScriptEnabled")
    private void configureWebView() {
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(true);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);
        settings.setLoadWithOverviewMode(false);
        settings.setUseWideViewPort(true);
        settings.setUserAgentString(settings.getUserAgentString() + " TapraAndroid/" + BuildConfig.VERSION_NAME);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) settings.setSafeBrowsingEnabled(true);

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
            public void onPageStarted(WebView view, String url, Bitmap favicon) {
                super.onPageStarted(view, url, favicon);
                pageCommitted = false;
                mainFrameFailed = false;
                showLoading("در حال دریافت آخرین نسخه سامانه…");
                scheduleLoadWatchdog();
            }

            @Override
            public void onPageCommitVisible(WebView view, String url) {
                super.onPageCommitVisible(view, url);
                pageCommitted = true;
                mainHandler.removeCallbacks(loadWatchdog);
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                super.onPageFinished(view, url);
                CookieManager.getInstance().flush();
                if (isTrustedWebOrigin(url) && hasLocationPermission()) {
                    Uri pageUri = Uri.parse(url);
                    String origin = pageUri.getScheme() + "://" + pageUri.getAuthority();
                    GeolocationPermissions.getInstance().allow(origin);
                }
                view.evaluateJavascript("window.dispatchEvent(new CustomEvent('tapra-native-ready'))", null);
                mainHandler.postDelayed(() -> verifyRenderedPage(view), 900L);
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                super.onReceivedError(view, request, error);
                if (request.isForMainFrame()) {
                    String details = error == null ? "" : String.valueOf(error.getDescription());
                    showLoadError("ارتباط با سامانه برقرار نشد.", details);
                }
            }

            @Override
            public void onReceivedError(WebView view, int errorCode, String description, String failingUrl) {
                super.onReceivedError(view, errorCode, description, failingUrl);
                if (failingUrl != null && failingUrl.equals(view.getUrl())) {
                    showLoadError("ارتباط با سامانه برقرار نشد.", description);
                }
            }

            @Override
            public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse response) {
                super.onReceivedHttpError(view, request, response);
                if (request.isForMainFrame() && response.getStatusCode() >= 400) {
                    showLoadError("سرور پاسخ مناسبی نداد.", "کد خطا: " + response.getStatusCode());
                }
            }

            @Override
            public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
                handler.cancel();
                showLoadError("اتصال امن سایت تأیید نشد.", "تاریخ و ساعت گوشی و اتصال اینترنت را بررسی کنید.");
            }

            @Override
            @TargetApi(Build.VERSION_CODES.O)
            public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
                mainHandler.removeCallbacks(loadWatchdog);
                Toast.makeText(MainActivity.this,
                    "نمایشگر برنامه دوباره راه‌اندازی شد", Toast.LENGTH_LONG).show();
                view.destroy();
                recreate();
                return true;
            }
        });
        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onGeolocationPermissionsShowPrompt(String origin, GeolocationPermissions.Callback callback) {
                if (!isTrustedWebOrigin(origin)) {
                    callback.invoke(origin, false, false);
                    return;
                }
                if (hasLocationPermission()) {
                    GeolocationPermissions.getInstance().allow(origin);
                    callback.invoke(origin, true, true);
                    return;
                }
                resolvePendingGeolocation(false);
                pendingGeolocationOrigin = origin;
                pendingGeolocationCallback = callback;
                requestRuntimePermissions();
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
                    Toast.makeText(MainActivity.this,
                        "انتخاب فایل در این گوشی در دسترس نیست", Toast.LENGTH_LONG).show();
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

    private void verifyRenderedPage(WebView view) {
        if (mainFrameFailed || view != webView) return;
        view.evaluateJavascript(
            "Boolean(document.body && document.body.innerText && document.body.innerText.trim().length > 8)",
            rendered -> {
                if ("true".equals(rendered)) {
                    pageCommitted = true;
                    automaticRecoveryCount = 0;
                    mainHandler.removeCallbacks(loadWatchdog);
                    statusPanel.setVisibility(View.GONE);
                    webView.setVisibility(View.VISIBLE);
                } else {
                    recoverFromBlankPage("محتوای صفحه نمایش داده نشد.");
                }
            });
    }

    private void scheduleLoadWatchdog() {
        mainHandler.removeCallbacks(loadWatchdog);
        mainHandler.postDelayed(loadWatchdog, PAGE_LOAD_TIMEOUT_MS);
    }

    private void recoverFromBlankPage(String reason) {
        if (automaticRecoveryCount >= MAX_AUTOMATIC_RECOVERIES) {
            showLoadError("صفحه سامانه بارگذاری نشد.",
                reason + " اینترنت یا Android System WebView را بررسی کنید.");
            return;
        }
        automaticRecoveryCount++;
        webView.clearCache(true);
        loadApplication(currentSafeUrl(), false);
    }

    private void loadApplication(String requestedUrl, boolean clearCache) {
        if (!isBatteryOptimizationExempt()) {
            showBatteryRequirement();
            return;
        }
        mainHandler.removeCallbacks(loadWatchdog);
        pageCommitted = false;
        mainFrameFailed = false;
        if (clearCache) webView.clearCache(true);
        showLoading("در حال دریافت آخرین نسخه سامانه…");
        Uri base = Uri.parse(isTrustedWebOrigin(requestedUrl) ? requestedUrl : APP_URL);
        Uri target = base.buildUpon()
            .appendQueryParameter("native_app", "android")
            .appendQueryParameter("native_version", BuildConfig.VERSION_NAME)
            .appendQueryParameter("native_refresh", String.valueOf(System.currentTimeMillis()))
            .build();
        webView.loadUrl(target.toString());
        scheduleLoadWatchdog();
    }

    private String currentSafeUrl() {
        String current = webView == null ? null : webView.getUrl();
        return isTrustedWebOrigin(current) ? current : APP_URL;
    }

    private void showLoading(String message) {
        statusPanel.setVisibility(View.VISIBLE);
        statusProgress.setVisibility(View.VISIBLE);
        retryButton.setVisibility(View.GONE);
        statusTitle.setText("در حال بازکردن راهکار…");
        statusMessage.setText(message);
    }

    private void showLoadError(String title, String details) {
        mainFrameFailed = true;
        pageCommitted = false;
        mainHandler.removeCallbacks(loadWatchdog);
        statusPanel.setVisibility(View.VISIBLE);
        statusProgress.setVisibility(View.GONE);
        retryButton.setVisibility(View.VISIBLE);
        statusTitle.setText(title);
        statusMessage.setText(details == null || details.trim().isEmpty()
            ? "اتصال اینترنت را بررسی کنید و دوباره تلاش کنید." : details);
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

    private boolean isTrustedWebOrigin(String origin) {
        if (origin == null || origin.trim().isEmpty()) return false;
        Uri uri = Uri.parse(origin);
        String host = uri.getHost();
        return "https".equalsIgnoreCase(uri.getScheme()) &&
            ("taprasystem.ir".equalsIgnoreCase(host) || "www.taprasystem.ir".equalsIgnoreCase(host));
    }

    private void resolvePendingGeolocation(boolean granted) {
        if (pendingGeolocationCallback == null || pendingGeolocationOrigin == null) return;
        GeolocationPermissions.Callback callback = pendingGeolocationCallback;
        String origin = pendingGeolocationOrigin;
        pendingGeolocationCallback = null;
        pendingGeolocationOrigin = null;
        if (granted) GeolocationPermissions.getInstance().allow(origin);
        callback.invoke(origin, granted, granted);
    }

    private void requestRuntimePermissions() {
        if (permissionRequestInFlight) return;
        List<String> permissions = new ArrayList<>();
        if (!hasLocationPermission()) permissions.add(Manifest.permission.ACCESS_FINE_LOCATION);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            permissions.add(Manifest.permission.POST_NOTIFICATIONS);
        }
        if (!permissions.isEmpty()) {
            permissionRequestInFlight = true;
            requestPermissions(permissions.toArray(new String[0]), PERMISSION_REQUEST);
        }
    }

    private boolean hasLocationPermission() {
        return checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED ||
            checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED;
    }

    private boolean hasNotificationPermission() {
        return NativeNotificationHelper.hasPermission(this);
    }

    private void requestNotificationPermission() {
        if (hasNotificationPermission()) {
            dispatchNativeNotificationPermissionState();
            return;
        }
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU || permissionRequestInFlight) return;
        permissionRequestInFlight = true;
        requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, PERMISSION_REQUEST);
    }

    private void dispatchNativeNotificationPermissionState() {
        if (webView == null) return;
        String granted = hasNotificationPermission() ? "true" : "false";
        webView.post(() -> webView.evaluateJavascript(
            "window.dispatchEvent(new CustomEvent('tapra-notification-permission-changed'," +
                "{detail:{granted:" + granted + "}}))", null));
    }

    private void openNotificationSettings() {
        try {
            Intent intent;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                intent = new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                    .putExtra(Settings.EXTRA_APP_PACKAGE, getPackageName());
            } else {
                intent = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                    Uri.fromParts("package", getPackageName(), null));
            }
            startActivity(intent);
        } catch (Exception ignored) {
            startActivity(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                Uri.fromParts("package", getPackageName(), null)));
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode != PERMISSION_REQUEST) return;
        permissionRequestInFlight = false;
        boolean locationGranted = hasLocationPermission();
        resolvePendingGeolocation(locationGranted);
        dispatchNativeNotificationPermissionState();
        if (locationGranted && webView != null) {
            webView.post(() -> webView.evaluateJavascript(
                "window.dispatchEvent(new CustomEvent('tapra-location-permission-granted'))", null));
        }
    }

    private void setTrackingActive(boolean active) {
        if (active && !hasLocationPermission()) {
            requestRuntimePermissions();
            Toast.makeText(this,
                "برای ثبت فعالیت، دسترسی موقعیت دقیق را مجاز کنید", Toast.LENGTH_LONG).show();
            return;
        }
        if (active && !isBatteryOptimizationExempt()) {
            requestBatteryOptimizationExemption();
            Toast.makeText(this,
                "برای ادامه ردیابی پس‌زمینه، مصرف باتری راهکار را روی بدون محدودیت قرار دهید",
                Toast.LENGTH_LONG).show();
            return;
        }
        Intent serviceIntent = new Intent(this, LocationTrackingService.class)
            .setAction(active ? LocationTrackingService.ACTION_START : LocationTrackingService.ACTION_STOP);
        if (active && Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) startForegroundService(serviceIntent);
        else startService(serviceIntent);
    }

    private boolean isBatteryOptimizationExempt() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return true;
        PowerManager manager = (PowerManager) getSystemService(POWER_SERVICE);
        return manager != null && manager.isIgnoringBatteryOptimizations(getPackageName());
    }

    private void requestBatteryOptimizationExemption() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M || isBatteryOptimizationExempt()) return;
        try {
            Intent request = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
                Uri.parse("package:" + getPackageName()));
            startActivity(request);
        } catch (Exception unavailable) {
            Intent fallback = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                Uri.fromParts("package", getPackageName(), null));
            startActivity(fallback);
        }
    }

    @SuppressLint("UnspecifiedRegisterReceiverFlag")
    private void registerTrackingReceiver() {
        IntentFilter filter = new IntentFilter(LocationTrackingService.ACTION_SESSION_ENDED);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            registerReceiver(trackingReceiver, filter, INTERNAL_BROADCAST_PERMISSION, null,
                Context.RECEIVER_NOT_EXPORTED);
        } else {
            registerReceiver(trackingReceiver, filter, INTERNAL_BROADCAST_PERMISSION, null);
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
        String current = currentSafeUrl();
        if (isTrustedWebOrigin(current)) outState.putString(SAVED_URL_KEY, current);
        super.onSaveInstanceState(outState);
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (webView != null) {
            if (!enforceBatteryAccessGate()) return;
            webView.onResume();
            dispatchNativeNotificationPermissionState();
            if (webView.getUrl() == null || webView.getUrl().trim().isEmpty()) loadApplication(APP_URL, false);
        }
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        String target = intent == null ? null : intent.getDataString();
        if (!isTrustedWebOrigin(target)) return;
        initialApplicationUrl = target;
        if (enforceBatteryAccessGate()) loadApplication(target, false);
    }

    @Override
    protected void onPause() {
        if (webView != null) webView.onPause();
        super.onPause();
    }

    @Override
    public void onBackPressed() {
        if (webView.canGoBack()) webView.goBack();
        else super.onBackPressed();
    }

    @Override
    protected void onDestroy() {
        mainHandler.removeCallbacks(loadWatchdog);
        resolvePendingGeolocation(false);
        if (receiverRegistered) unregisterReceiver(trackingReceiver);
        if (webView != null) {
            webView.removeJavascriptInterface("TapraAndroid");
            webView.stopLoading();
            webView.destroy();
        }
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
        public boolean isBatteryOptimizationExempt() {
            return MainActivity.this.isBatteryOptimizationExempt();
        }

        @JavascriptInterface
        public void requestBatteryOptimizationExemption() {
            runOnUiThread(MainActivity.this::requestBatteryOptimizationExemption);
        }

        @JavascriptInterface
        public boolean isNotificationPermissionGranted() {
            return hasNotificationPermission();
        }

        @JavascriptInterface
        public void requestNotificationPermission() {
            runOnUiThread(MainActivity.this::requestNotificationPermission);
        }

        @JavascriptInterface
        public void openNotificationSettings() {
            runOnUiThread(MainActivity.this::openNotificationSettings);
        }

        @JavascriptInterface
        public boolean showNativeNotification(
            String notificationId, String title, String message, String targetUrl
        ) {
            return NativeNotificationHelper.show(
                MainActivity.this, notificationId, title, message, targetUrl);
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
