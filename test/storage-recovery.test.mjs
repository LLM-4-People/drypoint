/**
 * PR-F1: an unreadable stored label is kept, not replaced.
 *
 * The store hands the raw stored string to its owner on every load failure, and
 * its owner (the storage alert) refuses every write until the operator exports
 * the raw value or resets the label. These tests drive the two halves with a
 * fake `localStorage` and the shared fake DOM.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { createStore } from '../src/core/store.js';
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
      values.set(key, value);
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

function alertHarness({ initial = {} } = {}) {
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
    onReset: () => resets.push('reset'),
    toast: (message, options) => toasts.push({ message, options }),
  });
  const errors = [];
  const store = createStore({ elements: [], lengthMm: 40 }, {
    key: 'drypoint.document',
    envelope: false,
    hydrate: (value) => hydrateStoredDocument(value),
    persistMs: 0,
    canPersist: () => !alert.active,
    onError: (error, phase, context) => {
      errors.push({ error, phase, context });
      if (phase === 'load') alert.capture(context?.raw ?? null, error);
    },
  });
  return { alert, store, storage, nodes, exported, resets, toasts, errors };
}

const INVALID = '{"lengthMm":40,"elements":"nope"}';
const TRUNCATED = '{"lengthMm":40,"elements":[{"type":"text","text":"Hi"';

test('an invalid stored element list is quarantined with its raw text', (t) => {
  t.after(() => delete globalThis.localStorage);
  const { alert, storage, nodes, errors } = alertHarness({ initial: { 'drypoint.document': INVALID } });
  assert.equal(alert.active, true, 'the quarantine is active');
  assert.equal(alert.raw, INVALID, 'the raw value is kept exactly');
  assert.equal(errors.length, 1);
  assert.equal(errors[0].phase, 'load');
  assert.equal(errors[0].context.raw, INVALID, 'the store hands the raw string to its owner');
  assert.equal(nodes.container.hidden, false, 'the notice is visible');
  assert.equal(nodes.textNode.textContent, STORAGE_ALERT_MESSAGE);
  assert.match(nodes.textNode.textContent, /kept exactly as it is/);
  assert.match(nodes.textNode.textContent, /nothing is saved/);
  assert.match(nodes.textNode.textContent, /until you reset the label/);
  assert.doesNotMatch(nodes.textNode.textContent, /until you export/, 'export is a backup, never the acknowledgement');
  assert.equal(storage.writes.length, 0, 'loading writes nothing');
});

test('a truncated stored value is quarantined too', (t) => {
  t.after(() => delete globalThis.localStorage);
  const { alert, nodes } = alertHarness({ initial: { 'drypoint.document': TRUNCATED } });
  assert.equal(alert.active, true);
  assert.equal(alert.raw, TRUNCATED);
  assert.equal(nodes.container.hidden, false);
});

test('an edit cannot overwrite the quarantined value, and a reload keeps it', (t) => {
  t.after(() => delete globalThis.localStorage);
  const { alert, store, storage } = alertHarness({ initial: { 'drypoint.document': INVALID } });

  store.replace({ lengthMm: 30, elements: [] });
  store.flush();
  assert.equal(storage.values.get('drypoint.document'), INVALID, 'the raw value survives an edit');
  assert.equal(storage.writes.length, 0, 'the store refused every write');
  assert.equal(store.dirty, true, 'the owed write is still owed, not silently dropped');

  // A reload reads the same value and raises the same notice.
  const again = alertHarness({ initial: { 'drypoint.document': storage.values.get('drypoint.document') } });
  assert.equal(again.alert.active, true);
  assert.equal(again.alert.raw, INVALID);
});

test('reset is the only path that replaces the quarantined value', (t) => {
  t.after(() => delete globalThis.localStorage);
  const { alert, store, storage, nodes, resets } = alertHarness({ initial: { 'drypoint.document': INVALID } });
  store.replace({ lengthMm: 30, elements: [] });

  assert.equal(alert.answer(), true, 'the explicit reset answers the quarantine');
  assert.equal(alert.active, false);
  assert.equal(resets.length, 1, 'one reset callback, one write owner');
  assert.equal(nodes.container.hidden, true, 'the notice disappears');
  store.flush();
  assert.equal(storage.writes.length, 1, 'the current label is written once');
  assert.equal(JSON.parse(storage.values.get('drypoint.document')).lengthMm, 30);
  assert.equal(alert.answer(), false, 'a second reset is a no-op');
});

test('the raw export writes the quarantined text unchanged and never releases the veto', (t) => {
  t.after(() => delete globalThis.localStorage);
  const { alert, store, storage, exported, toasts } = alertHarness({ initial: { 'drypoint.document': TRUNCATED } });
  assert.equal(alert.exportQuarantined(), true);
  assert.equal(exported.length, 1);
  assert.match(exported[0], /^drypoint-unreadable-label-\d+\.json$/);
  assert.equal(toasts.at(-1).message, 'Raw stored label exported');

  // Export is a backup, not an acknowledgement: the value is still kept and
  // the store still refuses to write over it.
  assert.equal(alert.active, true, 'the quarantine is still active after an export');
  assert.equal(alert.raw, TRUNCATED);
  store.replace({ lengthMm: 30, elements: [] });
  store.flush();
  assert.equal(storage.values.get('drypoint.document'), TRUNCATED, 'nothing was overwritten after the backup');
  assert.equal(storage.writes.length, 0);

  // With no quarantine the call is a no-op, never a zero-byte file.
  alert.answer();
  assert.equal(alert.exportQuarantined(), false);
  assert.equal(exported.length, 1);
  assert.equal(toasts.length, 1, 'no second toast');
});

test('a storage read that never produced a value does not quarantine', (t) => {
  t.after(() => delete globalThis.localStorage);
  const { alert, nodes, errors } = alertHarness({ initial: {} });
  assert.equal(alert.active, false, 'there is nothing to keep');
  assert.equal(errors.length, 0, 'an empty store is not a failure');
  assert.equal(nodes.container.hidden, true);
  // A null/empty context must never block persistence.
  delete globalThis.localStorage;
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
