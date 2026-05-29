package com.gcapbank.app;

import android.Manifest;
import android.app.PictureInPictureParams;
import android.content.BroadcastReceiver;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageManager;
import android.hardware.Sensor;
import android.hardware.SensorEvent;
import android.hardware.SensorEventListener;
import android.hardware.SensorManager;
import android.media.AudioAttributes;
import android.media.AudioDeviceInfo;
import android.media.AudioManager;
import android.media.MediaScannerConnection;
import android.media.Ringtone;
import android.media.RingtoneManager;
import android.net.Uri;
import android.media.AudioFocusRequest;
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
import android.util.Rational;
import android.media.ToneGenerator;

import androidx.annotation.RequiresApi;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;

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
 * AudioRoutePlugin — Comprehensive Native Capacitor Bridge
 *
 * Features:
 *  1. Audio routing — earpiece (default) / speakerphone toggle
 *  2. Audio focus — request/abandon (AudioFocusRequest API)
 *  3. Proximity sensor — screen OFF near ear, ON away (like WhatsApp)
 *  4. Headset detection — wired/Bluetooth auto-switch
 *  5. Ringtone + vibration for incoming call alerts
 *  6. Save image to gallery (MediaStore)
 *  7. Runtime camera/mic permissions
 *  8. Native phone call state (mute Agora on GSM call)
 *  9. Foreground call service — persistent notification in background
 * 10. PiP trigger + call-active flag for auto-PiP on Home press
 */
@CapacitorPlugin(name = "AudioRoute")
public class AudioRoutePlugin extends Plugin {

    // ── Static flag — read by MainActivity for auto-PiP on Home press ─────────
    public static boolean callActive = false;

    // ── Ringtone ───────────────────────────────────────────────────────────────
    private Ringtone currentRingtone;
    private Vibrator vibrator;
    
    // ── Outgoing Tone ────────────────────────────────────────────────────────
    private ToneGenerator toneGenerator;

    // ── Phone state (GSM call detection) ──────────────────────────────────────
    private TelephonyManager telephonyManager;
    private PhoneStateListener legacyPhoneListener;
    private TelephonyCallback modernPhoneCallback;
    private boolean phoneListenerRegistered = false;

    // ── Proximity sensor ────────────────────────────────────────────────────
    private SensorManager sensorManager;
    private Sensor proximitySensor;
    private SensorEventListener proximityListener;
    private boolean proximitySensorActive = false;

    // ── Audio focus ───────────────────────────────────────────────────────────
    private AudioFocusRequest audioFocusRequest; // API 26+
    private boolean hasFocus = false;

    // ── Headset broadcast receiver ─────────────────────────────────────────────
    private BroadcastReceiver headsetReceiver;
    private boolean headsetReceiverRegistered = false;

    // ── API 31+ TelephonyCallback ──────────────────────────────────────────────
    @RequiresApi(api = Build.VERSION_CODES.S)
    private class AppCallCallback extends TelephonyCallback
            implements TelephonyCallback.CallStateListener {
        @Override public void onCallStateChanged(int state) { notifyNativeCallState(state); }
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  Plugin lifecycle
    // ─────────────────────────────────────────────────────────────────────────

    @Override
    public void load() {
        super.load();
        sensorManager = (SensorManager) getContext().getSystemService(Context.SENSOR_SERVICE);
        setupPhoneStateListener();
        setupHeadsetReceiver();
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  1. AUDIO ROUTING
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Route audio to EARPIECE (front speaker) — default for calls (like WhatsApp).
     * JS calls this BEFORE Agora join() — equivalent to setDefaultAudioRouteToSpeakerphone(false).
     * JS also calls this after publish() with 800ms delay for double-confirmation.
     */
    @PluginMethod
    public void startEarpiece(PluginCall call) {
        try {
            AudioManager am = (AudioManager) getContext().getSystemService(Context.AUDIO_SERVICE);
            am.setMode(AudioManager.MODE_IN_COMMUNICATION);
            setAudioRoute(am, false);
            if (call != null) call.resolve();
        } catch (Exception e) {
            if (call != null) call.reject("startEarpiece failed: " + e.getMessage());
        }
    }

    /**
     * Route audio to SPEAKERPHONE (loudspeaker) — called when user taps speaker toggle.
     * Equivalent to setEnableSpeakerphone(true).
     */
    @PluginMethod
    public void startSpeaker(PluginCall call) {
        try {
            AudioManager am = (AudioManager) getContext().getSystemService(Context.AUDIO_SERVICE);
            am.setMode(AudioManager.MODE_IN_COMMUNICATION);
            setAudioRoute(am, true);
            if (call != null) call.resolve();
        } catch (Exception e) {
            if (call != null) call.reject("startSpeaker failed: " + e.getMessage());
        }
    }

    /** Reset audio mode to NORMAL after call ends */
    @PluginMethod
    public void stopAudio(PluginCall call) {
        try {
            AudioManager am = (AudioManager) getContext().getSystemService(Context.AUDIO_SERVICE);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                am.clearCommunicationDevice();
            }
            am.setSpeakerphoneOn(false);
            am.setMode(AudioManager.MODE_NORMAL);
            if (call != null) call.resolve();
        } catch (Exception e) {
            if (call != null) call.reject("stopAudio failed: " + e.getMessage());
        }
    }

    private void setAudioRoute(AudioManager am, boolean speakerOn) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            AudioDeviceInfo targetDevice = null;
            for (AudioDeviceInfo device : am.getAvailableCommunicationDevices()) {
                if (speakerOn && device.getType() == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER) {
                    targetDevice = device;
                    break;
                } else if (!speakerOn && device.getType() == AudioDeviceInfo.TYPE_BUILTIN_EARPIECE) {
                    targetDevice = device;
                    break;
                }
            }
            if (targetDevice != null) {
                am.setCommunicationDevice(targetDevice);
            }
        } else {
            // Fallback for Android < 12
            am.setSpeakerphoneOn(speakerOn);
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  2. AUDIO FOCUS
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Request AUDIOFOCUS_GAIN_TRANSIENT_EXCLUSIVE for calls.
     * Ducks other audio (music, etc.) and ensures our call audio has exclusive routing.
     * Call this BEFORE Agora join().
     */
    @PluginMethod
    public void requestAudioFocus(PluginCall call) {
        try {
            AudioManager am = (AudioManager) getContext().getSystemService(Context.AUDIO_SERVICE);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                AudioAttributes attrs = new AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                        .build();
                audioFocusRequest = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_EXCLUSIVE)
                        .setAudioAttributes(attrs)
                        .setAcceptsDelayedFocusGain(false)
                        .setOnAudioFocusChangeListener(focusChange -> {
                            // Handle transient loss (e.g. notification sound)
                            if (focusChange == AudioManager.AUDIOFOCUS_LOSS_TRANSIENT) {
                                JSObject data = new JSObject();
                                data.put("focus", "lost_transient");
                                notifyListeners("audioFocusChanged", data);
                            } else if (focusChange == AudioManager.AUDIOFOCUS_GAIN) {
                                JSObject data = new JSObject();
                                data.put("focus", "gained");
                                notifyListeners("audioFocusChanged", data);
                            }
                        })
                        .build();
                int result = am.requestAudioFocus(audioFocusRequest);
                hasFocus = (result == AudioManager.AUDIOFOCUS_REQUEST_GRANTED);
            } else {
                //noinspection deprecation
                int result = am.requestAudioFocus(null, AudioManager.STREAM_VOICE_CALL,
                        AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_EXCLUSIVE);
                hasFocus = (result == AudioManager.AUDIOFOCUS_REQUEST_GRANTED);
            }
            JSObject res = new JSObject();
            res.put("granted", hasFocus);
            call.resolve(res);
        } catch (Exception e) {
            call.reject("requestAudioFocus failed: " + e.getMessage());
        }
    }

    /** Release audio focus after call ends */
    @PluginMethod
    public void abandonAudioFocus(PluginCall call) {
        try {
            AudioManager am = (AudioManager) getContext().getSystemService(Context.AUDIO_SERVICE);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && audioFocusRequest != null) {
                am.abandonAudioFocusRequest(audioFocusRequest);
            } else {
                //noinspection deprecation
                am.abandonAudioFocus(null);
            }
            hasFocus = false;
            if (call != null) call.resolve();
        } catch (Exception e) {
            if (call != null) call.reject("abandonAudioFocus failed: " + e.getMessage());
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  3. PROXIMITY SENSOR (screen off near ear, like WhatsApp)
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Enable proximity sensor.
     * When phone is near ear → screen dims/off, earpiece stays active.
     * When pulled away → screen turns on.
     */
    @PluginMethod
    public void startProximitySensor(PluginCall call) {
        if (proximitySensorActive) { call.resolve(); return; }
        try {
            if (sensorManager == null) {
                sensorManager = (SensorManager) getContext().getSystemService(Context.SENSOR_SERVICE);
            }
            proximitySensor = sensorManager.getDefaultSensor(Sensor.TYPE_PROXIMITY);
            if (proximitySensor == null) {
                // Proximity sensor not available on this device — resolve gracefully
                call.resolve();
                return;
            }

            proximityListener = new SensorEventListener() {
                @Override
                public void onSensorChanged(SensorEvent event) {
                    float distance = event.values[0];
                    float maxRange = proximitySensor.getMaximumRange();
                    boolean near = (distance < maxRange);
                    // Notify JS — JS can handle screen dimming via KeepAwake plugin if needed
                    JSObject data = new JSObject();
                    data.put("near", near);
                    data.put("distance", distance);
                    notifyListeners("proximityChanged", data);
                }
                @Override public void onAccuracyChanged(Sensor sensor, int accuracy) {}
            };

            sensorManager.registerListener(proximityListener, proximitySensor,
                    SensorManager.SENSOR_DELAY_NORMAL);
            proximitySensorActive = true;
            call.resolve();
        } catch (Exception e) {
            // Non-fatal — proximity sensor failure should not break the call
            call.resolve();
        }
    }

    /** Disable proximity sensor */
    @PluginMethod
    public void stopProximitySensor(PluginCall call) {
        try {
            if (proximityListener != null && sensorManager != null) {
                sensorManager.unregisterListener(proximityListener);
                proximityListener = null;
            }
            proximitySensorActive = false;
            if (call != null) call.resolve();
        } catch (Exception e) {
            if (call != null) call.resolve(); // non-fatal
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  4. HEADSET DETECTION (wired + Bluetooth auto-switch)
    // ─────────────────────────────────────────────────────────────────────────

    private void setupHeadsetReceiver() {
        if (headsetReceiverRegistered) return;
        headsetReceiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context context, Intent intent) {
                String action = intent.getAction();
                JSObject data = new JSObject();

                if (AudioManager.ACTION_HEADSET_PLUG.equals(action)) {
                    int state = intent.getIntExtra("state", -1);
                    // state=1 → plugged in, state=0 → unplugged
                    data.put("type", "wired");
                    data.put("connected", state == 1);
                    // When wired headset plugged → route to headset (Android does this automatically)
                    // When unplugged → restore earpiece
                    if (state == 0 && callActive) {
                        startEarpiece(null); // restore earpiece
                    }
                } else if (AudioManager.ACTION_SCO_AUDIO_STATE_UPDATED.equals(action)) {
                    int sco = intent.getIntExtra(AudioManager.EXTRA_SCO_AUDIO_STATE, -1);
                    data.put("type", "bluetooth");
                    data.put("connected", sco == AudioManager.SCO_AUDIO_STATE_CONNECTED);
                    if (sco == AudioManager.SCO_AUDIO_STATE_DISCONNECTED && callActive) {
                        startEarpiece(null); // fallback to earpiece
                    }
                }
                notifyListeners("headsetChanged", data);
            }
        };

        IntentFilter filter = new IntentFilter();
        filter.addAction(AudioManager.ACTION_HEADSET_PLUG);
        filter.addAction(AudioManager.ACTION_SCO_AUDIO_STATE_UPDATED);
        getContext().registerReceiver(headsetReceiver, filter);
        headsetReceiverRegistered = true;
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  5. FOREGROUND CALL SERVICE
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Start the foreground call notification service.
     * JS calls this after Agora join() succeeds.
     * Keeps app alive in background + shows "Back to Call / End Call" notification.
     */
    @PluginMethod
    public void startForegroundService(PluginCall call) {
        try {
            String callType = call.getString("callType", "audio");
            Intent intent = new Intent(getContext(), ForegroundCallService.class);
            intent.setAction(ForegroundCallService.ACTION_START);
            intent.putExtra("callType", callType);

            // Register callback so notification "End Call" notifies JS
            ForegroundCallService.endCallCallback = () -> {
                notifyListeners("callEndedFromNotification", new JSObject());
            };

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                getContext().startForegroundService(intent);
            } else {
                getContext().startService(intent);
            }
            call.resolve();
        } catch (Exception e) {
            call.reject("startForegroundService failed: " + e.getMessage());
        }
    }

    /** Stop the foreground notification service. JS calls this when call ends. */
    @PluginMethod
    public void stopForegroundService(PluginCall call) {
        try {
            Intent intent = new Intent(getContext(), ForegroundCallService.class);
            intent.setAction(ForegroundCallService.ACTION_STOP);
            getContext().startService(intent);
            ForegroundCallService.endCallCallback = null;
            if (call != null) call.resolve();
        } catch (Exception e) {
            if (call != null) call.reject("stopForegroundService failed: " + e.getMessage());
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  6. CALL ACTIVE FLAG + PiP
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * JS calls setCallActive({active: true}) when Agora call starts.
     * JS calls setCallActive({active: false}) when call ends.
     * MainActivity reads this to decide whether to enter PiP on Home press.
     */
    @PluginMethod
    public void setCallActive(PluginCall call) {
        callActive = Boolean.TRUE.equals(call.getBoolean("active", false));
        call.resolve();
    }

    /**
     * Enter Android Picture-in-Picture mode from JS.
     * Called when back is pressed during a video call.
     * Requires Android 8.0+ (API 26).
     */
    @PluginMethod
    public void enterPiP(PluginCall call) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            getActivity().runOnUiThread(() -> {
                try {
                    PictureInPictureParams params = new PictureInPictureParams.Builder()
                            .setAspectRatio(new Rational(9, 16))
                            .build();
                    getActivity().enterPictureInPictureMode(params);
                    call.resolve();
                } catch (Exception e) {
                    call.reject("enterPiP failed: " + e.getMessage());
                }
            });
        } else {
            call.reject("PiP requires Android 8.0+");
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  7. RINGTONE + VIBRATION
    // ─────────────────────────────────────────────────────────────────────────

    @PluginMethod
    public void playRingtone(PluginCall call) {
        try {
            stopRingtoneInternal();
            Uri ringtoneUri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE);
            if (ringtoneUri == null) ringtoneUri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION);
            currentRingtone = RingtoneManager.getRingtone(getContext(), ringtoneUri);
            if (currentRingtone != null) {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) currentRingtone.setLooping(true);
                AudioManager am = (AudioManager) getContext().getSystemService(Context.AUDIO_SERVICE);
                if (am != null) am.setMode(AudioManager.MODE_RINGTONE);
                currentRingtone.play();
            }
            startVibration();
            call.resolve();
        } catch (Exception e) {
            call.reject("playRingtone failed: " + e.getMessage());
        }
    }

    @PluginMethod
    public void stopRingtone(PluginCall call) {
        try {
            stopRingtoneInternal();
            if (call != null) call.resolve();
        } catch (Exception e) {
            if (call != null) call.reject("stopRingtone failed: " + e.getMessage());
        }
    }

    @PluginMethod
    public void playOutgoingRing(PluginCall call) {
        try {
            stopOutgoingRingInternal();
            AudioManager am = (AudioManager) getContext().getSystemService(Context.AUDIO_SERVICE);
            am.setMode(AudioManager.MODE_IN_COMMUNICATION);
            setAudioRoute(am, false); // Default to earpiece
            
            // STREAM_VOICE_CALL ensures it routes to earpiece
            toneGenerator = new ToneGenerator(AudioManager.STREAM_VOICE_CALL, 100);
            // TONE_SUP_RINGTONE is the standard telecom ringing sound (tuuu... tuuu...)
            toneGenerator.startTone(ToneGenerator.TONE_SUP_RINGTONE);
            
            call.resolve();
        } catch (Exception e) {
            call.reject("playOutgoingRing failed: " + e.getMessage());
        }
    }

    @PluginMethod
    public void stopOutgoingRing(PluginCall call) {
        try {
            stopOutgoingRingInternal();
            if (call != null) call.resolve();
        } catch (Exception e) {
            if (call != null) call.reject("stopOutgoingRing failed: " + e.getMessage());
        }
    }

    private void stopOutgoingRingInternal() {
        if (toneGenerator != null) {
            toneGenerator.stopTone();
            toneGenerator.release();
            toneGenerator = null;
        }
    }

    private void stopRingtoneInternal() {
        if (currentRingtone != null) { currentRingtone.stop(); currentRingtone = null; }
        if (vibrator != null)        { vibrator.cancel();       vibrator = null; }
        try {
            AudioManager am = (AudioManager) getContext().getSystemService(Context.AUDIO_SERVICE);
            if (am != null) am.setMode(AudioManager.MODE_NORMAL);
        } catch (Exception ignored) {}
    }

    @SuppressWarnings("deprecation")
    private void startVibration() {
        try {
            long[] pattern = { 0, 500, 500 };
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                VibratorManager vm = (VibratorManager) getContext().getSystemService(Context.VIBRATOR_MANAGER_SERVICE);
                if (vm != null) vibrator = vm.getDefaultVibrator();
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
    //  8. SAVE IMAGE TO GALLERY
    // ─────────────────────────────────────────────────────────────────────────

    @PluginMethod
    public void saveImageToGallery(PluginCall call) {
        String base64 = call.getString("base64", "");
        String filename = call.getString("filename", "GCapBank_" + System.currentTimeMillis() + ".jpg");
        if (base64 == null || base64.isEmpty()) { call.reject("Missing base64 data"); return; }
        if (base64.contains(",")) base64 = base64.split(",", 2)[1];
        try {
            byte[] bytes = Base64.decode(base64, Base64.DEFAULT);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                saveViaMediaStore(bytes, filename);
            } else {
                saveViaFileSystem(bytes, filename);
            }
            JSObject res = new JSObject();
            res.put("saved", true);
            res.put("filename", filename);
            call.resolve(res);
        } catch (Exception e) {
            call.reject("Save failed: " + e.getMessage());
        }
    }

    @RequiresApi(api = Build.VERSION_CODES.Q)
    private void saveViaMediaStore(byte[] bytes, String filename) throws Exception {
        ContentValues values = new ContentValues();
        values.put(MediaStore.Images.Media.DISPLAY_NAME, filename);
        values.put(MediaStore.Images.Media.MIME_TYPE, "image/jpeg");
        values.put(MediaStore.Images.Media.RELATIVE_PATH, Environment.DIRECTORY_PICTURES + "/GCapBank");
        values.put(MediaStore.Images.Media.IS_PENDING, 1);
        ContentResolver resolver = getContext().getContentResolver();
        Uri uri = resolver.insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values);
        if (uri == null) throw new Exception("MediaStore insert failed");
        try (OutputStream out = resolver.openOutputStream(uri)) {
            if (out == null) throw new Exception("Output stream null");
            out.write(bytes);
        }
        values.clear();
        values.put(MediaStore.Images.Media.IS_PENDING, 0);
        resolver.update(uri, values, null, null);
    }

    @SuppressWarnings("deprecation")
    private void saveViaFileSystem(byte[] bytes, String filename) throws Exception {
        File dir = new File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_PICTURES), "GCapBank");
        if (!dir.exists() && !dir.mkdirs()) throw new Exception("Cannot create dir");
        File file = new File(dir, filename);
        try (FileOutputStream fos = new FileOutputStream(file)) { fos.write(bytes); }
        MediaScannerConnection.scanFile(getContext(), new String[]{ file.getAbsolutePath() }, new String[]{ "image/jpeg" }, null);
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  9. RUNTIME PERMISSIONS
    // ─────────────────────────────────────────────────────────────────────────

    @PluginMethod
    public void requestMediaPermissions(PluginCall call) {
        List<String> needed = new ArrayList<>();
        if (ContextCompat.checkSelfPermission(getContext(), Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED)
            needed.add(Manifest.permission.CAMERA);
        if (ContextCompat.checkSelfPermission(getContext(), Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED)
            needed.add(Manifest.permission.RECORD_AUDIO);
        if (!needed.isEmpty())
            ActivityCompat.requestPermissions(getActivity(), needed.toArray(new String[0]), 1001);
        JSObject res = new JSObject();
        res.put("requested", needed.size());
        call.resolve(res);
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  10. NATIVE PHONE CALL STATE (GSM call → mute Agora)
    // ─────────────────────────────────────────────────────────────────────────

    private void setupPhoneStateListener() {
        try {
            telephonyManager = (TelephonyManager) getContext().getSystemService(Context.TELEPHONY_SERVICE);
            if (telephonyManager == null || phoneListenerRegistered) return;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                modernPhoneCallback = new AppCallCallback();
                telephonyManager.registerTelephonyCallback(getContext().getMainExecutor(), modernPhoneCallback);
            } else {
                legacyPhoneListener = new PhoneStateListener() {
                    @Override public void onCallStateChanged(int state, String number) { notifyNativeCallState(state); }
                };
                //noinspection deprecation
                telephonyManager.listen(legacyPhoneListener, PhoneStateListener.LISTEN_CALL_STATE);
            }
            phoneListenerRegistered = true;
        } catch (Exception ignored) {}
    }

    private void notifyNativeCallState(int state) {
        JSObject data = new JSObject();
        String s = (state == TelephonyManager.CALL_STATE_RINGING ||
                    state == TelephonyManager.CALL_STATE_OFFHOOK) ? "active" : "idle";
        data.put("state", s);
        notifyListeners("nativeCallState", data);
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  Plugin destroy — clean up all resources
    // ─────────────────────────────────────────────────────────────────────────

    @Override
    protected void handleOnDestroy() {
        try { stopRingtoneInternal(); } catch (Exception ignored) {}
        try { stopProximitySensor(null); } catch (Exception ignored) {}
        try { abandonAudioFocus(null); } catch (Exception ignored) {}
        try { stopForegroundService(null); } catch (Exception ignored) {}
        try {
            if (headsetReceiverRegistered && headsetReceiver != null) {
                getContext().unregisterReceiver(headsetReceiver);
                headsetReceiverRegistered = false;
            }
        } catch (Exception ignored) {}
        try {
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
