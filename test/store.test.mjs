import test from 'node:test';
import assert from 'node:assert/strict';

import { createStore } from '../src/core/store.js';

function withStorage(storage, run) {
  const previous = globalThis.localStorage;
  globalThis.localStorage = storage;
  try {
    return run();
  } finally {
    globalThis.localStorage = previous;
  }
}

test('a quota failure is signalled while memory state keeps working', () => {
  const quota = new Error('The quota has been exceeded.');
  quota.name = 'QuotaExceededError';
  const failures = [];
  const storage = {
    getItem: () => null,
    setItem() {
      throw quota;
    },
  };

  withStorage(storage, () => {
    const store = createStore({ value: 1 }, { key: 'test.quota', onError: (error, phase) => failures.push({ error, phase }) });
    store.set({ value: 2 });
    assert.equal(store.get().value, 2, 'the in-memory state still updates');
    store.flush();
    assert.equal(failures.length, 1);
    assert.equal(failures[0].phase, 'persist');
    assert.equal(failures[0].error.name, 'QuotaExceededError');
  });
});

test('a read failure is signalled and falls back to the initial state', () => {
  const failures = [];
  const storage = {
    getItem() {
      throw new Error('storage is blocked');
    },
    setItem() {},
  };

  withStorage(storage, () => {
    const store = createStore({ value: 1 }, { key: 'test.read', onError: (error, phase) => failures.push(phase) });
    assert.deepEqual(store.get(), { value: 1 });
    assert.deepEqual(failures, ['load']);
  });
});

test('hydrate normalises a version-matching payload instead of merging it raw', () => {
  const storage = {
    getItem: () => JSON.stringify({ version: 7, data: { value: '9', junk: true } }),
    setItem() {},
  };

  withStorage(storage, () => {
    const store = createStore(
      { value: 0 },
      { key: 'test.hydrate', version: 7, hydrate: (data) => ({ value: Number(data.value) || 0 }) }
    );
    assert.deepEqual(store.get(), { value: 9 }, 'unknown keys are dropped and values are coerced');
  });
});

test('a version mismatch without hydrate keeps the initial state', () => {
  const storage = {
    getItem: () => JSON.stringify({ version: 1, data: { value: 42 } }),
    setItem() {},
  };

  withStorage(storage, () => {
    const store = createStore({ value: 0 }, { key: 'test.version', version: 2 });
    assert.deepEqual(store.get(), { value: 0 });
  });
});

test('malformed JSON is a load failure, not a crash', () => {
  const failures = [];
  const storage = {
    getItem: () => '{not json',
    setItem() {},
  };

  withStorage(storage, () => {
    const store = createStore({ value: 1 }, { key: 'test.json', onError: (error, phase) => failures.push(phase) });
    assert.deepEqual(store.get(), { value: 1 });
    assert.deepEqual(failures, ['load']);
  });
});

test('a throwing subscriber is surfaced at debug instead of vanishing', async (t) => {
  const { clearLog, getLogEntries, setLogLevel } = await import('../src/core/log.js');
  t.after(() => clearLog());
  t.mock.method(console, 'log', () => {});
  clearLog();
  setLogLevel('debug');

  const store = createStore({ value: 0 });
  const seen = [];
  store.subscribe(() => {
    throw new Error('subscriber exploded');
  }, { immediate: false });
  store.subscribe((state) => seen.push(state.value), { immediate: false });

  store.set({ value: 1 });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(seen, [1], 'the healthy subscriber still ran');
  const entry = getLogEntries().find((item) => item.message === 'store subscriber threw');
  assert.ok(entry, 'the failure is in the diagnostics log');
  assert.match(String(entry.detail), /subscriber exploded/);
});

/* ---------------- document persistence (R8-4/R8-5) ---------------- */

test('a failed write stays dirty and the next success clears it', () => {
  let failing = true;
  const writes = [];
  const storage = {
    getItem: () => null,
    setItem(key, value) {
      if (failing) throw new Error('quota exceeded');
      writes.push(value);
    },
  };

  withStorage(storage, () => {
    const failures = [];
    const persisted = [];
    const store = createStore({ value: 1 }, {
      key: 'test.dirty',
      persistMs: 0,
      onError: (error, phase) => failures.push(phase),
      onPersist: () => persisted.push(true),
    });
    assert.equal(store.dirty, false, 'a freshly loaded store owes no write');

    store.set({ value: 2 });
    assert.equal(store.dirty, true);
    store.flush();
    assert.deepEqual(failures, ['persist']);
    assert.equal(store.dirty, true, 'a failed write is still owed');

    failing = false;
    store.set({ value: 3 });
    store.flush();
    assert.equal(store.dirty, false, 'a successful write settles the document');
    assert.equal(persisted.length, 1, 'the owner hears about the recovery');
    assert.deepEqual(JSON.parse(writes.at(-1)), { version: 1, data: { value: 3 } });
  });
});

test('an unmodified tab never writes the document', () => {
  let writes = 0;
  const storage = {
    getItem: () => JSON.stringify({ version: 1, data: { value: 7 } }),
    setItem() {
      writes++;
    },
  };
  withStorage(storage, () => {
    const store = createStore({ value: 0 }, { key: 'test.clean', persistMs: 0 });
    assert.deepEqual(store.get(), { value: 7 });
    assert.equal(store.dirty, false, 'a tab that never edited must not rewrite storage');
    store.flush();
    assert.equal(writes, 0);
  });
});

test('a raw store writes the value itself, not a version envelope', () => {
  const writes = [];
  const storage = {
    getItem: () => null,
    setItem(key, value) {
      writes.push(value);
    },
  };
  withStorage(storage, () => {
    const store = createStore({ a: 1 }, { key: 'test.raw', envelope: false, persistMs: 0 });
    store.replace({ a: 2, name: 'Raw' });
    store.flush();
    assert.deepEqual(JSON.parse(writes.at(-1)), { a: 2, name: 'Raw' });
  });
});

test('a raw store loads its own shape through hydrate', () => {
  const storage = {
    getItem: () => JSON.stringify({ a: 2 }),
    setItem() {},
  };
  withStorage(storage, () => {
    const store = createStore({ a: 0 }, { key: 'test.rawload', envelope: false, hydrate: (data) => ({ a: Number(data.a) }) });
    assert.deepEqual(store.get(), { a: 2 });
  });
});
