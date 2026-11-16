import test from 'node:test';
import assert from 'node:assert/strict';

import { Session } from '../src/protocol/session.js';
import { encodeFrame } from '../src/protocol/frames.js';
import { PrinterError } from '../src/protocol/errors.js';
import { CONFIG } from '../src/core/config.js';
import { clearLog, subscribeLog } from '../src/core/log.js';

const tick = () => new Promise((resolve) => setImmediate(resolve));

/** Fail instead of hanging when a promise the fix should settle never does. */
function within(promise, ms, label) {
  let timer;
  const guard = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} never settled`)), ms);
  });
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}

function fakeLink() {
  let dataHandler = () => {};
  let closeHandler = () => {};
  const link = {
    writes: [],
    failWrite: null,
    async write(bytes) {
      if (link.failWrite) throw link.failWrite;
      link.writes.push(bytes);
    },
    onData(handler) {
      dataHandler = handler;
    },
    onClose(handler) {
      closeHandler = handler;
    },
    feed(bytes) {
      dataHandler(bytes);
    },
    drop(error) {
      closeHandler(error);
    },
  };
  return link;
}

const reply = (cmd, data = []) => encodeFrame(cmd, data);

test('a request resolves with its reply payload', async () => {
  const link = fakeLink();
  const session = new Session(link);
  const pending = session.exchange(encodeFrame(0x40, [0x08]), 0x48, 500);
  link.feed(reply(0x48, [0x09, 0x10]));
  const frame = await pending;
  assert.deepEqual([...frame.data], [0x09, 0x10]);
  assert.equal(link.writes.length, 1);
});

test('a missing reply rejects after the timeout', async () => {
  const link = fakeLink();
  const session = new Session(link);
  await assert.rejects(session.exchange(encodeFrame(0x40, [0x08]), 0x48, 40), /No reply to 0x40/);
});

test('an unsupported command rejects immediately with the unsupported flag', async () => {
  const link = fakeLink();
  const session = new Session(link);
  const pending = session.exchange(encodeFrame(0x40, [0x02]), 0x42, 5000);
  link.feed(reply(0x00, [0x01]));
  await assert.rejects(pending, (error) => {
    assert.equal(error.unsupported, true);
    assert.match(error.message, /not supported/i);
    return true;
  });
});

test('a printer error settles the pending request without a second report', async () => {
  const link = fakeLink();
  const session = new Session(link);
  const errors = [];
  session.events.on('error', (error) => errors.push(error.message));
  const pending = session.exchange(encodeFrame(0x01, [0x01]), 0x02, 5000);
  link.feed(reply(0xdb, [0x02]));
  await assert.rejects(pending, /Out of paper/);
  // The caller of the failed exchange owns the single report: emitting here as
  // well produced two error toasts and two log entries for one rejection.
  assert.deepEqual(errors, [], 'the pending request consumed the error');
});

test('a printer error that owns a request is logged once, not twice', async () => {
  const link = fakeLink();
  const session = new Session(link);
  clearLog();
  const logs = [];
  const off = subscribeLog((entry) => logs.push(entry));
  const pending = session.exchange(encodeFrame(0x01, [0x01]), 0x02, 5000);
  link.feed(reply(0xdb, [0x02]));
  await assert.rejects(pending, /Out of paper/);
  off();
  const reported = logs.filter((entry) => entry.scope === 'session' && /printer reported an error/.test(entry.message));
  assert.equal(reported.length, 1, 'one rejection, one log entry');
});

test('a write failure rejects its own request', async () => {
  const link = fakeLink();
  link.failWrite = new Error('port gone');
  const session = new Session(link);
  await assert.rejects(session.exchange(encodeFrame(0x01, [0x01]), 0x02, 5000), /port gone/);
});

test('closing the link rejects every pending request and emits closed', async () => {
  const link = fakeLink();
  const session = new Session(link);
  const closed = [];
  session.events.on('closed', (error) => closed.push(error.message));
  const pending = session.exchange(encodeFrame(0x40, [0x08]), 0x48, 5000);
  link.drop(new Error('adapter removed'));
  await assert.rejects(pending, /Connection lost: adapter removed/);
  assert.equal(closed.length, 1);
  assert.equal(session.closed, true);
});

test('writing after close throws a fatal error', async () => {
  const link = fakeLink();
  const session = new Session(link);
  session.close();
  await assert.rejects(session.write(encodeFrame(0x01, [0x01])), /closed/);
});

test('unsolicited frames are surfaced as events, not matched to requests', async () => {
  const link = fakeLink();
  const session = new Session(link);
  const seen = [];
  session.events.on('frame', (frame) => seen.push(frame.cmd));
  const pending = session.exchange(encodeFrame(0x01, [0x01]), 0x02, 500);
  link.feed(reply(0xd3, [0x00, 0x05, 0x01]));
  link.feed(reply(0x02, [0x01]));
  await pending;
  assert.deepEqual(seen, [0xd3]);
});

test('exchanges are serialised so only one request is outstanding', async () => {
  const link = fakeLink();
  const session = new Session(link);
  const first = session.exchange(encodeFrame(0x40, [0x08]), 0x48, 500);
  const second = session.exchange(encodeFrame(0x40, [0x09]), 0x49, 500);
  assert.equal(link.writes.length, 1, 'the second request must wait');
  link.feed(reply(0x48, [0x01]));
  await first;
  await tick();
  assert.equal(link.writes.length, 2);
  link.feed(reply(0x49, [0x02]));
  const frame = await second;
  assert.deepEqual([...frame.data], [0x02]);
});

test('0x00 rejects the outstanding request and the queue continues', async () => {
  const link = fakeLink();
  const session = new Session(link);
  const first = session.exchange(encodeFrame(0x40, [0x08]), 0x48, 500);
  const second = session.exchange(encodeFrame(0x40, [0x09]), 0x49, 500);
  link.feed(reply(0x00, [0x01]));
  await assert.rejects(first, (error) => error.unsupported === true);
  await tick();
  assert.equal(link.writes.length, 2);
  link.feed(reply(0x49, [0x05]));
  assert.deepEqual([...(await second).data], [0x05]);
});

test('a late 0x00 with nothing pending is logged, not dropped silently', () => {
  const link = fakeLink();
  const session = new Session(link);
  clearLog();
  const logs = [];
  const off = subscribeLog((entry) => logs.push(entry));
  link.feed(reply(0x00, [0x01]));
  off();
  assert.ok(logs.some((entry) => entry.scope === 'session' && /unsolicited 0x00/.test(entry.message)));
});

test('a printer error with nothing pending still emits and logs', () => {
  const link = fakeLink();
  const session = new Session(link);
  const codes = [];
  session.events.on('error', (error) => codes.push(error.code));
  clearLog();
  const logs = [];
  const off = subscribeLog((entry) => logs.push(entry));
  link.feed(reply(0xdb, [0x02]));
  off();
  assert.deepEqual(codes, [0x02]);
  assert.ok(logs.some((entry) => /no pending request/.test(entry.message)));
});

test('aborting an exchange rejects it as cancelled and keeps the session usable', async () => {
  const link = fakeLink();
  const session = new Session(link);
  const controller = new AbortController();
  const pending = session.exchange(encodeFrame(0x40, [0x08]), 0x48, { timeoutMs: 5000, signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, (error) => error.cancelled === true && error.fatal === true);
  assert.equal(session.closed, false);
  const next = session.exchange(encodeFrame(0x40, [0x08]), 0x48, 500);
  link.feed(reply(0x48, [0x07]));
  assert.deepEqual([...(await next).data], [0x07]);
});

test('aborting a queued exchange prevents its write', async () => {
  const link = fakeLink();
  const session = new Session(link);
  const first = session.exchange(encodeFrame(0x40, [0x08]), 0x48, 500);
  const controller = new AbortController();
  const second = session.exchange(encodeFrame(0x40, [0x09]), 0x49, { timeoutMs: 500, signal: controller.signal });
  controller.abort();
  link.feed(reply(0x48, [0x01]));
  await first;
  await assert.rejects(second, (error) => error.cancelled === true);
  assert.equal(link.writes.length, 1, 'the aborted request never reached the link');
});

test('timeouts carry a timeout flag so optional probes can be swallowed', async () => {
  const link = fakeLink();
  const session = new Session(link);
  await assert.rejects(session.exchange(encodeFrame(0x40, [0x08]), 0x48, 20), (error) => error.timeout === true);
});

test('a write that never settles times out and leaves the session usable', async () => {
  const link = fakeLink();
  let hang = true;
  link.write = async (bytes) => {
    if (hang) return new Promise(() => {});
    link.writes.push(bytes);
  };
  const session = new Session(link);
  const stuck = session.exchange(encodeFrame(0x40, [0x08]), 0x48, 20);
  await assert.rejects(within(stuck, 500, 'the stuck exchange'), (error) => error.timeout === true);
  hang = false;
  const next = session.exchange(encodeFrame(0x40, [0x09]), 0x49, 500);
  await tick();
  assert.equal(link.writes.length, 1, 'the tail was released for the next request');
  link.feed(reply(0x49, [0x05]));
  assert.deepEqual([...(await within(next, 500, 'the next exchange')).data], [0x05]);
});

test('a late 0x00 for a timed-out request does not reject the next one', async () => {
  const link = fakeLink();
  const session = new Session(link);
  const first = session.exchange(encodeFrame(0x40, [0x08]), 0x48, 20);
  await assert.rejects(first, (error) => error.timeout === true);
  const second = session.exchange(encodeFrame(0x40, [0x09]), 0x49, 500);
  await tick();
  link.feed(reply(0x00, [0x01]));
  // The late negative belonged to the timed-out request: the second survives.
  link.feed(reply(0x49, [0x05]));
  assert.deepEqual([...(await within(second, 500, 'the second request')).data], [0x05]);
});

test('only one late 0x00 is consumed; the next one rejects the current request', async () => {
  const link = fakeLink();
  const session = new Session(link);
  await assert.rejects(session.exchange(encodeFrame(0x40, [0x08]), 0x48, 20), (error) => error.timeout === true);
  const second = session.exchange(encodeFrame(0x40, [0x09]), 0x49, 500);
  await tick();
  link.feed(reply(0x00, [0x01]));
  link.feed(reply(0x00, [0x01]));
  await assert.rejects(within(second, 500, 'the second request'), (error) => error.unsupported === true);
});

test('a late negative is logged as a timed-out answer, not as unsolicited noise', async () => {
  const link = fakeLink();
  const session = new Session(link);
  await assert.rejects(session.exchange(encodeFrame(0x40, [0x08]), 0x48, 20), (error) => error.timeout === true);
  clearLog();
  const logs = [];
  const off = subscribeLog((entry) => logs.push(entry));
  link.feed(reply(0x00, [0x01]));
  off();
  assert.ok(logs.some((entry) => /late 0x00/.test(entry.message)), 'the late answer is attributed');
  assert.ok(!logs.some((entry) => /unsolicited 0x00/.test(entry.message)));
});

test('a 0xDB after a timeout still rejects the current request', async () => {
  const link = fakeLink();
  const session = new Session(link);
  const errors = [];
  session.events.on('error', (error) => errors.push(error.message));
  await assert.rejects(session.exchange(encodeFrame(0x01, [0x01]), 0x02, 20), (error) => error.timeout === true);
  const second = session.exchange(encodeFrame(0x40, [0x09]), 0x49, 500);
  await tick();
  link.feed(reply(0xdb, [0x02]));
  await assert.rejects(within(second, 500, 'the second request'), /Out of paper/);
  assert.deepEqual(errors, [], 'the current request owns the error; it is not emitted as well');
});

test('a successful reply retires older unanswered requests', async () => {
  const link = fakeLink();
  const session = new Session(link);
  await assert.rejects(session.exchange(encodeFrame(0x40, [0x08]), 0x48, 20), (error) => error.timeout === true);
  const second = session.exchange(encodeFrame(0x40, [0x09]), 0x49, 500);
  await tick();
  link.feed(reply(0x49, [0x05]));
  await within(second, 500, 'the second request');
  // The printer has answered a later request, so no older answer is pending:
  // a 0x00 now belongs to the current request.
  const third = session.exchange(encodeFrame(0x40, [0x0a]), 0x4a, 500);
  await tick();
  link.feed(reply(0x00, [0x01]));
  await assert.rejects(within(third, 500, 'the third request'), (error) => error.unsupported === true);
});

test('close is idempotent and emits closed once', () => {
  const link = fakeLink();
  const session = new Session(link);
  const closed = [];
  session.events.on('closed', (error) => closed.push(error.message));
  session.close();
  session.close();
  link.drop(new Error('late adapter removal'));
  assert.equal(closed.length, 1);
});

test('a stalled direct write is bounded, fatal, and leaves the session unusable', async (t) => {
  // The guard uses the real timer pair: a mocked one could never rescue a hang.
  const realTimeout = setTimeout;
  const realClearTimeout = clearTimeout;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const link = fakeLink();
  link.write = () => new Promise(() => {});
  const session = new Session(link);
  const outcome = session.write(encodeFrame(0x01, [0x01])).then(
    () => null,
    (error) => error
  );
  await tick();
  assert.equal(link.writes.length, 0, 'nothing reached the link yet');
  t.mock.timers.tick(CONFIG.protocol.timeouts.write);
  let guardTimer;
  const guard = new Promise((_, reject) => {
    guardTimer = realTimeout(() => reject(new Error('the stalled write never settled')), 2000);
  });
  const error = await Promise.race([outcome, guard]).finally(() => realClearTimeout(guardTimer));
  assert.ok(error instanceof Error, 'the write rejected');
  assert.equal(error.timeout, true);
  assert.equal(error.fatal, true, 'an unfinished write leaves the stream state unknown');
  assert.equal(session.closed, true);
  await assert.rejects(session.write(encodeFrame(0x01, [0x01])), /closed/);
});

test('a late 0x00 for an older request is not invented as a second pending answer', async () => {
  const link = fakeLink();
  const session = new Session(link);
  // A times out and leaves one credit behind.
  await assert.rejects(session.exchange(encodeFrame(0x40, [0x08]), 0x48, 20), (error) => error.timeout === true);
  // B is outstanding when the printer's 0x00 arrives: it is consumed for A.
  const second = session.exchange(encodeFrame(0x40, [0x09]), 0x49, 60).then(
    () => null,
    (error) => error
  );
  await tick();
  link.feed(reply(0x00, [0x01]));
  const secondError = await second;
  assert.equal(secondError?.unsupported, true, 'the 0x00 answered B; B is not a phantom timeout');
  // C must still see its own negative immediately: no stale credit is left.
  const third = session.exchange(encodeFrame(0x40, [0x0a]), 0x4a, 500);
  await tick();
  link.feed(reply(0x00, [0x01]));
  await assert.rejects(within(third, 500, 'the third request'), (error) => error.unsupported === true);
});

/* ---------------- late-0x00 ledger (R5A-3/R5A-4) ---------------- */

test('a successful reply retires older credits promptly, not at their own timeout', async () => {
  const link = fakeLink();
  const session = new Session(link);
  // A times out and leaves one credit behind.
  await assert.rejects(session.exchange(encodeFrame(0x40, [0x08]), 0x48, 20), (error) => error.timeout === true);
  // B's successful reply proves A's answer can never arrive: retire the credit.
  const second = session.exchange(encodeFrame(0x40, [0x09]), 0x49, 500);
  await tick();
  link.feed(reply(0x49, [0x05]));
  await within(second, 500, 'the second request');
  // C's own negative must settle it immediately. Without the retire rule the
  // stale credit absorbs this 0x00 and C only fails at its 500 ms timeout with
  // the same error object, which is why the old assertion could not tell them
  // apart.
  const third = session.exchange(encodeFrame(0x40, [0x0a]), 0x4a, 500);
  await tick();
  const started = Date.now();
  link.feed(reply(0x00, [0x01]));
  await assert.rejects(within(third, 500, 'the third request'), (error) => error.unsupported === true);
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 100, `the negative settles the request promptly (took ${elapsed} ms, timeout is 500 ms)`);
});

test('every timed-out request keeps one credit: two timeouts absorb two late negatives', async () => {
  const link = fakeLink();
  const session = new Session(link);
  await assert.rejects(session.exchange(encodeFrame(0x40, [0x08]), 0x48, 20), (error) => error.timeout === true);
  await assert.rejects(session.exchange(encodeFrame(0x40, [0x09]), 0x49, 20), (error) => error.timeout === true);
  const third = session.exchange(encodeFrame(0x40, [0x0a]), 0x4a, 500);
  await tick();
  // Two requests left the wire unanswered, so two 0x00s belong to them. The
  // third request must survive both and settle on its own reply.
  link.feed(reply(0x00, [0x01]));
  link.feed(reply(0x00, [0x01]));
  link.feed(reply(0x4a, [0x07]));
  assert.deepEqual([...(await within(third, 500, 'the third request')).data], [0x07]);
});

test('an exchange aborted after its write was issued leaves a credit for its late 0x00', async () => {
  const link = fakeLink();
  const session = new Session(link);
  const controller = new AbortController();
  const first = session.exchange(encodeFrame(0x40, [0x08]), 0x48, { timeoutMs: 5000, signal: controller.signal });
  await tick();
  assert.equal(link.writes.length, 1, 'the request reached the link');
  controller.abort();
  await assert.rejects(first, (error) => error.cancelled === true);
  // The printer may still answer the aborted request with 0x00; that answer
  // belongs to it, not to the request that is in flight now.
  const second = session.exchange(encodeFrame(0x40, [0x09]), 0x49, 500);
  await tick();
  link.feed(reply(0x00, [0x01]));
  link.feed(reply(0x49, [0x05]));
  assert.deepEqual([...(await within(second, 500, 'the second request')).data], [0x05]);
});

test('the ledger drops its oldest credit beyond the configured bound', async () => {
  const link = fakeLink();
  const session = new Session(link);
  const credits = CONFIG.protocol.maxUnansweredReplies;
  assert.ok(credits >= 2, 'the bound holds more than one credit');
  for (let index = 0; index <= credits; index++) {
    await assert.rejects(session.exchange(encodeFrame(0x40, [0x08 + index]), 0x48 + index, 5), (error) => error.timeout === true);
  }
  // Exactly `credits` late negatives are attributable; the next one belongs to
  // the current request and rejects it as unsupported.
  const current = session.exchange(encodeFrame(0x40, [0x7e]), 0x7f, 500);
  await tick();
  for (let index = 0; index < credits; index++) link.feed(reply(0x00, [0x01]));
  link.feed(reply(0x00, [0x01]));
  await assert.rejects(within(current, 500, 'the current request'), (error) => error.unsupported === true);
});

test('an abort carrying a PrinterError surfaces that error, not a cancel', async () => {
  const link = fakeLink();
  const session = new Session(link);
  const controller = new AbortController();
  const printerError = new PrinterError('Out of paper', { code: 0x02 });
  const pending = session.exchange(encodeFrame(0x01, [0x01]), 0x02, { timeoutMs: 5000, signal: controller.signal });
  controller.abort(printerError);
  await assert.rejects(pending, (error) => error === printerError);

  const secondController = new AbortController();
  link.write = () => new Promise(() => {});
  const write = session.write(encodeFrame(0x01, [0x01]), { signal: secondController.signal });
  secondController.abort(printerError);
  await assert.rejects(write, (error) => error === printerError);
});
