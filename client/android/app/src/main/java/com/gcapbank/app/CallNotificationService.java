package com.gcapbank.app;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Intent;
import android.media.RingtoneManager;
import android.net.Uri;
import android.os.Build;

import androidx.core.app.NotificationCompat;

import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;

import java.util.Map;

/**
 * CallNotificationService — Firebase Cloud Messaging handler.
 *
 * Receives FCM messages even when the app is KILLED or in background.
 * Two message types handled:
 *   - type=call    → Full-screen incoming call notification (WhatsApp-style)
 *   - type=message → Heads-up message notification
 *
 * FCM token is sent to server via socket on app start (ChatPage.jsx).
 *
 * SETUP REQUIRED:
 *   1. Download google-services.json from Firebase Console
 *      → Project Settings → Your Apps → Android → Download google-services.json
 *   2. Place it in: client/android/app/google-services.json
 *   3. In client/android/build.gradle: classpath 'com.google.gms:google-services:4.4.1'
 *   4. In client/android/app/build.gradle: apply plugin: 'com.google.gms.google-services'
 *      + implementation 'com.google.firebase:firebase-messaging:23.4.1'
 */
public class CallNotificationService extends FirebaseMessagingService {

    private static final String CALL_CHANNEL_ID    = "gcapbank_call_channel";
    private static final String MESSAGE_CHANNEL_ID = "gcapbank_msg_channel";
    private static final int    CALL_NOTIF_ID      = 8001;
    private static final int    MSG_NOTIF_ID       = 8002;

    @Override
    public void onCreate() {
        super.onCreate();
        createChannels();
    }

    /**
     * Called when a new FCM token is generated (first install or token refresh).
     * The token is picked up by JS via PushNotifications.addListener('registration').
     */
    @Override
    public void onNewToken(String token) {
        super.onNewToken(token);
        // JS side (via @capacitor/push-notifications) will send this to the server automatically
    }

    /**
     * Called when a FCM message arrives while app is in background OR killed.
     * Data-only messages (no notification block) always reach this handler.
     */
    @Override
    public void onMessageReceived(RemoteMessage message) {
        Map<String, String> data = message.getData();
        String type = data.getOrDefault("type", "message");

        if ("call".equals(type)) {
            showIncomingCallNotification(data.getOrDefault("callType", "audio"));
        } else {
            String body = message.getNotification() != null
                    ? message.getNotification().getBody()
                    : "You have a new message";
            showMessageNotification(body);
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  Incoming Call Notification (WhatsApp-style full-screen)
    // ─────────────────────────────────────────────────────────────────────────

    private void showIncomingCallNotification(String callType) {
        boolean isVideo = "video".equals(callType);

        // Tap → open app (which will show incoming call UI via socket)
        Intent intent = new Intent(this, MainActivity.class);
        intent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        intent.putExtra("openCall", true);
        int piFlags = PendingIntent.FLAG_UPDATE_CURRENT |
                (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M ? PendingIntent.FLAG_IMMUTABLE : 0);
        PendingIntent contentPi = PendingIntent.getActivity(this, 0, intent, piFlags);

        // Full-screen intent (shows even on locked screen — like WhatsApp calls)
        PendingIntent fullScreenPi = PendingIntent.getActivity(this, 1, intent, piFlags);

        Uri ringtone = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE);

        NotificationCompat.Builder builder = new NotificationCompat.Builder(this, CALL_CHANNEL_ID)
                .setContentTitle(isVideo ? "📹 Incoming Video Call" : "📞 Incoming Audio Call")
                .setContentText("GCapBank — Tap to answer")
                .setSmallIcon(android.R.drawable.ic_menu_call)
                .setContentIntent(contentPi)
                .setFullScreenIntent(fullScreenPi, true)  // ← Shows on lock screen
                .setCategory(NotificationCompat.CATEGORY_CALL)
                .setPriority(NotificationCompat.PRIORITY_MAX)
                .setAutoCancel(true)
                .setOngoing(true)
                .setSound(ringtone)
                .setVibrate(new long[]{0, 500, 500, 500});

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            builder.setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE);
        }

        getSystemService(NotificationManager.class)
                .notify(CALL_NOTIF_ID, builder.build());
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  Message Notification (heads-up)
    // ─────────────────────────────────────────────────────────────────────────

    private void showMessageNotification(String body) {
        Intent intent = new Intent(this, MainActivity.class);
        intent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        int piFlags = PendingIntent.FLAG_UPDATE_CURRENT |
                (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M ? PendingIntent.FLAG_IMMUTABLE : 0);
        PendingIntent contentPi = PendingIntent.getActivity(this, 2, intent, piFlags);

        NotificationCompat.Builder builder = new NotificationCompat.Builder(this, MESSAGE_CHANNEL_ID)
                .setContentTitle("💬 GCapBank")
                .setContentText(body)
                .setSmallIcon(android.R.drawable.ic_dialog_email)
                .setContentIntent(contentPi)
                .setCategory(NotificationCompat.CATEGORY_MESSAGE)
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setAutoCancel(true);

        getSystemService(NotificationManager.class)
                .notify(MSG_NOTIF_ID, builder.build());
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  Create notification channels (Android 8+)
    // ─────────────────────────────────────────────────────────────────────────

    private void createChannels() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager nm = getSystemService(NotificationManager.class);

        // Call channel — highest priority
        NotificationChannel callCh = new NotificationChannel(
                CALL_CHANNEL_ID, "Incoming Calls", NotificationManager.IMPORTANCE_HIGH);
        callCh.setDescription("Incoming audio and video call alerts");
        callCh.enableVibration(true);
        callCh.setVibrationPattern(new long[]{0, 500, 500, 500});
        nm.createNotificationChannel(callCh);

        // Message channel — normal priority
        NotificationChannel msgCh = new NotificationChannel(
                MESSAGE_CHANNEL_ID, "Messages", NotificationManager.IMPORTANCE_DEFAULT);
        msgCh.setDescription("New message notifications");
        nm.createNotificationChannel(msgCh);
    }
}
