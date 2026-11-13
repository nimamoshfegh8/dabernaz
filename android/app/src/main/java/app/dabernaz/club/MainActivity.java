package app.dabernaz.club;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.res.ColorStateList;
import android.graphics.Color;
import android.media.AudioAttributes;
import android.os.Handler;
import android.os.Looper;
import android.os.Bundle;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import android.speech.tts.Voice;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.SafeBrowsingResponse;
import android.webkit.SslErrorHandler;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.net.http.SslError;
import android.widget.FrameLayout;
import android.widget.ProgressBar;

import org.json.JSONObject;
import java.util.Locale;
import java.util.Set;

import androidx.core.view.WindowCompat;

public class MainActivity extends Activity {
    private static final String START_URL = "https://dabernaz.pages.dev/";
    private static final String APP_HOST = "dabernaz.pages.dev";
    private static final int FILE_CHOOSER_REQUEST = 4102;

    private WebView webView;
    private ProgressBar progressBar;
    private WebChromeClient.FileChooserParams pendingChooser;
    private android.webkit.ValueCallback<Uri[]> fileCallback;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private TextToSpeech textToSpeech;
    private volatile boolean nativeTtsReady = false;

    private static final String OFFLINE_HTML =
        "<!doctype html><html lang='fa' dir='rtl'><meta charset='utf-8'>" +
        "<meta name='viewport' content='width=device-width,initial-scale=1'>" +
        "<meta name='theme-color' content='#09090c'><body style='margin:0;background:#09090c;color:#fff;" +
        "font-family:system-ui,Tahoma,sans-serif;min-height:100vh;display:grid;place-items:center;text-align:center'>" +
        "<main style='padding:28px;max-width:360px'><div style='font-size:58px;color:#f6bf4b'>♛</div>" +
        "<h2>اتصال اینترنت برقرار نیست</h2><p style='color:#bbb;line-height:2'>برای ورود به دابرناز اتصال اینترنت را بررسی کن و دوباره تلاش کن.</p>" +
        "<button onclick=\"location.href='" + START_URL + "'\" style='border:0;border-radius:12px;padding:14px 28px;" +
        "background:#e51c37;color:white;font-weight:bold'>تلاش دوباره</button></main></body></html>";

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        Window window = getWindow();
        WindowCompat.setDecorFitsSystemWindows(window, true);
        window.setStatusBarColor(Color.rgb(9, 9, 12));
        window.setNavigationBarColor(Color.rgb(9, 9, 12));
        window.getDecorView().setSystemUiVisibility(0);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            window.setNavigationBarContrastEnforced(false);
            window.setStatusBarContrastEnforced(false);
        }

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.rgb(9, 9, 12));

        webView = new WebView(this);
        webView.setBackgroundColor(Color.rgb(9, 9, 12));
        webView.setOverScrollMode(View.OVER_SCROLL_NEVER);
        webView.setVerticalScrollBarEnabled(false);
        webView.setHorizontalScrollBarEnabled(false);

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setDefaultTextEncodingName("UTF-8");
        settings.setLoadWithOverviewMode(true);
        settings.setUseWideViewPort(true);
        settings.setSupportZoom(false);
        settings.setBuiltInZoomControls(false);
        settings.setDisplayZoomControls(false);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(true);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        settings.setSupportMultipleWindows(false);
        settings.setMediaPlaybackRequiresUserGesture(true);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            settings.setSafeBrowsingEnabled(true);
        }

        String userAgent = settings.getUserAgentString();
        settings.setUserAgentString(userAgent + " DabernazAndroid/1.0.0");
        CookieManager cookieManager = CookieManager.getInstance();
        cookieManager.setAcceptCookie(true);
        cookieManager.setAcceptThirdPartyCookies(webView, false);

        progressBar = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        progressBar.setMax(100);
        progressBar.setProgressTintList(ColorStateList.valueOf(Color.rgb(239, 40, 62)));
        progressBar.setProgressBackgroundTintList(ColorStateList.valueOf(Color.rgb(48, 26, 32)));

        FrameLayout.LayoutParams webParams = new FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT);
        root.addView(webView, webParams);
        FrameLayout.LayoutParams progressParams = new FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, dp(3), Gravity.TOP);
        root.addView(progressBar, progressParams);
        setContentView(root);
        webView.addJavascriptInterface(new NativeTtsBridge(), "DabernazNativeTTS");
        initializeNativeTts();

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if ("https".equalsIgnoreCase(uri.getScheme()) &&
                    APP_HOST.equalsIgnoreCase(uri.getHost())) {
                    return false;
                }
                openExternal(uri);
                return true;
            }

            @Override
            public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
                progressBar.setVisibility(View.VISIBLE);
                progressBar.setProgress(5);
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                progressBar.setProgress(100);
                progressBar.setVisibility(View.GONE);
                CookieManager.getInstance().flush();
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame()) {
                    view.loadDataWithBaseURL(START_URL, OFFLINE_HTML, "text/html", "UTF-8", null);
                }
            }

            @Override
            public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
                handler.cancel();
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onProgressChanged(WebView view, int newProgress) {
                progressBar.setProgress(newProgress);
                progressBar.setVisibility(newProgress >= 100 ? View.GONE : View.VISIBLE);
            }

            @Override
            public boolean onShowFileChooser(WebView view,
                    android.webkit.ValueCallback<Uri[]> callback,
                    FileChooserParams params) {
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = callback;
                try {
                    Intent intent = params.createIntent();
                    startActivityForResult(intent, FILE_CHOOSER_REQUEST);
                    return true;
                } catch (ActivityNotFoundException ex) {
                    fileCallback = null;
                    return false;
                }
            }
        });

        webView.setDownloadListener((url, downloadUserAgent, contentDisposition, mimeType, contentLength) ->
            openExternal(Uri.parse(url)));

        if (savedInstanceState != null) {
            webView.restoreState(savedInstanceState);
        }
        if (webView.getUrl() == null) {
            webView.loadUrl(START_URL);
        }
    }

    private void initializeNativeTts() {
        textToSpeech = new TextToSpeech(getApplicationContext(), status -> {
            TextToSpeech engine = textToSpeech;
            if (engine == null || status != TextToSpeech.SUCCESS) {
                nativeTtsReady = false;
                return;
            }

            int languageStatus = engine.setLanguage(new Locale("fa", "IR"));
            if (languageStatus < TextToSpeech.LANG_AVAILABLE) {
                nativeTtsReady = false;
                return;
            }

            // Prefer a Persian female voice when the installed Android engine exposes one.
            // The licensed Sage Woman MP3 pack remains the website's primary voice.
            try {
                Set<Voice> voices = engine.getVoices();
                if (voices != null) {
                    for (Voice voice : voices) {
                        Locale locale = voice.getLocale();
                        String voiceName = voice.getName() == null ? "" : voice.getName().toLowerCase(Locale.ROOT);
                        if (locale != null && "fa".equalsIgnoreCase(locale.getLanguage()) &&
                            (voiceName.contains("female") || voiceName.contains("woman") || voiceName.contains("زن"))) {
                            engine.setVoice(voice);
                            break;
                        }
                    }
                }
            } catch (Exception ignored) {
                // Some vendor TTS engines do not expose a complete voice catalogue.
            }

            engine.setSpeechRate(0.84f);
            engine.setPitch(1.0f);
            engine.setAudioAttributes(new AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_ASSISTANCE_ACCESSIBILITY)
                .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                .build());

            engine.setOnUtteranceProgressListener(new UtteranceProgressListener() {
                @Override
                public void onStart(String utteranceId) {
                }

                @Override
                public void onDone(String utteranceId) {
                    notifyNativeTtsResult(utteranceId, true, "");
                }

                @Override
                public void onError(String utteranceId) {
                    notifyNativeTtsResult(utteranceId, false, "Android TextToSpeech playback failed.");
                }

                @Override
                public void onError(String utteranceId, int errorCode) {
                    notifyNativeTtsResult(utteranceId, false, "Android TextToSpeech error " + errorCode + ".");
                }

                @Override
                public void onStop(String utteranceId, boolean interrupted) {
                    notifyNativeTtsResult(utteranceId, false, interrupted
                        ? "Android speech was interrupted."
                        : "Android speech stopped.");
                }
            });
            nativeTtsReady = true;
            if (webView != null) {
                webView.post(() -> webView.evaluateJavascript(
                    "window.dispatchEvent(new Event('dabernaz-native-tts-ready'));", null));
            }
        });
    }

    private void notifyNativeTtsResult(String requestId, boolean ok, String error) {
        if (webView == null || requestId == null ||
            !requestId.matches("[A-Za-z0-9_-]{1,80}")) return;
        String script = "window.dispatchEvent(new CustomEvent('dabernaz-native-tts-result',{detail:{requestId:" +
            JSONObject.quote(requestId) + ",ok:" + ok + ",error:" + JSONObject.quote(error == null ? "" : error) + "}}));";
        webView.post(() -> {
            if (webView != null) webView.evaluateJavascript(script, null);
        });
    }

    private final class NativeTtsBridge {
        @JavascriptInterface
        public boolean isAvailable() {
            return nativeTtsReady && textToSpeech != null;
        }

        @JavascriptInterface
        public void speak(String text, String language, String requestId) {
            final String safeText = text == null ? "" : text.trim();
            final String safeId = requestId == null ? "" : requestId;
            if (!safeId.matches("[A-Za-z0-9_-]{1,80}")) return;
            if (!"fa-IR".equalsIgnoreCase(language) ||
                safeText.isEmpty() || safeText.length() > 80 ||
                !safeText.matches("[\\p{L}\\s]+")) {
                notifyNativeTtsResult(safeId, false, "Invalid Persian speech request.");
                return;
            }

            mainHandler.post(() -> {
                TextToSpeech engine = textToSpeech;
                if (!nativeTtsReady || engine == null) {
                    notifyNativeTtsResult(safeId, false, "Persian Android voice is not installed or ready.");
                    return;
                }
                int languageStatus = engine.setLanguage(new Locale("fa", "IR"));
                if (languageStatus < TextToSpeech.LANG_AVAILABLE) {
                    nativeTtsReady = false;
                    notifyNativeTtsResult(safeId, false, "Persian Android voice data is unavailable.");
                    return;
                }
                int result = engine.speak(safeText, TextToSpeech.QUEUE_ADD, new Bundle(), safeId);
                if (result == TextToSpeech.ERROR) {
                    notifyNativeTtsResult(safeId, false, "Android TextToSpeech rejected the request.");
                }
            });
        }

        @JavascriptInterface
        public void stop() {
            mainHandler.post(() -> {
                if (textToSpeech != null) textToSpeech.stop();
            });
        }
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    private void openExternal(Uri uri) {
        try {
            Intent intent = new Intent(Intent.ACTION_VIEW, uri);
            startActivity(intent);
        } catch (ActivityNotFoundException ignored) {
            // Unsupported external schemes are intentionally ignored.
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == FILE_CHOOSER_REQUEST && fileCallback != null) {
            Uri[] results = WebChromeClient.FileChooserParams.parseResult(resultCode, data);
            fileCallback.onReceiveValue(results);
            fileCallback = null;
        }
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        if (webView != null) webView.saveState(outState);
        super.onSaveInstanceState(outState);
    }

    @Override
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
        } else {
            super.onBackPressed();
        }
    }

    @Override
    protected void onPause() {
        if (webView != null) webView.onPause();
        CookieManager.getInstance().flush();
        super.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (webView != null) webView.onResume();
    }

    @Override
    protected void onDestroy() {
        if (fileCallback != null) fileCallback.onReceiveValue(null);
        nativeTtsReady = false;
        if (textToSpeech != null) {
            textToSpeech.stop();
            textToSpeech.shutdown();
            textToSpeech = null;
        }
        if (webView != null) {
            webView.stopLoading();
            webView.setWebChromeClient(null);
            webView.setWebViewClient(null);
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }
}
