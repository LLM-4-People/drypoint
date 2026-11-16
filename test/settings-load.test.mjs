/**
 * N3: an unreadable settings payload is reported and replaced once, not
 * silently reset while the corrupt JSON stays on disk.
 *
 * Each case re-imports the module with a distinct query so its load issue and
 * store are fresh; the storage stub is swapped before the import because the
 * store reads at module evaluation.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { getLogEntries, clearLog } from '../src/core/log.js';
import { storageKey } from '../src/core/config.js';

const KEY = storageKey('settings');

function fakeStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  const writes = [];
  let failing = false;
  return {
    values,
    writes,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      if (failing) throw Object.assign(new Error('The quota has been exceeded.'), { name: 'QuotaExceededError' });
      writes.push([key, value]);
      values.set(key, value);
    },
    removeItem: (key) => values.delete(key),
    failWrites() {
      failing = true;
    },
  };
}

let sequence = 0;
async function freshSettings(storage) {
  globalThis.localStorage = storage;
  sequence += 1;
  return import(`../src/core/settings.js?load-case=${sequence}`);
}

/** The clean payload a settings reset must leave behind. */
function assertCleanDefaults(settings, storage) {
  const persisted = storage.getItem(KEY);
  assert.ok(persisted, 'a clean payload was written');
  const parsed = JSON.parse(persisted);
  assert.equal(parsed.version, 4, 'the envelope version is the document version');
  assert.deepEqual(parsed.data, settings.settingsStore.get(), 'the stored data is the defaults the app uses');
  assert.notEqual(persisted, '{not json');
}

test('a malformed settings JSON shows one notice and persists clean defaults', async () => {
  const storage = fakeStorage({ [KEY]: '{not json' });
  const settings = await freshSettings(storage);
  const issue = settings.takeSettingsLoadIssue();
  assert.ok(issue, 'the boot path has a notice to show');
  assert.match(issue.message, /could not be read and were reset to their defaults/);
  settings.settingsStore.flush();
  assertCleanDefaults(settings, storage);
  assert.equal(settings.takeSettingsLoadIssue(), null, 'the notice is taken once');
});

test('a non-object settings payload is reported, not treated as empty', async () => {
  for (const data of ['nope', 7, [], true, null]) {
    const storage = fakeStorage({ [KEY]: JSON.stringify({ version: 4, data }) });
    const settings = await freshSettings(storage);
    const issue = settings.takeSettingsLoadIssue();
    assert.ok(issue, `${JSON.stringify(data)} is a load issue`);
    assert.match(issue.message, /could not be read and were reset/);
    settings.settingsStore.flush();
    assertCleanDefaults(settings, storage);
  }
});

test('a version-matching envelope with no data key is a load issue too', async () => {
  // `?? {}` in the store used to turn both this and `data: null` into an
  // empty object before the settings owner could judge them.
  const storage = fakeStorage({ [KEY]: JSON.stringify({ version: 4 }) });
  const settings = await freshSettings(storage);
  const issue = settings.takeSettingsLoadIssue();
  assert.ok(issue, 'the absent data key is reported');
  assert.match(issue.message, /could not be read and were reset/);
  settings.settingsStore.flush();
  assertCleanDefaults(settings, storage);
});

test('a scalar envelope payload is a load issue, not a silent reset', async () => {
  for (const raw of ['5', '"text"', 'null', '[]']) {
    const storage = fakeStorage({ [KEY]: raw });
    const settings = await freshSettings(storage);
    assert.ok(settings.takeSettingsLoadIssue(), `${raw} is reported`);
    settings.settingsStore.flush();
    assertCleanDefaults(settings, storage);
  }
});

test('a settings envelope from another version is reported and reset', async () => {
  for (const envelope of [
    { version: 3, data: { 'editor.snap': false } },
    { version: 5, data: { 'editor.snap': false } },
    { data: { 'editor.snap': false } },
  ]) {
    const storage = fakeStorage({ [KEY]: JSON.stringify(envelope) });
    const settings = await freshSettings(storage);
    const issue = settings.takeSettingsLoadIssue();
    assert.ok(issue, `${JSON.stringify(envelope)} is a load issue`);
    assert.match(issue.message, /could not be read and were reset/);
    assert.equal(settings.getSetting('editor.snap'), true, 'another schema version is not coerced');
    settings.settingsStore.flush();
    assertCleanDefaults(settings, storage);
  }
});

test('one unreadable key still quarantines that key and keeps the rest', async () => {
  // A range clamps, so the throwing case is a value coercion cannot read: an
  // object whose toString is not callable.
  const stored = JSON.stringify({ version: 4, data: { 'print.density': { toString: null }, 'editor.snap': false } });
  const storage = fakeStorage({ [KEY]: stored });
  const settings = await freshSettings(storage);
  const issue = settings.takeSettingsLoadIssue();
  assert.match(issue.message, /Some saved settings could not be read and were reset: print\.density/);
  assert.equal(settings.getSetting('editor.snap'), false, 'the valid neighbour survives');
  assert.equal(settings.getSetting('print.density'), settings.settingsStore.get()['print.density']);
  settings.settingsStore.flush();
  assert.equal(JSON.parse(storage.getItem(KEY)).data['editor.snap'], false, 'the clean write keeps the valid key');
});

test('a failed save logs and leaves the stored value alone', async () => {
  const initial = JSON.stringify({ version: 4, data: { 'print.density': 3, 'editor.snap': true } });
  const storage = fakeStorage({ [KEY]: initial });
  const settings = await freshSettings(storage);
  assert.equal(settings.getSetting('print.density'), 3);
  clearLog();
  storage.failWrites();
  settings.settingsStore.set({ 'print.density': 5 });
  settings.settingsStore.flush();
  assert.equal(storage.getItem(KEY), initial, 'the stored value is not destroyed');
  assert.equal(settings.getSetting('print.density'), 5, 'the in-memory setting still changes');
  const warnings = getLogEntries().filter((entry) => entry.scope === 'settings' && entry.level === 'warn');
  assert.ok(warnings.some((entry) => /could not be saved/.test(entry.message)), 'the failure is logged');
});
