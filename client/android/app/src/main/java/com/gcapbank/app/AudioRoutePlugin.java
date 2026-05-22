package com.gcapbank.app;

import android.content.Context;
import android.media.AudioManager;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * AudioRoutePlugin — Native Capacitor Bridge
 *
 * Exposes audio routing control to JavaScript layer.
 * Called from ChatPage.jsx to switch between earpiece and speakerphone.
 * This is needed because Android WebView does NOT support the browser's
 * setSinkId() API, so we must use AudioManager directly from native code.
 */
@CapacitorPlugin(name = "AudioRoute")
public class AudioRoutePlugin extends Plugin {

    /**
     * Route audio to EARPIECE (front speaker) — like WhatsApp calls.
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
