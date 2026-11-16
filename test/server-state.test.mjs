import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  claimTrackedServer,
  commandLooksLikeServer,
  isProcessAlive,
  readProcessCommand,
  readTrackedServer,
  removeTrackedServerIfOwned,
  resolveHost,
  resolvePort,
  stopTrackedServer,
  writeTrackedServer,
} from '../scripts/lib/server-state.mjs';

test('port resolution follows the flag, then PORT, then 8080', () => {
  assert.equal(resolvePort([], {}), 8080);
  assert.equal(resolvePort(['--port', '9000'], {}), 9000);
  assert.equal(resolvePort(['--port=9001'], {}), 9001);
  assert.equal(resolvePort([], { PORT: '9002' }), 9002);
  assert.throws(() => resolvePort(['--port', 'nope'], {}), /invalid port/);
  assert.throws(() => resolvePort(['--port', '70000'], {}), /invalid port/);
});

test('a flag with no value is an error, never the default port', () => {
  assert.throws(() => resolvePort(['--port'], {}), /--port needs a value/);
  assert.throws(() => resolvePort(['--port', '--pid', '123'], {}), /--port needs a value/);
  assert.throws(() => resolvePort(['--port='], {}), /--port needs a value/);
});

test('host resolution defaults to loopback, then the flag wins over HOST', () => {
  assert.equal(resolveHost([], {}), '127.0.0.1', 'a bare start never exposes the app');
  assert.equal(resolveHost([], { HOST: '0.0.0.0' }), '0.0.0.0');
  assert.equal(resolveHost(['--host', '0.0.0.0'], { HOST: '192.168.1.4' }), '0.0.0.0', 'the flag wins');
  assert.equal(resolveHost(['--host=10.0.0.5'], { HOST: '0.0.0.0' }), '10.0.0.5');
  assert.equal(resolveHost(['--other', 'x'], { HOST: 'localhost' }), 'localhost');

  // A missing value must never fall back to a bind the operator did not ask for.
  assert.throws(() => resolveHost(['--host'], {}), /--host needs a value/);
  assert.throws(() => resolveHost(['--host', '--port', '9000'], {}), /--host needs a value/);
  assert.throws(() => resolveHost(['--host='], {}), /--host needs a value/);
});

test('the pid file round-trips, is exclusive and reports malformed contents', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'drypoint-server-state-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'server-8080.pid');

  assert.deepEqual(await readTrackedServer(file), { state: 'missing' });

  await writeTrackedServer(file, { pid: process.pid, port: 8080, startedAt: '2026-01-01T00:00:00.000Z' });
  const tracked = await readTrackedServer(file);
  assert.equal(tracked.state, 'tracked');
  assert.deepEqual(tracked.record, { pid: process.pid, port: 8080, startedAt: '2026-01-01T00:00:00.000Z' });

  await assert.rejects(writeTrackedServer(file, { pid: process.pid, port: 8080 }), { code: 'EEXIST' });

  await writeFile(file, 'not json');
  assert.equal((await readTrackedServer(file)).state, 'invalid');
});

test('cleanup only removes a file that still describes this process', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'drypoint-server-state-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'server-8080.pid');

  await writeTrackedServer(file, { pid: process.pid + 1, port: 8080, startedAt: 'x' });
  await removeTrackedServerIfOwned(file, process.pid);
  assert.equal((await readTrackedServer(file)).state, 'tracked', 'another pid keeps the file');

  await removeTrackedServerIfOwned(file, process.pid + 1);
  assert.equal((await readTrackedServer(file)).state, 'missing');
});

test('only the dev server command is accepted for signalling', async () => {
  assert.equal(commandLooksLikeServer('node scripts/serve.mjs'), true);
  assert.equal(commandLooksLikeServer('node /repo/scripts/serve.mjs --x'), true);
  assert.equal(commandLooksLikeServer('sleep 30'), false);
  assert.equal(commandLooksLikeServer(null), false);

  assert.equal(isProcessAlive(process.pid), true);
  const command = await readProcessCommand(process.pid);
  assert.ok(command && command.length > 0, 'the current command line is readable');
});

/* ---------------- claim / stop orchestration ---------------- */

/** In-memory pid file with the same read/write/remove contract as the real one. */
function memoryPidFile(initial = null) {
  const file = { raw: initial, removed: 0 };
  file.read = async () => {
    if (file.raw === null) return { state: 'missing' };
    try {
      const record = JSON.parse(file.raw);
      if (!record || !Number.isInteger(record.pid) || record.pid <= 0) throw new Error('bad record');
      return { state: 'tracked', record, raw: file.raw };
    } catch {
      return { state: 'invalid', raw: file.raw };
    }
  };
  file.write = async (_path, record) => {
    if (file.raw !== null) throw Object.assign(new Error('exists'), { code: 'EEXIST' });
    file.raw = `${JSON.stringify(record)}\n`;
    return record;
  };
  file.remove = async () => {
    file.removed++;
    file.raw = null;
  };
  return file;
}

test('claim wins an empty port and records this process', async () => {
  const file = memoryPidFile();
  const result = await claimTrackedServer({
    file: 'pid',
    port: 8080,
    pid: 42,
    startedAt: 'now',
    deps: { read: file.read, write: file.write, remove: file.remove, warn: () => {} },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(JSON.parse(file.raw), { pid: 42, port: 8080, startedAt: 'now' });
});

test('claim refuses a live server for the same port', async () => {
  const file = memoryPidFile(JSON.stringify({ pid: 7, port: 8080, startedAt: 'earlier' }));
  const result = await claimTrackedServer({
    file: 'pid',
    port: 8080,
    deps: {
      read: file.read,
      write: file.write,
      remove: file.remove,
      alive: () => true,
      commandFor: async () => 'node scripts/serve.mjs',
      warn: () => {},
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'tracked');
  assert.equal(file.removed, 0, 'the live server keeps its record');
});

test('claim replaces a stale, foreign or unreadable record', async () => {
  const cases = [
    { initial: JSON.stringify({ pid: 7, port: 8080 }), alive: () => false, command: null },
    { initial: JSON.stringify({ pid: 7, port: 8080 }), alive: () => true, command: 'sleep 30' },
    { initial: 'not json', alive: () => true, command: null },
  ];
  for (const { initial, alive, command } of cases) {
    const file = memoryPidFile(initial);
    const result = await claimTrackedServer({
      file: 'pid',
      port: 8080,
      pid: 9,
      deps: {
        read: file.read,
        write: file.write,
        remove: file.remove,
        alive,
        commandFor: async () => command,
        warn: () => {},
      },
    });
    assert.equal(result.ok, true, `replaced ${initial}`);
    assert.equal(JSON.parse(file.raw).pid, 9);
  }
});

test('a lost race never deletes the record the winner just wrote', async () => {
  // First read sees a stale record; the next reads see the winner's live one.
  const file = memoryPidFile(JSON.stringify({ pid: 1234, port: 8080 }));
  let reads = 0;
  const read = async () => {
    reads++;
    return reads === 1
      ? { state: 'tracked', record: { pid: 999, port: 8080 } }
      : { state: 'tracked', record: { pid: 1234, port: 8080 } };
  };
  const result = await claimTrackedServer({
    file: 'pid',
    port: 8080,
    deps: {
      read,
      write: file.write,
      remove: file.remove,
      alive: (pid) => pid === 1234,
      commandFor: async () => 'node scripts/serve.mjs',
      warn: () => {},
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'tracked');
  assert.equal(file.removed, 0, 'the winner is still tracked');
});

test('two concurrent claims produce exactly one winner', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'drypoint-claim-race-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'server-8080.pid');
  const deps = {
    alive: () => true,
    commandFor: async () => 'node scripts/serve.mjs',
    warn: () => {},
  };
  const [a, b] = await Promise.all([
    claimTrackedServer({ file, port: 8080, deps }),
    claimTrackedServer({ file, port: 8080, deps }),
  ]);
  assert.equal([a, b].filter((result) => result.ok).length, 1, 'one start owns the port');
  assert.equal((await readTrackedServer(file)).state, 'tracked');
});

function stopHarness({ tracked, alive = true, command = 'node scripts/serve.mjs', signal, wait = true } = {}) {
  const calls = { signals: [], removed: [] };
  const deps = {
    read: async () => tracked,
    alive: () => alive,
    commandFor: async () => command,
    signal: (pid, name) => {
      calls.signals.push([pid, name]);
      if (signal) signal(pid, name);
    },
    wait: async () => wait,
    removeOwned: async (file, pid) => calls.removed.push([file, pid]),
  };
  return { calls, deps };
}

test('stop reports a missing record without signalling anything', async () => {
  const { calls, deps } = stopHarness({ tracked: { state: 'missing' } });
  const result = await stopTrackedServer({ file: 'pid', port: 8080, deps });
  assert.equal(result.code, 0);
  assert.deepEqual(calls.signals, []);
  assert.match(result.messages[0].text, /no tracked server/);
});

test('stop refuses an unreadable or mismatched record and keeps the file', async () => {
  for (const tracked of [
    { state: 'invalid', raw: 'nope' },
    { state: 'tracked', record: { pid: 7, port: 9999 } },
  ]) {
    const { calls, deps } = stopHarness({ tracked });
    const result = await stopTrackedServer({ file: 'pid', port: 8080, deps });
    assert.equal(result.code, 1);
    assert.deepEqual(calls.signals, []);
    assert.deepEqual(calls.removed, []);
  }
});

test('stop removes a stale record only through the ownership-checked helper', async () => {
  const { calls, deps } = stopHarness({ tracked: { state: 'tracked', record: { pid: 7, port: 8080 } }, alive: false });
  const result = await stopTrackedServer({ file: 'pid', port: 8080, deps });
  assert.equal(result.code, 0);
  assert.deepEqual(calls.removed, [['pid', 7]], 're-read and ownership-checked, never a blind rm');
});

test('stop signals a verified server and removes the record after it exits', async () => {
  const { calls, deps } = stopHarness({ tracked: { state: 'tracked', record: { pid: 7, port: 8080 } } });
  const result = await stopTrackedServer({ file: 'pid', port: 8080, deps });
  assert.equal(result.code, 0);
  assert.deepEqual(calls.signals, [[7, 'SIGTERM']]);
  assert.deepEqual(calls.removed, [['pid', 7]]);
});

test('stop treats an already-exited process as success and cleans up', async () => {
  const { calls, deps } = stopHarness({
    tracked: { state: 'tracked', record: { pid: 7, port: 8080 } },
    signal: () => {
      throw Object.assign(new Error('gone'), { code: 'ESRCH' });
    },
  });
  const result = await stopTrackedServer({ file: 'pid', port: 8080, deps });
  assert.equal(result.code, 0);
  assert.deepEqual(calls.removed, [['pid', 7]]);
});

test('stop reports a permission failure, a timeout and a foreign process', async () => {
  const denied = stopHarness({
    tracked: { state: 'tracked', record: { pid: 7, port: 8080 } },
    signal: () => {
      throw Object.assign(new Error('not permitted'), { code: 'EPERM' });
    },
  });
  const deniedResult = await stopTrackedServer({ file: 'pid', port: 8080, deps: denied.deps });
  assert.equal(deniedResult.code, 1);
  assert.match(deniedResult.messages.at(-1).text, /not permitted/);
  assert.deepEqual(denied.calls.removed, [], 'a refused signal keeps the record');

  const slow = stopHarness({ tracked: { state: 'tracked', record: { pid: 7, port: 8080 } }, wait: false });
  const slowResult = await stopTrackedServer({ file: 'pid', port: 8080, deps: slow.deps });
  assert.equal(slowResult.code, 1);
  assert.match(slowResult.messages.at(-1).text, /did not exit within 5s/);
  assert.deepEqual(slow.calls.removed, []);

  const foreign = stopHarness({ tracked: { state: 'tracked', record: { pid: 7, port: 8080 } }, command: 'sleep 30' });
  const foreignResult = await stopTrackedServer({ file: 'pid', port: 8080, deps: foreign.deps });
  assert.equal(foreignResult.code, 1);
  assert.deepEqual(foreign.calls.signals, [], 'an unrelated process is never signalled');
  assert.deepEqual(foreign.calls.removed, []);
});
