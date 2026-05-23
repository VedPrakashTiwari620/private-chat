package com.gcapbank.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.os.Build;
import android.os.IBinder;

import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;

/**
 * ForegroundCallService
 *
 * Keeps the app process alive in the background during an active Agora call.
 * Shows a persistent notification so the user can:
 *   - Tap notification  → return to call screen
 *   - Tap "End Call"    → terminate the call from notification
 *
 * Lifecycle:
 *   Start → AudioRoutePlugin.startForegroundService() → called by JS when Agora join() succeeds
 *   Stop  → AudioRoutePlugin.stopForegroundService()  → called by JS when call ends
 */
public class ForegroundCallService extends Service {

    public static final String CHANNEL_ID      = "gcapbank_call_channel";
    public static final String ACTION_START    = "com.gcapbank.app.START_CALL";
    public static final String ACTION_STOP     = "com.gcapbank.app.STOP_CALL";
    public static final String ACTION_END_CALL = "com.gcapbank.app.END_CALL";
    public static final int    NOTIF_ID        = 7001;

    /** JS callback — fired when user taps "End Call" on the notification */
    public interface EndCallCallback { void onEndCall(); }
    public static EndCallCallback endCallCallback = null;

    // ─────────────────────────────────────────────────────────────────────────

    @Override
    public void onCreate() {
        super.onCreate();
        createNotificationChannel();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null) { stopSelf(); return START_NOT_STICKY; }

        String action = intent.getAction() != null ? intent.getAction() : ACTION_START;
        switch (action) {
            case ACTION_STOP:
                stopForeground(true);
                stopSelf();
                return START_NOT_STICKY;

            case ACTION_END_CALL:
                // User tapped "End Call" in notification → notify JS
                if (endCallCallback != null) endCallCallback.onEndCall();
                stopForeground(true);
                stopSelf();
                return START_NOT_STICKY;

            default: // ACTION_START
                boolean isVideo = "video".equals(intent.getStringExtra("callType"));
                startForeground(NOTIF_ID, buildNotification(isVideo));
                return START_STICKY;
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  Notification builder
    // ─────────────────────────────────────────────────────────────────────────

    private Notification buildNotification(boolean isVideo) {
        // Tap on notification → bring MainActivity back to front
        Intent backIntent = new Intent(this, MainActivity.class);
        backIntent.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_REORDER_TO_FRONT);
        int piFlags = PendingIntent.FLAG_UPDATE_CURRENT |
                (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M ? PendingIntent.FLAG_IMMUTABLE : 0);
        PendingIntent contentPi = PendingIntent.getActivity(this, 0, backIntent, piFlags);

        // "End Call" action button in notification
        Intent endIntent = new Intent(this, ForegroundCallService.class);
        endIntent.setAction(ACTION_END_CALL);
        PendingIntent endPi = PendingIntent.getService(this, 1, endIntent, piFlags);

        NotificationCompat.Builder builder = new NotificationCompat.Builder(this, CHANNEL_ID)
                .setContentTitle(isVideo ? "📹 Video Call Active" : "📞 Audio Call Active")
                .setContentText("GCapBank — Tap to return to call")
                .setSmallIcon(android.R.drawable.ic_menu_call)
                .setContentIntent(contentPi)
                .addAction(android.R.drawable.ic_delete, "End Call", endPi)
                .setOngoing(true)
                .setSilent(true)
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setCategory(NotificationCompat.CATEGORY_CALL)
                .setShowWhen(true)
                .setUsesChronometer(true);   // shows elapsed time

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            builder.setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE);
        }
        return builder.build();
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  Notification channel (Android 8+)
    // ─────────────────────────────────────────────────────────────────────────

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel ch = new NotificationChannel(
                    CHANNEL_ID, "Active Calls", NotificationManager.IMPORTANCE_HIGH);
            ch.setDescription("Shown while a GCapBank call is in progress");
            ch.setSound(null, null);      // no sound — call is already ringing
            ch.enableVibration(false);
            getSystemService(NotificationManager.class).createNotificationChannel(ch);
        }
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) { return null; }
}
