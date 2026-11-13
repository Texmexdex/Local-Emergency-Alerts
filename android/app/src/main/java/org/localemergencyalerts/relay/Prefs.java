package org.localemergencyalerts.relay;

import android.content.Context;
import android.content.SharedPreferences;

/** Settings and status, kept in the app's private preferences. */
final class Prefs {
    static final String DEFAULT_WORKER = "https://local-emergency-alerts.he-texmexdex.workers.dev";
    static final String DEFAULT_MATCH = "CAER";

    static final String WORKER_URL = "worker_url";
    static final String TOKEN = "token";
    static final String APP_MATCH = "app_match";
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
        return m.isEmpty() ? DEFAULT_MATCH : m;
    }

    static void put(Context ctx, String key, String value) {
        get(ctx).edit().putString(key, value).apply();
    }
}
