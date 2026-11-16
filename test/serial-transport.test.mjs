/**
 * Web Serial transport: only a port that actually advertises the printer's SPP
 * service is ever opened without asking the user. A granted port that answers
 * nothing else must fall through to the picker instead of being retried.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { SerialTransport, canonicalSpp } from '../src/device/transports/serial.js';
import { createDeviceManager } from '../src/device/manager.js';
import { CONFIG } from '../src/core/config.js';
import { encodeFrame } from '../src/protocol/frames.js';

const port = (serviceClassId, label = serviceClassId) => ({
  label,
  getInfo: () => (serviceClassId === undefined ? {} : { bluetoothServiceClassId: serviceClassId }),
});

/** Replace navigator.serial for one test and restore it afterwards. */
function withSerial(t, ports) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', {
    value: { serial: { getPorts: async () => ports, requestPort: async () => ports[0] } },
    configurable: true,
    writable: true,
  });
  t.after(() => {
    if (descriptor) Object.defineProperty(globalThis, 'navigator', descriptor);
    else delete globalThis.navigator;
  });
}

test('an authorised port without the SPP service is never treated as granted', async (t) => {
  withSerial(t, [port(undefined, 'COM4')]);
  assert.equal(await SerialTransport.granted(), null, 'a non-Bluetooth port is not the printer');
  assert.equal(SerialTransport.available(), true);
});

test('a different Bluetooth service class is not the printer', async (t) => {
  // A different service class differs in its 16-bit alias, not just the tail.
  withSerial(t, [port('0000110b-0000-1000-8000-00805f9b34fb', 'COM5')]);
  assert.equal(await SerialTransport.granted(), null);
});

test('the granted port is the one that advertises the configured SPP service', async (t) => {
  const other = port('0000110b-0000-1000-8000-00805f9b34fb', 'headset');
  const printer = port(CONFIG.transport.sppService, 'D110 SPP');
  withSerial(t, [other, printer]);
  assert.equal(await SerialTransport.granted(), printer, 'the matching port wins, not the first one');
});

test('the granted port matches the 16-bit form Chrome reports for a mapped SPP port', async (t) => {
  const numeric = port(0x1101, 'D110 SPP');
  withSerial(t, [numeric]);
  assert.equal(await SerialTransport.granted(), numeric, 'a numeric service class id is the same service');
});

test('an unrelated 16-bit service class is not the printer', async (t) => {
  withSerial(t, [port(0x110b, 'headset')]);
  assert.equal(await SerialTransport.granted(), null);
});

test('canonicalSpp reduces every reported form to the same eight digits', () => {
  assert.equal(canonicalSpp(0x1101), '00001101');
  assert.equal(canonicalSpp(CONFIG.transport.sppService), '00001101');
  assert.equal(canonicalSpp('1101'), '00001101');
  assert.equal(canonicalSpp('0x1101'), '00001101');
  assert.equal(canonicalSpp(0x110b), '0000110b');
  assert.equal(canonicalSpp(undefined), null);
  assert.equal(canonicalSpp(''), null);
});

test('the request filter carries both service-class forms', async (t) => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  let options = null;
  Object.defineProperty(globalThis, 'navigator', {
    value: { serial: { requestPort: async (value) => ((options = value), 'picked') } },
    configurable: true,
    writable: true,
  });
  t.after(() => {
    if (descriptor) Object.defineProperty(globalThis, 'navigator', descriptor);
    else delete globalThis.navigator;
  });

  assert.equal(await SerialTransport.request(), 'picked');
  assert.deepEqual(options.filters, [
    { bluetoothServiceClassId: 0x1101 },
    { bluetoothServiceClassId: CONFIG.transport.sppService },
  ]);
});

test('a granted-but-unusable port makes the manager ask once instead of retrying', async () => {
  const calls = [];
  const asked = { id: 'picked' };
  class PortTransport {
    kind = 'serial';
    static available() {
      return true;
    }
    static async granted() {
      calls.push('granted');
      return null;
    }
    static async request() {
      calls.push('request');
      return asked;
    }
    onData(callback) {
      this.onDataHandler = callback;
    }
    onClose() {}
    async open(target) {
      this.target = target;
    }
    async write() {
      // This printer answers every request as unsupported.
      this.onDataHandler(encodeFrame(0x00, [0x01]));
    }
    async close() {}
    describe() {
      return 'Port transport';
    }
  }
  const manager = createDeviceManager({ candidates: () => [PortTransport] });
  const connecting = manager.connect();
  // The picked port opens; discovery then reports that the printer did not
  // answer. The point is that the picker was offered exactly once.
  await assert.rejects(connecting, /did not answer any capability probe/);
  assert.deepEqual(calls, ['granted', 'request']);
});
