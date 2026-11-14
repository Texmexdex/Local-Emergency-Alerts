package org.localemergencyalerts.relay;

import android.app.Notification;
import android.content.Context;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.os.Bundle;
import android.service.notification.NotificationListenerService;
import android.service.notification.StatusBarNotification;

import android.provider.Telephony;

import java.util.Locale;
import java.util.regex.Pattern;

/**
 * Receives every notification the phone shows (once the user grants
 * notification access) and forwards only:
 *  - notifications from apps named in the settings ("CAER, CrimeRadar" by default), and
 *  - text messages whose sender matches one of the configured senders (none by default).
 * Everything else is ignored and never leaves the phone.
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
        boolean sms = isMessagingApp(pkg);
        if (!sms && !matchesApp(label, pkg, Prefs.appMatch(this))) return;

        Notification n = sbn.getNotification();
        if ((n.flags & Notification.FLAG_GROUP_SUMMARY) != 0) return;
        Bundle extras = n.extras;
        String title = text(extras, Notification.EXTRA_TITLE);
        String body = text(extras, Notification.EXTRA_BIG_TEXT);
        if (body.isEmpty()) body = text(extras, Notification.EXTRA_TEXT);
        if (title.isEmpty() && body.isEmpty()) return;
        // Texts: only from the senders the user listed (the sender is the notification title).
        if (sms && !matchesSender(title, Prefs.smsSenders(this))) return;

        rememberWatched(sms ? label + ": " + title : label);
        // Apps often re-post the same notification when it updates; send each message once.
        if (!rememberNew(pkg + "|" + title + "|" + body)) return;

        Context ctx = getApplicationContext();
        String t = title, b = body;
        long postedAt = sbn.getPostTime();
        Relay.EXECUTOR.execute(() -> Relay.forward(ctx, t, b, label, pkg, postedAt));
    }

    /** An app matches a name in the list as a whole word ("X" matches "X", not "Xfinity"), or by package name. */
    static boolean matchesApp(String label, String pkg, String csv) {
        String p = pkg.toLowerCase(Locale.US);
        for (String name : Prefs.parts(csv)) {
            Pattern word = Pattern.compile("(^|\\W)" + Pattern.quote(name) + "($|\\W)", Pattern.CASE_INSENSITIVE);
            if (word.matcher(label).find()) return true;
            String compact = name.toLowerCase(Locale.US).replaceAll("\\s+", "");
            if (compact.length() >= 4 && p.contains(compact)) return true;
        }
        return false;
    }

    static boolean matchesSender(String sender, String csv) {
        String s = sender.toLowerCase(Locale.US).replaceAll("[\\s()-]", "");
        for (String want : Prefs.parts(csv)) {
            String w = want.toLowerCase(Locale.US).replaceAll("[\\s()-]", "");
            if (!w.isEmpty() && s.contains(w)) return true;
        }
        return false;
    }

    private boolean isMessagingApp(String pkg) {
        String def = Telephony.Sms.getDefaultSmsPackage(this);
        return pkg.equals(def) || pkg.equals("com.google.android.apps.messaging")
                || pkg.equals("com.samsung.android.messaging") || pkg.equals("com.android.mms");
    }

    /** Keep a short list of the apps/senders that have been forwarded, newest first. */
    private synchronized void rememberWatched(String who) {
        String current = Prefs.get(this).getString(Prefs.WATCHED_APP, "");
        StringBuilder sb = new StringBuilder(who);
        int kept = 1;
        for (String w : current.split("\\|")) {
            if (w.isEmpty() || w.equals(who) || kept >= 6) continue;
            sb.append('|').append(w);
            kept++;
        }
        Prefs.put(this, Prefs.WATCHED_APP, sb.toString());
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
