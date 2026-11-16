/**
 * The saved web printer identity and the manager's reconnect preference.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { createDeviceManager } from '../src/device/manager.js';
import { clearLastPrinter, readLastPrinter, writeLastPrinter } from '../src/device/last-printer.js';
import { transportCandidates } from '../src/device/transports/index.js';
import { BleTransport } from '../src/device/transports/ble.js';
import { encodeFrame } from '../src/protocol/frames.js';

function fakeStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem: (key) => (values.has(key) ? values.get(key) : null),
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  };
}

test('a valid printer identity round-trips through its versioned envelope', () => {
  const storage = fakeStorage();
  assert.equal(writeLastPrinter({ kind: 'ble', id: 'device-1', name: 'D110' }, storage), true);
  assert.deepEqual(readLastPrinter(storage), { kind: 'ble', id: 'device-1', name: 'D110' });
  assert.equal(JSON.parse(storage.values.get('drypoint.printer')).version, 1);

  assert.equal(writeLastPrinter({ kind: 'serial', id: '', name: 'Bluetooth serial (SPP)' }, storage), true);
  assert.deepEqual(readLastPrinter(storage), { kind: 'serial', id: '', name: 'Bluetooth serial (SPP)' });
  assert.equal(clearLastPrinter(storage), true);
  assert.equal(readLastPrinter(storage), null);
});

test('malformed values are ignored, never trusted', () => {
  const storage = fakeStorage();
  const malformed = [
    'not json',
    JSON.stringify({ version: 2, data: { kind: 'ble', id: 'x', name: 'y' } }),
    JSON.stringify({ version: 1, data: { kind: 'android', id: 'x', name: 'y' } }),
    JSON.stringify({ version: 1, data: { kind: 'ble', id: '', name: 'y' } }),
    JSON.stringify({ version: 1, data: { kind: 'ble', id: 'x'.repeat(513), name: 'y' } }),
    JSON.stringify({ version: 1, data: { kind: 'serial', id: 7, name: 'y' } }),
    JSON.stringify({ version: 1, data: { kind: 'serial', id: '', name: 7 } }),
    JSON.stringify({ version: 1, data: null }),
  ];
  for (const raw of malformed) {
    storage.values.set('drypoint.printer', raw);
    assert.equal(readLastPrinter(storage), null, raw);
  }
  assert.equal(writeLastPrinter({ kind: 'android', id: 'x', name: 'y' }, storage), false);
  assert.equal(storage.values.has('drypoint.printer'), true, 'a refused write leaves the old value');
});

function withBluetooth(devices, body) {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    writable: true,
    value: { bluetooth: { getDevices: async () => devices } },
  });
  return Promise.resolve()
    .then(body)
    .finally(() => {
      if (original) Object.defineProperty(globalThis, 'navigator', original);
      else delete globalThis.navigator;
    });
}

test('BLE granted matches the saved id, or returns null when it is gone', async () => {
  const devices = [
    { id: 'other', name: 'D110 other' },
    { id: 'saved', name: 'D110 saved' },
  ];
  await withBluetooth(devices, async () => {
    assert.equal((await BleTransport.granted({ kind: 'ble', id: 'saved' })).id, 'saved');
    assert.equal(await BleTransport.granted({ kind: 'ble', id: 'missing' }), null, 'no silent fallback to another printer');
    assert.equal((await BleTransport.granted(null)).id, 'other', 'without a preference the first match is unchanged');
  });
});

/** A transport whose protocol answers are unsupported, so discovery fails fast. */
function fakeTransport({ kind = 'ble', granted = async () => ({ id: 'device-1' }), available = true } = {}) {
  const log = [];
  class Fake {
    static kind = kind;
    kind = kind;
    static available() {
      return available;
    }
    static async granted(preferred) {
      log.push({ call: 'granted', preferred });
      return granted(preferred);
    }
    static async request() {
      log.push({ call: 'request' });
      return null;
    }
    static async forget() {
      log.push({ call: 'forget' });
      return true;
    }
    constructor() {
      this.onDataHandler = () => {};
      this.onCloseHandler = () => {};
    }
    onData(callback) {
      this.onDataHandler = callback;
    }
    onClose(callback) {
      this.onCloseHandler = callback;
    }
    async open() {}
    async write() {
      this.onDataHandler(encodeFrame(0x00, [0x01]));
    }
    describe() {
      return 'Fake transport';
    }
    identity() {
      return { kind, id: 'saved-id', name: 'Saved printer' };
    }
    async close() {}
  }
  return { Fake, log };
}

test('the manager passes the saved identity to granted and reports the opened printer', async () => {
  const transport = fakeTransport();
  const reported = [];
  const manager = createDeviceManager({
    candidates: () => [transport.Fake],
    preferred: { kind: 'ble', id: 'saved', name: 'Old name' },
    onPrinter: (identity) => reported.push(identity),
  });
  await assert.rejects(manager.connect({ auto: true }), /did not answer any capability probe/);
  assert.deepEqual(transport.log[0], { call: 'granted', preferred: { kind: 'ble', id: 'saved', name: 'Old name' } });
  assert.deepEqual(reported, [{ kind: 'ble', id: 'saved-id', name: 'Saved printer' }]);
});

test('an opened printer becomes the preference for the next connect', async () => {
  const transport = fakeTransport();
  const manager = createDeviceManager({
    candidates: () => [transport.Fake],
    preferred: { kind: 'ble', id: 'saved', name: 'Old name' },
  });
  await assert.rejects(manager.connect({ auto: true }), /did not answer any capability probe/);
  await assert.rejects(manager.connect({ auto: true }), /did not answer any capability probe/);
  assert.equal(transport.log.at(-1).preferred.id, 'saved-id');
  assert.equal(transport.log.at(-1).preferred.name, 'Saved printer');
});

test('auto connect does not fall through to another printer when the saved one is missing', async () => {
  const ble = fakeTransport({ kind: 'ble', granted: async () => null });
  const serial = fakeTransport({ kind: 'serial', granted: async () => ({ id: 'serial-port' }) });
  const manager = createDeviceManager({ candidates: () => [ble.Fake, serial.Fake] });
  await assert.rejects(
    manager.connect({ auto: true, preferred: { kind: 'ble', id: 'gone', name: 'D110' } }),
    /saved printer is not available/
  );
  assert.deepEqual(ble.log.filter((entry) => entry.call === 'request'), [], 'auto never prompts');
  assert.deepEqual(serial.log, [], 'the other transport was not tried');
});

test('forget clears the manager preference and reports the removal', async () => {
  const transport = fakeTransport();
  const reported = [];
  const manager = createDeviceManager({
    candidates: () => [transport.Fake],
    preferred: { kind: 'ble', id: 'saved', name: 'Old name' },
    onPrinter: (identity) => reported.push(identity),
  });
  const results = await manager.forgetPrinter();
  assert.deepEqual(reported, [null]);
  assert.deepEqual(results, [{ transport: 'Fake', forgotten: true }]);
  assert.ok(transport.log.some((entry) => entry.call === 'forget'));

  // The next automatic attempt carries no saved preference.
  await assert.rejects(manager.connect({ auto: true }), /did not answer any capability probe/);
  assert.equal(transport.log.find((entry) => entry.call === 'granted').preferred, null);
});

test('the transport registry moves the saved transport first', () => {
  const bleFirst = transportCandidates('auto', { kind: 'ble' });
  assert.equal(bleFirst[0], BleTransport);
  const serialFirst = transportCandidates('auto', { kind: 'serial' });
  assert.equal(serialFirst[0].kind, 'serial');
  assert.equal(transportCandidates('serial', { kind: 'ble' })[0].kind, 'serial', 'an explicit preference wins');
});
