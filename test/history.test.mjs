import test from 'node:test';
import assert from 'node:assert/strict';

import { CONFIG } from '../src/core/config.js';
import { createHistory, estimateDocumentBytes } from '../src/label/history.js';
import { validateDocument } from '../src/label/schema.js';

const doc = (text) => ({ version: 4, name: 'Untitled', lengthMm: 40, copies: 1, elements: [{ id: 'a', type: 'text', text }] });

test('commit skips a structurally equal document', () => {
  const history = createHistory({ initial: doc('A') });
  history.commit(doc('A'));
  assert.equal(history.canUndo(), false, 'a no-op commit must not create an undo step');
  history.commit(doc('B'));
  assert.equal(history.canUndo(), true);
  history.commit(doc('B'));
  assert.equal(history.canUndo(), true);
  // One undo returns to A: the repeated B never stacked a second entry.
  assert.equal(history.undo().elements[0].text, 'A');
  assert.equal(history.canUndo(), false);
});

test('commit is key-order independent', () => {
  const history = createHistory({ initial: { version: 4, elements: [{ id: 'a', type: 'text', text: 'A' }], lengthMm: 40 } });
  history.commit({ lengthMm: 40, elements: [{ text: 'A', type: 'text', id: 'a' }], version: 4 });
  assert.equal(history.canUndo(), false, 'a clone that only reordered keys is not a change');

  history.commit({ lengthMm: 40, elements: [{ text: 'B', type: 'text', id: 'a' }], version: 4 });
  assert.equal(history.canUndo(), true, 'a real value change is still recorded');
});

test('reset clears the coalesce key so the next commit is a new step', () => {
  const history = createHistory({ initial: doc('A') });
  history.commit(doc('B'), { coalesceKey: 'typing' });
  history.reset(doc('B'));
  history.commit(doc('C'), { coalesceKey: 'typing' });
  assert.equal(history.canUndo(), true, 'reset must not let the next commit merge into the old key');
  assert.equal(history.undo().elements[0].text, 'B');
});

test('the present getter returns a deep clone', () => {
  const history = createHistory({ initial: doc('A') });
  const present = history.present;
  present.elements[0].text = 'mutated';
  assert.equal(history.present.elements[0].text, 'A');
  assert.equal(history.undo(), null, 'mutating a copy must not create history');
});

test('undo and redo still round-trip independent snapshots', () => {
  const history = createHistory({ initial: doc('A') });
  history.commit(doc('B'));
  history.commit(doc('C'));
  assert.equal(history.undo().elements[0].text, 'B');
  assert.equal(history.undo().elements[0].text, 'A');
  assert.equal(history.redo().elements[0].text, 'B');
  assert.equal(history.redo().elements[0].text, 'C');
});

/* ---------------- the retained-memory budget (P2a) ---------------- */

const IMAGE_SRC = `data:image/png;base64,${'A'.repeat(3_800_000)}`;
const imageDoc = (x) => ({
  version: 4,
  name: 'Untitled',
  lengthMm: 40,
  copies: 1,
  elements: [{ id: 'img', type: 'image', src: IMAGE_SRC, x }],
});

test('eighty image edits retain the configured byte budget, not eighty snapshots', () => {
  const history = createHistory({ initial: imageDoc(0) });
  for (let index = 1; index <= 80; index++) history.commit(imageDoc(index));

  assert.ok(
    history.retainedBytes <= CONFIG.history.maxBytes,
    `retained ${history.retainedBytes} bytes exceeds the ${CONFIG.history.maxBytes}-byte budget`
  );
  assert.ok(history.retainedEntries < 81, 'old snapshots were dropped before the entry limit');
  assert.equal(history.undo().elements[0].x, 79, 'the recent edit is still undoable');
  assert.ok(history.retainedBytes <= CONFIG.history.maxBytes, 'undo does not grow the retained set');
});

test('the budget always leaves one undo step, even when one snapshot exceeds it', () => {
  const history = createHistory({ initial: imageDoc(0), maxBytes: 1 });
  history.commit(imageDoc(1));
  assert.equal(history.canUndo(), true, 'an undo step is kept');
  assert.equal(history.present.elements[0].x, 1);
  assert.ok(history.retainedBytes > 1, 'the one-step floor is documented, not hidden');
  assert.equal(history.undo().elements[0].x, 0);
});

test('the size estimate counts the image source and every element, without serialising', () => {
  const small = estimateDocumentBytes({ elements: [{ type: 'text', text: 'hello' }] });
  const large = estimateDocumentBytes(imageDoc(0));
  assert.ok(large > IMAGE_SRC.length, 'a snapshot is at least its image source');
  assert.ok(large > small + IMAGE_SRC.length / 2, 'the image dominates the estimate');
});

/* ---------------- persisted snapshot and restore ---------------- */

test('snapshot returns an independent copy of both stacks', () => {
  const history = createHistory({ initial: doc('A') });
  history.commit(doc('B'));
  const snapshot = history.snapshot();
  assert.equal(snapshot.past.length, 1);
  assert.equal(snapshot.future.length, 0);
  snapshot.past[0].elements[0].text = 'mutated';
  assert.equal(history.undo().elements[0].text, 'A', 'mutating a snapshot must not rewrite history');
});

test('restore replaces present and both stacks without an undo step', () => {
  const changes = [];
  const history = createHistory({ initial: doc('A'), onChange: (state) => changes.push(state) });
  history.restore({ present: doc('Present'), past: [doc('Past')], future: [doc('Future')] }, { silent: true });
  assert.deepEqual(changes, [], 'silent restore does not notify');
  assert.equal(history.present.elements[0].text, 'Present');
  assert.equal(history.canUndo(), true);
  assert.equal(history.canRedo(), true);
  assert.equal(history.undo().elements[0].text, 'Past', 'the restored past is the undo target');
  assert.equal(history.redo().elements[0].text, 'Present');
  assert.equal(history.redo().elements[0].text, 'Future');
});

test('a non-silent restore notifies and resets coalescing', () => {
  const changes = [];
  const history = createHistory({ initial: doc('A'), onChange: (state) => changes.push(state) });
  history.commit(doc('B'), { coalesceKey: 'typing' });
  history.restore({ present: doc('Restored'), past: [doc('Old')], future: [] });
  assert.equal(changes.length, 2, 'the commit and the restore each notified');
  history.commit(doc('After'), { coalesceKey: 'typing' });
  assert.equal(history.undo().elements[0].text, 'Restored', 'a restore breaks the old coalescing window');
});

test('restore reapplies the entry cap and the byte budget', () => {
  const past = Array.from({ length: CONFIG.history.maxEntries + 3 }, (_, index) => doc(`Past ${index}`));
  const history = createHistory({ initial: doc('Present') });
  history.restore({ present: doc('Present'), past, future: [] }, { silent: true });
  assert.equal(history.retainedEntries, CONFIG.history.maxEntries + 1);
  assert.equal(history.undo().elements[0].text, `Past ${CONFIG.history.maxEntries + 2}`, 'the newest past entry survives');
});


/* ---------------- the estimate is a memory bound, not a schema (K-F2) ---------------- */

test('the estimate counts every retained string, whatever its key', () => {
  const documents = [
    { elements: [] },
    { elements: [{ type: 'text', text: 'x'.repeat(1000) }] },
    { unknownTopLevel: 'y'.repeat(250_000), elements: [] },
    { elements: [{ type: 'text', text: 'ok', unknownField: 'z'.repeat(250_000), nested: { deep: 'w'.repeat(10_000) } }] },
    {
      version: 4,
      name: 'N'.repeat(120),
      copies: 3,
      lengthMm: 40,
      notices: Array.from({ length: 20 }, (_, index) => `notice ${index} ${'q'.repeat(290)}`),
      elements: Array.from({ length: 50 }, (_, index) => ({ id: `e${index}`, type: 'rect', w: 10, h: 10, name: 'box' })),
    },
  ];
  for (const document of documents) {
    const estimate = estimateDocumentBytes(document);
    const serialised = JSON.stringify(document).length;
    assert.ok(estimate >= serialised, `estimate ${estimate} covers the serialised ${serialised} characters`);
    assert.ok(estimate <= serialised * 2 + 1024, `estimate ${estimate} stays proportional to ${serialised}`);
  }
});

test('a 250 kB unknown-field import keeps the snapshot budget and the entries', () => {
  const padded = 'z'.repeat(250_000);
  const hostile = {
    version: 4,
    name: 'Hostile',
    lengthMm: 40,
    copies: 1,
    padding: padded,
    elements: [{ id: 'a', type: 'text', text: 'x', padding: padded }],
  };
  // The shape owner strips the unknown fields, so every snapshot is a small
  // document and the estimate can tell the truth about it.
  const clean = validateDocument(hostile);
  assert.equal(Object.hasOwn(clean, 'padding'), false);
  assert.equal(Object.hasOwn(clean.elements[0], 'padding'), false);

  const history = createHistory({ initial: clean });
  for (let index = 1; index <= 80; index++) {
    history.commit({ ...clean, elements: [{ ...clean.elements[0], text: `x${index}` }] });
  }
  assert.ok(history.retainedBytes <= CONFIG.history.maxBytes, 'the byte budget holds');
  assert.equal(history.retainedEntries, 81, 'the count keeps all eighty edits, because the snapshots are small');
  assert.equal(history.undo().elements[0].text, 'x79');
});

/* ---------------- escapes and the injected byte budget (B-core-F3/F7) ---------------- */

test('the estimate counts JSON escapes, so it never undercounts a snapshot', () => {
  const withNewlines = validateDocument({
    lengthMm: 40,
    elements: Array.from({ length: 200 }, () => ({ type: 'text', text: '\n'.repeat(2000) })),
  });
  const control = validateDocument({
    lengthMm: 40,
    elements: [
      { type: 'text', text: '\u0001\u0002'.repeat(500) },
      { type: 'text', text: 'quote " backslash \\ tab\t' },
      { type: 'text', name: 'a\nb', text: 'emoji 😀 and a lone \ud800 surrogate' },
    ],
  });
  const documents = [
    withNewlines,
    control,
    { elements: [{ type: 'text', text: '\ud800\ud800' }] },
    { elements: [{ type: 'text', text: '😀😀' }] },
  ];
  for (const document of documents) {
    const estimate = estimateDocumentBytes(document);
    const serialised = JSON.stringify(document).length;
    assert.ok(estimate >= serialised, `estimate ${estimate} covers the escaped ${serialised}`);
    assert.ok(estimate <= serialised + 4096, `estimate ${estimate} is not wildly over ${serialised}`);
  }
  // The specific undercount the review measured: 2000 newlines are 4002 JSON
  // characters, not 2002.
  const one = { elements: [{ type: 'text', text: '\n'.repeat(2000) }] };
  assert.ok(estimateDocumentBytes(one) >= JSON.stringify(one).length);
});

test('the byte budget is the injected value, not the configured default', () => {
  const budget = 4096;
  const history = createHistory({ initial: doc('x'.repeat(1000)), maxBytes: budget });
  for (let index = 0; index < 40; index++) history.commit(doc(`${'x'.repeat(1000)}${index}`));
  assert.ok(history.retainedBytes <= budget, `retained ${history.retainedBytes} exceeds the injected ${budget}`);
  assert.ok(history.retainedEntries < 41, 'old snapshots were dropped at the injected budget');
  assert.ok(history.retainedEntries >= 2, 'at least one undo step survives');
  // A hard-coded 32 MiB would keep every snapshot, so the count proves the
  // parameter is read.
  assert.ok(history.retainedEntries < 10, `the injected budget is the one enforced (${history.retainedEntries} entries)`);
});
