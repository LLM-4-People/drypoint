/**
 * Library domain: CRUD, ordering, current selection, migration, unreadable
 * record isolation, cascade delete and persisted history normalization.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { CONFIG } from '../src/core/config.js';
import { createMemoryLibrary, openLibrary } from '../src/core/library.js';
import { createMemoryDatabase } from '../src/core/library-db.js';
import { estimateDocumentBytes, normaliseHistory } from '../src/label/history.js';
import { createDocument } from '../src/label/schema.js';

/** A localStorage stand-in for the migration key. */
function fakeStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem: (key) => (values.has(key) ? values.get(key) : null),
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  };
}

function doc(name, extra = {}) {
  return createDocument({ name, elements: [], ...extra });
}

/** The library plus its adapter, so a test can seed a broken stored record. */
async function harness({ storage = fakeStorage(), initial = {} } = {}) {
  let sequence = 0;
  let clock = 1000;
  const db = createMemoryDatabase(initial);
  const library = await openLibrary({
    db,
    storage,
    newId: () => `label-${++sequence}`,
    now: () => (clock += 10),
  });
  return { library, db };
}

test('create, read, save and list keep metadata in step with the document', async () => {
  const { library, db } = await harness();
  const created = await library.create(doc('  First label  '));
  assert.equal(created.name, 'First label');
  assert.equal(created.elementCount, 0);

  const read = await library.read(created.id);
  assert.equal(read.ok, true);
  assert.equal(read.document.name, '  First label  ', 'the document name is not trimmed');
  assert.equal(read.label.name, 'First label', 'the metadata name is trimmed');

  const saved = await library.save(created.id, doc('Renamed', { elements: [createDocument().elements[0]] }));
  assert.equal(saved.createdAt, created.createdAt, 'createdAt never changes');
  assert.ok(saved.updatedAt > created.updatedAt);
  assert.equal(saved.name, 'Renamed');
  assert.equal(saved.elementCount, 1);
  assert.equal((await library.list())[0].name, 'Renamed');
});

test('an empty document name becomes Untitled in metadata only', async () => {
  const { library, db } = await harness();
  const label = await library.create(doc('   '));
  assert.equal(label.name, 'Untitled');
  assert.equal((await library.read(label.id)).document.name, '   ');
});

test('list orders by updatedAt, then createdAt, then id', async () => {
  const { library, db } = await harness();
  const first = await library.create(doc('First'));
  const second = await library.create(doc('Second'));
  assert.deepEqual((await library.list()).map((label) => label.name), ['Second', 'First']);
  await library.save(first.id, doc('First edited'));
  assert.deepEqual((await library.list()).map((label) => label.name), ['First edited', 'Second']);
});

test('current selection round-trips and rejects a malformed value', async () => {
  const { library, db } = await harness();
  const label = await library.create(doc('Current'));
  assert.equal(await library.currentId(), null);
  await library.setCurrent(label.id);
  assert.equal(await library.currentId(), label.id);
  await db.put('meta', { key: 'currentLabelId', value: 7 });
  assert.equal(await library.currentId(), null, 'a non-string meta value is refused');
});

test('duplicate clones the document, names the copy and uses a new identity', async () => {
  const { library, db } = await harness();
  const source = await library.create(doc('Source'));
  const copy = await library.duplicate(source.id);
  assert.notEqual(copy.id, source.id);
  assert.equal(copy.name, 'Source copy');
  assert.ok(copy.createdAt >= source.createdAt);
  const original = await library.read(source.id);
  const duplicated = await library.read(copy.id);
  assert.notEqual(original.document, duplicated.document);
  assert.equal(duplicated.document.name, 'Source copy');
  assert.deepEqual(duplicated.document.elements, original.document.elements);
});

test('remove cascades through documents, histories and sessions', async () => {
  const { library, db } = await harness();
  const label = await library.create(doc('Cascade'));
  await library.writeHistory(label.id, { past: [doc('Old')], future: [] });
  await library.writeSession(label.id, { selection: null });
  await library.remove(label.id);
  assert.equal(await library.read(label.id).then((result) => result.ok), false);
  assert.deepEqual(await library.list(), []);
  assert.equal(await library.readHistory(label.id), null);
  assert.equal(await library.readSession(label.id), null);
});

test('an unreadable record does not block another label from saving', async () => {
  const { library, db } = await harness();
  const good = await library.create(doc('Good'));
  const bad = await library.create(doc('Bad'));
  // Seed a record that cannot pass validation, as a partial or hand-edited
  // IndexedDB write would.
  await db.put('documents', { id: bad.id, document: { lengthMm: 40, elements: 'nope' } });

  const broken = await library.read(bad.id);
  assert.equal(broken.ok, false);
  assert.match(broken.reason, /no valid element list/);
  assert.match(broken.raw, /"elements":"nope"/);

  const saved = await library.save(good.id, doc('Still saves'));
  assert.equal(saved.name, 'Still saves');
  assert.equal((await library.list()).length, 2, 'both metadata rows remain listable');
  assert.equal((await library.read(good.id)).ok, true);
});

test('history normalization drops invalid snapshots and reapplies the entry cap', async () => {
  const { library, db } = await harness();
  const label = await library.create(doc('History'));
  await db.put('histories', {
    labelId: label.id,
    past: [doc('One'), { elements: 'nope' }, doc('Two')],
    future: [doc('Three')],
  });
  const history = await library.readHistory(label.id);
  assert.equal(history.past.length, 2, 'the invalid snapshot is dropped');
  assert.equal(history.future.length, 1);

  const many = Array.from({ length: CONFIG.history.maxEntries + 5 }, (_, index) => doc(`Snap ${index}`));
  await db.put('histories', { labelId: label.id, past: many, future: many });
  const capped = await library.readHistory(label.id);
  assert.equal(capped.past.length, CONFIG.history.maxEntries);
  assert.equal(capped.future.length, CONFIG.history.maxEntries);
  assert.equal(capped.past.at(-1).name, `Snap ${many.length - 1}`, 'the newest past snapshot survives');
});

test('the history byte budget trims the oldest past entries first', () => {
  const heavy = (index) => doc(`Heavy ${index}`, { elements: [{ id: 'a', type: 'text', text: 'x'.repeat(1000) }] });
  const snapshots = Array.from({ length: 20 }, (_, index) => heavy(index));
  const history = normaliseHistory({ past: snapshots, future: snapshots }, { limit: 20, maxBytes: 4000 });
  const bytes = [...history.past, ...history.future].reduce((sum, entry) => sum + estimateDocumentBytes(entry), 0);
  assert.ok(bytes <= 4000 || history.past.length === 1, `retained ${bytes} bytes`);
  assert.ok(history.past.length >= 1, 'one undo step is kept');
  assert.equal(history.past.at(-1).name, 'Heavy 19', 'the recent end is kept');
});

test('migration with no key records the state and boot creates the first label', async () => {
  const storage = fakeStorage();
  const { library, db } = await harness({ storage });
  assert.deepEqual(await library.migrateLegacy(), { migrated: false });
  assert.equal((await db.get('meta', 'legacyMigrated'))?.value, true, 'an absent key is recorded as migrated');
  const boot = await library.boot();
  assert.equal(boot.label.name, 'Untitled');
  assert.equal(boot.document.elements.length, 1);
  assert.equal(boot.legacyError, undefined);
  assert.equal((await library.list()).length, 1);
});

test('a valid legacy label becomes one label and its key is removed', async () => {
  const legacy = doc('Legacy label', { elements: [{ id: 'text_legacy', type: 'text', text: 'Hi' }] });
  const storage = fakeStorage({ 'drypoint.document': JSON.stringify(legacy) });
  const { library, db } = await harness({ storage });
  const migration = await library.migrateLegacy();
  assert.equal(migration.migrated, true);
  assert.equal(migration.label.name, 'Legacy label');
  assert.equal((await db.get('meta', 'legacyMigrated'))?.value, true, 'a successful migration is recorded');
  assert.equal(storage.values.has('drypoint.document'), false, 'the migrated key is removed');
  const boot = await library.boot();
  assert.equal(boot.document.name, 'Legacy label');
  assert.deepEqual(boot.history, { past: [], future: [] });
  assert.equal(boot.session.tab, 'design');
  assert.equal(boot.session.selection, 'text_legacy', 'the migrated label starts with its last element selected');
  assert.equal((await library.list()).length, 1, 'nothing is duplicated');
});

test('an invalid legacy value is kept, reported and never blocks a new label', async () => {
  const raw = '{"lengthMm":40,"elements":"nope"}';
  const storage = fakeStorage({ 'drypoint.document': raw });
  const { library, db } = await harness({ storage });
  const migration = await library.migrateLegacy();
  assert.equal(migration.migrated, false);
  assert.equal(migration.legacyError.raw, raw);
  assert.match(migration.legacyError.message, /no valid element list/);
  assert.equal(storage.values.get('drypoint.document'), raw);
  assert.equal(await db.get('meta', 'legacyMigrated'), undefined, 'an unreadable value is not recorded as migrated');

  const boot = await library.boot();
  assert.equal(boot.legacyError.raw, raw, 'a reload still reports the same raw value');
  assert.equal((await library.list()).length, 1, 'boot opens a usable label anyway');
  const saved = await library.save(boot.label.id, doc('Saved beside the bad value'));
  assert.equal(saved.name, 'Saved beside the bad value');
  assert.equal(storage.values.get('drypoint.document'), raw, 'the bad value is untouched');
});

test('an already populated library leaves a valid legacy key alone and does not duplicate', async () => {
  const storage = fakeStorage({ 'drypoint.document': JSON.stringify(doc('Legacy')) });
  const { library, db } = await harness({ storage });
  const existing = await library.create(doc('Existing'));
  const migration = await library.migrateLegacy();
  assert.equal(migration.migrated, false);
  assert.equal((await library.list()).length, 1);
  assert.equal((await library.list())[0].id, existing.id);
  assert.equal(storage.values.has('drypoint.document'), true, 'the key is left untouched');
  assert.equal((await db.get('meta', 'legacyMigrated'))?.value, true, 'the populated library records the migration state');
});

test('an already populated library still reports an unreadable legacy key', async () => {
  const raw = '{"lengthMm":40,"elements":"nope"}';
  const storage = fakeStorage({ 'drypoint.document': raw });
  const { library, db } = await harness({ storage });
  await library.create(doc('Existing'));
  const migration = await library.migrateLegacy();
  assert.equal(migration.legacyError.raw, raw);
  assert.equal(storage.values.get('drypoint.document'), raw);
  assert.equal((await db.get('meta', 'legacyMigrated'))?.value, true, 'a populated library records the migration state even when the key is unreadable');
});

test('one reset keeps the current readable label and removes the legacy key', async () => {
  const raw = '{"lengthMm":40,"elements":"nope"}';
  const storage = fakeStorage({ 'drypoint.document': raw });
  const { library } = await harness({ storage });
  const boot = await library.boot();
  await library.save(boot.label.id, doc('Edited after boot'));

  const label = await library.resetLegacy();
  assert.equal(label.id, boot.label.id, 'the label opened at boot is kept');
  assert.equal(label.name, 'Edited after boot', 'edits made since boot survive');
  assert.equal(await library.currentId(), boot.label.id);
  assert.equal(storage.values.has('drypoint.document'), false, 'the legacy key is removed');
  const labels = await library.list();
  assert.equal(labels.length, 1, 'reset does not add a second Untitled label');
  assert.equal((await library.read(labels[0].id)).ok, true, 'the only label is readable');
});

test('reset creates a label only when no readable label exists and removes the legacy key', async () => {
  const raw = '{"lengthMm":40,"elements":"nope"}';
  const storage = fakeStorage({ 'drypoint.document': raw });
  const { library } = await harness({ storage });
  const label = await library.resetLegacy();
  assert.equal(label.name, 'Untitled');
  assert.equal(storage.values.has('drypoint.document'), false);
  assert.equal(await library.currentId(), label.id);
  assert.equal((await library.read(label.id)).document.elements.length, 1);
  assert.equal((await library.list()).length, 1);
});

test('boot skips an unreadable current label and chooses a readable one', async () => {
  const { library, db } = await harness();
  const bad = await library.create(doc('Bad'));
  const good = await library.create(doc('Good'));
  await db.put('documents', { id: bad.id, document: { elements: 'nope' } });
  await library.setCurrent(bad.id);
  const boot = await library.boot();
  assert.equal(boot.label.id, good.id);
  assert.match(boot.notice, /could not be read/);
  assert.equal(await library.currentId(), good.id, 'the current pointer follows the readable label');
});

test('boot creates a new label when every record is unreadable and keeps the bad rows', async () => {
  const { library, db } = await harness();
  const first = await library.create(doc('First bad'));
  const second = await library.create(doc('Second bad'));
  await db.put('documents', { id: first.id, document: { elements: 'nope' } });
  await db.put('documents', { id: second.id, document: { elements: 'nope' } });
  const boot = await library.boot();
  assert.equal(boot.document.name, 'Untitled');
  assert.equal(boot.label.id !== first.id && boot.label.id !== second.id, true);
  assert.equal((await library.list()).length, 3, 'the unreadable rows are kept for export or delete');
});

test('the memory fallback boots one default label without touching storage', async () => {
  const library = createMemoryLibrary();
  const boot = await library.boot();
  assert.equal(boot.label.name, 'Untitled');
  assert.equal(boot.document.elements.length, 1);
});

test('openLibrary reports unavailable IndexedDB with a typed code', async () => {
  await assert.rejects(openLibrary({ indexedDB: null, storage: null }), (error) => {
    assert.equal(error.name, 'LibraryDbError');
    assert.equal(error.code, 'unavailable');
    return true;
  });
});

test('a failed migration write keeps the legacy key and does not open a default label', async () => {
  const storage = fakeStorage({ 'drypoint.document': JSON.stringify(doc('Legacy')) });
  const db = createMemoryDatabase();
  db.batch = async () => {
    throw new Error('The quota has been exceeded.');
  };
  const library = await openLibrary({ db, storage, newId: () => 'label-1', now: () => 1000 });
  await assert.rejects(library.boot(), /quota has been exceeded/);
  assert.equal(storage.values.get('drypoint.document'), JSON.stringify(doc('Legacy')), 'the key is untouched');
  assert.deepEqual(await db.getAll('labels'), [], 'no default label was created beside the stranded key');
});

test('the memory batch is atomic when one record is invalid', async () => {
  const db = createMemoryDatabase();
  await assert.rejects(
    db.batch([
      { type: 'put', store: 'labels', value: { id: 'first', name: 'First' } },
      { type: 'put', store: 'labels', value: { name: 'No key' } },
    ]),
    (error) => {
      assert.match(error.message, /batch failed/);
      assert.match(error.cause.message, /has no key/);
      return true;
    }
  );
  assert.equal(await db.get('labels', 'first'), undefined, 'the valid half of the refused batch was rolled back');

  await db.batch([
    { type: 'put', store: 'labels', value: { id: 'first', name: 'First' } },
    { type: 'put', store: 'meta', value: { key: 'currentLabelId', value: 'first' } },
  ]);
  assert.equal((await db.get('labels', 'first')).name, 'First');
  assert.equal((await db.get('meta', 'currentLabelId')).value, 'first');
});
