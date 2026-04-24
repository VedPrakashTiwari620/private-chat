package com.gcapbank.app;

import android.os.Bundle;
import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;
import android.webkit.WebView;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // Grant WebView full access to Camera, Microphone & Audio for WebRTC calls
        WebView webView = getBridge().getWebView();
        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(final PermissionRequest request) {
                // Auto-grant all media permissions (camera, mic, audio)
                runOnUiThread(() -> request.grant(request.getResources()));
            }
        });

        // Enable hardware acceleration for smooth video rendering
        webView.setLayerType(WebView.LAYER_TYPE_HARDWARE, null);
    }
}
