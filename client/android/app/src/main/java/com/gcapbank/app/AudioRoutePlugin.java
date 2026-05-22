package com.gcapbank.app;

import android.Manifest;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.media.AudioManager;
import android.media.MediaScannerConnection;
import android.media.Ringtone;
import android.media.RingtoneManager;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.os.VibratorManager;
import android.provider.MediaStore;
import android.telephony.PhoneStateListener;
import android.telephony.TelephonyCallback;
import android.telephony.TelephonyManager;
import android.util.Base64;

import androidx.annotation.RequiresApi;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import android.content.pm.PackageManager;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.List;

/**
 * AudioRoutePlugin — Native Capacitor Bridge
 *
 * Provides native Android capabilities to the JavaScript layer:
 * 1. Audio routing (earpiece / speakerphone) for WebRTC calls
 * 2. Ringtone + Vibration for incoming call alerts
 * 3. Save image to device Gallery via MediaStore
 * 4. Request camera / microphone permissions at runtime
 * 5. Native phone call state monitoring (mute WebRTC on incoming native call)
 */
@CapacitorPlugin(name = "AudioRoute")
public class AudioRoutePlugin extends Plugin {

    // ── Ringtone state ─────────────────────────────────────────────────────────
    private Ringtone  currentRingtone;
    private Vibrator  vibrator;

    // ── Phone state ────────────────────────────────────────────────────────────
    private TelephonyManager telephonyManager;
    private PhoneStateListener legacyPhoneListener;  // API < 31
    private TelephonyCallback  modernPhoneCallback;  // API 31+
    private boolean phoneListenerRegistered = false;

    // ── Inner class for API 31+ TelephonyCallback ──────────────────────────
    // Cannot use anonymous class here — TelephonyCallback.onCallStateChanged
    // requires implementing TelephonyCallback.CallStateListener interface.
    @RequiresApi(api = Build.VERSION_CODES.S)
    private class AppCallCallback extends TelephonyCallback
            implements TelephonyCallback.CallStateListener {
        @Override
        public void onCallStateChanged(int state) {
            notifyNativeCallState(state);
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  Plugin lifecycle
    // ─────────────────────────────────────────────────────────────────────────
    @Override
    public void load() {
        super.load();
        setupPhoneStateListener();
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  1. AUDIO ROUTING
    // ─────────────────────────────────────────────────────────────────────────

    /** Route audio to EARPIECE (front speaker) — like WhatsApp calls */
    @PluginMethod
    public void startEarpiece(PluginCall call) {
        try {
            AudioManager am = (AudioManager) getContext().getSystemService(Context.AUDIO_SERVICE);
            am.setMode(AudioManager.MODE_IN_COMMUNICATION);
            am.setSpeakerphoneOn(false);
            call.resolve();
        } catch (Exception e) {
            call.reject("startEarpiece failed: " + e.getMessage());
        }
    }

    /** Route audio to SPEAKERPHONE (back loud speaker) */
    @PluginMethod
    public void startSpeaker(PluginCall call) {
        try {
            AudioManager am = (AudioManager) getContext().getSystemService(Context.AUDIO_SERVICE);
            am.setMode(AudioManager.MODE_IN_COMMUNICATION);
            am.setSpeakerphoneOn(true);
            call.resolve();
        } catch (Exception e) {
            call.reject("startSpeaker failed: " + e.getMessage());
        }
    }

    /** Reset audio mode back to NORMAL after call ends */
    @PluginMethod
    public void stopAudio(PluginCall call) {
        try {
            AudioManager am = (AudioManager) getContext().getSystemService(Context.AUDIO_SERVICE);
            am.setSpeakerphoneOn(false);
            am.setMode(AudioManager.MODE_NORMAL);
            if (call != null) call.resolve();
        } catch (Exception e) {
            if (call != null) call.reject("stopAudio failed: " + e.getMessage());
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  2. RINGTONE + VIBRATION
    // ─────────────────────────────────────────────────────────────────────────

    /** Play the device's default ringtone + vibration pattern (looping) */
    @PluginMethod
    public void playRingtone(PluginCall call) {
        try {
            // Stop any existing ringtone first
            stopRingtoneInternal();

            // Play system default ringtone
            Uri ringtoneUri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE);
            if (ringtoneUri == null) {
                ringtoneUri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION);
            }
            currentRingtone = RingtoneManager.getRingtone(getContext(), ringtoneUri);
            if (currentRingtone != null) {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                    currentRingtone.setLooping(true);
                }
                // Set ringtone to full volume on ringer stream
                AudioManager am = (AudioManager) getContext().getSystemService(Context.AUDIO_SERVICE);
                if (am != null) am.setMode(AudioManager.MODE_RINGTONE);
                currentRingtone.play();
            }

            // Vibrate: 500ms on, 500ms off, repeat
            startVibration();

            call.resolve();
        } catch (Exception e) {
            call.reject("playRingtone failed: " + e.getMessage());
        }
    }

    /** Stop ringtone + vibration */
    @PluginMethod
    public void stopRingtone(PluginCall call) {
        try {
            stopRingtoneInternal();
            if (call != null) call.resolve();
        } catch (Exception e) {
            if (call != null) call.reject("stopRingtone failed: " + e.getMessage());
        }
    }

    private void stopRingtoneInternal() {
        if (currentRingtone != null) {
            currentRingtone.stop();
            currentRingtone = null;
        }
        if (vibrator != null) {
            vibrator.cancel();
            vibrator = null;
        }
        // Reset audio mode
        try {
            AudioManager am = (AudioManager) getContext().getSystemService(Context.AUDIO_SERVICE);
            if (am != null) am.setMode(AudioManager.MODE_NORMAL);
        } catch (Exception ignored) {}
    }

    @SuppressWarnings("deprecation")
    private void startVibration() {
        try {
            long[] pattern = { 0, 500, 500 };  // wait 0, on 500, off 500 → repeat at index 0
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                VibratorManager vm = (VibratorManager) getContext().getSystemService(Context.VIBRATOR_MANAGER_SERVICE);
                if (vm != null) {
                    vibrator = vm.getDefaultVibrator();
                }
            } else {
                vibrator = (Vibrator) getContext().getSystemService(Context.VIBRATOR_SERVICE);
            }
            if (vibrator != null && vibrator.hasVibrator()) {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    vibrator.vibrate(VibrationEffect.createWaveform(pattern, 0));
                } else {
                    vibrator.vibrate(pattern, 0);
                }
            }
        } catch (Exception ignored) {}
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  3. SAVE IMAGE TO GALLERY
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Save a base64 image to the device gallery.
     * Accepts: { base64: "data:image/jpeg;base64,...", filename: "optional.jpg" }
     * On Android 10+ uses MediaStore (no permission needed).
     * On Android < 10 uses direct file write (needs WRITE_EXTERNAL_STORAGE).
     */
    @PluginMethod
    public void saveImageToGallery(PluginCall call) {
        String base64 = call.getString("base64", "");
        String filename = call.getString("filename", "GCapBank_" + System.currentTimeMillis() + ".jpg");

        if (base64 == null || base64.isEmpty()) {
            call.reject("Missing base64 data");
            return;
        }

        // Strip data URL prefix if present (e.g. "data:image/jpeg;base64,")
        if (base64.contains(",")) {
            base64 = base64.split(",", 2)[1];
        }

        try {
            byte[] imageBytes = Base64.decode(base64, Base64.DEFAULT);

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                // Android 10+ — MediaStore (no permissions needed)
                saveViaMediaStore(imageBytes, filename);
            } else {
                // Android < 10 — direct file write
                saveViaFileSystem(imageBytes, filename);
            }

            JSObject result = new JSObject();
            result.put("saved", true);
            result.put("filename", filename);
            call.resolve(result);

        } catch (Exception e) {
            call.reject("Save failed: " + e.getMessage());
        }
    }

    @RequiresApi(api = Build.VERSION_CODES.Q)
    private void saveViaMediaStore(byte[] imageBytes, String filename) throws Exception {
        ContentValues values = new ContentValues();
        values.put(MediaStore.Images.Media.DISPLAY_NAME, filename);
        values.put(MediaStore.Images.Media.MIME_TYPE, "image/jpeg");
        values.put(MediaStore.Images.Media.RELATIVE_PATH,
                Environment.DIRECTORY_PICTURES + "/GCapBank");
        values.put(MediaStore.Images.Media.IS_PENDING, 1);

        ContentResolver resolver = getContext().getContentResolver();
        Uri uri = resolver.insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values);
        if (uri == null) throw new Exception("Could not create MediaStore entry");

        try (OutputStream out = resolver.openOutputStream(uri)) {
            if (out == null) throw new Exception("Could not open output stream");
            out.write(imageBytes);
        }

        values.clear();
        values.put(MediaStore.Images.Media.IS_PENDING, 0);
        resolver.update(uri, values, null, null);
    }

    @SuppressWarnings("deprecation")
    private void saveViaFileSystem(byte[] imageBytes, String filename) throws Exception {
        File dir = new File(
                Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_PICTURES),
                "GCapBank");
        if (!dir.exists() && !dir.mkdirs()) throw new Exception("Could not create directory");

        File file = new File(dir, filename);
        try (FileOutputStream fos = new FileOutputStream(file)) {
            fos.write(imageBytes);
        }

        // Tell MediaScanner to index the new file so it appears in Gallery
        MediaScannerConnection.scanFile(
                getContext(),
                new String[]{ file.getAbsolutePath() },
                new String[]{ "image/jpeg" },
                null);
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  4. RUNTIME PERMISSIONS
    // ─────────────────────────────────────────────────────────────────────────

    /** Request CAMERA + RECORD_AUDIO at runtime (required for WebRTC getUserMedia) */
    @PluginMethod
    public void requestMediaPermissions(PluginCall call) {
        List<String> needed = new ArrayList<>();

        if (ContextCompat.checkSelfPermission(getContext(), Manifest.permission.CAMERA)
                != PackageManager.PERMISSION_GRANTED) {
            needed.add(Manifest.permission.CAMERA);
        }
        if (ContextCompat.checkSelfPermission(getContext(), Manifest.permission.RECORD_AUDIO)
                != PackageManager.PERMISSION_GRANTED) {
            needed.add(Manifest.permission.RECORD_AUDIO);
        }

        if (!needed.isEmpty()) {
            ActivityCompat.requestPermissions(
                    getActivity(),
                    needed.toArray(new String[0]),
                    1001);
        }

        JSObject result = new JSObject();
        result.put("requested", needed.size());
        call.resolve(result);
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  5. NATIVE PHONE CALL STATE (auto-mute WebRTC on incoming native call)
    // ─────────────────────────────────────────────────────────────────────────

    private void setupPhoneStateListener() {
        try {
            telephonyManager = (TelephonyManager)
                    getContext().getSystemService(Context.TELEPHONY_SERVICE);
            if (telephonyManager == null || phoneListenerRegistered) return;

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                // API 31+ — use named inner class (anonymous class cannot implement
                // TelephonyCallback.CallStateListener in an @Override)
                modernPhoneCallback = new AppCallCallback();
                telephonyManager.registerTelephonyCallback(
                        getContext().getMainExecutor(),
                        modernPhoneCallback);
            } else {
                // API < 31 — PhoneStateListener
                legacyPhoneListener = new PhoneStateListener() {
                    @Override
                    public void onCallStateChanged(int state, String phoneNumber) {
                        notifyNativeCallState(state);
                    }
                };
                //noinspection deprecation
                telephonyManager.listen(legacyPhoneListener,
                        PhoneStateListener.LISTEN_CALL_STATE);
            }

            phoneListenerRegistered = true;
        } catch (Exception e) {
            // READ_PHONE_STATE might not be granted yet — fail silently
        }
    }

    private void notifyNativeCallState(int state) {
        JSObject data = new JSObject();
        String stateStr;
        if (state == TelephonyManager.CALL_STATE_RINGING ||
                state == TelephonyManager.CALL_STATE_OFFHOOK) {
            stateStr = "active";  // native call in progress — mute WebRTC
        } else {
            stateStr = "idle";    // native call ended — restore WebRTC
        }
        data.put("state", stateStr);
        notifyListeners("nativeCallState", data);
    }

    @Override
    protected void handleOnDestroy() {
        try {
            stopRingtoneInternal();
            if (telephonyManager != null) {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && modernPhoneCallback != null) {
                    telephonyManager.unregisterTelephonyCallback(modernPhoneCallback);
                } else if (legacyPhoneListener != null) {
                    //noinspection deprecation
                    telephonyManager.listen(legacyPhoneListener, PhoneStateListener.LISTEN_NONE);
                }
            }
        } catch (Exception ignored) {}
        super.handleOnDestroy();
    }
}
