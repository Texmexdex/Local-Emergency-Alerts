package org.localemergencyalerts.relay;

import android.app.Activity;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.os.Bundle;
import android.provider.Settings;
import android.text.InputType;
import android.view.View;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

/** Single settings/status screen. */
public class MainActivity extends Activity {
    private EditText workerUrl;
    private EditText token;
    private EditText appMatch;
    private TextView status;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        int pad = dp(16);
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(pad, pad, pad, pad);

        root.addView(text("Forwards notifications from the EHCMA CAER Online app to your "
                + "Local Emergency Alerts Worker. Keep this phone plugged in and on WiFi.", 15));

        root.addView(label("Worker address"));
        workerUrl = edit(Prefs.workerUrl(this), InputType.TYPE_TEXT_VARIATION_URI);
        root.addView(workerUrl);

        root.addView(label("Relay password (INGEST_TOKEN)"));
        token = edit(Prefs.token(this), InputType.TYPE_TEXT_VARIATION_PASSWORD);
        root.addView(token);

        root.addView(label("Forward apps whose name contains"));
        appMatch = edit(Prefs.appMatch(this), InputType.TYPE_TEXT_VARIATION_NORMAL);
        root.addView(appMatch);

        root.addView(button("Save", v -> save()));
        root.addView(button("1. Allow notification access", v ->
                startActivity(new Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS))));
        root.addView(button("2. Don't let Android put this app to sleep", v ->
                startActivity(new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))));
        root.addView(button("3. Send a test message", v -> sendTest()));
        root.addView(button("Send heartbeat now", v -> sendHeartbeat()));

        root.addView(label("Status"));
        status = text("", 14);
        root.addView(status);

        ScrollView scroll = new ScrollView(this);
        scroll.addView(root);
        setContentView(scroll);
    }

    @Override
    protected void onResume() {
        super.onResume();
        refresh();
    }

    private void save() {
        Prefs.get(this).edit()
                .putString(Prefs.WORKER_URL, workerUrl.getText().toString().trim())
                .putString(Prefs.TOKEN, token.getText().toString().trim())
                .putString(Prefs.APP_MATCH, appMatch.getText().toString().trim())
                .apply();
        HeartbeatReceiver.schedule(this);
        Toast.makeText(this, "Saved", Toast.LENGTH_SHORT).show();
        refresh();
    }

    private void sendTest() {
        save();
        Context ctx = getApplicationContext();
        Relay.EXECUTOR.execute(() -> {
            int code = Relay.forward(ctx, "CAER Relay test",
                    "*** DRILL *** This is a test message from the CAER Relay app.", "CAER Relay", System.currentTimeMillis());
            runOnUiThread(() -> {
                Toast.makeText(this, "Test: " + Relay.describe(code), Toast.LENGTH_LONG).show();
                refresh();
            });
        });
    }

    private void sendHeartbeat() {
        save();
        Context ctx = getApplicationContext();
        Relay.EXECUTOR.execute(() -> {
            int code = Relay.heartbeat(ctx);
            runOnUiThread(() -> {
                Toast.makeText(this, "Heartbeat: " + Relay.describe(code), Toast.LENGTH_LONG).show();
                refresh();
            });
        });
    }

    private void refresh() {
        boolean access = hasNotificationAccess();
        String watched = Prefs.get(this).getString(Prefs.WATCHED_APP, "");
        StringBuilder sb = new StringBuilder();
        sb.append("Notification access: ").append(access ? "allowed ✓" : "NOT allowed — tap step 1").append('\n');
        sb.append("Password: ").append(Prefs.token(this).isEmpty() ? "not set" : "set").append('\n');
        sb.append("Watching: ").append(watched.isEmpty()
                ? "no matching app has posted yet (looking for \"" + Prefs.appMatch(this) + "\")" : watched).append('\n');
        sb.append("Last forwarded: ").append(Prefs.get(this).getString(Prefs.LAST_FORWARDED, "none yet")).append('\n');
        sb.append("Last delivery: ").append(Prefs.get(this).getString(Prefs.LAST_RESULT, "none yet")).append('\n');
        sb.append("Last heartbeat: ").append(Prefs.get(this).getString(Prefs.LAST_HEARTBEAT, "none yet")).append('\n');
        int pending = Relay.pendingCount(this);
        if (pending > 0) sb.append("Waiting to resend: ").append(pending).append('\n');
        status.setText(sb.toString());
    }

    private boolean hasNotificationAccess() {
        String enabled = Settings.Secure.getString(getContentResolver(), "enabled_notification_listeners");
        ComponentName me = new ComponentName(this, RelayListener.class);
        return enabled != null && enabled.contains(me.flattenToString());
    }

    private int dp(int v) {
        return Math.round(v * getResources().getDisplayMetrics().density);
    }

    private TextView text(String s, int sizeSp) {
        TextView t = new TextView(this);
        t.setText(s);
        t.setTextSize(sizeSp);
        t.setPadding(0, dp(4), 0, dp(4));
        return t;
    }

    private TextView label(String s) {
        TextView t = text(s, 13);
        t.setPadding(0, dp(12), 0, 0);
        return t;
    }

    private EditText edit(String value, int variation) {
        EditText e = new EditText(this);
        e.setInputType(InputType.TYPE_CLASS_TEXT | variation);
        e.setSingleLine(true);
        e.setText(value);
        return e;
    }

    private Button button(String s, View.OnClickListener onClick) {
        Button b = new Button(this);
        b.setText(s);
        b.setAllCaps(false);
        b.setOnClickListener(onClick);
        return b;
    }
}
