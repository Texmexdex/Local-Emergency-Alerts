package org.localemergencyalerts.relay;

import android.content.Context;
import android.content.SharedPreferences;

/** Settings and status, kept in the app's private preferences. */
final class Prefs {
    static final String DEFAULT_WORKER = "https://local-emergency-alerts.he-texmexdex.workers.dev";
    static final String DEFAULT_MATCH = "CAER, CrimeRadar";

    static final String WORKER_URL = "worker_url";
    static final String TOKEN = "token";
    static final String APP_MATCH = "app_match";
    static final String SMS_SENDERS = "sms_senders";
    static final String LAST_FORWARDED = "last_forwarded";
    static final String LAST_RESULT = "last_result";
    static final String LAST_HEARTBEAT = "last_heartbeat";
    static final String WATCHED_APP = "watched_app";
    static final String PENDING = "pending";
    static final String RECENT_KEYS = "recent_keys";

    private Prefs() {}

    static SharedPreferences get(Context ctx) {
        return ctx.getSharedPreferences("relay", Context.MODE_PRIVATE);
    }

    static String workerUrl(Context ctx) {
        String url = get(ctx).getString(WORKER_URL, DEFAULT_WORKER).trim();
        while (url.endsWith("/")) url = url.substring(0, url.length() - 1);
        return url;
    }

    static String token(Context ctx) {
        return get(ctx).getString(TOKEN, "").trim();
    }

    static String appMatch(Context ctx) {
        String m = get(ctx).getString(APP_MATCH, DEFAULT_MATCH).trim();
        // Version 1 only forwarded CAER; upgrade an untouched setting to the new default.
        return m.isEmpty() || m.equalsIgnoreCase("CAER") ? DEFAULT_MATCH : m;
    }

    /** Text-message senders to forward (blank = none). */
    static String smsSenders(Context ctx) {
        return get(ctx).getString(SMS_SENDERS, "").trim();
    }

    /** Split a comma-separated setting into trimmed, non-empty parts. */
    static java.util.List<String> parts(String csv) {
        java.util.List<String> out = new java.util.ArrayList<>();
        for (String p : csv.split(",")) {
            String t = p.trim();
            if (!t.isEmpty()) out.add(t);
        }
        return out;
    }

    static void put(Context ctx, String key, String value) {
        get(ctx).edit().putString(key, value).apply();
    }
}
