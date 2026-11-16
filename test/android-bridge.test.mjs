/**
 * Contract tests for the native GATT bridge.
 *
 * The Java side cannot run in CI (no Android runtime), so these assertions pin
 * the behaviours round 3 fixed: a bounded connect handshake, an ack watchdog
 * instead of a guessed delay, MTU reset + capped chunks, and teardown that
 * cannot call into a dead WebView. The compiled build is verified separately by
 * scripts/build-android.mjs (javac + d8 + apksigner).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { lexJavaScript } from '../scripts/lib/js-scan.mjs';

const root = new URL('../', import.meta.url);
const read = (path) => readFileSync(new URL(path, root), 'utf8');
const bridgeSource = () => read('android/app/src/main/java/dev/llm4people/drypoint/BleBridge.java');
const activitySource = () => read('android/app/src/main/java/dev/llm4people/drypoint/MainActivity.java');

/** The body of one Java method/initialiser, from `start` to its matching brace. */
function block(source, start) {
  const from = source.indexOf(start);
  assert.ok(from >= 0, `expected the source to contain: ${start}`);
  let depth = 0;
  for (let index = source.indexOf('{', from); index < source.length; index++) {
    if (source[index] === '{') depth++;
    else if (source[index] === '}' && --depth === 0) return source.slice(from, index + 1);
  }
  throw new Error(`unbalanced braces after: ${start}`);
}

test('the connect handshake never advances writes on a guessed delay', () => {
  const java = bridgeSource();
  assert.match(java, /WRITE_ACK_TIMEOUT_MS = 2000/, 'the ack watchdog is two seconds');
  assert.doesNotMatch(java, /\},\s*150\)/, 'the old 150 ms auto-advance is gone');
  const nextWrite = block(java, 'private void nextWrite()');
  assert.match(nextWrite, /armWriteWatchdog\(generation\)/, 'each submitted chunk arms the watchdog');
  assert.doesNotMatch(nextWrite, /nextWrite\(\);[\s\S]*postDelayed/, 'a chunk never precedes its ack');
  const watchdog = block(java, 'private void armWriteWatchdog(int generation)');
  assert.match(watchdog, /emit\("close", "Printer stopped acknowledging writes"\)/);
  assert.match(watchdog, /closeGatt\(\);/, 'a missing ack closes the link');
  const ack = block(java, 'public void onCharacteristicWrite(');
  assert.match(ack, /if \(!writing\) return;/, 'a late ack cannot reopen the write gate');
  assert.match(ack, /cancelWriteWatchdog\(\);/, 'an ack cancels its watchdog');
});

test('the handshake settles after notifications and the MTU exchange, with a fallback', () => {
  const java = bridgeSource();
  assert.match(java, /MTU_FALLBACK_MS = 300/);
  const services = block(java, 'public void onServicesDiscovered(');
  assert.match(services, /g\.requestMtu\(247\)/);
  assert.match(services, /main\.postDelayed\(mtuFallback, MTU_FALLBACK_MS\)/);
  assert.match(block(java, 'public void onDescriptorWrite('), /descriptorReady = true;[\s\S]*settleHandshake\(\)/);
  assert.match(block(java, 'public void onMtuChanged('), /mtuReady = true;[\s\S]*settleHandshake\(\)/);
  const settle = block(java, 'private void settleHandshake()');
  assert.match(settle, /descriptorReady && mtuReady/, 'both halves gate the resolve');
  assert.match(settle, /resolve\(connectToken, ok\(\)\)/);
});

test('each connection starts and ends at the default MTU and chunks are capped', () => {
  const java = bridgeSource();
  const connect = block(java, 'public void connect(');
  assert.match(connect, /mtu = 23;/, 'a new connection never inherits the previous MTU');
  const close = block(java, 'private void closeGatt()');
  assert.match(close, /mtu = 23;/);
  assert.match(java, /MAX_CHUNK_BYTES = 512/);
  assert.match(block(java, 'private void enqueue('), /Math\.min\(mtu - 3, MAX_CHUNK_BYTES\)/, 'a bogus MTU cannot create huge chunks');
  assert.match(java, /Math\.min\(size, MAX_CHUNK_BYTES \+ 3\)/, 'the negotiated MTU is capped too');
});

test('a failed or abandoned GATT connect settles the connection token', () => {
  const java = bridgeSource();
  const state = block(java, 'public void onConnectionStateChange(');
  assert.match(state, /boolean handshaking = connectToken != null;/);
  assert.match(state, /resolveError\(connectToken, "Printer disconnected before the connection was ready"\)/);
  assert.match(state, /if \(status != BluetoothGatt\.GATT_SUCCESS\)/);
  assert.match(state, /Bluetooth connection failed \(status /);
  const resolve = block(java, 'private void resolve(String token, JSONObject payload)');
  assert.match(resolve, /token\.equals\(connectToken\)/, 'the token is cleared by the settle itself');
  assert.match(resolve, /connectToken = null;/);
  const services = block(java, 'public void onServicesDiscovered(');
  assert.match(services, /status != BluetoothGatt\.GATT_SUCCESS/);
});

test('teardown cannot call into a destroyed WebView', () => {
  const java = bridgeSource();
  assert.match(java, /private boolean destroyed = false;/);
  const destroy = block(java, 'void destroy()');
  assert.match(destroy, /destroyed = true;/);
  assert.match(destroy, /main\.removeCallbacksAndMessages\(null\)/);
  assert.match(destroy, /dialog\.dismiss\(\)/);
  assert.match(destroy, /stopScan\(\)/);
  assert.match(destroy, /pendingToken = null;/);
  assert.match(destroy, /connectToken = null;/);
  assert.match(java, /if \(destroyed \|\| webView == null\) return;/, 'every evaluateJavascript call is guarded');
  assert.match(java, /dialog\.setOnDismissListener/, 'the picker dialog is owned, not leaked');

  const activity = activitySource();
  assert.match(activity, /private boolean destroyed = false;/);
  const onDestroy = block(activity, 'protected void onDestroy()');
  assert.match(onDestroy, /destroyed = true;/);
  assert.match(onDestroy, /fileCallback\.onReceiveValue\(null\)/);
  assert.match(onDestroy, /fileCallback = null;/);
  assert.match(onDestroy, /ble\.destroy\(\);/);
  assert.match(onDestroy, /ble = null;/);
});

/* ---------------- the file picker is built from the page's accept list (K-F1) ---------------- */

/**
 * The picker's own source, without comments: a behaviour contract must read the
 * code, not a sentence that describes it. The shared lexer does the stripping,
 * so a `/*` inside a comment or a string cannot eat the code below it.
 */
function codeOf(source) {
  return lexJavaScript(source).code;
}

test('the picker is built from the page accept list, not a hard-coded image type', () => {
  const activity = activitySource();
  const picker = block(activity, 'public boolean onShowFileChooser(');
  const code = codeOf(picker);

  assert.match(code, /params\.getAcceptTypes\(\)/, 'the page accept tokens are read');
  assert.match(code, /acceptTypes\(/, 'they go through the one resolver');
  assert.match(code, /params\.getMode\(\)/, 'the requested selection mode is read');
  assert.match(code, /FileChooserParams\.MODE_OPEN_MULTIPLE/, 'the multiple constant is the comparison');
  assert.match(code, /Intent\.CATEGORY_OPENABLE/, 'only openable documents are offered');
  assert.match(code, /Intent\.EXTRA_ALLOW_MULTIPLE/, 'a multiple request is forwarded');
  assert.match(code, /Intent\.EXTRA_MIME_TYPES/, 'several exact types are forwarded');
  assert.match(code, /intent\.setType\("\*\/\*"\)/, 'the fallback type stays open');
  assert.doesNotMatch(code, /intent\.setType\("image\/\*"\)/, 'the hard-coded image-only intent is gone');

  // No file manager: the callback is answered, not left pending.
  assert.match(code, /fileCallback = null;[\s\S]*callback\.onReceiveValue\(null\);[\s\S]*return false;/, 'a missing picker answers the page');
  assert.match(code, /if \(fileCallback != null\) fileCallback\.onReceiveValue\(null\);/, 'a superseded request is answered before it is replaced');
});

test('the extension map offers the label JSON as every type a picker may report', () => {
  const activity = activitySource();
  const map = block(activity, 'static {');
  assert.match(map, /types\.put\("\.json", new String\[\] \{ "application\/json", "text\/plain", "application\/octet-stream" \}\)/);
  assert.match(map, /types\.put\("\.txt", new String\[\] \{ "text\/plain" \}\)/);
  for (const extension of ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']) {
    assert.match(map, new RegExp(`types\\.put\\("\\${extension}", new String\\[\\] \\{ "image/`), `${extension} maps to an image type`);
  }

  const resolver = block(activity, 'static List<String> acceptTypes(');
  assert.match(resolver, /startsWith\("\."\)/, 'an extension token is recognised');
  assert.match(resolver, /toLowerCase\(Locale\.ROOT\)/, 'the extension match is case-insensitive');
  assert.match(resolver, /EXTENSION_MIME_TYPES\.get\(/, 'the map is the one resolver');
  assert.match(resolver, /!types\.contains\(type\)/, 'the list is deduplicated');
  assert.match(resolver, /types\.add\(value\)/, 'a MIME token and a wildcard are kept as written');
  // The page's own input declares application/json,.json; the resolver is the
  // only thing that turns that into picker types.
  assert.match(read('index.html'), /id="importDocumentInput"[^>]*accept="application\/json,\.json"/);
});

test('a multi-item selection answers every URI, deduplicated, and cancel answers null', () => {
  const activity = activitySource();
  const selection = block(activity, 'private static Uri[] selectedUris(');
  assert.match(selection, /data\.getData\(\)/, 'the primary URI is kept');
  assert.match(selection, /data\.getClipData\(\)/, 'ClipData is read, not only getData');
  assert.match(selection, /getItemCount\(\)/, 'every item is iterated');
  assert.match(selection, /getItemAt\(index\)\.getUri\(\)/, 'each item URI is read');
  assert.match(selection, /!uris\.contains\(uri\)/, 'duplicates are dropped');
  assert.match(selection, /uris\.isEmpty\(\) \? null/, 'an empty selection is null');

  const result = block(activity, 'protected void onActivityResult(');
  assert.match(result, /resultCode == RESULT_OK && data != null \? selectedUris\(data\) : null/, 'cancel and a missing intent answer null');
  assert.match(result, /fileCallback\.onReceiveValue\(result\)/, 'the page receives the answer');
  assert.match(result, /fileCallback = null;/, 'the callback is always cleared');

  const destroy = block(activity, 'protected void onDestroy()');
  assert.match(destroy, /fileCallback\.onReceiveValue\(null\)/);
  assert.match(destroy, /fileCallback = null;/);
});

test('the legacy saveFile refuses an existing name and deletes its partial file', () => {
  const java = bridgeSource();
  const legacy = block(java, 'private boolean saveFileLegacy(');
  assert.match(legacy, /downloadTarget\(name\)/, 'the canonical target resolver is still the owner');
  assert.match(legacy, /if \(target\.exists\(\)\) return false;/, 'an existing export is refused, not truncated');
  assert.ok(
    legacy.indexOf('target.exists()') < legacy.indexOf('new FileOutputStream'),
    'the duplicate check runs before anything is opened'
  );
  // The successful close is the success condition. A flag set inside the try
  // would claim success before flush/close had succeeded and would leave a
  // partial file behind when close failed. Contract: a failed write closes,
  // deletes the file this call created, and rethrows.
  const write = legacy.indexOf('out.write(');
  const close = legacy.indexOf('catch (java.io.IOException | RuntimeException error)');
  const remove = legacy.indexOf('!target.delete()');
  const rethrow = legacy.indexOf('throw error;');
  const success = legacy.indexOf('return true;', rethrow);
  assert.ok(close > write, 'the catch follows the write');
  assert.ok(remove > close && remove < rethrow, 'the partial file is deleted in the catch');
  assert.ok(rethrow > remove, 'the failure is rethrown, never reported as an export');
  assert.ok(success > rethrow, 'success is only returned after the stream closed');
  assert.doesNotMatch(legacy, /boolean written|written = true/, 'no pre-close success flag');
  assert.doesNotMatch(legacy, /finally/, 'the catch owns the failure path, not a finally workaround');
});

test('the duplicate-name lookup is by name only and documents the race', () => {
  const java = bridgeSource();
  const lookup = block(java, 'private boolean displayNameTaken(');
  assert.match(lookup, /MediaStore\.Downloads\.DISPLAY_NAME \+ " = \?"/, 'the display name is the key');
  assert.doesNotMatch(lookup, /MIME_TYPE/, 'A-F6: a same-named file of another type is still a collision');
  assert.match(lookup, /new String\[\] \{ name \}/, 'one selection argument');
  assert.match(java, /The race is accepted/, 'the residual check-then-insert window is documented');
  // A-F7 was rejected: the caller always writes JSON, so the row type stays.
  assert.match(java, /values\.put\(MediaStore\.Downloads\.MIME_TYPE, JSON_MIME\)/);
  assert.match(java, /private static final String JSON_MIME = "application\/json"/);
});
