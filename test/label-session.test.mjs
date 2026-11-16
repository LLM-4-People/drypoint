/**
 * Session normalization and the label session persistence owner: debounce,
 * flush, switch, failure and retry.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { CONFIG } from '../src/core/config.js';
import { createLabelSession } from '../src/core/label-session.js';
import { openLibrary } from '../src/core/library.js';
import { createMemoryDatabase } from '../src/core/library-db.js';
import { defaultSession, mergeSession, normalizeSession } from '../src/core/session.js';
import { createDocument } from '../src/label/schema.js';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function doc(name, elements = []) {
  return createDocument({ name, elements });
}

function fakeStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem: (key) => (values.has(key) ? values.get(key) : null),
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  };
}

async function harness() {
  let sequence = 0;
  let clock = 1000;
  const db = createMemoryDatabase();
  const library = await openLibrary({
    db,
    storage: fakeStorage(),
    newId: () => `label-${++sequence}`,
    now: () => (clock += 10),
  });
  const first = await library.create(doc('First'));
  const second = await library.create(doc('Second'));
  await library.setCurrent(first.id);
  const boot = await library.boot();
  return { library, db, first, second, boot };
}

/* ---------------- session normalization ---------------- */

test('a session repairs each field without rejecting the whole value', () => {
  const session = normalizeSession({
    selection: 7,
    tab: 'nope',
    scroll: { stageX: -3, stageY: Number.POSITIVE_INFINITY, layersY: '12.7', panelY: CONFIG.ui.persistence.scrollMaxPx * 10 },
  });
  assert.deepEqual(session, {
    selection: null,
    tab: 'design',
    scroll: { stageX: 0, stageY: 0, layersY: 13, panelY: CONFIG.ui.persistence.scrollMaxPx },
  });
});

test('a null selection is a deliberate deselection, not a missing field', () => {
  const session = normalizeSession({ selection: null, tab: 'print' });
  assert.equal(session.selection, null);
  assert.equal(session.tab, 'print');
});

test('an over-long or non-string selection falls back to no selection', () => {
  assert.equal(normalizeSession({ selection: 'x'.repeat(CONFIG.bounds.maxIdChars + 1) }).selection, null);
  assert.equal(normalizeSession({ selection: '' }).selection, null);
  assert.equal(normalizeSession({ selection: {} }).selection, null);
});

test('mergeSession merges one scroll axis without resetting the others', () => {
  const current = normalizeSession({ selection: 'a', tab: 'print', scroll: { stageX: 10, stageY: 20, layersY: 30, panelY: 40 } });
  const merged = mergeSession(current, { scroll: { stageY: 99 } });
  assert.equal(merged.selection, 'a');
  assert.equal(merged.tab, 'print');
  assert.deepEqual(merged.scroll, { stageX: 10, stageY: 99, layersY: 30, panelY: 40 });
});

test('defaultSession selects the last element on the design tab', () => {
  const document = doc('Default', [
    { id: 'one', type: 'text', text: 'one' },
    { id: 'two', type: 'text', text: 'two' },
  ]);
  const session = defaultSession(document);
  assert.equal(session.selection, 'two');
  assert.equal(session.tab, 'design');
  assert.deepEqual(session.scroll, { stageX: 0, stageY: 0, layersY: 0, panelY: 0 });
});

/* ---------------- label session ---------------- */

test('the document write is debounced and one flush drains it', async () => {
  const { library } = await harness();
  const session = createLabelSession({ library, boot: await library.boot(), persistMs: 5, historyMs: 5, sessionMs: 5 });
  session.saveDocument(doc('Debounced'));
  await wait(25);
  assert.equal((await library.read(session.labelId)).document.name, 'Debounced');

  session.saveDocument(doc('Flushed'));
  await session.flush();
  assert.equal((await library.read(session.labelId)).document.name, 'Flushed');
});

test('history is read when its debounce fires, and the session merges patches', async () => {
  const { library } = await harness();
  const session = createLabelSession({ library, boot: await library.boot(), persistMs: 5, historyMs: 5, sessionMs: 5 });
  let version = 1;
  const controller = { historyState: () => ({ past: [doc(`Version ${version}`)], future: [] }) };
  session.saveHistory(controller);
  version = 2;
  session.saveSession({ selection: 'kept' });
  session.saveSession({ scroll: { stageY: 42 } });
  await session.flush();

  const history = await library.readHistory(session.labelId);
  assert.equal(history.past[0].name, 'Version 2', 'the snapshot is read at write time');
  const stored = await library.readSession(session.labelId);
  assert.equal(stored.selection, 'kept');
  assert.equal(stored.scroll.stageY, 42);
  assert.equal(stored.scroll.stageX, 0);
});

test('switchTo flushes the old label, writes the current pointer and returns the target payload', async () => {
  const { library, first, second } = await harness();
  const boot = await library.boot();
  const session = createLabelSession({ library, boot, persistMs: 5, historyMs: 5, sessionMs: 5 });
  session.saveDocument(doc('First edited'));
  const payload = await session.switchTo(second.id);

  assert.equal(payload.label.id, second.id);
  assert.equal(payload.document.name, 'Second');
  assert.equal(await library.currentId(), second.id);
  assert.equal((await library.read(first.id)).document.name, 'First edited', 'the old label was flushed first');
  assert.equal(session.labelId, second.id);
});

test('a failed document write stays owed, reports once and succeeds on flush', async () => {
  const { library } = await harness();
  const boot = await library.boot();
  const errors = [];
  const saved = [];
  const originalSave = library.save;
  let attempts = 0;
  library.save = async (...args) => {
    attempts += 1;
    if (attempts === 1) throw new Error('The quota has been exceeded.');
    return originalSave(...args);
  };
  const session = createLabelSession({
    library,
    boot,
    persistMs: 5,
    historyMs: 5,
    sessionMs: 5,
    onError: (error, kind) => errors.push({ error, kind }),
    onSaved: (kind) => saved.push(kind),
  });

  session.saveDocument(doc('Retried'));
  await wait(25);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].kind, 'document');
  assert.equal((await library.read(session.labelId)).document.name, 'First', 'the failed write did not land');

  await session.flush();
  assert.equal(attempts, 2, 'flush retries the owed write once');
  assert.equal((await library.read(session.labelId)).document.name, 'Retried');
  assert.ok(saved.includes('document'));
});

test('switching after a failed write does not carry the old document into the new label', async () => {
  const { library, second } = await harness();
  const boot = await library.boot();
  const errors = [];
  const originalSave = library.save;
  let fail = true;
  library.save = async (...args) => {
    if (fail) throw new Error('blocked');
    return originalSave(...args);
  };
  const session = createLabelSession({
    library,
    boot,
    persistMs: 5,
    historyMs: 5,
    sessionMs: 5,
    onError: (error, kind) => errors.push(kind),
  });
  session.saveDocument(doc('Old pending'));
  const payload = await session.switchTo(second.id);
  assert.equal(payload.document.name, 'Second');
  assert.deepEqual(errors, ['document']);
  fail = false;
  session.saveDocument(doc('New label only'));
  await session.flush();
  assert.equal((await library.read(second.id)).document.name, 'New label only');
});

test('create and import create a label and switch to it', async () => {
  const { library } = await harness();
  const session = createLabelSession({ library, boot: await library.boot(), persistMs: 5, historyMs: 5, sessionMs: 5 });
  const created = await session.create(doc('Created'));
  assert.equal(created.label.name, 'Created');
  assert.equal(session.labelId, created.label.id);
  assert.equal(await library.currentId(), created.label.id);
  assert.equal(created.history.past.length, 0);
  assert.equal(created.session.selection, created.document.elements.at(-1)?.id ?? null, 'a new label selects its last element');

  const imported = await session.importDocument(doc('Imported'));
  assert.equal(imported.label.name, 'Imported');
  assert.equal(session.labelId, imported.label.id);
  assert.equal((await library.list()).length, 4, 'the harness labels plus the two created ones');
});

test('duplicate copies a label without switching the current one', async () => {
  const { library, first } = await harness();
  const session = createLabelSession({ library, boot: await library.boot(), persistMs: 5, historyMs: 5, sessionMs: 5 });
  const copy = await session.duplicate(first.id);
  assert.equal(copy.name, 'First copy');
  assert.equal(session.labelId, first.id);
  assert.equal(await library.currentId(), first.id);
});

test('removing the current label opens the next recent one, or creates a default', async () => {
  const { library, db, first, second } = await harness();
  const bad = await library.create(doc('Bad'));
  await db.put('documents', { id: bad.id, document: { elements: 'nope' } });
  const session = createLabelSession({ library, boot: await library.boot(), persistMs: 5, historyMs: 5, sessionMs: 5 });
  const next = await session.remove(first.id);
  assert.equal(next.label.id, second.id);
  assert.equal(session.labelId, second.id);

  const fresh = await session.remove(second.id);
  assert.equal(fresh.label.name, 'Untitled');
  assert.equal(session.labelId, fresh.label.id);
  assert.equal((await library.list()).length, 2, 'the unreadable label is kept for export or delete');
  assert.equal((await library.read(bad.id)).ok, false, 'and it was never overwritten');
});

test('resetLegacy removes the legacy key and switches to a fresh label', async () => {
  const storage = fakeStorage({ 'drypoint.document': '{"elements":"nope"}' });
  let sequence = 0;
  const db = createMemoryDatabase();
  const library = await openLibrary({
    db,
    storage,
    newId: () => `label-${++sequence}`,
    now: () => 1000 + sequence,
  });
  const boot = await library.boot();
  assert.match(boot.legacyError.message, /no valid element list/);
  const session = createLabelSession({ library, boot, persistMs: 5, historyMs: 5, sessionMs: 5 });
  const payload = await session.resetLegacy();
  assert.equal(payload.label.name, 'Untitled');
  assert.equal(storage.values.has('drypoint.document'), false);
  assert.equal(session.labelId, payload.label.id);
  assert.equal(payload.session.selection, payload.document.elements.at(-1).id, 'a reset label selects its last element');
});

test('a history failure shares the one error channel and is retried on flush', async () => {
  const { library } = await harness();
  const boot = await library.boot();
  const errors = [];
  const originalWrite = library.writeHistory;
  let attempts = 0;
  library.writeHistory = async (...args) => {
    attempts += 1;
    if (attempts === 1) throw new Error('history blocked');
    return originalWrite(...args);
  };
  const session = createLabelSession({
    library,
    boot,
    persistMs: 5,
    historyMs: 5,
    sessionMs: 5,
    onError: (error, kind) => errors.push(kind),
  });
  session.saveHistory({ historyState: () => ({ past: [doc('Past')], future: [] }) });
  await wait(25);
  assert.deepEqual(errors, ['history']);
  await session.flush();
  assert.equal(attempts, 2);
  assert.equal((await library.readHistory(session.labelId)).past[0].name, 'Past');
});
