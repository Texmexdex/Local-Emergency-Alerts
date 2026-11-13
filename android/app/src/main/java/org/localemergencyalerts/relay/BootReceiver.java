package org.localemergencyalerts.relay;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** Restart the hourly heartbeat after the phone reboots. */
public class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        if (Intent.ACTION_BOOT_COMPLETED.equals(intent.getAction())) {
            HeartbeatReceiver.schedule(context);
        }
    }
}
