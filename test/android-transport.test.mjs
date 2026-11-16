import test from 'node:test';
import assert from 'node:assert/strict';

import { AndroidTransport } from '../src/device/transports/android.js';
import { CONFIG } from '../src/core/config.js';
import { buildCommand } from '../src/protocol/commands.js';
import { clearLog, subscribeLog } from '../src/core/log.js';

/** One shared window keeps the bridge installer idempotent across tests. */
const window = {};
globalThis.window = window;

class FakeBridge {
  constructor() {
    this.calls = [];
    this.last = '';
    this.connected = false;
    this.files = [];
  }

  lastDevice() {
    return this.last;
  }

  pickDevice(token, prefixesJson) {
    this.calls.push(['pick', token, prefixesJson]);
    this.pickToken = token;
  }

  cancelPick() {
    this.calls.push(['cancelPick']);
  }

  connect(token, id, service, characteristic) {
    this.calls.push(['connect', token, id, service, characteristic]);
    this.connected = true;
    this.connectToken = token;
    // The native bridge resolves asynchronously once notifications are enabled.
    queueMicrotask(() => this.resolve(token, { ok: true }));
  }

  write(base64) {
    this.calls.push(['write', base64]);
    return this.connected;
  }

  disconnect() {
    this.connected = false;
    this.calls.push(['disconnect']);
  }

  saveFile(name, text) {
    this.files.push([name, text]);
    return true;
  }

  resolve(token, payload) {
    window.__niimbot.resolve(token, payload);
  }

  event(type, payload) {
    window.__niimbot.event(type, payload);
  }
}

function base64(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

test.beforeEach(() => {
  window.NiimbotBLE = new FakeBridge();
});

test.afterEach(() => {
  delete window.NiimbotBLE;
});

test('the transport is available only when the native bridge exists', () => {
  assert.equal(AndroidTransport.available(), true);
  delete window.NiimbotBLE;
  assert.equal(AndroidTransport.available(), false);
});

test('the last device is read from the bridge and malformed data is ignored', async () => {
  window.NiimbotBLE.last = JSON.stringify({ id: 'AA:BB', name: 'D110' });
  assert.deepEqual(await AndroidTransport.granted(), { id: 'AA:BB', name: 'D110' });
  window.NiimbotBLE.last = '{not json';
  assert.equal(await AndroidTransport.granted(), null);
  window.NiimbotBLE.last = '';
  assert.equal(await AndroidTransport.granted(), null);
});

test('the last device can be forgotten through the bridge', async () => {
  window.NiimbotBLE.last = JSON.stringify({ id: 'AA:BB', name: 'D110' });
  window.NiimbotBLE.forgetCalls = 0;
  window.NiimbotBLE.forgetDevice = () => {
    window.NiimbotBLE.forgetCalls++;
    window.NiimbotBLE.last = '';
  };
  assert.equal(AndroidTransport.forget(), true);
  assert.equal(window.NiimbotBLE.forgetCalls, 1);
  assert.equal(await AndroidTransport.granted(), null, 'the next connection has no saved printer');

  delete window.NiimbotBLE.forgetDevice;
  assert.equal(AndroidTransport.forget(), false, 'an older bridge cannot pretend it forgot');
});

test('picking a printer resolves the device and sends the configured prefixes', async () => {
  const picking = AndroidTransport.request();
  const [pick] = window.NiimbotBLE.calls;
  assert.equal(pick[0], 'pick');
  assert.deepEqual(JSON.parse(pick[2]), CONFIG.transport.bleNamePrefixes);
  window.NiimbotBLE.resolve(pick[1], { ok: true, device: { id: 'AA:BB', name: 'D110' } });
  assert.deepEqual(await picking, { id: 'AA:BB', name: 'D110' });
});

test('cancelling the native picker rejects with the shared NotFoundError contract', async () => {
  const picking = AndroidTransport.request();
  const [pick] = window.NiimbotBLE.calls;
  window.NiimbotBLE.resolve(pick[1], { ok: false, cancelled: true });
  await assert.rejects(picking, (error) => error.name === 'NotFoundError');
});

test('a native error rejects with its message', async () => {
  const picking = AndroidTransport.request();
  const [pick] = window.NiimbotBLE.calls;
  window.NiimbotBLE.resolve(pick[1], { ok: false, error: 'Bluetooth permission denied' });
  await assert.rejects(picking, /permission denied/);
});

test('open connects with the configured UUIDs and sends the shared connect frame', async () => {
  const transport = new AndroidTransport();
  await transport.open({ id: 'AA:BB', name: 'D110' });
  const connect = window.NiimbotBLE.calls.find((call) => call[0] === 'connect');
  assert.deepEqual(connect.slice(2), [
    'AA:BB',
    CONFIG.transport.bleService,
    CONFIG.transport.bleCharacteristic,
  ]);
  const written = window.NiimbotBLE.calls.find((call) => call[0] === 'write');
  assert.equal(written[1], base64(buildCommand('connect')));
  assert.match(transport.describe(), /D110/);
});

test('notifications become data events for the attached handler', async () => {
  const transport = new AndroidTransport();
  const received = [];
  transport.onData((bytes) => received.push([...bytes]));
  await transport.open({ id: 'AA:BB', name: 'D110' });
  window.NiimbotBLE.event('data', base64([0x55, 0x55, 0x02, 0x00]));
  assert.deepEqual(received, [[0x55, 0x55, 0x02, 0x00]]);
});

test('a connection loss reaches the close handler, and close drops the device', async () => {
  const transport = new AndroidTransport();
  const reasons = [];
  transport.onClose((error) => reasons.push(error.message));
  await transport.open({ id: 'AA:BB', name: 'D110' });
  window.NiimbotBLE.event('close', 'Printer disconnected');
  assert.deepEqual(reasons, ['Printer disconnected']);
  await transport.close();
  assert.equal(window.NiimbotBLE.connected, false);
  await assert.rejects(transport.write(new Uint8Array([1])), /not connected/);
});

test('a rejected native write is surfaced instead of silently dropped', async () => {
  const transport = new AndroidTransport();
  await transport.open({ id: 'AA:BB', name: 'D110' });
  window.NiimbotBLE.connected = false;
  await assert.rejects(transport.write(new Uint8Array([1])), /rejected/);
});

test('a late native close after an intentional close is ignored', async () => {
  const transport = new AndroidTransport();
  const reasons = [];
  transport.onClose((error) => reasons.push(error.message));
  await transport.open({ id: 'AA:BB', name: 'D110' });
  await transport.close();
  window.NiimbotBLE.event('close', 'Printer disconnected');
  assert.deepEqual(reasons, []);
});

test('a bridge call that never answers rejects after the configured timeout', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  window.NiimbotBLE.connect = () => {
    // The native handshake stalls and never calls back.
  };
  const transport = new AndroidTransport();
  const opened = transport.open({ id: 'AA:BB', name: 'D110' }).then(
    () => null,
    (error) => error
  );
  t.mock.timers.tick(CONFIG.transport.androidCallTimeoutMs - 1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(transport.describe(), 'Bluetooth LE (D110)', 'still connecting before the deadline');
  t.mock.timers.tick(1);
  const error = await opened;
  assert.ok(error instanceof Error, 'the stalled connect rejected');
  assert.match(error.message, /did not answer connect/);
  assert.match(error.message, new RegExp(String(CONFIG.transport.androidCallTimeoutMs)));
});

test('a resolved bridge call clears its timeout', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const transport = new AndroidTransport();
  const opening = transport.open({ id: 'AA:BB', name: 'D110' });
  // The fake bridge answers the connect call from a microtask; the write that
  // follows waits for the transport's pacing timer.
  await new Promise((resolve) => setImmediate(resolve));
  t.mock.timers.tick(CONFIG.transport.bleWritePacingMs);
  await opening;
  clearLog();
  const logs = [];
  const off = subscribeLog((entry) => logs.push(entry));
  t.mock.timers.tick(CONFIG.transport.androidCallTimeoutMs * 2);
  off();
  assert.deepEqual(logs.filter((entry) => /timed out/.test(entry.message)), [], 'a settled call cannot time out later');
});

test('closing the transport rejects an unanswered bridge call', async () => {
  let token;
  window.NiimbotBLE.connect = (pendingToken) => {
    token = pendingToken;
  };
  const transport = new AndroidTransport();
  const opened = transport.open({ id: 'AA:BB', name: 'D110' }).then(
    () => null,
    (error) => error
  );
  assert.ok(token, 'the connect call reached the bridge');
  await transport.close();
  const error = await opened;
  assert.ok(error instanceof Error, 'open() rejected instead of staying pending');
  assert.match(error.message, /link closed/);
  // A native reply for the abandoned token must be ignored, not resurrect it.
  assert.doesNotThrow(() => window.__niimbot.resolve(token, { ok: true }));
});

/* ---------------- interactive picker lifetime (R1-2) ---------------- */

test('the interactive picker is bounded by the picker timeout, not the call timeout', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let settled = false;
  const picking = AndroidTransport.request().then(
    (value) => {
      settled = true;
      return value;
    },
    (error) => {
      settled = true;
      return error;
    }
  );
  t.mock.timers.tick(CONFIG.transport.androidCallTimeoutMs);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false, 'a human still choosing is not a stalled bridge call');

  t.mock.timers.tick(CONFIG.transport.androidPickerTimeoutMs - CONFIG.transport.androidCallTimeoutMs);
  const error = await picking;
  assert.ok(error instanceof Error);
  assert.match(error.message, new RegExp(String(CONFIG.transport.androidPickerTimeoutMs)));
});

test('picking again dismisses a picker the native side still shows', async () => {
  // The first pick is abandoned (its JS call timed out, the dialog did not).
  const first = AndroidTransport.request().then(
    () => null,
    (error) => error
  );
  const second = AndroidTransport.request();
  const kinds = window.NiimbotBLE.calls.map((call) => call[0]);
  const picks = window.NiimbotBLE.calls.filter((call) => call[0] === 'pick');
  assert.equal(picks.length, 2, 'one pick per request, never stacked');
  assert.equal(kinds[kinds.lastIndexOf('pick') - 1], 'cancelPick', 'the stale dialog is dismissed before the new pick');
  window.NiimbotBLE.resolve(picks[1][1], { ok: true, device: { id: 'AA:BB' } });
  assert.deepEqual(await second, { id: 'AA:BB' });
  window.NiimbotBLE.resolve(picks[0][1], { ok: false, cancelled: true });
  assert.equal((await first).name, 'NotFoundError');
});

test('closing the transport dismisses a picker left open', async () => {
  const picking = AndroidTransport.request().then(
    () => null,
    (error) => error
  );
  const transport = new AndroidTransport();
  await transport.close();
  assert.ok(
    window.NiimbotBLE.calls.some((call) => call[0] === 'cancelPick'),
    'close() asks the native side to dismiss the dialog'
  );
  const error = await picking;
  assert.equal(error.name, 'NotFoundError', 'the JS answer matches the native cancelled reply');
  assert.doesNotMatch(error.message, /link closed/, 'a dismissed picker is not a broken link');
  assert.match(error.message, /No printer selected/);
});
