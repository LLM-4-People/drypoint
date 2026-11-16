package dev.llm4people.drypoint;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothGatt;
import android.bluetooth.BluetoothGattCallback;
import android.bluetooth.BluetoothGattCharacteristic;
import android.bluetooth.BluetoothGattDescriptor;
import android.bluetooth.BluetoothGattService;
import android.bluetooth.BluetoothManager;
import android.bluetooth.BluetoothProfile;
import android.bluetooth.le.BluetoothLeScanner;
import android.bluetooth.le.ScanCallback;
import android.bluetooth.le.ScanResult;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.provider.MediaStore;
import android.util.Base64;
import android.util.Log;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * Native BLE bridge for the WebView shell.
 *
 * The web app keeps every protocol decision; this class only discovers, connects,
 * chunks writes to the negotiated MTU and forwards notifications. Constants that
 * belong to the app (service/characteristic UUIDs, name prefixes) are passed in
 * from JavaScript, so there is no second copy here.
 */
public class BleBridge {
  private static final String TAG = "DrypointShell";
  private static final int REQ_PERMISSIONS = 61;
  private static final int REQ_ENABLE = 62;
  private static final long SCAN_MS = 8000;
  /** A write that is never acknowledged means the link is gone, not "retry". */
  private static final long WRITE_ACK_TIMEOUT_MS = 2000;
  /** The MTU exchange is advisory: settle the handshake without it after this. */
  private static final long MTU_FALLBACK_MS = 300;
  /** Nothing above this is ever needed for a request frame; keeps chunks sane on a bogus MTU. */
  private static final int MAX_CHUNK_BYTES = 512;

  private final Activity activity;
  private final WebView webView;
  private final Handler main = new Handler(Looper.getMainLooper());
  private final SharedPreferences prefs;
  private final BluetoothAdapter adapter;

  private BluetoothGatt gatt;
  private BluetoothGattCharacteristic characteristic;
  private int mtu = 23;
  private final ArrayDeque<byte[]> writes = new ArrayDeque<>();
  private boolean writing = false;
  private int writeGeneration = 0;
  private Runnable writeWatchdog;
  private Runnable mtuFallback;
  private boolean closing = false;
  private boolean destroyed = false;

  private String pendingToken;
  private Runnable pendingAction;
  private AlertDialog dialog;
  private BluetoothLeScanner scanningScanner;
  private ScanCallback scanningCallback;

  private String connectToken;
  private String connectService;
  private String connectCharacteristic;
  private boolean descriptorReady = false;
  private boolean mtuReady = false;

  BleBridge(Activity activity, WebView webView) {
    this.activity = activity;
    this.webView = webView;
    BluetoothManager manager = (BluetoothManager) activity.getSystemService(Context.BLUETOOTH_SERVICE);
    this.adapter = manager == null ? null : manager.getAdapter();
    this.prefs = activity.getSharedPreferences("niimbot", Context.MODE_PRIVATE);
  }

  /* ---------------- JavaScript API ---------------- */

  @JavascriptInterface
  public String lastDevice() {
    return prefs.getString("lastDevice", "");
  }

  /** Forget the saved selection so the next connect asks which printer to use. */
  @JavascriptInterface
  public void forgetDevice() {
    prefs.edit().remove("lastDevice").apply();
  }

  @JavascriptInterface
  public void pickDevice(String token, String prefixesJson) {
    main.post(() -> {
      if (destroyed) return;
      // A dialog from an abandoned pick (its JS call timed out) must be gone
      // before a new one opens: the native side owns one picker at a time.
      dismissPicker();
      pendingToken = token;
      ensureReady(() -> scan(prefixesJson));
    });
  }

  /** Dismiss the picker, stop the scan and settle its call as cancelled. */
  @JavascriptInterface
  public void cancelPick() {
    main.post(() -> {
      if (destroyed) return;
      dismissPicker();
    });
  }

  /**
   * One owner for "the picker is over": the token is cleared before the reply
   * is posted, so a second dismissal cannot resolve the same call twice.
   */
  private void dismissPicker() {
    pendingAction = null;
    stopScan();
    AlertDialog open = dialog;
    dialog = null;
    if (open != null) open.dismiss();
    String token = pendingToken;
    pendingToken = null;
    if (token != null) resolve(token, cancelled());
  }

  @JavascriptInterface
  public void connect(String token, String id, String serviceUuid, String characteristicUuid) {
    main.post(() -> {
      if (destroyed) {
        resolveError(token, "The Bluetooth bridge is shutting down");
        return;
      }
      if (!hasPermissions()) {
        resolveError(token, "Bluetooth permission denied");
        return;
      }
      connectToken = token;
      connectService = serviceUuid;
      connectCharacteristic = characteristicUuid;
      descriptorReady = false;
      mtuReady = false;
      // A previous link's negotiated MTU must never split the next connection.
      mtu = 23;
      closeGatt();
      try {
        if (adapter == null) {
          resolveError(token, "This device has no Bluetooth adapter");
          return;
        }
        BluetoothDevice device = adapter.getRemoteDevice(id);
        gatt = device.connectGatt(activity, false, callback, BluetoothDevice.TRANSPORT_LE);
        if (gatt == null) resolveError(token, "Could not open the printer");
      } catch (Exception error) {
        resolveError(token, "Could not open the printer: " + error.getMessage());
      }
    });
  }

  @JavascriptInterface
  public boolean write(String base64) {
    if (destroyed || gatt == null || characteristic == null) return false;
    final byte[] data;
    try {
      data = Base64.decode(base64, Base64.NO_WRAP);
    } catch (IllegalArgumentException error) {
      return false;
    }
    main.post(() -> enqueue(data));
    return true;
  }

  @JavascriptInterface
  public void disconnect() {
    main.post(this::closeGatt);
  }

  /**
   * The page is the theme owner; the shell only follows. applyTheme sends the
   * background token it just applied, and this forwards it to the window so the
   * status and navigation bars cannot keep a hard-coded colour that disagrees
   * with the page. A malformed value is ignored rather than crashing the page.
   */
  @JavascriptInterface
  public void setSystemBars(String colorHex) {
    if (colorHex == null || !colorHex.matches("#[0-9a-fA-F]{6}")) return;
    main.post(() -> {
      if (destroyed) return;
      int color = Color.parseColor(colorHex);
      activity.getWindow().setStatusBarColor(color);
      activity.getWindow().setNavigationBarColor(color);
    });
  }

  /**
   * The canonical target under this app's Downloads directory, or null when the
   * name is unsafe or the resolved path leaves that directory (a symlink, for
   * example). The check runs before anything is created or written.
   */
  private File downloadTarget(String name) throws java.io.IOException {
    if (!SafeFileName.isSafe(name)) return null;
    File dir = activity.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
    if (dir == null) return null;
    String base = dir.getCanonicalPath();
    File target = new File(dir, name);
    if (!target.getCanonicalPath().startsWith(base + File.separator)) return null;
    if (!dir.exists() && !dir.mkdirs()) return null;
    return target;
  }

  @JavascriptInterface
  public boolean saveFile(String name, String text) {
    if (!SafeFileName.isSafe(name) || text == null) return false;
    try {
      if (Build.VERSION.SDK_INT >= 29) {
        ContentValues values = new ContentValues();
        values.put(MediaStore.Downloads.DISPLAY_NAME, name);
        values.put(MediaStore.Downloads.MIME_TYPE, "application/json");
        Uri uri = activity.getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
        if (uri == null) return false;
        try (OutputStream out = activity.getContentResolver().openOutputStream(uri)) {
          if (out == null) return false;
          out.write(text.getBytes(StandardCharsets.UTF_8));
        }
        return true;
      }
      File target = downloadTarget(name);
      if (target == null) return false;
      try (FileOutputStream out = new FileOutputStream(target)) {
        out.write(text.getBytes(StandardCharsets.UTF_8));
      }
      return true;
    } catch (Exception error) {
      return false;
    }
  }

  /* ---------------- permissions and adapter ---------------- */

  private boolean hasPermissions() {
    if (Build.VERSION.SDK_INT >= 31) {
      return activity.checkSelfPermission(Manifest.permission.BLUETOOTH_SCAN) == PackageManager.PERMISSION_GRANTED
          && activity.checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT) == PackageManager.PERMISSION_GRANTED;
    }
    if (Build.VERSION.SDK_INT >= 23) {
      return activity.checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED;
    }
    return true;
  }

  private void ensureReady(Runnable next) {
    if (adapter == null) {
      resolveError(pendingToken, "This device has no Bluetooth adapter");
      return;
    }
    if (Build.VERSION.SDK_INT >= 31 && !hasPermissions()) {
      pendingAction = next;
      activity.requestPermissions(
          new String[] { Manifest.permission.BLUETOOTH_SCAN, Manifest.permission.BLUETOOTH_CONNECT },
          REQ_PERMISSIONS);
      return;
    }
    if (Build.VERSION.SDK_INT >= 23 && Build.VERSION.SDK_INT < 31 && !hasPermissions()) {
      pendingAction = next;
      activity.requestPermissions(new String[] { Manifest.permission.ACCESS_FINE_LOCATION }, REQ_PERMISSIONS);
      return;
    }
    if (!adapter.isEnabled()) {
      pendingAction = next;
      activity.startActivityForResult(new Intent(BluetoothAdapter.ACTION_REQUEST_ENABLE), REQ_ENABLE);
      return;
    }
    next.run();
  }

  void onRequestPermissionsResult(int requestCode, int[] grantResults) {
    if (requestCode != REQ_PERMISSIONS) return;
    boolean granted = grantResults.length > 0;
    for (int result : grantResults) granted = granted && result == PackageManager.PERMISSION_GRANTED;
    if (granted) {
      Runnable next = pendingAction;
      pendingAction = null;
      if (next != null) next.run();
    } else {
      pendingAction = null;
      resolveError(pendingToken, "Bluetooth permission denied");
    }
  }

  void onActivityResult(int requestCode, int resultCode) {
    if (requestCode != REQ_ENABLE) return;
    Runnable next = pendingAction;
    pendingAction = null;
    if (resultCode == Activity.RESULT_OK) {
      if (next != null) next.run();
    } else {
      resolveError(pendingToken, "Bluetooth is turned off");
    }
  }

  /* ---------------- discovery ---------------- */

  private void scan(String prefixesJson) {
    if (destroyed) return;
    List<String> prefixes = new ArrayList<>();
    try {
      JSONArray array = new JSONArray(prefixesJson);
      for (int i = 0; i < array.length(); i += 1) prefixes.add(array.optString(i).toLowerCase());
    } catch (Exception ignored) {
      // An empty list still lists every named device below.
    }
    BluetoothLeScanner scanner = adapter.getBluetoothLeScanner();
    if (scanner == null) {
      resolveError(pendingToken, "Bluetooth scanning is unavailable");
      return;
    }

    Map<String, JSONObject> found = new LinkedHashMap<>();
    for (BluetoothDevice device : adapter.getBondedDevices()) {
      String name = device.getName();
      if (name != null && matches(name, prefixes)) add(found, device, name);
    }

    ScanCallback callback = new ScanCallback() {
      @Override
      public void onScanResult(int callbackType, ScanResult result) {
        if (destroyed) return;
        String name = result.getDevice().getName();
        if (name == null && result.getScanRecord() != null) name = result.getScanRecord().getDeviceName();
        if (name != null && matches(name, prefixes)) add(found, result.getDevice(), name);
      }
    };
    scanningScanner = scanner;
    scanningCallback = callback;

    try {
      scanner.startScan(callback);
    } catch (SecurityException error) {
      scanningScanner = null;
      scanningCallback = null;
      resolveError(pendingToken, "Bluetooth permission denied");
      return;
    }
    main.postDelayed(() -> {
      stopScan();
      choose(found);
    }, SCAN_MS);
  }

  /** Stop an in-flight scan exactly once; safe after destroy(). */
  private void stopScan() {
    BluetoothLeScanner scanner = scanningScanner;
    ScanCallback callback = scanningCallback;
    scanningScanner = null;
    scanningCallback = null;
    if (scanner == null || callback == null) return;
    try {
      scanner.stopScan(callback);
    } catch (Exception ignored) {
      // Scan already stopped, or the adapter is off.
    }
  }

  private static boolean matches(String name, List<String> prefixes) {
    if (prefixes.isEmpty()) return true;
    String lower = name.toLowerCase();
    for (String prefix : prefixes) if (lower.startsWith(prefix)) return true;
    return false;
  }

  private void add(Map<String, JSONObject> found, BluetoothDevice device, String name) {
    try {
      JSONObject entry = new JSONObject();
      entry.put("id", device.getAddress());
      entry.put("name", name);
      found.put(device.getAddress(), entry);
    } catch (Exception ignored) {
      // A device without a readable address cannot be selected.
    }
  }

  private void choose(Map<String, JSONObject> found) {
    if (destroyed) return;
    if (found.isEmpty()) {
      finishPick(cancelled());
      return;
    }
    List<JSONObject> entries = new ArrayList<>(found.values());
    String[] labels = new String[entries.size()];
    for (int i = 0; i < entries.size(); i += 1) {
      labels[i] = entries.get(i).optString("name") + "\n" + entries.get(i).optString("id");
    }
    dialog = new AlertDialog.Builder(activity)
        .setTitle("Select printer")
        .setItems(labels, (d, which) -> {
          JSONObject device = entries.get(which);
          prefs.edit().putString("lastDevice", device.toString()).apply();
          JSONObject reply = new JSONObject();
          try {
            reply.put("ok", true);
            reply.put("device", device);
          } catch (Exception ignored) {
            // The fields above cannot fail for a JSONObject.
          }
          finishPick(reply);
        })
        .setNegativeButton("Cancel", (which, item) -> finishPick(cancelled()))
        .setOnCancelListener(which -> finishPick(cancelled()))
        .create();
    dialog.setOnDismissListener(which -> dialog = null);
    dialog.show();
  }

  /** Resolve the open picker and clear the token that owns it. */
  private void finishPick(JSONObject payload) {
    String token = pendingToken;
    pendingToken = null;
    if (token != null) resolve(token, payload);
  }

  /* ---------------- GATT ---------------- */

  private final BluetoothGattCallback callback = new BluetoothGattCallback() {
    @Override
    public void onConnectionStateChange(BluetoothGatt g, int status, int newState) {
      if (g != gatt) return;
      if (newState == BluetoothProfile.STATE_CONNECTED) {
        if (status != BluetoothGatt.GATT_SUCCESS) {
          // A "connected" state with an error status cannot be used: never
          // leave the handshake waiting for callbacks that will not come.
          resolveError(connectToken, "Bluetooth connection failed (status " + status + ")");
          return;
        }
        g.discoverServices();
      } else if (newState == BluetoothProfile.STATE_DISCONNECTED) {
        boolean handshaking = connectToken != null;
        characteristic = null;
        writes.clear();
        writing = false;
        cancelWriteWatchdog();
        if (handshaking) {
          // A failed GATT connect ends here, not in onDescriptorWrite.
          resolveError(connectToken, "Printer disconnected before the connection was ready");
          return;
        }
        if (status != BluetoothGatt.GATT_SUCCESS) {
          resolveError(connectToken, "Bluetooth connection failed (status " + status + ")");
        }
        if (!closing) emit("close", "Printer disconnected");
      } else if (status != BluetoothGatt.GATT_SUCCESS) {
        resolveError(connectToken, "Bluetooth connection failed (status " + status + ")");
      }
    }

    @Override
    public void onServicesDiscovered(BluetoothGatt g, int status) {
      if (g != gatt) return;
      if (status != BluetoothGatt.GATT_SUCCESS) {
        resolveError(connectToken, "Could not read the printer's services");
        return;
      }
      BluetoothGattService service = g.getService(UUID.fromString(connectService));
      if (service == null) {
        resolveError(connectToken, "The printer does not expose its data service");
        return;
      }
      characteristic = service.getCharacteristic(UUID.fromString(connectCharacteristic));
      if (characteristic == null) {
        resolveError(connectToken, "The printer does not expose its data characteristic");
        return;
      }
      if (!g.setCharacteristicNotification(characteristic, true)) {
        resolveError(connectToken, "Could not subscribe to printer replies");
        return;
      }
      BluetoothGattDescriptor descriptor = characteristic.getDescriptor(UUID.fromString("00002902-0000-1000-8000-00805f9b34fb"));
      if (descriptor == null) {
        resolveError(connectToken, "The printer has no notification descriptor");
        return;
      }
      descriptor.setValue(BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE);
      if (!g.writeDescriptor(descriptor)) {
        resolveError(connectToken, "Could not enable printer notifications");
        return;
      }
      g.requestMtu(247);
      // The peer may never answer the MTU exchange; the link still works at 23.
      mtuFallback = () -> {
        mtuFallback = null;
        mtuReady = true;
        settleHandshake();
      };
      main.postDelayed(mtuFallback, MTU_FALLBACK_MS);
    }

    @Override
    public void onDescriptorWrite(BluetoothGatt g, BluetoothGattDescriptor descriptor, int status) {
      if (g != gatt) return;
      if (status != BluetoothGatt.GATT_SUCCESS) {
        resolveError(connectToken, "Could not enable printer notifications");
        return;
      }
      descriptorReady = true;
      settleHandshake();
    }

    @Override
    public void onMtuChanged(BluetoothGatt g, int size, int status) {
      if (g != gatt) return;
      if (status == BluetoothGatt.GATT_SUCCESS) mtu = Math.max(23, Math.min(size, MAX_CHUNK_BYTES + 3));
      mtuReady = true;
      settleHandshake();
    }

    @Override
    public void onCharacteristicChanged(BluetoothGatt g, BluetoothGattCharacteristic value) {
      if (g != gatt) return;
      emit("data", Base64.encodeToString(value.getValue(), Base64.NO_WRAP));
    }

    @Override
    public void onCharacteristicWrite(BluetoothGatt g, BluetoothGattCharacteristic value, int status) {
      if (g != gatt) return;
      // Only the in-flight chunk may advance the queue. A late ack for a chunk
      // the watchdog already abandoned must not reopen the write gate.
      if (!writing) return;
      cancelWriteWatchdog();
      writing = false;
      if (status == BluetoothGatt.GATT_SUCCESS) nextWrite();
      else {
        writes.clear();
        emit("close", "Printer write failed");
      }
    }
  };

  /** Resolve the connect call once notifications and (or) the MTU are ready. */
  private void settleHandshake() {
    if (descriptorReady && mtuReady) resolve(connectToken, ok());
  }

  private void enqueue(byte[] data) {
    if (destroyed || gatt == null || characteristic == null) {
      writes.clear();
      return;
    }
    int size = Math.max(20, Math.min(mtu - 3, MAX_CHUNK_BYTES));
    for (int offset = 0; offset < data.length; offset += size) {
      int end = Math.min(data.length, offset + size);
      byte[] chunk = new byte[end - offset];
      System.arraycopy(data, offset, chunk, 0, chunk.length);
      writes.add(chunk);
    }
    nextWrite();
  }

  private void nextWrite() {
    if (writing) return;
    byte[] chunk = writes.poll();
    if (chunk == null) return;
    if (gatt == null || characteristic == null) {
      writes.clear();
      return;
    }
    writing = true;
    final int generation = ++writeGeneration;
    characteristic.setWriteType(BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE);
    boolean queued;
    if (Build.VERSION.SDK_INT >= 33) {
      queued = gatt.writeCharacteristic(characteristic, chunk, BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE)
          == android.bluetooth.BluetoothStatusCodes.SUCCESS;
    } else {
      characteristic.setValue(chunk);
      queued = gatt.writeCharacteristic(characteristic);
    }
    if (!queued) {
      writing = false;
      writes.clear();
      emit("close", "Printer write failed");
      return;
    }
    // The next chunk waits for this chunk's ack. If none arrives the link is
    // dead: close it instead of advancing on a guessed delay.
    armWriteWatchdog(generation);
  }

  private void armWriteWatchdog(int generation) {
    cancelWriteWatchdog();
    Runnable watchdog = () -> {
      writeWatchdog = null;
      if (!writing || generation != writeGeneration) return;
      writing = false;
      writes.clear();
      Log.w(TAG, "no write ack within " + WRITE_ACK_TIMEOUT_MS + " ms; closing the link");
      emit("close", "Printer stopped acknowledging writes");
      closeGatt();
    };
    writeWatchdog = watchdog;
    main.postDelayed(watchdog, WRITE_ACK_TIMEOUT_MS);
  }

  private void cancelWriteWatchdog() {
    if (writeWatchdog != null) {
      main.removeCallbacks(writeWatchdog);
      writeWatchdog = null;
    }
  }

  private void cancelMtuFallback() {
    if (mtuFallback != null) {
      main.removeCallbacks(mtuFallback);
      mtuFallback = null;
    }
  }

  private void closeGatt() {
    closing = true;
    cancelWriteWatchdog();
    cancelMtuFallback();
    writes.clear();
    writing = false;
    // The next connection negotiates its own MTU; 23 is the only safe default.
    mtu = 23;
    descriptorReady = false;
    mtuReady = false;
    characteristic = null;
    if (gatt != null) {
      try {
        gatt.disconnect();
        gatt.close();
      } catch (Exception ignored) {
        // The link is already gone.
      }
    }
    gatt = null;
    closing = false;
  }

  /* ---------------- replies ---------------- */

  private void resolve(String token, JSONObject payload) {
    if (token == null) return;
    if (token.equals(connectToken)) {
      // Every settle ends the handshake, success or failure.
      connectToken = null;
      descriptorReady = false;
      mtuReady = false;
      cancelMtuFallback();
    }
    postJs("window.__niimbot&&window.__niimbot.resolve(" + JSONObject.quote(token) + "," + payload + ")");
  }

  private void resolveError(String token, String message) {
    if (token == null) return;
    JSONObject reply = new JSONObject();
    try {
      reply.put("ok", false);
      reply.put("error", message);
    } catch (Exception ignored) {
      // A failure to report the failure has no other channel.
      return;
    }
    resolve(token, reply);
  }

  private static JSONObject ok() {
    JSONObject reply = new JSONObject();
    try {
      reply.put("ok", true);
    } catch (Exception ignored) {
      // Constant field.
    }
    return reply;
  }

  private static JSONObject cancelled() {
    JSONObject reply = new JSONObject();
    try {
      reply.put("ok", false);
      reply.put("cancelled", true);
    } catch (Exception ignored) {
      // Constant fields.
    }
    return reply;
  }

  /** Evaluate page JavaScript only while the shell is alive. */
  private void postJs(String js) {
    if (destroyed || webView == null) return;
    main.post(() -> {
      if (destroyed || webView == null) return;
      webView.evaluateJavascript(js, null);
    });
  }

  private void emit(String type, String payload) {
    if (destroyed) return;
    postJs("window.__niimbot&&window.__niimbot.event(" + JSONObject.quote(type) + "," + JSONObject.quote(payload) + ")");
  }

  /** Called from MainActivity.onDestroy, before the WebView is torn down. */
  void destroy() {
    destroyed = true;
    Log.d(TAG, "bridge destroyed");
    main.removeCallbacksAndMessages(null);
    writeWatchdog = null;
    mtuFallback = null;
    if (dialog != null) {
      dialog.dismiss();
      dialog = null;
    }
    stopScan();
    pendingToken = null;
    pendingAction = null;
    connectToken = null;
    closeGatt();
  }
}
