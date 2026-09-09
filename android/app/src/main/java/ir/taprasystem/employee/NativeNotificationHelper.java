package ir.taprasystem.employee;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;

import org.json.JSONArray;

import java.util.LinkedHashSet;

final class NativeNotificationHelper {
    private static final String CHANNEL_ID = "tapra_account_notifications";
    private static final String PREFERENCES = "tapra_native_notifications";
    private static final String DISPLAYED_IDS = "displayed_notification_ids";
    private static final String POSTED_SYSTEM_IDS = "posted_system_notification_ids";
    private static final String ACTIVE_USER_ID = "active_user_id";
    private static final int MAX_DISPLAYED_IDS = 200;
    private static final String BASE_URL = BuildConfig.BASE_URL.replaceAll("/+$", "");
    private static final String DEFAULT_TARGET = BASE_URL + "/?panel=employee&screen=notifications";

    private NativeNotificationHelper() { }

    static void ensureChannel(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationChannel channel = new NotificationChannel(
            CHANNEL_ID, "اعلان‌های مأموریت و پیگیری", NotificationManager.IMPORTANCE_HIGH);
        channel.setDescription("مأموریت جدید، ارجاع، لغو و پیام‌های عملیاتی راهکار");
        channel.enableVibration(true);
        context.getSystemService(NotificationManager.class).createNotificationChannel(channel);
    }

    static boolean hasPermission(Context context) {
        return Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU ||
            context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) ==
                PackageManager.PERMISSION_GRANTED;
    }

    static synchronized String activeUserId(Context context) {
        String value = preferences(context).getString(ACTIVE_USER_ID, "");
        return value == null ? "" : value.trim();
    }

    static synchronized void switchUser(Context context, String userId) {
        String safeUserId = clean(userId, 64);
        String current = activeUserId(context);
        if (safeUserId.equals(current)) return;
        cancelPostedNotifications(context);
        preferences(context).edit()
            .putString(ACTIVE_USER_ID, safeUserId)
            .remove(DISPLAYED_IDS)
            .remove(POSTED_SYSTEM_IDS)
            .apply();
    }

    static synchronized void clearUser(Context context) {
        cancelPostedNotifications(context);
        preferences(context).edit()
            .remove(ACTIVE_USER_ID)
            .remove(DISPLAYED_IDS)
            .remove(POSTED_SYSTEM_IDS)
            .apply();
    }

    static synchronized boolean show(
        Context context, String notificationId, String title, String message, String targetUrl
    ) {
        if (!hasPermission(context)) return false;
        String activeUserId = activeUserId(context);
        if (activeUserId.isEmpty()) return false;
        String safeId = clean(notificationId, 120);
        String scopedId = activeUserId + ":" + safeId;
        if (safeId.isEmpty() || wasDisplayed(context, scopedId)) return false;

        ensureChannel(context);
        String safeTitle = clean(title, 160);
        String safeMessage = clean(message, 600);
        String safeTarget = trustedTarget(targetUrl);

        Intent openIntent = new Intent(context, MainActivity.class)
            .setData(Uri.parse(safeTarget))
            .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        int requestCode = 4000 + Math.abs(scopedId.hashCode() % 500_000);
        PendingIntent pendingIntent = PendingIntent.getActivity(
            context, requestCode, openIntent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        Notification.Builder builder;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            builder = new Notification.Builder(context, CHANNEL_ID);
        } else {
            builder = new Notification.Builder(context).setPriority(Notification.PRIORITY_HIGH);
        }
        Notification notification = builder
            .setSmallIcon(R.drawable.ic_location)
            .setContentTitle(safeTitle.isEmpty() ? "اعلان راهکار" : safeTitle)
            .setContentText(safeMessage)
            .setStyle(new Notification.BigTextStyle().bigText(safeMessage))
            .setContentIntent(pendingIntent)
            .setAutoCancel(true)
            .setCategory(Notification.CATEGORY_MESSAGE)
            .setVisibility(Notification.VISIBILITY_PRIVATE)
            .build();

        int systemId = 1000 + Math.abs(scopedId.hashCode() % 900_000);
        context.getSystemService(NotificationManager.class).notify(systemId, notification);
        rememberDisplayed(context, scopedId);
        rememberSystemId(context, systemId);
        return true;
    }

    static synchronized boolean showForUser(
        Context context, String expectedUserId, String notificationId,
        String title, String message, String targetUrl
    ) {
        // Check and post under the same lock as switchUser/clearUser.
        if (expectedUserId == null || !expectedUserId.equals(activeUserId(context))) return false;
        return show(context, notificationId, title, message, targetUrl);
    }

    private static String clean(String value, int maximumLength) {
        if (value == null) return "";
        String cleaned = value.trim();
        return cleaned.length() <= maximumLength ? cleaned : cleaned.substring(0, maximumLength);
    }

    private static String trustedTarget(String value) {
        if (value == null || value.trim().isEmpty()) return DEFAULT_TARGET;
        try {
            Uri uri = Uri.parse(value);
            Uri backend = Uri.parse(BASE_URL);
            if (backend.getScheme() != null && backend.getScheme().equalsIgnoreCase(uri.getScheme()) &&
                backend.getHost() != null && backend.getHost().equalsIgnoreCase(uri.getHost()) &&
                backend.getPort() == uri.getPort()) return uri.toString();
        } catch (Exception ignored) { }
        return DEFAULT_TARGET;
    }

    private static boolean wasDisplayed(Context context, String id) {
        return readDisplayed(context).contains(id);
    }

    private static void rememberDisplayed(Context context, String id) {
        LinkedHashSet<String> ids = readDisplayed(context);
        ids.remove(id);
        ids.add(id);
        while (ids.size() > MAX_DISPLAYED_IDS) ids.remove(ids.iterator().next());
        JSONArray array = new JSONArray();
        for (String item : ids) array.put(item);
        preferences(context).edit().putString(DISPLAYED_IDS, array.toString()).apply();
    }

    private static void rememberSystemId(Context context, int systemId) {
        LinkedHashSet<String> ids = readStringSet(context, POSTED_SYSTEM_IDS);
        ids.add(String.valueOf(systemId));
        while (ids.size() > MAX_DISPLAYED_IDS) ids.remove(ids.iterator().next());
        writeStringSet(context, POSTED_SYSTEM_IDS, ids);
    }

    private static void cancelPostedNotifications(Context context) {
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        for (String value : readStringSet(context, POSTED_SYSTEM_IDS)) {
            try { manager.cancel(Integer.parseInt(value)); }
            catch (Exception ignored) { }
        }
    }

    private static LinkedHashSet<String> readDisplayed(Context context) {
        return readStringSet(context, DISPLAYED_IDS);
    }

    private static LinkedHashSet<String> readStringSet(Context context, String key) {
        LinkedHashSet<String> ids = new LinkedHashSet<>();
        try {
            JSONArray array = new JSONArray(preferences(context).getString(key, "[]"));
            for (int index = 0; index < array.length(); index++) {
                String id = array.optString(index, "").trim();
                if (!id.isEmpty()) ids.add(id);
            }
        } catch (Exception ignored) { }
        return ids;
    }

    private static void writeStringSet(Context context, String key, LinkedHashSet<String> ids) {
        JSONArray array = new JSONArray();
        for (String item : ids) array.put(item);
        preferences(context).edit().putString(key, array.toString()).apply();
    }

    private static SharedPreferences preferences(Context context) {
        return context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE);
    }
}
