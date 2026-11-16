/**
 * The unreadable legacy label is kept, exported and only removed by a
 * confirmed reset. The library keeps saving every other label while the
 * quarantine banner is up.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { openLibrary } from '../src/core/library.js';
import { createMemoryDatabase } from '../src/core/library-db.js';
import { hydrateStoredDocument, INVALID_ELEMENT_LIST_MESSAGE } from '../src/label/schema.js';
import { createStorageAlert, STORAGE_ALERT_MESSAGE } from '../src/ui/storage-alert.js';
import { installDom } from './helpers/fake-dom.mjs';

/** A localStorage stand-in that counts writes. */
function fakeStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  const writes = [];
  return {
    values,
    writes,
    getItem: (key) => (values.has(key) ? values.get(key) : null),
    setItem: (key, value) => {
      writes.push([key, value]);
      values.set(key, String(value));
    },
    removeItem: (key) => values.delete(key),
  };
}

/** The alert's DOM, built from the same ids index.html uses. */
function alertNodes() {
  const dom = installDom();
  const container = dom.createElement('div');
  const textNode = dom.createElement('p');
  const exportButton = dom.createElement('button');
  const resetButton = dom.createElement('button');
  container.append(textNode, exportButton, resetButton);
  container.hidden = true;
  return { container, textNode, exportButton, resetButton };
}

function alertHarness({ initial = {}, confirm = async () => true } = {}) {
  const storage = fakeStorage(initial);
  globalThis.localStorage = storage;
  const nodes = alertNodes();
  const exported = [];
  const resets = [];
  const toasts = [];
  const alert = createStorageAlert({
    ...nodes,
    exportRaw: (filename) => {
      exported.push(filename);
      return true;
    },
    onReset: (raw) => resets.push(raw),
    confirm,
    toast: (message, options) => toasts.push({ message, options }),
  });
  // The boot owner reports the unreadable legacy value; the harness does the
  // same so the alert tests start from the real quarantine state.
  if (typeof initial['drypoint.document'] === 'string') {
    alert.capture(initial['drypoint.document'], new Error('unreadable legacy label'));
  }
  return { alert, storage, nodes, exported, resets, toasts };
}

async function libraryHarness(initial) {
  const storage = fakeStorage(initial);
  let sequence = 0;
  let clock = 1000;
  const library = await openLibrary({
    db: createMemoryDatabase(),
    storage,
    newId: () => `label-${++sequence}`,
    now: () => (clock += 10),
  });
  return { library, storage };
}

const INVALID = '{"lengthMm":40,"elements":"nope"}';
const TRUNCATED = '{"lengthMm":40,"elements":[{"type":"text","text":"Hi"';

test('an invalid stored element list is quarantined with its raw text', (t) => {
  t.after(() => delete globalThis.localStorage);
  const { alert, storage, nodes } = alertHarness({ initial: { 'drypoint.document': INVALID } });
  assert.equal(alert.active, true, 'the quarantine is active');
  assert.equal(alert.raw, INVALID, 'the raw value is kept exactly');
  assert.equal(nodes.container.hidden, false, 'the notice is visible');
  assert.equal(nodes.textNode.textContent, STORAGE_ALERT_MESSAGE);
  assert.match(nodes.textNode.textContent, /could not be read/);
  assert.match(nodes.textNode.textContent, /kept exactly as it is/);
  assert.match(nodes.textNode.textContent, /until you reset it/);
  assert.match(nodes.textNode.textContent, /Other labels keep saving/);
  assert.doesNotMatch(nodes.textNode.textContent, /nothing is saved/, 'the library keeps writing other labels');
  assert.doesNotMatch(nodes.textNode.textContent, /until you export/, 'export is a backup, never the acknowledgement');
  assert.equal(storage.writes.length, 0, 'loading writes nothing');
});

test('the reset button asks before it destroys the only copy', async (t) => {
  t.after(() => delete globalThis.localStorage);
  const asks = [];
  const { alert, nodes, resets, storage } = alertHarness({
    initial: { 'drypoint.document': INVALID },
    confirm: async (request) => {
      asks.push(request);
      return false;
    },
  });

  nodes.resetButton.click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(asks.length, 1, 'one confirmation request');
  assert.match(asks[0].title, /Reset the unreadable label/);
  assert.match(asks[0].message, /removed\. The label open now is kept/);
  assert.match(asks[0].message, /Export the raw value first/);
  assert.match(asks[0].message, /cannot be undone/);
  assert.equal(asks[0].confirmLabel, 'Reset the label');
  assert.deepEqual(resets, [], 'a refusal resets nothing');
  assert.equal(alert.active, true, 'the quarantine holds');
  assert.equal(alert.raw, INVALID, 'the raw value is untouched');
  assert.equal(nodes.container.hidden, false, 'the banner stays');
  assert.equal(storage.writes.length, 0, 'nothing was written');
});

test('confirming hands the raw value to the reset owner exactly once', async (t) => {
  t.after(() => delete globalThis.localStorage);
  const { alert, nodes, resets } = alertHarness({ initial: { 'drypoint.document': INVALID } });

  nodes.resetButton.click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(resets, [INVALID], 'the owner can restore the raw value if its reset fails');
  assert.equal(alert.active, false);
  assert.equal(nodes.container.hidden, true);

  nodes.resetButton.click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(resets, [INVALID], 'the quarantine is answered once');
});

test('a truncated stored value is quarantined too', (t) => {
  t.after(() => delete globalThis.localStorage);
  const { alert, nodes } = alertHarness({ initial: { 'drypoint.document': TRUNCATED } });
  assert.equal(alert.active, true);
  assert.equal(alert.raw, TRUNCATED);
  assert.equal(nodes.container.hidden, false);
});

test('a bad legacy record does not stop another label from saving, and survives a reload', async (t) => {
  t.after(() => delete globalThis.localStorage);
  const { library, storage } = await libraryHarness({ 'drypoint.document': INVALID });
  const boot = await library.boot();
  assert.equal(boot.legacyError.raw, INVALID);
  const { alert } = alertHarness({ initial: { 'drypoint.document': INVALID } });
  assert.equal(alert.raw, INVALID);

  const saved = await library.save(boot.label.id, {
    ...boot.document,
    name: 'Saved beside the unreadable value',
  });
  assert.equal(saved.name, 'Saved beside the unreadable value');
  assert.equal(storage.values.get('drypoint.document'), INVALID, 'the raw legacy value is untouched');
  assert.equal((await library.read(boot.label.id)).document.name, 'Saved beside the unreadable value');

  // The next boot still reports the same quarantine and reads the saved label.
  const again = await library.boot();
  assert.equal(again.legacyError.raw, INVALID);
  assert.equal(again.document.name, 'Saved beside the unreadable value');
  assert.equal(alert.active, true);
});

test('reset is the only path that removes the quarantined value', async (t) => {
  t.after(() => delete globalThis.localStorage);
  const { library, storage } = await libraryHarness({ 'drypoint.document': INVALID });
  const boot = await library.boot();
  const label = await library.resetLegacy();
  assert.equal(storage.values.has('drypoint.document'), false, 'the key is removed, not overwritten');
  assert.equal(label.name, 'Untitled');
  assert.equal(await library.currentId(), label.id);
  assert.equal((await library.read(label.id)).document.elements.length, 1);
  assert.equal(label.id, boot.label.id, 'the label boot opened is kept');
  assert.equal((await library.list()).length, 1, 'reset does not add a duplicate label');
});

test('the raw export writes the quarantined text unchanged and never releases the quarantine', (t) => {
  t.after(() => delete globalThis.localStorage);
  const { alert, exported, toasts } = alertHarness({ initial: { 'drypoint.document': TRUNCATED } });
  assert.equal(alert.exportQuarantined(), true);
  assert.equal(exported.length, 1);
  assert.match(exported[0], /^drypoint-unreadable-label-\d+\.json$/);
  assert.equal(toasts.at(-1).message, 'Raw stored label exported');
  assert.equal(alert.active, true, 'the quarantine is still active after an export');
  assert.equal(alert.raw, TRUNCATED);

  // With no quarantine the call is a no-op, never a zero-byte file.
  alert.answer();
  assert.equal(alert.exportQuarantined(), false);
  assert.equal(exported.length, 1);
  assert.equal(toasts.length, 1, 'no second toast');
});

test('a storage read that never produced a value does not quarantine', (t) => {
  t.after(() => delete globalThis.localStorage);
  const { alert, nodes } = alertHarness();
  assert.equal(alert.active, false, 'there is nothing to keep');
  assert.equal(nodes.container.hidden, true);
  assert.equal(alert.capture(null), false);
  assert.equal(alert.capture(''), false);
  assert.equal(alert.active, false);
});

test('the stored-hydration boundary refuses every non-label root', () => {
  for (const value of [null, undefined, 7, 'label', [], true]) {
    assert.throws(() => hydrateStoredDocument(value), new RegExp(INVALID_ELEMENT_LIST_MESSAGE.slice(0, 20)));
  }
  assert.throws(() => hydrateStoredDocument({ elements: 'nope' }), new RegExp(INVALID_ELEMENT_LIST_MESSAGE.slice(0, 20)));
  // A real label still hydrates, and an older one still migrates.
  assert.equal(hydrateStoredDocument({ lengthMm: 40, elements: [] }).lengthMm, 40);
  assert.equal(hydrateStoredDocument({ version: 3, lengthMm: 40, elements: [] }).version, 4);
});
