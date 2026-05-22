package com.gcapbank.app;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        // Register native AudioRoute plugin for earpiece/speaker routing during WebRTC calls
        registerPlugin(AudioRoutePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
