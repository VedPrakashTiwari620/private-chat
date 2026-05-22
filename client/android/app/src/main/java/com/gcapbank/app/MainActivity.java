package com.gcapbank.app;

import android.content.Context;
import android.media.AudioManager;
import android.os.Bundle;

import com.getcapacitor.BridgeActivity;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

public class MainActivity extends BridgeActivity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        // Register our native AudioRoute bridge BEFORE super.onCreate
        registerPlugin(AudioRoutePlugin.class);
        super.onCreate(savedInstanceState);
    }
}

/**
 * AudioRoutePlugin — Native Capacitor Bridge
 *
 * Exposes audio routing control to JavaScript layer.
 * Called from ChatPage.jsx to switch between earpiece and speakerphone.
 * This is needed because Android WebView does NOT support the browser's
 * setSinkId() API, so we must use AudioManager directly from native code.
 */
@CapacitorPlugin(name = "AudioRoute")
class AudioRoutePlugin extends Plugin {

    /**
     * Route audio to EARPIECE (front speaker) — like WhatsApp calls.
     * Sets AudioManager to MODE_IN_COMMUNICATION which is the standard
     * mode for VoIP/calling applications on Android.
     */
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

    /**
     * Route audio to SPEAKERPHONE (back loud speaker).
     * Can be used if a speaker toggle button is added in the future.
     */
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

    /**
     * Reset audio mode back to NORMAL after call ends.
     * MUST be called on every call end / hang up to avoid audio
     * remaining in IN_COMMUNICATION mode for other apps.
     */
    @PluginMethod
    public void stopAudio(PluginCall call) {
        try {
            AudioManager am = (AudioManager) getContext().getSystemService(Context.AUDIO_SERVICE);
            am.setSpeakerphoneOn(false);
            am.setMode(AudioManager.MODE_NORMAL);
            call.resolve();
        } catch (Exception e) {
            call.reject("stopAudio failed: " + e.getMessage());
        }
    }
}
