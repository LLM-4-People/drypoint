import test from 'node:test';
import assert from 'node:assert/strict';

import { createDeviceManager, DIAGNOSTIC_INFO_KEYS, INFO_PROBES, INFO_PROJECTION } from '../src/device/manager.js';
import { CONFIG } from '../src/core/config.js';
import { clearLog, subscribeLog } from '../src/core/log.js';
import { emptyCapabilities } from '../src/device/capabilities.js';
import { INFO_KEYS } from '../src/protocol/commands.js';
import { getRollProfile, rememberRoll } from '../src/device/roll-profiles.js';
import { geometry, resetGeometry } from '../src/core/geometry.js';
import { documentHeightPx } from '../src/label/schema.js';
import { encodeFrame } from '../src/protocol/frames.js';
import { fromHex } from '../src/core/format.js';
import {
  FIXTURE_BLUETOOTH_ADDRESS,
  FIXTURE_BLUETOOTH_BYTES,
  FIXTURE_SERIAL,
  ROLL_BARCODE,
  rollTagBytes,
  serialBytes,
} from './fixtures/captured-unit.mjs';

const HEARTBEAT = fromHex('04 01 04 17 00 60 02 02 01 00');
const ADVANCED = fromHex('0f e6 04 49 00 00 01 00 00 00 00');
const STATUS = fromHex('30 30 23 28 00 c8 00 00 00 0a 00 03 01 12 ee 00');
const CAPS = fromHex(
  '01 01 00 02 01 01 03 01 00 04 02 00 c8 05 01 01 06 02 04 00 07 02 05 01 08 02 05 01 09 04 00 00 00 17 0a 02 00 60 0b 02 06 40 0c 01 01 0d 01 02 0e 01 01 0f 01 03 10 01 01 11 02 04 01 12 01 00 13 02 00 00 14 01 03 15 01 00 16 01 00 17 01 01 18 05 01 07 00 00 00 19 01 01'
);
const RFID = rollTagBytes();

const INFO_REPLIES = {
  0x01: [3],
  0x02: [1],
  0x03: [1],
  0x04: [0x00, 0x60],
  0x07: [3],
  0x08: [0x09, 0x10],
  0x09: [4, 23],
  0x0a: [4],
  0x0b: serialBytes(),
  0x0c: [4, 1],
  0x0d: [...FIXTURE_BLUETOOTH_BYTES],
  0x0e: [1],
  0x0f: [0x00, 0x60, 0x06, 0x40],
};

function frameOf(bytes) {
  const length = bytes[3];
  return { cmd: bytes[2], data: [...bytes.subarray(4, 4 + length)] };
}

/** Fake transport whose replies are deterministic protocol frames. */
function harness({ unsupported = false, advanced = ADVANCED, override = () => undefined, closeGate = null, hold = null, openGate = null } = {}) {
  const instances = [];
  let pages = 1;

  function respond(cmd, data) {
    const custom = override(cmd, data);
    if (custom !== undefined) return custom;
    if (unsupported) return [{ cmd: 0x00, data: [0x01] }];
    switch (cmd) {
      case 0x40:
        return [{ cmd: 0x40 + data[0], data: INFO_REPLIES[data[0]] ?? [0] }];
      case 0xdc:
        return data[0] === 0x03 ? [{ cmd: 0xde, data: [...HEARTBEAT] }] : [{ cmd: 0xd9, data: [...advanced] }];
      case 0xa5:
        return [{ cmd: 0xb5, data: [...STATUS] }];
      case 0xaf:
        return [{ cmd: 0xbf, data: [...CAPS] }];
      case 0x1a:
        return [{ cmd: 0x1b, data: [...RFID] }];
      case 0x21:
        return [{ cmd: 0x31, data: [1] }];
      case 0x23:
        return [{ cmd: 0x33, data: [1] }];
      case 0x01:
        pages = (data[0] << 8) | data[1];
        return [{ cmd: 0x02, data: [1] }];
      case 0xa3:
        return [{ cmd: 0xb3, data: [0x00, pages, 0x64, 0x64, 0, 0, 0, 1] }];
      case 0x13:
        return [{ cmd: 0x14, data: [1] }];
      case 0xe3:
        return [{ cmd: 0xe4, data: [1] }];
      case 0xf3:
        return [{ cmd: 0xf4, data: [1] }];
      case 0x8e:
        return [{ cmd: 0x8f, data: [1] }];
      case 0x5a:
        return [{ cmd: 0x6a, data: [1] }];
      case 0x58:
        return [{ cmd: 0x68, data: [0, data[1], 1] }];
      case 0x27:
        return [{ cmd: 0x37, data: [1] }];
      case 0x07:
        return [{ cmd: 0x08, data: [1] }];
      case 0x28:
        return [{ cmd: 0x38, data: [1] }];
      default:
        return null;
    }
  }

  class FakeTransport {
    kind = 'fake';

    static available() {
      return true;
    }

    static async granted() {
      return { id: instances.length };
    }

    static async request() {
      return null;
    }

    constructor() {
      this.writes = [];
      this.closeCount = 0;
      this.onDataHandler = () => {};
      this.onCloseHandler = () => {};
      instances.push(this);
    }

    onData(callback) {
      this.onDataHandler = callback;
    }

    onClose(callback) {
      this.onCloseHandler = callback;
    }

    async open() {
      if (openGate) await openGate.promise;
    }

    async write(bytes) {
      this.writes.push(bytes);
      const { cmd, data } = frameOf(bytes);
      const outcome = respond(cmd, data);
      if (!outcome) return;
      if (hold?.(cmd, data)) {
        // Answer later, but let the write itself complete like a real link.
        Promise.resolve(outcome).then((replies) => {
          for (const reply of replies) this.emit(reply.cmd, reply.data);
        });
        return;
      }
      const replies = await outcome;
      for (const reply of replies) this.emit(reply.cmd, reply.data);
    }

    emit(cmd, data) {
      this.onDataHandler(encodeFrame(cmd, data));
    }

    drop(error) {
      this.onCloseHandler(error);
    }

    describe() {
      return 'Fake transport';
    }

    async close() {
      this.closeCount++;
      if (closeGate) await closeGate;
    }
  }

  return { FakeTransport, instances };
}

const raster = { width: 96, height: 3, rows: [new Uint8Array(12).fill(0xff), new Uint8Array(12).fill(0xff), new Uint8Array(12)] };
const tick = () => new Promise((resolve) => setImmediate(resolve));

/** Resolve `predicate` by yielding until it is true, or fail after `tries`. */
async function waitFor(predicate, tries = 500) {
  for (let attempt = 0; attempt < tries; attempt++) {
    if (predicate()) return;
    await tick();
  }
  throw new Error('condition was never reached');
}

function deferred() {
  let resolve;
  const promise = new Promise((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

const frameCommands = (instance) => instance.writes.map((bytes) => frameOf(bytes).cmd);

test('connect fails when the printer answers no core probe', async () => {
  const fake = harness({ unsupported: true });
  const manager = createDeviceManager({ candidates: () => [fake.FakeTransport] });
  await assert.rejects(manager.connect(), /did not answer any capability probe/);
  assert.equal(manager.state.status, 'error');
  assert.equal(fake.instances[0].closeCount, 1);
});

test('connect merges the real replies and applies device geometry', async (t) => {
  t.after(resetGeometry);
  const fake = harness();
  const manager = createDeviceManager({ candidates: () => [fake.FakeTransport] });
  const capabilities = await manager.connect();

  assert.equal(manager.connected, true);
  assert.equal(capabilities.model, 'D110_M');
  assert.equal(capabilities.modelSupport, 'confirmed');
  assert.equal(capabilities.task, 'd110mv4');
  assert.equal(capabilities.dpi, 200);
  assert.equal(capabilities.headWidthPx, 96);
  assert.equal(capabilities.density, 3);
  assert.equal(capabilities.labelType, 1);
  assert.equal(capabilities.autoShutdown, 3);
  assert.equal(capabilities.battery.percent, 100);
  assert.equal(capabilities.sensors.lidClosed, true);
  assert.equal(capabilities.roll.barcode, ROLL_BARCODE);
  assert.equal(documentHeightPx(), 96);
  assert.ok(Math.abs(geometry().dotsPerMm - 200 / 25.4) < 1e-9, 'the capability TLV’s 200 dpi is the pitch');
});

test('every GetInfo key has a declared consumer or is explicitly diagnostic', () => {
  const tableKeys = INFO_PROJECTION.map(({ key }) => key);
  assert.deepEqual(
    [...new Set(tableKeys)].sort((a, b) => a - b),
    [...new Set(Object.values(INFO_KEYS))].sort((a, b) => a - b),
    'every decodable key appears exactly once'
  );
  assert.equal(new Set(tableKeys).size, tableKeys.length, 'no duplicate rows');

  const model = emptyCapabilities();
  for (const { key, field, name } of INFO_PROJECTION) {
    assert.ok(name, `GetInfo ${key.toString(16)} has a human name`);
    if (field === 'diagnostic') {
      assert.ok(DIAGNOSTIC_INFO_KEYS.includes(key), `${name} is only read on demand`);
      continue;
    }
    assert.ok(field in model, `${name} feeds the real capability field "${field}"`);
    assert.ok(INFO_PROBES.includes(key), `${name} is probed`);
  }
  assert.deepEqual(INFO_PROBES, INFO_PROJECTION.filter(({ field }) => field !== 'diagnostic').map(({ key }) => key));
  assert.deepEqual(DIAGNOSTIC_INFO_KEYS, INFO_PROJECTION.filter(({ field }) => field === 'diagnostic').map(({ key }) => key));
});

test('discovery reads only the GetInfo keys with a consumer', async () => {
  const fake = harness();
  const manager = createDeviceManager({ candidates: () => [fake.FakeTransport] });
  await manager.connect();
  const probed = fake.instances[0].writes
    .map(frameOf)
    .filter(({ cmd }) => cmd === 0x40)
    .map(({ data }) => data[0]);
  assert.deepEqual(probed, [...INFO_PROBES], 'the probe order is the projection table');
  assert.equal(probed.length, 8, 'the four unconsumed probes are gone');
});

test('diagnostic GetInfo reads every unconsumed key on demand', async () => {
  const fake = harness();
  const manager = createDeviceManager({ candidates: () => [fake.FakeTransport] });
  await manager.connect();
  const before = frameCommands(fake.instances[0]).filter((cmd) => cmd === 0x40).length;
  const entries = await manager.readInfoDiagnostics();
  const after = frameCommands(fake.instances[0]).filter((cmd) => cmd === 0x40).length;

  assert.deepEqual(entries.map(({ key }) => key), [...DIAGNOSTIC_INFO_KEYS]);
  assert.equal(after - before, DIAGNOSTIC_INFO_KEYS.length, 'one read per diagnostic key');
  const area = entries.find(({ key }) => key === INFO_KEYS.area);
  assert.deepEqual(area.decoded.area, { length: 4, raw: [0x00, 0x60, 0x06, 0x40] });
  const address = entries.find(({ key }) => key === INFO_KEYS.bluetoothAddress);
  assert.equal(address.decoded.bluetoothAddress, FIXTURE_BLUETOOTH_ADDRESS);
});

test('a link lost while PrintEnd is awaited carries the terminal commit', async () => {
  // The page counter confirmed every copy, so the outcome is settled, but the
  // link dropped before the PrintEnd ack and the flow never emitted
  // `finishing`. The disconnect must carry the commit fact, or the UI says the
  // label "may be incomplete" about a label the printer counted as printed.
  const fake = harness({
    override: (cmd) => (cmd === 0xf3 ? new Promise(() => {}) : undefined),
    hold: (cmd) => cmd === 0xf3,
  });
  const manager = createDeviceManager({ candidates: () => [fake.FakeTransport] });
  const disconnected = [];
  manager.events.on('disconnected', (detail) => disconnected.push(detail));
  await manager.connect();

  const job = manager.print(raster, { lengthMm: 40 });
  await waitFor(() => frameCommands(fake.instances[0]).includes(0xf3));
  fake.instances[0].drop(new Error('Printer disconnected'));
  await assert.rejects(job, /disconnected/i);
  await tick();

  assert.equal(disconnected.length, 1, 'one disconnect event');
  assert.equal(disconnected[0].committed, true, 'the disposable fact survives the cleared job');
  assert.match(disconnected[0].error.message, /disconnected/i);
  assert.equal(manager.connected, false);
});

test('disconnect closes the transport once and emits disconnected once', async () => {
  const fake = harness();
  const manager = createDeviceManager({ candidates: () => [fake.FakeTransport] });
  const disconnected = [];
  manager.events.on('disconnected', () => disconnected.push(true));
  await manager.connect();
  await manager.disconnect();
  await manager.disconnect();
  assert.equal(fake.instances[0].closeCount, 1);
  assert.equal(disconnected.length, 1);
  assert.equal(manager.state.status, 'idle');
});

test('a late close from the previous session does not clobber a newer connection', async () => {
  let releaseClose;
  const closeGate = new Promise((resolve) => {
    releaseClose = resolve;
  });
  const fake = harness({ closeGate });
  const manager = createDeviceManager({ candidates: () => [fake.FakeTransport] });
  await manager.connect();
  const disconnecting = manager.disconnect();
  await tick();
  const connecting = manager.connect();
  await connecting;
  assert.equal(manager.connected, true);
  releaseClose();
  await disconnecting;
  assert.equal(manager.connected, true);
  assert.equal(fake.instances.length, 2);
});

test('printing is blocked while the lid is open or the battery is critical', async () => {
  const lidOpen = ADVANCED.slice();
  lidOpen[4] = 1;
  const lidFake = harness({ advanced: lidOpen });
  const lidManager = createDeviceManager({ candidates: () => [lidFake.FakeTransport] });
  await lidManager.connect();
  await assert.rejects(lidManager.print(raster, { lengthMm: 40 }), /lid/i);

  const emptyBattery = ADVANCED.slice();
  emptyBattery[2] = 0;
  const batteryFake = harness({ advanced: emptyBattery });
  const batteryManager = createDeviceManager({ candidates: () => [batteryFake.FakeTransport] });
  await batteryManager.connect();
  await assert.rejects(batteryManager.print(raster, { lengthMm: 40 }), /Battery is too low/);
});

test('maintenance commands are blocked while a job is running', async () => {
  let releasePrintEnd;
  const gate = new Promise((resolve) => {
    releasePrintEnd = () => resolve([{ cmd: 0xf4, data: [1] }]);
  });
  const fake = harness({ override: (cmd) => (cmd === 0xf3 ? gate : undefined) });
  const manager = createDeviceManager({ candidates: () => [fake.FakeTransport] });
  await manager.connect();
  const job = manager.print(raster, { lengthMm: 40 });
  await tick();
  await assert.rejects(manager.calibrate(), /print job is running/);
  await assert.rejects(manager.pushSetting('print.density', 4), /print job is running/);
  await assert.rejects(manager.refresh(), /print job is running/);
  releasePrintEnd();
  await job;
  await tick();
});

test('a successful print remembers the roll length and label type', async () => {
  const fake = harness();
  const manager = createDeviceManager({ candidates: () => [fake.FakeTransport] });
  await manager.connect();
  const barcode = manager.capabilities.roll.barcode;
  await manager.print(raster, { lengthMm: 40 });
  const profile = getRollProfile(barcode);
  assert.equal(profile.lengthMm, 40);
  assert.equal(profile.labelType, 1);
  await tick();
});

test('an unsupported model is refused before a print frame is written (A4)', async () => {
  const fake = harness({
    override: (cmd, data) => (cmd === 0x40 && data[0] === 0x08 ? [{ cmd: 0x48, data: [0x10, 0x00] }] : undefined),
  });
  const manager = createDeviceManager({ candidates: () => [fake.FakeTransport] });
  const capabilities = await manager.connect();
  assert.equal(capabilities.model, 'B1');
  assert.equal(capabilities.modelSupport, 'unsupported');

  const before = fake.instances[0].writes.length;
  await assert.rejects(manager.print(raster, { lengthMm: 40 }), /B1 is not supported/);
  const commands = fake.instances[0].writes.slice(before).map((bytes) => frameOf(bytes).cmd);
  for (const cmd of [0x01, 0x21, 0x23, 0xe3, 0xf3, 0xda]) {
    assert.equal(commands.includes(cmd), false, `0x${cmd.toString(16)} is never sent for an unsupported model`);
  }
});

test('a caller abort signal cancels the job before it reaches the wire', async () => {
  const fake = harness();
  const manager = createDeviceManager({ candidates: () => [fake.FakeTransport] });
  await manager.connect();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(manager.print(raster, { lengthMm: 40, signal: controller.signal }), (error) => error.cancelled === true);
  const printFrames = fake.instances[0].writes.filter((bytes) => frameOf(bytes).cmd === 0x01);
  assert.equal(printFrames.length, 0);
});

test('auto-connect never prompts and stays idle without a granted device', async () => {
  let requested = 0;
  class NoGrantTransport {
    kind = 'fake';
    static available() {
      return true;
    }
    static async granted() {
      return null;
    }
    static async request() {
      requested++;
      throw new Error('must not prompt without a user gesture');
    }
    onData() {}
    onClose() {}
    async open() {}
    async write() {}
    async close() {}
  }
  const manager = createDeviceManager({ candidates: () => [NoGrantTransport] });
  await assert.rejects(manager.connect({ auto: true }), /No granted printer/);
  assert.equal(requested, 0, 'auto-connect must not call request()');
  assert.equal(manager.state.status, 'idle');
  assert.equal(manager.state.error, null);
});

test('a fatal probe error rejects the connect instead of publishing connected', async () => {
  const fake = harness({
    override: (cmd) => {
      if (cmd === 0xaf) throw new Error('link lost');
      return undefined;
    },
  });
  const manager = createDeviceManager({ candidates: () => [fake.FakeTransport] });
  const disconnected = [];
  manager.events.on('disconnected', () => disconnected.push(true));
  await assert.rejects(manager.connect(), /link lost/);
  assert.equal(manager.connected, false);
  assert.equal(manager.state.status, 'error');
  assert.equal(fake.instances[0].closeCount, 1);
  assert.deepEqual(disconnected, [], 'a link that never connected has nothing to disconnect');
});

test('a discovery that loses its session never publishes over the next connection', async () => {
  const gate = deferred();
  let gated = false;
  const fake = harness({
    override: (cmd) => {
      if (gated && cmd === 0xaf) return gate.promise;
      return undefined;
    },
    hold: (cmd) => gated && cmd === 0xaf,
  });
  const manager = createDeviceManager({ candidates: () => [fake.FakeTransport] });
  const discovered = [];
  manager.events.on('discovered', (capabilities) => discovered.push(capabilities.model));
  await manager.connect();

  gated = true;
  const stale = manager.refresh().then(
    () => null,
    (error) => error
  );
  await waitFor(() => frameCommands(fake.instances[0]).filter((cmd) => cmd === 0xaf).length === 2);
  await manager.disconnect();
  gated = false;
  await manager.connect();

  const staleError = await stale;
  assert.ok(staleError instanceof Error, 'the stale discovery rejected');
  assert.equal(manager.connected, true);
  assert.equal(manager.state.capabilities.model, 'D110_M');
  assert.deepEqual(discovered, ['D110_M', 'D110_M'], 'the stale discovery never published');
  gate.resolve([{ cmd: 0xbf, data: [...CAPS] }]);
  await tick();
});

test('a cancelled port picker rejects with a cancelled PrinterError', async () => {
  class CancelledTransport {
    kind = 'fake';
    static available() {
      return true;
    }
    static async granted() {
      return null;
    }
    static async request() {
      const error = new Error('The user aborted a request.');
      error.name = 'NotFoundError';
      throw error;
    }
    onData() {}
    onClose() {}
    async open() {}
    async write() {}
    async close() {}
  }
  const manager = createDeviceManager({ candidates: () => [CancelledTransport] });
  await assert.rejects(manager.connect(), (error) => {
    assert.equal(error.name, 'PrinterError');
    assert.equal(error.cancelled, true);
    assert.match(error.message, /No printer selected/);
    return true;
  });
  assert.equal(manager.state.status, 'idle', 'a cancelled picker is not an error state');
});

test('diagnostic commands are blocked while a job is running', async () => {
  const gate = deferred();
  const fake = harness({ override: (cmd) => (cmd === 0xf3 ? gate.promise : undefined) });
  const manager = createDeviceManager({ candidates: () => [fake.FakeTransport] });
  await manager.connect();
  const job = manager.print(raster, { lengthMm: 40 });
  await waitFor(() => frameCommands(fake.instances[0]).includes(0xf3));
  await assert.rejects(manager.diagnostic('paperInfo'), /print job is running/);
  gate.resolve([{ cmd: 0xf4, data: [1] }]);
  await job;
});

test('the post-print refresh holds the job lock until it settles', async () => {
  const gate = deferred();
  let armed = false;
  const fake = harness({
    override: (cmd) => (armed && cmd === 0xa5 ? gate.promise : undefined),
    hold: (cmd) => armed && cmd === 0xa5,
  });
  const manager = createDeviceManager({ candidates: () => [fake.FakeTransport] });
  await manager.connect();
  armed = true;

  const job = manager.print(raster, { lengthMm: 40 });
  await waitFor(() => frameCommands(fake.instances[0]).filter((cmd) => cmd === 0xa5).length === 2);

  await assert.rejects(manager.print(raster, { lengthMm: 40 }), /print job is running/);
  await assert.rejects(manager.diagnostic('paperInfo'), /print job is running/);

  gate.resolve([{ cmd: 0xb5, data: [...STATUS] }]);
  await job;
  await manager.refresh();
  assert.equal(manager.connected, true);
});

test('cancel after the labels are printed reports that there is nothing to cancel', async () => {
  const gate = deferred();
  let armed = false;
  const fake = harness({
    override: (cmd) => (armed && cmd === 0xa5 ? gate.promise : undefined),
    hold: (cmd) => armed && cmd === 0xa5,
  });
  const manager = createDeviceManager({ candidates: () => [fake.FakeTransport] });
  await manager.connect();
  armed = true;

  const job = manager.print(raster, { lengthMm: 40 });
  await waitFor(() => frameCommands(fake.instances[0]).filter((cmd) => cmd === 0xa5).length === 2);
  assert.equal(manager.state.printing, true, 'the post-print refresh still holds the lock');
  // The labels are out; only the refresh is running. Cancel must say so instead
  // of sending a frame between the discovery probes.
  assert.equal(await manager.cancel(), false);

  gate.resolve([{ cmd: 0xb5, data: [...STATUS] }]);
  await job;
  assert.equal(manager.state.printing, false);
});

test('the printer state is refreshed after a failed job too', async () => {
  const fake = harness({
    override: (cmd) => {
      if (cmd === 0x13) throw new Error('page size rejected');
      return undefined;
    },
  });
  const manager = createDeviceManager({ candidates: () => [fake.FakeTransport] });
  await manager.connect();
  const before = frameCommands(fake.instances[0]).filter((cmd) => cmd === 0xa5).length;
  await assert.rejects(manager.print(raster, { lengthMm: 40 }), /page size rejected/);
  const after = frameCommands(fake.instances[0]).filter((cmd) => cmd === 0xa5).length;
  assert.equal(after, before + 1, 'a failed job re-reads the printer');
});

test('the printer state is refreshed after a cancelled job too', async () => {
  const fake = harness();
  const manager = createDeviceManager({ candidates: () => [fake.FakeTransport] });
  await manager.connect();
  const controller = new AbortController();
  const before = frameCommands(fake.instances[0]).filter((cmd) => cmd === 0xa5).length;
  const job = manager.print(raster, { lengthMm: 40, signal: controller.signal });
  controller.abort();
  await assert.rejects(job, (error) => error.cancelled === true);
  const after = frameCommands(fake.instances[0]).filter((cmd) => cmd === 0xa5).length;
  assert.equal(after, before + 1, 'a cancelled job re-reads the printer');
});

test('reset re-reads the printer and mirrors its stored density', async () => {
  const { getSetting, setSetting } = await import('../src/core/settings.js');
  const fake = harness();
  const manager = createDeviceManager({ candidates: () => [fake.FakeTransport] });
  await manager.connect();
  setSetting('print.density', 5);
  assert.equal(getSetting('print.density'), 5);
  await manager.resetPrinter();
  assert.equal(getSetting('print.density'), 3, 'the detected density is applied again after the reset');
});

test('the print gate refuses on the job’s fresh heartbeat, not on discovery', async () => {
  let lid = 0;
  const fake = harness({
    override: (cmd, data) => {
      if (cmd === 0xdc && data[0] === 0x04) {
        const advanced = ADVANCED.slice();
        advanced[4] = lid;
        return [{ cmd: 0xd9, data: [...advanced] }];
      }
      return undefined;
    },
  });
  const manager = createDeviceManager({ candidates: () => [fake.FakeTransport] });
  await manager.connect();
  // The lid opens after discovery; the stale model still says "closed".
  lid = 1;
  await assert.rejects(manager.print(raster, { lengthMm: 40 }), /lid/i);
  assert.equal(manager.capabilities.sensors.lidClosed, false, 'the fresh sample reached the model');
});

test('the print gate refuses a job when the fresh sensor sample is missing', async () => {
  let silent = false;
  const fake = harness({
    override: (cmd, data) => (silent && cmd === 0xdc && data[0] === 0x04 ? [{ cmd: 0x00, data: [0] }] : undefined),
  });
  const manager = createDeviceManager({ candidates: () => [fake.FakeTransport] });
  await manager.connect();
  assert.ok(manager.capabilities.sensors, 'discovery reported sensors');
  silent = true;
  await assert.rejects(manager.print(raster, { lengthMm: 40 }), /did not report its sensors/);
  assert.equal(frameCommands(fake.instances[0]).filter((cmd) => cmd === 0x01).length, 0, 'no paper moved');
});

test('two concurrent refreshes share one discovery and publish once', async () => {
  const fake = harness();
  const manager = createDeviceManager({ candidates: () => [fake.FakeTransport] });
  await manager.connect();
  const discovered = [];
  manager.events.on('discovered', (capabilities) => discovered.push(capabilities.model));
  const before = frameCommands(fake.instances[0]).filter((cmd) => cmd === 0xa5).length;
  const [first, second] = await Promise.all([manager.refresh(), manager.refresh()]);
  assert.equal(first, second, 'both callers joined the same discovery');
  assert.deepEqual(discovered, ['D110_M'], 'one discovery, one published model');
  const after = frameCommands(fake.instances[0]).filter((cmd) => cmd === 0xa5).length;
  assert.equal(after, before + 1, 'the second refresh did not probe again');
});

test('an unanswered probe group keeps what the same session already reported', async () => {
  let silent = false;
  const fake = harness({ override: (cmd) => (silent && cmd === 0xaf ? [{ cmd: 0x00, data: [0] }] : undefined) });
  const manager = createDeviceManager({ candidates: () => [fake.FakeTransport] });
  const first = await manager.connect();
  assert.equal(first.hasVolume, true);
  silent = true;
  const second = await manager.refresh();
  assert.equal(second.hasVolume, true, 'volume survives a silent capability probe');
  assert.equal(second.source.volume, 'reported');
  assert.equal(second.hasRtc, true);
  assert.deepEqual(second.labelTypes, [1, 2, 3, 5]);
});

test('a new connection never inherits the previous printer’s capabilities', async () => {
  let silent = false;
  const fake = harness({ override: (cmd) => (silent && cmd === 0xaf ? [{ cmd: 0x00, data: [0] }] : undefined) });
  const manager = createDeviceManager({ candidates: () => [fake.FakeTransport] });
  await manager.connect();
  await manager.disconnect();
  silent = true;
  const second = await manager.connect();
  assert.equal(second.hasVolume, null, 'the fresh session falls back to its own answer');
  assert.equal(second.source.volume, 'default');
});

test('disconnect clears the readings that belonged to the link', async () => {
  const fake = harness();
  const manager = createDeviceManager({ candidates: () => [fake.FakeTransport] });
  const connected = await manager.connect();
  assert.ok(connected.battery && connected.sensors && connected.roll, 'the link reported live readings');
  await manager.disconnect();
  const after = manager.capabilities;
  assert.equal(after.battery, null);
  assert.equal(after.sensors, null);
  assert.equal(after.roll, null);
  assert.equal(after.source.battery, 'default');
  assert.equal(after.source.sensors, 'default');
  assert.equal(after.model, 'D110_M', 'identity survives the disconnect');
  assert.equal(after.serial, FIXTURE_SERIAL);
  assert.equal(after.dpi, 200);
  assert.deepEqual(after.labelTypes, [1, 2, 3, 5]);
});

test('a lost link clears the live readings too', async () => {
  const fake = harness();
  const manager = createDeviceManager({ candidates: () => [fake.FakeTransport] });
  await manager.connect();
  fake.instances[0].drop(new Error('adapter removed'));
  await waitFor(() => manager.state.status === 'idle');
  assert.equal(manager.capabilities.battery, null);
  assert.equal(manager.capabilities.sensors, null);
  assert.equal(manager.capabilities.roll, null);
  assert.equal(manager.capabilities.model, 'D110_M');
});

test('detected settings are mirrored before the discovered event publishes', async () => {
  const { getSetting, setSetting } = await import('../src/core/settings.js');
  setSetting('print.density', 5);
  const fake = harness();
  const manager = createDeviceManager({ candidates: () => [fake.FakeTransport] });
  const seen = [];
  manager.events.on('discovered', () => seen.push(getSetting('print.density')));
  await manager.connect();
  assert.deepEqual(seen, [3], 'the panel renders the mirrored density, not the previous one');
});

test('silent probes hit the discovery deadline instead of locking the manager', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const fake = harness({ override: (cmd) => (cmd === 0x40 ? null : undefined) });
  const manager = createDeviceManager({ candidates: () => [fake.FakeTransport] });
  const connecting = manager.connect();
  await waitFor(() => frameCommands(fake.instances[0]).includes(0x40));
  t.mock.timers.tick(CONFIG.protocol.timeouts.discovery);
  await assert.rejects(connecting, /did not finish discovery within 12000 ms/);
  assert.equal(manager.state.status, 'error');
  assert.equal(fake.instances[0].closeCount, 1, 'the stalled link is closed');
});

test('disconnect during open() cancels the attempt instead of reconnecting', async () => {
  const openGate = deferred();
  const fake = harness({ openGate });
  const manager = createDeviceManager({ candidates: () => [fake.FakeTransport] });
  const connecting = manager.connect();
  await waitFor(() => fake.instances.length === 1);
  await manager.disconnect();
  openGate.resolve();
  await assert.rejects(connecting, (error) => error.cancelled === true);
  assert.equal(manager.state.status, 'idle');
  assert.equal(fake.instances.length, 1, 'no second connection was opened');
  assert.equal(fake.instances[0].closeCount, 1, 'the opened link was closed');
  assert.deepEqual(frameCommands(fake.instances[0]), [], 'discovery never ran');
});

test('a disconnect during the first candidate never constructs the second', async () => {
  const openGate = deferred();
  const events = [];
  class FirstTransport {
    kind = 'first';
    static available() {
      return true;
    }
    static async granted() {
      events.push('first.granted');
      return { id: 'first' };
    }
    static async request() {
      events.push('first.request');
      return null;
    }
    constructor() {
      events.push('first.constructed');
    }
    onData() {}
    onClose() {}
    async open() {
      events.push('first.open');
      await openGate.promise;
    }
    async write() {}
    async close() {
      events.push('first.close');
    }
    describe() {
      return 'First transport';
    }
  }
  class SecondTransport {
    kind = 'second';
    static available() {
      return true;
    }
    static async granted() {
      events.push('second.granted');
      return { id: 'second' };
    }
    static async request() {
      events.push('second.request');
      return null;
    }
    constructor() {
      events.push('second.constructed');
    }
    onData() {}
    onClose() {}
    async open() {
      events.push('second.open');
    }
    async write() {}
    async close() {
      events.push('second.close');
    }
    describe() {
      return 'Second transport';
    }
  }
  const manager = createDeviceManager({ candidates: () => [FirstTransport, SecondTransport] });
  const connecting = manager.connect().then(
    () => null,
    (error) => error
  );
  await waitFor(() => events.includes('first.open'));
  await manager.disconnect();
  openGate.resolve();
  const error = await connecting;
  assert.equal(error.cancelled, true);
  assert.equal(events.includes('second.constructed'), false, 'the next candidate was never built');
  assert.deepEqual(
    events.filter((event) => event.startsWith('second.')),
    [],
    'granted, request and open were never called on the second candidate'
  );
  assert.equal(manager.state.status, 'idle');
});

test('a cancelled picker does not solicit the next transport', async () => {
  const events = [];
  class PickerTransport {
    kind = 'first';
    static available() {
      return true;
    }
    static async granted() {
      events.push('first.granted');
      return null;
    }
    static async request() {
      events.push('first.request');
      const error = new Error('The user aborted a request.');
      error.name = 'NotFoundError';
      throw error;
    }
    onData() {}
    onClose() {}
    async open() {}
    async write() {}
    async close() {}
  }
  class NextTransport {
    kind = 'second';
    static available() {
      return true;
    }
    static async granted() {
      events.push('second.granted');
      return { id: 'second' };
    }
    static async request() {
      events.push('second.request');
      return null;
    }
    onData() {}
    onClose() {}
    async open() {}
    async write() {}
    async close() {}
  }
  const manager = createDeviceManager({ candidates: () => [PickerTransport, NextTransport] });
  await assert.rejects(manager.connect(), (error) => error.cancelled === true && /No printer selected/.test(error.message));
  assert.deepEqual(events, ['first.granted', 'first.request'], 'the cancel stopped the candidate loop');
});

test('a test print does not overwrite the live roll profile', async () => {
  const fake = harness();
  const manager = createDeviceManager({ candidates: () => [fake.FakeTransport] });
  await manager.connect();
  rememberRoll(ROLL_BARCODE, { lengthMm: 60, labelType: 1 });
  assert.equal(getRollProfile(ROLL_BARCODE).lengthMm, 60);

  // The action-bar test label is the fixed 40 mm document and never records.
  await manager.print(raster, { lengthMm: 40, rememberRoll: false });
  assert.equal(getRollProfile(ROLL_BARCODE).lengthMm, 60, 'the test page left the saved roll alone');

  // A real label still owns the profile.
  await manager.print(raster, { lengthMm: 45 });
  assert.equal(getRollProfile(ROLL_BARCODE).lengthMm, 45);
});

test('a maintenance command owns the link until it completes', async () => {
  const gate = deferred();
  const fake = harness({ override: (cmd) => (cmd === 0x5a ? gate.promise : undefined) });
  const manager = createDeviceManager({ candidates: () => [fake.FakeTransport] });
  await manager.connect();
  const instance = fake.instances[0];

  const selfTest = manager.testPage();
  await waitFor(() => frameCommands(instance).includes(0x5a));
  assert.equal(manager.state.maintaining, true, 'the busy flag is published');

  await assert.rejects(manager.testPage(), /printer command is running/);
  await assert.rejects(manager.print(raster, { lengthMm: 40 }), /printer command is running/);
  assert.equal(frameCommands(instance).filter((cmd) => cmd === 0x5a).length, 1, 'no second self-test frame');
  assert.equal(frameCommands(instance).filter((cmd) => cmd === 0x01).length, 0, 'no print frame');

  gate.resolve([{ cmd: 0x6a, data: [1] }]);
  await selfTest;
  assert.equal(manager.state.maintaining, false);
  await manager.print(raster, { lengthMm: 40 });
});

test('the manager publishes its printing lock and clears it after the job', async () => {
  const gate = deferred();
  const fake = harness({ override: (cmd) => (cmd === 0xf3 ? gate.promise : undefined) });
  const manager = createDeviceManager({ candidates: () => [fake.FakeTransport] });
  await manager.connect();
  const seen = [];
  manager.events.on('state', (state) => seen.push(state.printing));
  assert.equal(manager.state.printing, false);

  const job = manager.print(raster, { lengthMm: 40 });
  assert.equal(manager.state.printing, true, 'the lock is published before the first frame');
  assert.equal(manager.printing, true);
  await assert.rejects(manager.calibrate(), /print job is running/);

  gate.resolve([{ cmd: 0xf4, data: [1] }]);
  await job;
  assert.equal(manager.state.printing, false);
  assert.equal(manager.printing, false);
  assert.ok(seen.includes(true) && seen.includes(false), 'the panel hears both transitions');
});

test('Choose printer asks the picker while Connect reuses the granted device', async () => {
  const counts = { granted: 0, request: 0 };
  class ChoiceTransport {
    kind = 'fake';
    static available() {
      return true;
    }
    static async granted() {
      counts.granted++;
      return { id: 'cached' };
    }
    static async request() {
      counts.request++;
      return { id: 'picked' };
    }
    onData() {}
    onClose() {}
    async open(target) {
      throw new Error(`opened ${target.id}`);
    }
    async write() {}
    async close() {}
  }
  const manager = createDeviceManager({ candidates: () => [ChoiceTransport] });

  await assert.rejects(manager.connect(), /opened cached/);
  assert.deepEqual(counts, { granted: 1, request: 0 }, 'a normal connect never prompts');

  counts.granted = 0;
  await assert.rejects(manager.choosePrinter(), /opened picked/);
  assert.deepEqual(counts, { granted: 0, request: 1 }, 'Choose printer always opens the picker');
});

test('Forget printer clears only transports that own a saved selection', async () => {
  class SavedTransport {
    static available() {
      return true;
    }
    static async forget() {
      return true;
    }
  }
  class BrowserTransport {
    static available() {
      return true;
    }
  }
  class RefusingTransport {
    static available() {
      return true;
    }
    static async forget() {
      return false;
    }
  }

  const saved = createDeviceManager({ candidates: () => [SavedTransport] });
  assert.deepEqual(await saved.forgetPrinter(), [{ transport: 'SavedTransport', forgotten: true }]);

  const browser = createDeviceManager({ candidates: () => [BrowserTransport] });
  assert.deepEqual(await browser.forgetPrinter(), [], 'a browser grant is not ours to clear');

  const refusing = createDeviceManager({ candidates: () => [RefusingTransport] });
  assert.deepEqual(await refusing.forgetPrinter(), [{ transport: 'RefusingTransport', forgotten: false }]);
});

/* ---------------- link ownership (R1-3/R1-5/R6-1) ---------------- */

test('a transport close that never settles cannot wedge the manager', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const fake = harness({ closeGate: new Promise(() => {}) });
  const manager = createDeviceManager({ candidates: () => [fake.FakeTransport] });
  await manager.connect();

  const disconnecting = manager.disconnect();
  await waitFor(() => fake.instances[0].closeCount === 1);
  t.mock.timers.tick(CONFIG.transport.closeTimeoutMs);
  await disconnecting;
  assert.equal(manager.state.status, 'idle', 'disconnect settled despite the stalled close');

  // The next attempt is a fresh link, not a dead one.
  await manager.connect();
  assert.equal(fake.instances.length, 2);
  assert.equal(manager.connected, true);
});

test('a failed connect whose close stalls still releases the connecting lock', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const fake = harness({ unsupported: true, closeGate: new Promise(() => {}) });
  const manager = createDeviceManager({ candidates: () => [fake.FakeTransport] });

  const first = manager.connect().then(
    () => null,
    (error) => error
  );
  await waitFor(() => fake.instances[0]?.closeCount === 1);
  t.mock.timers.tick(CONFIG.transport.closeTimeoutMs);
  const error = await first;
  assert.match(error.message, /did not answer any capability probe/);
  assert.equal(manager.state.status, 'error');

  // connect() no longer joins the dead attempt: a second call opens a link.
  const second = manager.connect().then(
    () => null,
    (failure) => failure
  );
  await waitFor(() => fake.instances.length === 2);
  await waitFor(() => fake.instances[1].closeCount === 1);
  t.mock.timers.tick(CONFIG.transport.closeTimeoutMs);
  await second;
});

test('print waits for a held discovery instead of interleaving probes', async () => {
  const gate = deferred();
  let gated = false;
  const fake = harness({
    override: (cmd) => (gated && cmd === 0xaf ? gate.promise : undefined),
    hold: (cmd) => gated && cmd === 0xaf,
  });
  const manager = createDeviceManager({ candidates: () => [fake.FakeTransport] });
  await manager.connect();

  gated = true;
  const refreshing = manager.refresh();
  await waitFor(() => frameCommands(fake.instances[0]).filter((cmd) => cmd === 0xaf).length === 2);

  const job = manager.print(raster, { lengthMm: 40 });
  await tick();
  await tick();
  const held = frameCommands(fake.instances[0]);
  // The stream is the discovery's: a job frame here means print stopped waiting.
  const jobOnly = [0x23, 0x21, 0x01, 0x13, 0xa3, 0xe3, 0x85];
  assert.deepEqual(held.filter((cmd) => jobOnly.includes(cmd)), [], 'no job frame while the discovery probe is held');
  assert.ok(!held.includes(0x85), 'no bitmap row while the probe is held');

  gate.resolve([{ cmd: 0xbf, data: [...CAPS] }]);
  await refreshing;
  await job;
  const commands = frameCommands(fake.instances[0]);
  const firstRow = commands.indexOf(0x85);
  assert.ok(firstRow > 0, 'the job ran after the discovery settled');

  // The held probe owns the stream: no discovery traffic may land between the
  // job's PrintStart and PageEnd, and the job cannot start before the probe was
  // released. Deleting `await discovery.promise` reorders all three.
  const firstJobFrame = commands.indexOf(0x23);
  assert.ok(firstJobFrame > held.length, 'the first job frame follows the last held probe');
  const start = commands.indexOf(0x01);
  const end = commands.indexOf(0xe3);
  assert.ok(start > 0 && end > start, 'the job has a PrintStart and a PageEnd');
  const probesInJob = commands.filter((cmd, index) => index > start && index < end && [0x40, 0xaf, 0xdc].includes(cmd));
  assert.deepEqual(probesInJob, [], 'no GetInfo, capability or heartbeat probe between PrintStart and PageEnd');
});

test('a second diagnostic read joins the one in flight and print is refused', async () => {
  const gate = deferred();
  const fake = harness({
    override: (cmd, data) => (cmd === 0x40 && data[0] === INFO_KEYS.speed ? gate.promise : undefined),
    hold: (cmd, data) => cmd === 0x40 && data[0] === INFO_KEYS.speed,
  });
  const manager = createDeviceManager({ candidates: () => [fake.FakeTransport] });
  await manager.connect();

  const read = manager.readInfoDiagnostics();
  assert.equal(manager.state.readingInfo, true, 'the lock is published synchronously');
  assert.equal(manager.readInfoDiagnostics(), read, 'the second read joins the first');
  await assert.rejects(manager.print(raster, { lengthMm: 40 }), /device info read is running/);
  assert.equal(frameCommands(fake.instances[0]).filter((cmd) => cmd === 0x01).length, 0, 'no paper moved');

  gate.resolve([{ cmd: 0x42, data: [3] }]);
  const entries = await read;
  assert.deepEqual(entries.map(({ key }) => key), [...DIAGNOSTIC_INFO_KEYS]);
  assert.equal(manager.state.readingInfo, false);

  // The link is free again: the same job now runs.
  await manager.print(raster, { lengthMm: 40 });
});

test('cancel settles a job stalled on a row write and clears the printing lock', async () => {
  const fake = harness();
  const manager = createDeviceManager({ candidates: () => [fake.FakeTransport] });
  await manager.connect();
  const instance = fake.instances[0];
  const stallingWrite = instance.write.bind(instance);
  let stalled = false;
  instance.write = (bytes) => {
    // A real row frame reaches a dead link and never settles.
    if (frameOf(bytes).cmd === 0x85) {
      stalled = true;
      return new Promise(() => {});
    }
    return stallingWrite(bytes);
  };

  const job = manager.print(raster, { lengthMm: 40 });
  await waitFor(() => stalled);
  assert.equal(manager.state.printing, true);
  const cancelling = manager.cancel();
  await assert.rejects(job, (error) => error.cancelled === true);
  assert.equal(await cancelling, true, 'a live job reported that it was cancelled');
  assert.equal(manager.state.printing, false, 'the caller and the lock both settled');
  assert.equal(manager.printing, false);
});

test('a deliberate disconnect logs info; an unexpected close warns', async (t) => {
  for (const level of ['log', 'info', 'warn', 'error']) t.mock.method(console, level, () => {});
  clearLog();
  const entries = [];
  const off = subscribeLog((entry) => entries.push(entry));
  try {
    const fake = harness();
    const manager = createDeviceManager({ candidates: () => [fake.FakeTransport] });
    await manager.connect();
    await manager.disconnect();
    const closed = entries.filter((entry) => entry.message === 'session closed');
    assert.equal(closed.at(-1)?.level, 'info', 'the operator asked for this close');
    assert.equal(entries.filter((entry) => entry.level === 'warn').length, 0, 'no fault was reported');

    await manager.connect();
    // The adapter disappears with no caller asking: that is a fault.
    fake.instances.at(-1).onCloseHandler(new Error('Adapter removed'));
    await waitFor(() => manager.state.status === 'idle');
    const dropped = entries.filter((entry) => entry.message === 'session closed');
    assert.equal(dropped.at(-1)?.level, 'warn');
  } finally {
    off();
  }
});

test('a failed job publishes finishing before its refresh and refuses cancel', async () => {
  const gate = deferred();
  let armed = false;
  const finishing = [];
  const fake = harness({
    override: (cmd) => {
      if (!armed) return undefined;
      if (cmd === 0x13) throw new Error('page size rejected');
      if (cmd === 0xa5) return gate.promise;
      return undefined;
    },
    hold: (cmd) => armed && cmd === 0xa5,
  });
  const manager = createDeviceManager({ candidates: () => [fake.FakeTransport] });
  manager.events.on('finishing', () => finishing.push(manager.state.printing));
  await manager.connect();
  armed = true;

  const job = manager.print(raster, { lengthMm: 40 }).catch((error) => error);
  await waitFor(() => frameCommands(fake.instances[0]).filter((cmd) => cmd === 0xa5).length === 2);

  assert.deepEqual(finishing, [true], 'the outcome is settled while the job lock is still held');
  assert.equal(await manager.cancel(), false, 'there is nothing left to abort');

  gate.resolve([{ cmd: 0xb5, data: [...STATUS] }]);
  const error = await job;
  assert.match(error.message, /page size rejected/);
  assert.equal(manager.state.printing, false);
});

/* ---------------- error ownership, cancel, open bound (R5F-1/R5A-1/R5A-6/R5F-9) ---------------- */

test('an unsolicited printer error on an idle link still reaches the main error channel', async () => {
  const fake = harness();
  const manager = createDeviceManager({ candidates: () => [fake.FakeTransport] });
  await manager.connect();
  const reported = [];
  manager.events.on('printer-error', (error) => reported.push(error.message));
  fake.instances[0].emit(0xdb, [0x02]);
  assert.deepEqual(reported, ['Out of paper']);
});

test('a printer error during the raster stops the rows and sends CancelPrint, not PrintEnd', async () => {
  let rowWrites = 0;
  const fake = harness({
    override: (cmd) => {
      if (cmd === 0x85 || cmd === 0x84) {
        rowWrites++;
        if (rowWrites === 1) {
          // A real printer error mid-raster: no request is outstanding, so the
          // session has no reply to reject and the job must own it.
          fake.instances[0].emit(0xdb, [0x02]);
          return null;
        }
      }
      return undefined;
    },
  });
  const manager = createDeviceManager({ candidates: () => [fake.FakeTransport] });
  await manager.connect();
  const reported = [];
  manager.events.on('printer-error', (error) => reported.push(error.message));

  const rows = Array.from({ length: 12 }, (_, index) => {
    const row = new Uint8Array(12);
    row[0] = 0x80 | index;
    return row;
  });
  await assert.rejects(manager.print({ width: 96, height: 12, rows }, { lengthMm: 40 }), /Out of paper/);

  const commands = frameCommands(fake.instances[0]);
  const sentRows = commands.filter((cmd) => cmd === 0x85 || cmd === 0x84).length;
  assert.ok(sentRows <= 2, `the raster stopped at the error (sent ${sentRows} row frames of 12)`);
  assert.ok(commands.includes(0xda), 'the started job sends CancelPrint');
  assert.equal(commands.includes(0xf3), false, 'never a success frame after the error');
  assert.deepEqual(reported, [], 'the job owns the error: no second report');
});

test('cancel after the terminal frame is committed is refused and the job still succeeds', async () => {
  const gate = deferred();
  const fake = harness({ override: (cmd) => (cmd === 0xf3 ? gate.promise : undefined) });
  const manager = createDeviceManager({ candidates: () => [fake.FakeTransport] });
  await manager.connect();
  const job = manager.print(raster, { lengthMm: 40 });
  await waitFor(() => frameCommands(fake.instances[0]).includes(0xf3));
  assert.equal(manager.state.printing, true);
  assert.equal(await manager.cancel(), false, 'the outcome is settled: nothing is left to cancel');
  gate.resolve([{ cmd: 0xf4, data: [1] }]);
  const result = await job;
  assert.equal(result.copies, 1, 'the committed job completes');
  assert.deepEqual(frameCommands(fake.instances[0]).filter((cmd) => cmd === 0xda), [], 'no terminal cancel frame');
});

test('finishing reports whether paper ever started', async () => {
  const fake = harness();
  const manager = createDeviceManager({ candidates: () => [fake.FakeTransport] });
  await manager.connect();
  const finished = [];
  manager.events.on('finishing', (info) => finished.push(info));
  await manager.print(raster, { lengthMm: 40 });
  // `committed` is true only once printEnd went on the wire: the disconnect
  // copy may then say the label was printed (V2).
  assert.deepEqual(finished, [{ started: true, committed: true }]);

  const lidOpen = ADVANCED.slice();
  lidOpen[4] = 1;
  const refusedFake = harness({ advanced: lidOpen });
  const refused = createDeviceManager({ candidates: () => [refusedFake.FakeTransport] });
  await refused.connect();
  const refusedFinished = [];
  refused.events.on('finishing', (info) => refusedFinished.push(info));
  await assert.rejects(refused.print(raster, { lengthMm: 40 }), /lid/i);
  assert.deepEqual(refusedFinished, [{ started: false, committed: false }], 'a refused job never started');
});

test('a transport open that never settles times out, is disposed, and frees the next attempt', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const instances = [];
  let stall = true;
  class StallTransport {
    kind = 'stall';
    static available() {
      return true;
    }
    static async granted() {
      return { id: instances.length };
    }
    static async request() {
      return null;
    }
    constructor() {
      this.closed = 0;
      instances.push(this);
    }
    onData() {}
    onClose() {}
    async open() {
      if (stall) return new Promise(() => {});
    }
    async write() {}
    async close() {
      this.closed++;
    }
    describe() {
      return 'Stalled transport';
    }
  }
  const manager = createDeviceManager({ candidates: () => [StallTransport] });
  const attempt = manager.connect().then(
    () => null,
    (error) => error
  );
  await tick();
  assert.equal(manager.state.status, 'connecting');
  t.mock.timers.tick(CONFIG.transport.openTimeoutMs);
  const error = await attempt;
  assert.equal(error?.name, 'PrinterError');
  assert.equal(error?.timeout, true);
  assert.match(error.message, /did not open within 15000 ms/);
  assert.equal(manager.state.status, 'error');
  assert.equal(instances[0].closed, 1, 'the half-open instance is disposed');

  // The failure left `connecting` clear: a later click starts a new attempt.
  stall = false;
  const second = manager.connect().then(
    () => null,
    (failure) => failure
  );
  await tick();
  assert.equal(instances.length, 2, 'a new attempt created a new transport');
  await manager.disconnect();
  await second;
});

test('disconnect during a pending open cancels the attempt, disposes it, and stays idle', async () => {
  const instances = [];
  class StallTransport {
    kind = 'stall';
    static available() {
      return true;
    }
    static async granted() {
      return { id: instances.length };
    }
    static async request() {
      return null;
    }
    constructor() {
      this.closed = 0;
      instances.push(this);
    }
    onData() {}
    onClose() {}
    async open() {
      return new Promise(() => {});
    }
    async write() {}
    async close() {
      this.closed++;
    }
    describe() {
      return 'Stalled transport';
    }
  }
  const manager = createDeviceManager({ candidates: () => [StallTransport] });
  const attempt = manager.connect().then(
    () => null,
    (error) => error
  );
  await tick();
  await tick();
  assert.equal(manager.state.status, 'connecting');
  assert.equal(await manager.cancel(), false, 'no job, no cancel');

  await manager.disconnect();
  const error = await attempt;
  assert.equal(error?.cancelled, true);
  assert.equal(manager.state.status, 'idle', 'the user asked for idle and gets idle');
  assert.equal(instances[0].closed, 1, 'the in-flight instance is disposed');

  // The dead attempt is not joined: a later connect() opens a fresh transport
  // instead of returning the settled promise.
  const again = manager.connect().then(
    () => null,
    (failure) => failure
  );
  await tick();
  assert.equal(instances.length, 2, 'a new open was attempted');
  await manager.disconnect();
  await again;
});

/* ---------------- sound state is what the reply says (R5F-3) ---------------- */

test('soundSettings returns the reply state and nothing for an absent one', async () => {
  const cases = [
    { label: 'on', data: [0, 1, 1], expected: true },
    { label: 'off', data: [0, 1, 0], expected: false },
    { label: 'a short reply', data: [0, 1], expected: null },
    { label: 'an unrecognised state byte', data: [0, 1, 2], expected: null },
  ];
  for (const { label, data, expected } of cases) {
    const fake = harness({ override: (cmd) => (cmd === 0x58 ? [{ cmd: 0x68, data }] : undefined) });
    const manager = createDeviceManager({ candidates: () => [fake.FakeTransport] });
    await manager.connect();
    assert.equal(await manager.soundSettings(1), expected, `${label}: read`);
    assert.equal(await manager.soundSettings(1, 0x01), expected, `${label}: write reply is the same authority`);
  }
});

test('an unsupported sound command is unknown, never off', async () => {
  const fake = harness({ override: (cmd) => (cmd === 0x58 ? [{ cmd: 0x00, data: [0x01] }] : undefined) });
  const manager = createDeviceManager({ candidates: () => [fake.FakeTransport] });
  await manager.connect();
  assert.equal(await manager.soundSettings(1), null);
  assert.equal(await manager.soundSettings(2, 0x00), null, 'a refused write is not a confirmed off');
});

/* ---------------- the dead attempt is never joined (O5) ---------------- */

test('a reconnect during a cancelled open starts a fresh attempt, not the dead one', async () => {
  const gate = deferred();
  const fake = harness({ openGate: gate });
  const manager = createDeviceManager({ candidates: () => [fake.FakeTransport] });

  const first = manager.connect().catch((error) => error);
  await tick();
  assert.equal(fake.instances.length, 1, 'the first attempt is opening');
  assert.equal(manager.state.status, 'connecting');

  const stopping = manager.disconnect();
  // Same tick: `connecting` still holds attempt 1 while the generation is
  // already dead. Joining it would make this click a silent no-op.
  const second = manager.connect().catch((error) => error);
  await tick();
  assert.equal(fake.instances.length, 2, 'a new open was attempted instead of joining the cancelled one');

  gate.resolve();
  assert.equal((await first)?.cancelled, true, 'the old attempt is the one that was cancelled');
  const secondResult = await second;
  assert.equal(secondResult?.cancelled, undefined, 'the fresh attempt is not the dead promise');
  await stopping;
  assert.equal(manager.state.status, 'connected');
});

/* ---------------- the support gate covers every mutating command (P1) ---------------- */

const GUESSED_CAPS = (() => {
  const bytes = [...CAPS];
  const index = bytes.findIndex((byte, at) => byte === 0x0a && bytes[at + 1] === 0x02 && bytes[at + 2] === 0x00 && bytes[at + 3] === 0x60);
  assert.ok(index >= 0, 'the head-width TLV is present in the captured capabilities');
  bytes[index + 2] = 0;
  bytes[index + 3] = 0;
  return bytes;
})();

function managerForModel(code, { advanced = ADVANCED, guessedHead = false } = {}) {
  const fake = harness({
    advanced,
    override: (cmd, data) => {
      if (cmd === 0x40 && data[0] === 0x08) return [{ cmd: 0x48, data: [code >> 8, code & 0xff] }];
      if (cmd === 0x59) return [{ cmd: 0x69, data: [0] }];
      if (cmd === 0x52) return [{ cmd: 0x62, data: [0] }];
      if (guessedHead && cmd === 0xdc && data[0] === 0x03) {
        const heartbeat = [...HEARTBEAT];
        heartbeat[4] = 0;
        heartbeat[5] = 0;
        return [{ cmd: 0xde, data: heartbeat }];
      }
      if (guessedHead && cmd === 0xaf) return [{ cmd: 0xbf, data: [...GUESSED_CAPS] }];
      return undefined;
    },
  });
  const manager = createDeviceManager({ candidates: () => [fake.FakeTransport] });
  return { fake, manager };
}

const MUTATING_COMMANDS = [
  ['self-test', (manager) => manager.testPage()],
  ['feed', (manager) => manager.calibrate()],
  ['reset', (manager) => manager.resetPrinter()],
  ['clock', (manager) => manager.syncClock()],
  ['density', (manager) => manager.pushSetting('print.density', 3)],
  ['tape', (manager) => manager.pushSetting('print.labelType', 1)],
  ['auto-off', (manager) => manager.setAutoShutdown(2)],
  ['sound write', (manager) => manager.soundSettings(1, 0x01)],
  ['cancel on idle', (manager) => manager.cancel()],
  ['print', (manager) => manager.print(raster, { lengthMm: 40 })],
];

test('every mutating command is gated before a frame: allowed models run, blocked models do not', async () => {
  const cases = [
    { label: 'D110_M', code: 0x0910, allowed: true },
    { label: 'D11_H', code: 0x0210, allowed: true },
    { label: 'B1', code: 0x1000, allowed: false, reason: /B1 is not supported[\s\S]*no frame was sent/ },
    { label: 'unknown', code: 0x1234, allowed: false, reason: /did not report a model[\s\S]*no frame was sent/i },
    { label: 'guessed head', code: 0x0910, guessedHead: true, allowed: false, reason: /did not report its head width[\s\S]*no frame was sent/ },
  ];
  for (const entry of cases) {
    const { fake, manager } = managerForModel(entry.code, { guessedHead: entry.guessedHead });
    const capabilities = await manager.connect();
    const instance = fake.instances[0];
    if (entry.guessedHead) {
      assert.equal(capabilities.source.geometry, 'default', 'a zero head is not reported geometry');
    }
    for (const [name, run] of MUTATING_COMMANDS) {
      const before = instance.writes.length;
      let error = null;
      try {
        await run(manager);
      } catch (caught) {
        error = caught;
      }
      const commands = frameCommands(instance).slice(before);
      const detail = `${entry.label} / ${name}: ${commands.map((cmd) => `0x${cmd.toString(16)}`).join(' ')}`;
      if (entry.allowed) {
        assert.equal(error, null, `${detail} is allowed`);
        assert.ok(commands.length > 0, `${detail} reaches the printer`);
      } else {
        assert.ok(error instanceof Error, `${detail} is refused`);
        assert.match(error.message, entry.reason, detail);
        assert.equal(commands.length, 0, `${detail} writes zero frames`);
      }
    }
  }
});

test('a feed refusal says nothing was fed, and sends no frame', async () => {
  const lidOpen = Uint8Array.from([...ADVANCED.slice(0, 4), 1, 0, ...ADVANCED.slice(6)]);
  const fake = harness({ advanced: lidOpen });
  const manager = createDeviceManager({ candidates: () => [fake.FakeTransport] });
  await manager.connect();
  const instance = fake.instances[0];
  const before = instance.writes.length;

  await assert.rejects(manager.calibrate(), /Close the printer lid before feeding; nothing was fed\./);
  assert.equal(instance.writes.length, before, 'the gate refuses before the feed frame');
  // The self-test is a print; its refusal keeps the printed wording.
  await assert.rejects(manager.testPage(), /Close the printer lid before printing; nothing was printed\./);
  assert.equal(instance.writes.length, before, 'the gate refuses before the self-test frame');
});

test('a model or geometry refused print sends zero frames and runs no discovery', async () => {
  for (const entry of [
    { label: 'B1', code: 0x1000, reason: /B1 is not supported/ },
    { label: 'unknown', code: 0x1234, reason: /did not report a model/i },
    { label: 'guessed head', code: 0x0910, guessedHead: true, reason: /did not report its head width/ },
  ]) {
    const { fake, manager } = managerForModel(entry.code, { guessedHead: entry.guessedHead });
    await manager.connect();
    const instance = fake.instances[0];
    const before = instance.writes.length;
    await assert.rejects(manager.print(raster, { lengthMm: 40 }), entry.reason);
    const frames = instance.writes.slice(before).map(frameOf);
    assert.deepEqual(frames, [], `${entry.label}: a refused print writes nothing, not even a heartbeat or discovery probe`);
  }
});

test('a sensor refusal sends only the job heartbeat, then stops without discovery', async () => {
  const cases = [
    {
      label: 'lid open',
      advanced: Uint8Array.from([...ADVANCED.slice(0, 4), 1, 0, ...ADVANCED.slice(6)]),
      reason: /lid[\s\S]*nothing was printed/i,
    },
    {
      label: 'no paper',
      advanced: Uint8Array.from([...ADVANCED.slice(0, 5), 1, ...ADVANCED.slice(6)]),
      reason: /label roll[\s\S]*nothing was printed/i,
    },
    {
      label: 'critical battery',
      advanced: Uint8Array.from([ADVANCED[0], ADVANCED[1], 0, ...ADVANCED.slice(3)]),
      reason: /Battery is too low[\s\S]*nothing was printed/i,
    },
  ];
  for (const entry of cases) {
    const fake = harness({ advanced: entry.advanced });
    const manager = createDeviceManager({ candidates: () => [fake.FakeTransport] });
    await manager.connect();
    const instance = fake.instances[0];
    const before = instance.writes.length;
    let error = null;
    try {
      await manager.print(raster, { lengthMm: 40 });
    } catch (caught) {
      error = caught;
    }
    assert.ok(error instanceof Error, entry.label);
    assert.match(error.message, entry.reason, entry.label);
    assert.doesNotMatch(error.message, /nothing was sent/, `${entry.label}: a sensor refusal never claims nothing was sent`);
    const frames = instance.writes.slice(before).map(frameOf);
    assert.equal(frames.length, 1, `${entry.label}: at most the heartbeat is read`);
    assert.equal(frames[0].cmd, 0xdc, `${entry.label}: the one frame is the heartbeat query`);
    assert.equal(frames[0].data[0], 0x04, `${entry.label}: it is the advanced heartbeat`);
    const commands = frames.map(({ cmd }) => cmd);
    for (const forbidden of [0x01, 0x21, 0x23, 0xe3, 0xf3, 0xda, 0xa5, 0xaf, 0x40, 0x1a]) {
      assert.equal(commands.includes(forbidden), false, `${entry.label}: no 0x${forbidden.toString(16)} after the refusal`);
    }
  }
});

test('reads stay allowed on an unsupported model', async () => {
  const { fake, manager } = managerForModel(0x1000);
  await manager.connect();
  const instance = fake.instances[0];
  const before = instance.writes.length;
  await manager.diagnostic('paperInfo');
  await manager.diagnostic('printHistory');
  assert.equal(await manager.soundSettings(1), true, 'reading the sound switch is a read');
  await manager.readInfoDiagnostics();
  await manager.refresh();
  assert.ok(instance.writes.length > before, 'the reads reached the printer');
  assert.ok(frameCommands(instance).slice(before).includes(0x59), 'paper info was read');
});
