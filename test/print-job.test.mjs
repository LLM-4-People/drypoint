import test from 'node:test';
import assert from 'node:assert/strict';

import { encodeRows, runPrintJob } from '../src/device/print-job.js';
import { decodePrintStatus } from '../src/protocol/replies.js';
import { PrinterError } from '../src/protocol/errors.js';
import { clearLog, subscribeLog } from '../src/core/log.js';

const blank = () => new Uint8Array(12);
const black = () => new Uint8Array(12).fill(0xff);

test('blank rows collapse into one empty-row frame', () => {
  const frames = encodeRows([blank(), blank(), blank()], 96);
  assert.equal(frames.length, 1);
  assert.equal(frames[0][2], 0x84);
  assert.deepEqual([...frames[0].slice(4, 7)], [0x00, 0x00, 0x03]);
});

test('identical rows collapse with a repeat count and popcounts', () => {
  const frames = encodeRows([black(), black(), black()], 96);
  assert.equal(frames.length, 1);
  assert.equal(frames[0][2], 0x85);
  const data = [...frames[0].slice(4, 4 + 18)];
  assert.deepEqual(data.slice(0, 6), [0x00, 0x00, 32, 32, 32, 3]);
});

test('row indices continue after a repeated run', () => {
  const frames = encodeRows([black(), black(), blank(), black()], 96);
  assert.equal(frames.length, 3);
  assert.deepEqual([...frames[1].slice(4, 7)], [0x00, 0x02, 0x01]);
  assert.deepEqual([...frames[2].slice(4, 6)], [0x00, 0x03]);
});

test('runs split at the 255 blank and 200 repeat limits', () => {
  const blanks = Array.from({ length: 300 }, blank);
  const blankFrames = encodeRows(blanks, 96);
  assert.deepEqual(blankFrames.map((frame) => frame[6]), [255, 45]);

  const rows = Array.from({ length: 250 }, black);
  const rowFrames = encodeRows(rows, 96);
  assert.deepEqual(rowFrames.map((frame) => frame[9]), [200, 50]);
});

test('a single black pixel is packed MSB-first', () => {
  const row = blank();
  row[0] = 0x80;
  const frames = encodeRows([row], 96);
  assert.deepEqual([...frames[0].slice(4, 10)], [0x00, 0x00, 1, 0, 0, 1]);
  assert.equal(frames[0][10], 0x80);
});

function fakeClient({ pages = 1 } = {}) {
  const calls = [];
  return {
    calls,
    session: {
      async write(bytes) {
        calls.push(['write', bytes[2]]);
      },
    },
    async tryRequest(name) {
      calls.push(['try', name]);
      return new Uint8Array(0);
    },
    async tryQuery(name) {
      calls.push(['try', name]);
      return null;
    },
    async request(name, params = {}) {
      calls.push(['request', name, params]);
      if (name === 'printStatus') return Uint8Array.from([0x00, pages, 0x64, 0x64, 0, 0, 0, 1]);
      return new Uint8Array([0x01]);
    },
    async send(name) {
      calls.push(['send', name]);
    },
  };
}

const raster = { width: 96, height: 3, rows: [black(), black(), blank()] };

test('print job follows the D110M V4 sequence in order', async () => {
  const client = fakeClient();
  await runPrintJob(client, { raster, copies: 1, speed: 1, density: 3, labelType: 1 });
  const names = client.calls.filter((call) => call[0] !== 'write').map((call) => call[1]);
  assert.deepEqual(names, [
    'try:heartbeatAdvanced',
    'setLabelType',
    'setDensity',
    'printStart',
    'try:printStatus',
    'pageSize',
    'pageEnd',
    'printStatus',
    'printEnd',
  ].map((entry) => (entry.startsWith('try:') ? entry.slice(4) : entry)));
  const writes = client.calls.filter((call) => call[0] === 'write').map((call) => call[1]);
  assert.deepEqual(writes, [0x85, 0x84]);
});

test('print job passes copies and geometry to the printer', async () => {
  const client = fakeClient({ pages: 2 });
  await runPrintJob(client, { raster, copies: 2, speed: 0, density: 4, labelType: 5 });
  const pageSize = client.calls.find((call) => call[1] === 'pageSize');
  assert.deepEqual(pageSize[2], { rows: 3, cols: 96, copies: 2 });
  const start = client.calls.find((call) => call[1] === 'printStart');
  assert.deepEqual(start[2], { pages: 2, speed: 0 });
  const density = client.calls.find((call) => call[1] === 'setDensity');
  assert.deepEqual(density[2], { value: 4 });
  const labelType = client.calls.find((call) => call[1] === 'setLabelType');
  assert.deepEqual(labelType[2], { value: 5 });
});

test('the gate receives the job’s own heartbeat sample before any paper moves', async () => {
  const client = fakeClient();
  const sample = { lidClosed: true, paperPresent: true, batteryPercent: 80 };
  client.tryQuery = async (name) => {
    client.calls.push(['try', name]);
    return sample;
  };
  const samples = [];
  await runPrintJob(client, { raster, copies: 1, speed: 1, density: 3, labelType: 1, gate: (value) => samples.push(value) });
  assert.deepEqual(samples, [sample]);
  const firstPaperFrame = client.calls.findIndex((call) => call[0] === 'request' && call[1] === 'printStart');
  const gateSample = client.calls.findIndex((call) => call[0] === 'try');
  assert.ok(gateSample < firstPaperFrame, 'the sample is taken before PrintStart');
});

test('a gate that refuses stops the job before PrintStart', async () => {
  const client = fakeClient();
  const refusal = new Error('lid open');
  await assert.rejects(
    runPrintJob(client, { raster, copies: 1, speed: 1, density: 3, labelType: 1, gate: () => { throw refusal; } }),
    /lid open/
  );
  assert.equal(client.calls.filter((call) => call[1] === 'printStart').length, 0);
  assert.equal(client.calls.filter((call) => call[0] === 'send').length, 0, 'nothing started, nothing to cancel');
});

test('print job aborts when the signal fires before it starts', async () => {
  const client = fakeClient();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    runPrintJob(client, { raster, copies: 1, speed: 1, density: 3, labelType: 1, signal: controller.signal }),
    (error) => error.cancelled === true
  );
  assert.equal(client.calls.filter((call) => call[0] === 'send').length, 0, 'nothing started, nothing to cancel');
});

test('a user cancel logs at info; a real failure stays at error', async (t) => {
  for (const level of ['log', 'info', 'warn', 'error']) t.mock.method(console, level, () => {});
  clearLog();
  const entries = [];
  const off = subscribeLog((entry) => entries.push(entry));
  try {
    const cancelledClient = fakeClient();
    const controller = new AbortController();
    const original = cancelledClient.request;
    cancelledClient.request = async (name, params, options) => {
      const result = await original(name, params, options);
      if (name === 'printStart') controller.abort();
      return result;
    };
    await assert.rejects(
      runPrintJob(cancelledClient, { raster, copies: 1, speed: 1, density: 3, labelType: 1, signal: controller.signal }),
      (error) => error.cancelled === true
    );
    const cancelled = entries.find((entry) => entry.message === 'job cancelled');
    assert.equal(cancelled?.level, 'info', 'an operator cancel is a normal outcome');
    assert.equal(entries.some((entry) => entry.message === 'job failed'), false);

    const failingClient = fakeClient();
    const baseRequest = failingClient.request;
    failingClient.request = async (name, params, options) => {
      if (name === 'setDensity') throw new Error('density rejected');
      return baseRequest(name, params, options);
    };
    await assert.rejects(
      runPrintJob(failingClient, { raster, copies: 1, speed: 1, density: 3, labelType: 1 }),
      /density rejected/
    );
    const failed = entries.find((entry) => entry.message === 'job failed');
    assert.equal(failed?.level, 'error');
  } finally {
    off();
  }
});

test('a completed job sends exactly one printEnd terminal frame', async () => {
  const client = fakeClient();
  await runPrintJob(client, { raster, copies: 1, speed: 1, density: 3, labelType: 1 });
  assert.equal(client.calls.filter((call) => call[1] === 'printEnd').length, 1);
  assert.equal(client.calls.filter((call) => call[0] === 'send').length, 0);
});

test('cancelling after the job started sends cancelPrint only, never printEnd', async () => {
  const client = fakeClient();
  const controller = new AbortController();
  const original = client.request;
  client.request = async (name, params, options) => {
    const result = await original(name, params, options);
    if (name === 'printStart') controller.abort();
    return result;
  };
  await assert.rejects(
    runPrintJob(client, { raster, copies: 1, speed: 1, density: 3, labelType: 1, signal: controller.signal }),
    (error) => error.cancelled === true
  );
  assert.deepEqual(client.calls.filter((call) => call[0] === 'send').map((call) => call[1]), ['cancelPrint']);
  assert.equal(client.calls.filter((call) => call[1] === 'printEnd').length, 0);
});

test('a failure after the job started sends cancelPrint instead of a success frame', async () => {
  const client = fakeClient();
  const original = client.request;
  client.request = async (name, params, options) => {
    if (name === 'pageSize') throw new Error('page size rejected');
    return original(name, params, options);
  };
  await assert.rejects(runPrintJob(client, { raster, copies: 1, speed: 1, density: 3, labelType: 1 }), /page size rejected/);
  assert.deepEqual(client.calls.filter((call) => call[0] === 'send').map((call) => call[1]), ['cancelPrint']);
  assert.equal(client.calls.filter((call) => call[1] === 'printEnd').length, 0);
});

test('the caller signal reaches the job exchanges', async () => {
  const client = fakeClient();
  const controller = new AbortController();
  const signals = [];
  const original = client.request;
  client.request = async (name, params, options) => {
    signals.push(options?.signal);
    return original(name, params, options);
  };
  await runPrintJob(client, { raster, copies: 1, speed: 1, density: 3, labelType: 1, signal: controller.signal });
  assert.ok(signals.includes(controller.signal));
});

test('the job signal cancels a stalled row write instead of pinning the caller', async () => {
  const client = fakeClient();
  let stalled = false;
  // The fake link honours the signal exactly like Session#write: if the row
  // loop forgets to pass it, nothing can settle this write.
  client.session.write = (bytes, { signal } = {}) =>
    new Promise((_, reject) => {
      stalled = true;
      signal?.addEventListener(
        'abort',
        () => reject(Object.assign(new Error('Print cancelled'), { cancelled: true, fatal: true })),
        { once: true }
      );
    });
  const controller = new AbortController();
  const job = runPrintJob(client, { raster, copies: 1, speed: 1, density: 3, labelType: 1, signal: controller.signal });
  for (let attempt = 0; attempt < 100 && !stalled; attempt++) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stalled, true, 'the row frame reached the stalled link');
  controller.abort();
  let guardTimer;
  const guard = new Promise((_, reject) => {
    guardTimer = setTimeout(() => reject(new Error('the stalled row write was never aborted')), 2000);
  });
  await assert.rejects(Promise.race([job, guard]), (error) => error.cancelled === true);
  clearTimeout(guardTimer);
});

test('print job fails when the printer never confirms', async () => {
  const client = fakeClient({ pages: 0 });
  const original = client.request;
  client.request = async (name, params) => {
    if (name === 'printStatus') return Uint8Array.from([0x00, 0x00, 0x64, 0x64, 0, 0, 0, 1]);
    return original(name, params);
  };
  await assert.rejects(
    runPrintJob(client, { raster, copies: 1, speed: 1, density: 3, labelType: 1, completionTimeoutMs: 80 }),
    /did not confirm/
  );
});

test('empty rasters are rejected before touching the wire', async () => {
  const client = fakeClient();
  await assert.rejects(runPrintJob(client, { raster: { width: 96, height: 0, rows: [] }, copies: 1 }), /Nothing to print/);
  assert.equal(client.calls.length, 0);
});

test('print status decoder tolerates short payloads', () => {
  assert.equal(decodePrintStatus(new Uint8Array([0x00])).pagesPrinted, 0);
  assert.equal(decodePrintStatus(new Uint8Array(0)).pagesPrinted, 0);
});

/* ---------------- watchdog, ownership, terminal commit (R5A-2/R5A-6/R5F-9) ---------------- */

test('the completion watchdog is per page: a progressing multi-copy job is not cancelled', async () => {
  const copies = 4;
  const perPageMs = 60;
  const startedAt = Date.now();
  const client = fakeClient();
  client.request = async (name, params = {}) => {
    client.calls.push(['request', name, params]);
    if (name === 'printStatus') {
      const printed = Math.min(copies, Math.floor((Date.now() - startedAt) / perPageMs));
      return Uint8Array.from([0x00, printed, 0x64, 0x64, 0, 0, 0, 1]);
    }
    return new Uint8Array([0x01]);
  };
  await runPrintJob(client, { raster, copies, speed: 1, density: 3, labelType: 1, completionTimeoutMs: 150 });
  assert.equal(client.calls.filter((call) => call[1] === 'printEnd').length, 1);
  assert.deepEqual(client.calls.filter((call) => call[0] === 'send'), [], 'a progressing job is never cancelled');
});

test('a job that stops advancing fails with the no-new-page message', async () => {
  const client = fakeClient({ pages: 0 });
  await assert.rejects(
    runPrintJob(client, { raster, copies: 3, speed: 1, density: 3, labelType: 1, completionTimeoutMs: 80 }),
    /no new page for 80 ms \(0\/3 labels\)/
  );
  assert.deepEqual(client.calls.filter((call) => call[0] === 'send').map((call) => call[1]), ['cancelPrint']);
});

test('a printer error carried by the signal stops the job with that error, not a cancel', async () => {
  const client = fakeClient();
  const controller = new AbortController();
  const printerError = new PrinterError('Out of paper', { code: 0x02 });
  const original = client.request;
  client.request = async (name, params, options) => {
    if (name === 'printStart') controller.abort(printerError);
    return original(name, params, options);
  };
  await assert.rejects(
    runPrintJob(client, { raster, copies: 1, speed: 1, density: 3, labelType: 1, signal: controller.signal }),
    (error) => error === printerError
  );
  assert.deepEqual(client.calls.filter((call) => call[0] === 'send').map((call) => call[1]), ['cancelPrint']);
  assert.equal(client.calls.filter((call) => call[1] === 'printEnd').length, 0);
});

test('onStart runs immediately before PrintStart and never for a refused gate', async () => {
  const client = fakeClient();
  const order = [];
  const original = client.request;
  client.request = async (name, params, options) => {
    order.push(name);
    return original(name, params, options);
  };
  await runPrintJob(client, {
    raster, copies: 1, speed: 1, density: 3, labelType: 1,
    onStart: () => order.push('onStart'),
  });
  const at = order.indexOf('onStart');
  assert.equal(at, order.indexOf('printStart') - 1, 'onStart is the step just before PrintStart');

  const refused = fakeClient();
  const started = [];
  await assert.rejects(
    runPrintJob(refused, {
      raster, copies: 1, speed: 1, density: 3, labelType: 1,
      gate: () => { throw new Error('lid open'); },
      onStart: () => started.push(true),
    }),
    /lid open/
  );
  assert.deepEqual(started, [], 'a gate refusal never reports a started job');
});

test('the terminal commit is published before PrintEnd is acknowledged', async () => {
  const client = fakeClient();
  let release;
  const ack = new Promise((resolve) => {
    release = resolve;
  });
  const order = [];
  const original = client.request;
  client.request = async (name, params, options) => {
    if (name === 'printEnd') {
      order.push('printEnd:issued');
      await ack;
      order.push('printEnd:ack');
      return new Uint8Array([0x01]);
    }
    return original(name, params, options);
  };
  const job = runPrintJob(client, {
    raster, copies: 1, speed: 1, density: 3, labelType: 1,
    onTerminalCommit: () => order.push('commit'),
  });
  for (let attempt = 0; attempt < 100 && !order.includes('printEnd:issued'); attempt++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.deepEqual(order, ['commit', 'printEnd:issued'], 'the outcome is settled before the ack is awaited');
  release();
  await job;
  assert.deepEqual(order, ['commit', 'printEnd:issued', 'printEnd:ack']);
});

/* ---------------- a refusal sends no frames at all (O6) ---------------- */

test('a gate refusal sends zero PrintStart, CancelPrint, PrintEnd or row frames', async () => {
  const client = fakeClient();
  await assert.rejects(
    runPrintJob(client, {
      raster,
      copies: 1,
      speed: 1,
      density: 3,
      labelType: 1,
      gate: () => {
        throw new Error('lid open');
      },
    }),
    /lid open/
  );

  const requests = client.calls.filter((call) => call[0] === 'request').map((call) => call[1]);
  assert.deepEqual(
    requests.filter((name) => ['printStart', 'pageEnd', 'printEnd'].includes(name)),
    [],
    'no 0x01, 0xE3 or 0xF3 frame'
  );
  assert.deepEqual(client.calls.filter((call) => call[0] === 'send'), [], 'no 0xDA CancelPrint');
  assert.deepEqual(client.calls.filter((call) => call[0] === 'write'), [], 'no bitmap row');
});
