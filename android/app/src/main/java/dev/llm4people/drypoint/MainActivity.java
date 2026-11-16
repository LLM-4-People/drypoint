package dev.llm4people.drypoint;

import android.app.Activity;
import android.content.ClipData;
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
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
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

  /**
   * The MIME types a page extension is offered as.
   *
   * A file picker filters on MIME types, not on extensions, and Android
   * pickers disagree about which type a `.json` file is reported as: some
   * answer `application/json`, others `text/plain` or
   * `application/octet-stream`. A label export therefore has to be offered as
   * all three, or the system picker greys it out and the app's only import path
   * on the phone is unreachable.
   */
  private static final Map<String, String[]> EXTENSION_MIME_TYPES;
  static {
    Map<String, String[]> types = new HashMap<>();
    types.put(".json", new String[] { "application/json", "text/plain", "application/octet-stream" });
    types.put(".txt", new String[] { "text/plain" });
    types.put(".png", new String[] { "image/png" });
    types.put(".jpg", new String[] { "image/jpeg" });
    types.put(".jpeg", new String[] { "image/jpeg" });
    types.put(".gif", new String[] { "image/gif" });
    types.put(".webp", new String[] { "image/webp" });
    types.put(".bmp", new String[] { "image/bmp" });
    types.put(".svg", new String[] { "image/svg+xml" });
    types.put(".heic", new String[] { "image/heic" });
    types.put(".heif", new String[] { "image/heif" });
    types.put(".avif", new String[] { "image/avif" });
    types.put(".ico", new String[] { "image/x-icon", "image/vnd.microsoft.icon" });
    EXTENSION_MIME_TYPES = Collections.unmodifiableMap(types);
  }

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
        // A locally generated resource (an imported image data URL, a canvas
        // blob, about:blank) is not a network request: release it to the
        // WebView instead of answering 403. Every other non-app URL is answered,
        // not released: returning null let the WebView resolve it against the
        // network, so a page (or a redirect) could reach any host the phone
        // could. The shell has no INTERNET permission and must not depend on
        // that to stay offline.
        if (isEmbeddedScheme(url)) return null;
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
        // A second request supersedes the first: the earlier page callback is
        // answered now, not left waiting for a result that cannot arrive.
        if (fileCallback != null) fileCallback.onReceiveValue(null);
        fileCallback = callback;

        // Build the intent from the page's own `accept` list. Hard-coding
        // image/* filtered out the label JSON the Document panel imports, so
        // the one backup path on the phone could not be used at all.
        Intent intent = new Intent(Intent.ACTION_GET_CONTENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        List<String> types = acceptTypes(params != null ? params.getAcceptTypes() : null);
        if (types.size() == 1) {
          intent.setType(types.get(0));
        } else {
          // Several exact types, or none: keep the picker open to everything
          // and let EXTRA_MIME_TYPES do the filtering.
          intent.setType("*/*");
          if (types.size() > 1) intent.putExtra(Intent.EXTRA_MIME_TYPES, types.toArray(new String[0]));
        }
        // The current inputs are single-file, but a page that asks for several
        // must not have the extra selection silently dropped by this shell.
        boolean multiple = params != null && params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE;
        intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, multiple);
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

  /**
   * Schemes the WebView resolves locally and never on the network. Imported
   * images are data URLs and the canvas creates blob URLs; if the WebView asks
   * the interceptor for one of those, it must be released (null), not refused.
   * No network scheme belongs here, so `isAppUrl` still owns every fetch.
   */
  private static boolean isEmbeddedScheme(Uri url) {
    if (url == null) return false;
    String scheme = url.getScheme();
    if (scheme == null) return false;
    return "data".equalsIgnoreCase(scheme) || "blob".equalsIgnoreCase(scheme) || "about".equalsIgnoreCase(scheme);
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

  /**
   * The MIME types one page `accept` list asks for.
   *
   * The page sends `accept` tokens (MIME types and extensions) through
   * FileChooserParams; a picker only understands MIME types, so an extension
   * is resolved through the one map below. `image/*` and any other MIME token
   * is kept as written. Unknown tokens are dropped rather than guessed, and
   * the result is ordered and duplicate-free so the intent is deterministic.
   *
   * @param accept the page's tokens, or null
   * @returns the resolved MIME types
   */
  static List<String> acceptTypes(String[] accept) {
    List<String> types = new ArrayList<>();
    if (accept == null) return types;
    for (String token : accept) {
      if (token == null) continue;
      String value = token.trim();
      if (value.isEmpty()) continue;
      if (value.startsWith(".")) {
        String[] mapped = EXTENSION_MIME_TYPES.get(value.toLowerCase(Locale.ROOT));
        if (mapped != null) {
          for (String type : mapped) {
            if (!types.contains(type)) types.add(type);
          }
        }
        continue;
      }
      if (!types.contains(value)) types.add(value);
    }
    return types;
  }

  /**
   * Satisfy one page file request. A picker that offers several items answers
   * through ClipData, so both shapes are read, the primary URI is kept and the
   * list is deduplicated.
   *
   * @returns the selected URIs, or null when nothing was selected
   */
  private static Uri[] selectedUris(Intent data) {
    List<Uri> uris = new ArrayList<>();
    Uri single = data.getData();
    if (single != null) uris.add(single);
    ClipData clip = data.getClipData();
    if (clip != null) {
      for (int index = 0; index < clip.getItemCount(); index++) {
        Uri uri = clip.getItemAt(index).getUri();
        if (uri != null && !uris.contains(uri)) uris.add(uri);
      }
    }
    return uris.isEmpty() ? null : uris.toArray(new Uri[0]);
  }

  @Override
  protected void onActivityResult(int requestCode, int resultCode, Intent data) {
    if (requestCode == REQ_FILE) {
      // Cancel, a missing file manager and an empty selection all answer null;
      // the callback is cleared either way so the page never waits.
      Uri[] result = resultCode == RESULT_OK && data != null ? selectedUris(data) : null;
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
