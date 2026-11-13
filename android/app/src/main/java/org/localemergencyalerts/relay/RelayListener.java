package org.localemergencyalerts.relay;

import android.app.Notification;
import android.content.Context;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.os.Bundle;
import android.service.notification.NotificationListenerService;
import android.service.notification.StatusBarNotification;

import java.util.Locale;

/**
 * Receives every notification the phone shows (once the user grants
 * notification access) and forwards those from apps whose name contains the
 * configured text ("CAER" by default).
 */
public class RelayListener extends NotificationListenerService {
    private static final int RECENT_LIMIT = 50;

    @Override
    public void onListenerConnected() {
        HeartbeatReceiver.schedule(this);
        Context ctx = getApplicationContext();
        Relay.EXECUTOR.execute(() -> Relay.heartbeat(ctx));
    }

    @Override
    public void onNotificationPosted(StatusBarNotification sbn) {
        String pkg = sbn.getPackageName();
        if (pkg.equals(getPackageName())) return;
        String label = appLabel(this, pkg);
        String match = Prefs.appMatch(this).toLowerCase(Locale.US);
        if (!label.toLowerCase(Locale.US).contains(match) && !pkg.toLowerCase(Locale.US).contains(match)) return;

        Notification n = sbn.getNotification();
        if ((n.flags & Notification.FLAG_GROUP_SUMMARY) != 0) return;
        Bundle extras = n.extras;
        String title = text(extras, Notification.EXTRA_TITLE);
        String body = text(extras, Notification.EXTRA_BIG_TEXT);
        if (body.isEmpty()) body = text(extras, Notification.EXTRA_TEXT);
        if (title.isEmpty() && body.isEmpty()) return;

        Prefs.put(this, Prefs.WATCHED_APP, label + " (" + pkg + ")");
        // Apps often re-post the same notification when it updates; send each message once.
        if (!rememberNew(pkg + "|" + title + "|" + body)) return;

        Context ctx = getApplicationContext();
        String t = title, b = body;
        long postedAt = sbn.getPostTime();
        Relay.EXECUTOR.execute(() -> Relay.forward(ctx, t, b, label, postedAt));
    }

    static String appLabel(Context ctx, String pkg) {
        try {
            PackageManager pm = ctx.getPackageManager();
            ApplicationInfo info = pm.getApplicationInfo(pkg, 0);
            return String.valueOf(pm.getApplicationLabel(info));
        } catch (PackageManager.NameNotFoundException e) {
            return pkg;
        }
    }

    private static String text(Bundle extras, String key) {
        CharSequence cs = extras == null ? null : extras.getCharSequence(key);
        return cs == null ? "" : cs.toString().trim();
    }

    private synchronized boolean rememberNew(String key) {
        String id = Integer.toHexString(key.hashCode());
        String recent = Prefs.get(this).getString(Prefs.RECENT_KEYS, "");
        for (String seen : recent.split(",")) {
            if (seen.equals(id)) return false;
        }
        String updated = recent.isEmpty() ? id : id + "," + recent;
        String[] parts = updated.split(",");
        if (parts.length > RECENT_LIMIT) {
            StringBuilder sb = new StringBuilder();
            for (int i = 0; i < RECENT_LIMIT; i++) {
                if (i > 0) sb.append(',');
                sb.append(parts[i]);
            }
            updated = sb.toString();
        }
        Prefs.put(this, Prefs.RECENT_KEYS, updated);
        return true;
    }
}
