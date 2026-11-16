package dev.llm4people.drypoint;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.util.Log;
import android.view.ViewGroup;
import android.webkit.ConsoleMessage;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;

/**
 * The Android shell: one WebView over the bundled web app.
 *
 * Assets are served through shouldInterceptRequest on a stable https origin, so
 * ES modules, localStorage and the same code paths as the PWA work unchanged.
 * The only host API the page needs — Bluetooth — is provided by BleBridge.
 */
public class MainActivity extends Activity {
  private static final String ORIGIN = "https://drypoint.local";
  /** The host is derived from ORIGIN so the origin has one owner. */
  private static final String HOST = hostOf(ORIGIN);
  private static final String START_URL = ORIGIN + "/index.html";
  private static final int REQ_FILE = 71;

  private WebView webView;
  private BleBridge ble;
  private ValueCallback<Uri[]> fileCallback;
  private boolean destroyed = false;

  @Override
  protected void onCreate(Bundle state) {
    super.onCreate(state);
    getWindow().setStatusBarColor(Color.rgb(8, 8, 10));
    getWindow().setNavigationBarColor(Color.rgb(8, 8, 10));

    webView = new WebView(this);
    webView.setBackgroundColor(Color.rgb(8, 8, 10));
    WebSettings settings = webView.getSettings();
    settings.setJavaScriptEnabled(true);
    settings.setDomStorageEnabled(true);
    settings.setDatabaseEnabled(true);
    settings.setAllowFileAccess(false);
    settings.setAllowContentAccess(true);
    settings.setMediaPlaybackRequiresUserGesture(true);
    settings.setSupportZoom(false);
    settings.setBuiltInZoomControls(false);
    settings.setUseWideViewPort(false);
    settings.setLoadWithOverviewMode(false);

    webView.setWebViewClient(new WebViewClient() {
      @Override
      public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
        Uri url = request.getUrl();
        // A request that is not the bundled app is answered, not released:
        // returning null let the WebView resolve it against the network, so a
        // page (or a redirect) could reach any host the phone could. The shell
        // has no INTERNET permission and must not depend on that to stay
        // offline.
        if (!isAppUrl(url)) return textResponse(403, "Forbidden");
        String path = url.getPath();
        if (path == null || path.equals("/") || path.isEmpty()) path = "/index.html";
        if (path.contains("..") || path.indexOf('\\') >= 0) return textResponse(400, "Bad request");
        try {
          InputStream stream = getAssets().open("www" + path);
          return assetResponse(path, stream);
        } catch (IOException missing) {
          return textResponse(404, "Not found");
        }
      }

      @Override
      public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
        // Navigation stays in the app: a link that leaves the one origin is
        // refused here instead of being handed to a browser or an external app.
        return !isAppUrl(request.getUrl());
      }
    });

    webView.setWebChromeClient(new WebChromeClient() {
      @Override
      public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
        if (destroyed) return false;
        if (fileCallback != null) fileCallback.onReceiveValue(null);
        fileCallback = callback;
        Intent intent = new Intent(Intent.ACTION_GET_CONTENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("image/*");
        try {
          startActivityForResult(intent, REQ_FILE);
          return true;
        } catch (Exception error) {
          // No file manager: the page must not wait for a callback that will
          // never arrive.
          fileCallback = null;
          callback.onReceiveValue(null);
          return false;
        }
      }

      @Override
      public boolean onConsoleMessage(ConsoleMessage message) {
        Log.d("DrypointShell", message.message() + " (" + message.sourceId() + ":" + message.lineNumber() + ")");
        return true;
      }
    });

    ble = new BleBridge(this, webView);
    webView.addJavascriptInterface(ble, "NiimbotBLE");

    setContentView(webView, new ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
    webView.loadUrl(START_URL);
  }

  /** Host part of the app origin; a malformed constant is a build fault. */
  private static String hostOf(String origin) {
    try {
      return new java.net.URL(origin).getHost();
    } catch (java.net.MalformedURLException error) {
      throw new IllegalStateException("invalid ORIGIN: " + origin, error);
    }
  }

  /**
   * Whether a URL belongs to the bundled app: https on the one app host.
   *
   * This is the only place a request is allowed in, so the interceptor and the
   * navigation override cannot disagree about what "the app" is.
   */
  private static boolean isAppUrl(Uri url) {
    return url != null && "https".equals(url.getScheme()) && HOST.equals(url.getHost());
  }

  private static WebResourceResponse assetResponse(String path, InputStream stream) {
    String mime = mimeOf(path);
    boolean textual = mime.startsWith("text/") || mime.endsWith("json") || mime.endsWith("javascript") || mime.endsWith("svg+xml");
    Map<String, String> headers = new HashMap<>();
    headers.put("Cache-Control", "no-store");
    return new WebResourceResponse(mime, textual ? "utf-8" : null, 200, "OK", headers, stream);
  }

  private static WebResourceResponse textResponse(int status, String body) {
    Map<String, String> headers = new HashMap<>();
    headers.put("Cache-Control", "no-store");
    return new WebResourceResponse(
        "text/plain",
        "utf-8",
        status,
        reasonOf(status),
        headers,
        new ByteArrayInputStream(body.getBytes(StandardCharsets.UTF_8)));
  }

  /** The status line for a refusal; never a reason that contradicts the code. */
  private static String reasonOf(int status) {
    switch (status) {
      case 403:
        return "Forbidden";
      case 404:
        return "Not Found";
      case 400:
      default:
        return "Bad Request";
    }
  }

  private static String mimeOf(String path) {
    if (path.endsWith(".html")) return "text/html";
    if (path.endsWith(".js") || path.endsWith(".mjs")) return "text/javascript";
    if (path.endsWith(".css")) return "text/css";
    if (path.endsWith(".json") || path.endsWith(".webmanifest")) return "application/json";
    if (path.endsWith(".png")) return "image/png";
    if (path.endsWith(".svg")) return "image/svg+xml";
    if (path.endsWith(".woff2")) return "font/woff2";
    return "application/octet-stream";
  }

  @Override
  protected void onActivityResult(int requestCode, int resultCode, Intent data) {
    if (requestCode == REQ_FILE) {
      Uri[] result = null;
      if (resultCode == RESULT_OK && data != null && data.getData() != null) {
        result = new Uri[] { data.getData() };
      }
      if (fileCallback != null) {
        fileCallback.onReceiveValue(result);
        fileCallback = null;
      }
      return;
    }
    if (ble != null) ble.onActivityResult(requestCode, resultCode);
    super.onActivityResult(requestCode, resultCode, data);
  }

  @Override
  public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
    if (ble != null) ble.onRequestPermissionsResult(requestCode, grantResults);
  }

  @Override
  public void onBackPressed() {
    if (webView != null && webView.canGoBack()) webView.goBack();
    else super.onBackPressed();
  }

  @Override
  protected void onDestroy() {
    destroyed = true;
    // A web-side file import must not hold a callback into a dead Activity.
    if (fileCallback != null) {
      fileCallback.onReceiveValue(null);
      fileCallback = null;
    }
    if (ble != null) {
      ble.destroy();
      ble = null;
    }
    if (webView != null) {
      webView.removeJavascriptInterface("NiimbotBLE");
      webView.destroy();
      webView = null;
    }
    super.onDestroy();
  }
}
