import test from 'node:test';
import assert from 'node:assert/strict';

import { CONFIG } from '../src/core/config.js';
import { createHistory, estimateDocumentBytes } from '../src/label/history.js';

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
