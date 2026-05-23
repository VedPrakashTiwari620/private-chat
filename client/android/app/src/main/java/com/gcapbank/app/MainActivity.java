package com.gcapbank.app;

import android.app.PictureInPictureParams;
import android.os.Build;
import android.os.Bundle;
import android.util.Rational;
import android.widget.Toast;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    private long lastBackPress = 0;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        registerPlugin(AudioRoutePlugin.class);
        super.onCreate(savedInstanceState);
    }

    /**
     * Back button handler — WhatsApp-style behavior:
     *
     *  • If a call is active (AudioRoutePlugin.callActive == true):
     *    → Enter PiP (video) or just stay — NEVER close the app.
     *    → Also dispatch 'backbutton' event so JS can minimize the call UI.
     *
     *  • If no call active:
     *    → Dispatch 'backbutton' to JS first (for navigation).
     *    → If user presses back twice within 2 seconds → exit app.
     *    → Otherwise show "Press back again to exit" toast.
     */
    @Override
    public void onBackPressed() {
        // Always dispatch event to JS so React can handle navigation
        try {
            getBridge().getWebView().evaluateJavascript(
                "document.dispatchEvent(new Event('backbutton'))", null);
        } catch (Exception ignored) {}

        if (AudioRoutePlugin.callActive) {
            // Call is active — try PiP, but DO NOT close the app
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                try {
                    PictureInPictureParams params = new PictureInPictureParams.Builder()
                            .setAspectRatio(new Rational(9, 16))
                            .build();
                    enterPictureInPictureMode(params);
                } catch (Exception ignored) {}
            }
            // Don't call super — prevents app close during call
            return;
        }

        // No call — double-back-to-exit pattern
        long now = System.currentTimeMillis();
        if (now - lastBackPress < 2000) {
            super.onBackPressed(); // actually close
        } else {
            lastBackPress = now;
            Toast.makeText(this, "Press back again to exit", Toast.LENGTH_SHORT).show();
        }
    }

    /**
     * Auto-enter PiP when user presses Home during an active call.
     * (onUserLeaveHint fires on Home press, Recent Apps, etc.)
     */
    @Override
    public void onUserLeaveHint() {
        super.onUserLeaveHint();
        if (AudioRoutePlugin.callActive && Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            try {
                PictureInPictureParams params = new PictureInPictureParams.Builder()
                        .setAspectRatio(new Rational(9, 16))
                        .build();
                enterPictureInPictureMode(params);
            } catch (Exception ignored) {}
        }
    }

    /**
     * Notify JS when PiP mode starts or ends.
     * JS listens for 'pip-state' CustomEvent on window.
     */
    @Override
    public void onPictureInPictureModeChanged(boolean isInPiP) {
        super.onPictureInPictureModeChanged(isInPiP);
        try {
            String js = "window.dispatchEvent(new CustomEvent('pip-state',{detail:{inPiP:" + isInPiP + "}}))";
            getBridge().getWebView().post(() ->
                getBridge().getWebView().evaluateJavascript(js, null));
        } catch (Exception ignored) {}
    }
}
