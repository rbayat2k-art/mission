package ir.taprasystem.employee;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.webkit.CookieManager;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.HashSet;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public class LocationTrackingService extends Service implements LocationListener {
    public static final String ACTION_START = "ir.taprasystem.employee.action.START_TRACKING";
    public static final String ACTION_STOP = "ir.taprasystem.employee.action.STOP_TRACKING";
    public static final String ACTION_SESSION_ENDED = "ir.taprasystem.employee.action.SESSION_ENDED";

    private static final String BASE_URL = "https://taprasystem.ir";
    private static final String LOCATION_ENDPOINT = BASE_URL + "/api/locations";
    private static final String CHANNEL_ID = "tapra_active_tracking";
    private static final String INTERNAL_BROADCAST_PERMISSION =
        "ir.taprasystem.employee.permission.INTERNAL_BROADCAST";
    private static final int NOTIFICATION_ID = 201;
    private static final long UPDATE_INTERVAL_MS = 20_000L;
    private static final float UPDATE_DISTANCE_METERS = 8f;
    private static final int MAX_QUEUE_SIZE = 3000;

    private final ExecutorService networkExecutor = Executors.newSingleThreadExecutor();
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private LocationManager locationManager;
    private SharedPreferences preferences;
    private PowerManager.WakeLock wakeLock;
    private volatile boolean flushInProgress;

    private final Runnable periodicFlush = new Runnable() {
        @Override
        public void run() {
            flushQueue();
            mainHandler.postDelayed(this, 30_000L);
        }
    };

    @Override
    public void onCreate() {
        super.onCreate();
        preferences = getSharedPreferences("tapra_native_tracking", MODE_PRIVATE);
        locationManager = (LocationManager) getSystemService(Context.LOCATION_SERVICE);
        createNotificationChannel();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent == null ? ACTION_START : intent.getAction();
        if (ACTION_STOP.equals(action)) {
            stopTracking(true);
            return START_NOT_STICKY;
        }
        preferences.edit().putBoolean("tracking_requested", true).apply();
        startForeground(NOTIFICATION_ID, buildNotification("در انتظار دریافت موقعیت دقیق…"));
        startTracking();
        return START_STICKY;
    }

    private void startTracking() {
        if (checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED &&
            checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) != PackageManager.PERMISSION_GRANTED) {
            updateNotification("دسترسی موقعیت داده نشده است");
            return;
        }
        acquireWakeLock();
        try {
            if (locationManager.isProviderEnabled(LocationManager.GPS_PROVIDER)) {
                locationManager.requestLocationUpdates(LocationManager.GPS_PROVIDER,
                    UPDATE_INTERVAL_MS, UPDATE_DISTANCE_METERS, this, Looper.getMainLooper());
            }
        } catch (Exception ignored) { }
        try {
            if (locationManager.isProviderEnabled(LocationManager.NETWORK_PROVIDER)) {
                locationManager.requestLocationUpdates(LocationManager.NETWORK_PROVIDER,
                    UPDATE_INTERVAL_MS, UPDATE_DISTANCE_METERS, this, Looper.getMainLooper());
            }
        } catch (Exception ignored) { }
        mainHandler.removeCallbacks(periodicFlush);
        mainHandler.post(periodicFlush);
    }

    @Override
    public void onLocationChanged(Location location) {
        if (location == null || !preferences.getBoolean("tracking_requested", false)) return;
        try {
            JSONObject point = new JSONObject();
            point.put("clientEventId", UUID.randomUUID().toString());
            point.put("latitude", location.getLatitude());
            point.put("longitude", location.getLongitude());
            point.put("accuracy", Math.max(0, location.getAccuracy()));
            if (location.hasAltitude()) point.put("altitude", location.getAltitude());
            else point.put("altitude", JSONObject.NULL);
            if (location.hasSpeed()) point.put("speed", location.getSpeed());
            else point.put("speed", JSONObject.NULL);
            if (location.hasBearing()) point.put("heading", location.getBearing());
            else point.put("heading", JSONObject.NULL);
            point.put("recordedAt", isoTimestamp(location.getTime()));
            appendPoint(point);
            updateNotification("آخرین موقعیت ثبت شد · دقت " + Math.round(location.getAccuracy()) + " متر");
            flushQueue();
        } catch (Exception ignored) { }
    }

    @Override
    public void onProviderDisabled(String provider) {
        updateNotification("GPS خاموش است؛ برای ادامه ثبت آن را روشن کنید");
    }

    @Override
    public void onProviderEnabled(String provider) {
        updateNotification("GPS روشن است؛ در حال دریافت موقعیت…");
    }

    @Override
    public void onStatusChanged(String provider, int status, Bundle extras) { }

    private synchronized void appendPoint(JSONObject point) {
        JSONArray current = readQueue();
        JSONArray next = new JSONArray();
        int start = Math.max(0, current.length() - MAX_QUEUE_SIZE + 1);
        for (int index = start; index < current.length(); index++) next.put(current.opt(index));
        next.put(point);
        preferences.edit().putString("location_queue", next.toString()).apply();
    }

    private synchronized JSONArray readQueue() {
        try {
            return new JSONArray(preferences.getString("location_queue", "[]"));
        } catch (Exception ignored) {
            return new JSONArray();
        }
    }

    private void flushQueue() {
        if (flushInProgress) return;
        final JSONArray batch = firstBatch(readQueue(), 100);
        if (batch.length() == 0) return;
        final String cookies = CookieManager.getInstance().getCookie(BASE_URL);
        if (cookies == null || cookies.trim().isEmpty()) {
            updateNotification("برای ارسال موقعیت دوباره وارد حساب شوید");
            return;
        }
        flushInProgress = true;
        networkExecutor.execute(() -> {
            try {
                JSONObject requestBody = new JSONObject().put("points", batch);
                HttpResult result = postJson(LOCATION_ENDPOINT, requestBody.toString(), cookies);
                if (result.status >= 200 && result.status < 300) {
                    removeAccepted(batch);
                    JSONObject response = new JSONObject(result.body.isEmpty() ? "{}" : result.body);
                    if (response.optBoolean("autoEnded", false)) {
                        mainHandler.post(() -> stopTrackingForServerEnd());
                    }
                } else if (result.status == 401 || result.status == 403) {
                    updateNotification("ورود منقضی شده؛ برنامه را باز و دوباره وارد شوید");
                }
            } catch (Exception ignored) {
                updateNotification("موقعیت روی گوشی ذخیره شد؛ منتظر اینترنت");
            } finally {
                flushInProgress = false;
            }
        });
    }

    private JSONArray firstBatch(JSONArray source, int maximum) {
        JSONArray batch = new JSONArray();
        for (int index = 0; index < source.length() && index < maximum; index++) batch.put(source.opt(index));
        return batch;
    }

    private synchronized void removeAccepted(JSONArray accepted) {
        Set<String> ids = new HashSet<>();
        for (int index = 0; index < accepted.length(); index++) {
            JSONObject item = accepted.optJSONObject(index);
            if (item != null) ids.add(item.optString("clientEventId"));
        }
        JSONArray current = readQueue();
        JSONArray remaining = new JSONArray();
        for (int index = 0; index < current.length(); index++) {
            JSONObject item = current.optJSONObject(index);
            if (item == null || !ids.contains(item.optString("clientEventId"))) remaining.put(current.opt(index));
        }
        preferences.edit().putString("location_queue", remaining.toString()).apply();
    }

    private HttpResult postJson(String endpoint, String body, String cookies) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) new URL(endpoint).openConnection();
        try {
            connection.setRequestMethod("POST");
            connection.setConnectTimeout(20_000);
            connection.setReadTimeout(20_000);
            connection.setDoOutput(true);
            connection.setRequestProperty("Content-Type", "application/json; charset=utf-8");
            connection.setRequestProperty("Accept", "application/json");
            connection.setRequestProperty("Cookie", cookies);
            connection.setRequestProperty("User-Agent", "TapraAndroid/" + BuildConfig.VERSION_NAME);
            byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
            connection.setFixedLengthStreamingMode(bytes.length);
            try (OutputStream output = connection.getOutputStream()) {
                output.write(bytes);
            }
            int status = connection.getResponseCode();
            InputStream stream = status >= 200 && status < 400 ? connection.getInputStream() : connection.getErrorStream();
            StringBuilder response = new StringBuilder();
            if (stream != null) {
                try (BufferedReader reader = new BufferedReader(new InputStreamReader(stream, StandardCharsets.UTF_8))) {
                    String line;
                    while ((line = reader.readLine()) != null) response.append(line);
                }
            }
            return new HttpResult(status, response.toString());
        } finally {
            connection.disconnect();
        }
    }

    private String isoTimestamp(long milliseconds) {
        java.text.SimpleDateFormat format = new java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", java.util.Locale.US);
        format.setTimeZone(java.util.TimeZone.getTimeZone("UTC"));
        return format.format(new java.util.Date(milliseconds));
    }

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationChannel channel = new NotificationChannel(CHANNEL_ID, "ثبت موقعیت فعالیت",
            NotificationManager.IMPORTANCE_LOW);
        channel.setDescription("هنگام فعالیت کاری، وضعیت ثبت موقعیت را نمایش می‌دهد");
        channel.setShowBadge(false);
        getSystemService(NotificationManager.class).createNotificationChannel(channel);
    }

    private Notification buildNotification(String text) {
        Intent openIntent = new Intent(this, MainActivity.class)
            .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent pendingIntent = PendingIntent.getActivity(this, 0, openIntent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Notification.Builder builder;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            builder = new Notification.Builder(this, CHANNEL_ID);
        } else {
            builder = new Notification.Builder(this)
                .setPriority(Notification.PRIORITY_LOW);
        }
        return builder
            .setSmallIcon(ir.taprasystem.employee.R.drawable.ic_location)
            .setContentTitle("ثبت موقعیت فعالیت در حال اجراست")
            .setContentText(text)
            .setContentIntent(pendingIntent)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setCategory(Notification.CATEGORY_SERVICE)
            .build();
    }

    private void updateNotification(String text) {
        mainHandler.post(() -> getSystemService(NotificationManager.class)
            .notify(NOTIFICATION_ID, buildNotification(text)));
    }

    private void acquireWakeLock() {
        if (wakeLock != null && wakeLock.isHeld()) return;
        PowerManager manager = (PowerManager) getSystemService(POWER_SERVICE);
        wakeLock = manager.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "tapra:location-tracking");
        wakeLock.setReferenceCounted(false);
        wakeLock.acquire(10 * 60 * 60 * 1000L);
    }

    private void releaseWakeLock() {
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        wakeLock = null;
    }

    private void stopTrackingForServerEnd() {
        stopTracking(false);
        Intent intent = new Intent(ACTION_SESSION_ENDED).setPackage(getPackageName());
        sendBroadcast(intent, INTERNAL_BROADCAST_PERMISSION);
    }

    private void stopTracking(boolean requestedByUser) {
        preferences.edit().putBoolean("tracking_requested", false).apply();
        mainHandler.removeCallbacks(periodicFlush);
        try {
            locationManager.removeUpdates(this);
        } catch (Exception ignored) { }
        releaseWakeLock();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) stopForeground(STOP_FOREGROUND_REMOVE);
        else stopForeground(true);
        stopSelf();
    }

    @Override
    public void onDestroy() {
        mainHandler.removeCallbacks(periodicFlush);
        try {
            locationManager.removeUpdates(this);
        } catch (Exception ignored) { }
        releaseWakeLock();
        networkExecutor.shutdown();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    private static final class HttpResult {
        final int status;
        final String body;

        HttpResult(int status, String body) {
            this.status = status;
            this.body = body;
        }
    }
}
