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
