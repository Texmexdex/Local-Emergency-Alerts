package org.localemergencyalerts.relay;

import android.content.Context;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.IOException;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.text.DateFormat;
import java.util.Date;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Sends notifications and heartbeats to the Worker's /api/ingest/notification
 * endpoint. Anything that can't be delivered is queued and retried with the
 * next notification or heartbeat.
 */
final class Relay {
    static final ExecutorService EXECUTOR = Executors.newSingleThreadExecutor();
    private static final int MAX_PENDING = 50;

    private Relay() {}

    /** HTTP status code, or -1 if the request never got a response. */
    static int post(Context ctx, JSONObject body, boolean heartbeat) {
        String token = Prefs.token(ctx);
        if (token.isEmpty()) return -2;
        HttpURLConnection conn = null;
        try {
            URL url = new URL(Prefs.workerUrl(ctx) + "/api/ingest/notification" + (heartbeat ? "?heartbeat=1" : ""));
            conn = (HttpURLConnection) url.openConnection();
            conn.setRequestMethod("POST");
            conn.setConnectTimeout(15000);
            conn.setReadTimeout(15000);
            conn.setDoOutput(true);
            conn.setRequestProperty("Authorization", "Bearer " + token);
            conn.setRequestProperty("Content-Type", "application/json");
            byte[] bytes = (body == null ? "{}" : body.toString()).getBytes(StandardCharsets.UTF_8);
            try (OutputStream out = conn.getOutputStream()) {
                out.write(bytes);
            }
            return conn.getResponseCode();
        } catch (IOException e) {
            return -1;
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    static boolean ok(int code) {
        return code >= 200 && code < 300;
    }

    static String describe(int code) {
        if (ok(code)) return "delivered";
        switch (code) {
            case -2: return "no password set";
            case -1: return "no connection (will retry)";
            case 401: return "wrong password (401)";
            case 503: return "relay not set up on the Worker yet (503)";
            default: return "error " + code + " (will retry)";
        }
    }

    private static String now() {
        return DateFormat.getDateTimeInstance(DateFormat.SHORT, DateFormat.SHORT).format(new Date());
    }

    /** Forward one notification (runs on the caller's thread). */
    static int forward(Context ctx, String title, String text, String app, String pkg, long postedAt) {
        JSONObject body = new JSONObject();
        try {
            body.put("title", title);
            body.put("text", text);
            body.put("app", app);
            if (pkg != null) body.put("package", pkg);
            body.put("time", postedAt);
        } catch (JSONException ignored) {
            // JSONObject.put only throws for non-finite numbers
        }
        flushPending(ctx);
        int code = post(ctx, body, false);
        if (!ok(code) && code != 401 && code != -2) enqueue(ctx, body);
        Prefs.put(ctx, Prefs.LAST_FORWARDED, now() + " · " + (title.isEmpty() ? text : title));
        Prefs.put(ctx, Prefs.LAST_RESULT, now() + " · " + describe(code));
        return code;
    }

    /** Retry queued notifications, then send a heartbeat (runs on the caller's thread). */
    static int heartbeat(Context ctx) {
        flushPending(ctx);
        int code = post(ctx, null, true);
        Prefs.put(ctx, Prefs.LAST_HEARTBEAT, now() + " · " + describe(code));
        return code;
    }

    private static synchronized void enqueue(Context ctx, JSONObject body) {
        JSONArray pending = pending(ctx);
        pending.put(body);
        while (pending.length() > MAX_PENDING) pending.remove(0);
        Prefs.put(ctx, Prefs.PENDING, pending.toString());
    }

    private static synchronized void flushPending(Context ctx) {
        JSONArray pending = pending(ctx);
        if (pending.length() == 0) return;
        JSONArray left = new JSONArray();
        for (int i = 0; i < pending.length(); i++) {
            JSONObject item = pending.optJSONObject(i);
            if (item == null) continue;
            if (!ok(post(ctx, item, false))) left.put(item);
        }
        Prefs.put(ctx, Prefs.PENDING, left.toString());
    }

    static int pendingCount(Context ctx) {
        return pending(ctx).length();
    }

    private static JSONArray pending(Context ctx) {
        try {
            return new JSONArray(Prefs.get(ctx).getString(Prefs.PENDING, "[]"));
        } catch (JSONException e) {
            return new JSONArray();
        }
    }
}
