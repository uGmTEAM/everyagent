package com.ugmteam.everyagent;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.text.InputType;
import android.view.Gravity;
import android.view.ViewGroup;
import android.view.Window;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.EditText;
import android.widget.TextView;

/**
 * EveryAgent 安卓客户端：用 WebView 加载电脑上运行的面板。
 * 首次启动填写服务器地址；之后自动连接，连接失败时可直接修改地址。
 */
public class MainActivity extends Activity {

    private static final String PREFS = "everyagent";
    private static final String KEY_URL = "server_url";
    private static final int FILE_CHOOSER = 1001;
    private static final int DEFAULT_PORT = 7843;

    private WebView webView;
    private SharedPreferences prefs;
    private ValueCallback<Uri[]> fileCallback;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        prefs = getSharedPreferences(PREFS, MODE_PRIVATE);

        Window window = getWindow();
        window.setStatusBarColor(Color.parseColor("#0f172a"));

        webView = new WebView(this);
        webView.setBackgroundColor(Color.parseColor("#0f172a"));
        setContentView(webView, new ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        configureWebView();

        String saved = prefs.getString(KEY_URL, "");
        if (saved == null || saved.isEmpty()) {
            promptServer(false);
        } else {
            webView.loadUrl(saved);
        }
    }

    private void configureWebView() {
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setUseWideViewPort(true);
        settings.setLoadWithOverviewMode(true);
        settings.setSupportZoom(false);
        settings.setBuiltInZoomControls(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                String scheme = uri.getScheme() == null ? "" : uri.getScheme();
                if (scheme.equals("http") || scheme.equals("https")) return false;
                openExternal(uri);
                return true;
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, android.webkit.WebResourceError error) {
                if (request.isForMainFrame()) {
                    view.post(() -> promptServer(true));
                }
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback,
                                             FileChooserParams params) {
                if (fileCallback != null) {
                    fileCallback.onReceiveValue(null);
                    fileCallback = null;
                }
                fileCallback = callback;
                try {
                    startActivityForResult(params.createIntent(), FILE_CHOOSER);
                    return true;
                } catch (Exception error) {
                    fileCallback = null;
                    return false;
                }
            }
        });
    }

    private void openExternal(Uri uri) {
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, uri));
        } catch (Exception ignored) {
            // 没有可处理该链接的应用时忽略
        }
    }

    private String normalize(String raw) {
        String text = raw == null ? "" : raw.trim();
        if (text.isEmpty()) return "";
        if (!text.startsWith("http://") && !text.startsWith("https://")) {
            text = "http://" + text;
        }
        try {
            Uri uri = Uri.parse(text);
            String host = uri.getHost();
            if (host != null && uri.getPort() == -1) {
                String scheme = uri.getScheme() == null ? "http" : uri.getScheme();
                String path = uri.getPath() == null ? "" : uri.getPath();
                text = scheme + "://" + host + ":" + DEFAULT_PORT + path;
            }
        } catch (Exception ignored) {
            // 解析失败时按原样使用
        }
        return text.replaceAll("/+$", "");
    }

    private void promptServer(boolean failed) {
        final EditText input = new EditText(this);
        input.setInputType(InputType.TYPE_TEXT_VARIATION_URI);
        input.setSingleLine(true);
        input.setHint("http://192.168.1.10:7843");
        String current = prefs.getString(KEY_URL, "");
        if (current != null && !current.isEmpty()) input.setText(current);

        TextView tip = new TextView(this);
        tip.setText("填写电脑上 EveryAgent 面板的地址（手机与电脑需在同一局域网）。");
        tip.setPadding(48, 24, 48, 8);
        tip.setTextSize(13);

        android.widget.LinearLayout layout = new android.widget.LinearLayout(this);
        layout.setOrientation(android.widget.LinearLayout.VERTICAL);
        layout.setPadding(16, 8, 16, 0);
        layout.addView(tip);
        layout.addView(input);

        AlertDialog.Builder builder = new AlertDialog.Builder(this)
                .setTitle(failed ? "连接失败，修改地址" : "连接 EveryAgent")
                .setView(layout)
                .setCancelable(false)
                .setPositiveButton("连接", (dialog, which) -> {
                    String url = normalize(input.getText().toString());
                    if (url.isEmpty()) {
                        promptServer(failed);
                        return;
                    }
                    prefs.edit().putString(KEY_URL, url).apply();
                    webView.loadUrl(url);
                });
        if (failed) {
            builder.setNegativeButton("退出", (dialog, which) -> finish());
        } else {
            builder.setNegativeButton("退出", (dialog, which) -> finish());
        }
        builder.show();
    }

    @Override
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
            return;
        }
        new AlertDialog.Builder(this)
                .setTitle("退出 EveryAgent")
                .setMessage("AI 仍在电脑上继续运行，手机只是关闭面板。")
                .setPositiveButton("退出", (dialog, which) -> finish())
                .setNegativeButton("取消", null)
                .show();
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == FILE_CHOOSER) {
            if (fileCallback == null) return;
            Uri[] results = null;
            if (resultCode == RESULT_OK && data != null) {
                if (data.getClipData() != null) {
                    int count = data.getClipData().getItemCount();
                    results = new Uri[count];
                    for (int index = 0; index < count; index += 1) {
                        results[index] = data.getClipData().getItemAt(index).getUri();
                    }
                } else if (data.getData() != null) {
                    results = new Uri[] { data.getData() };
                }
            }
            fileCallback.onReceiveValue(results);
            fileCallback = null;
            return;
        }
        super.onActivityResult(requestCode, resultCode, data);
    }

    @Override
    protected void onDestroy() {
        if (webView != null) {
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }
}
