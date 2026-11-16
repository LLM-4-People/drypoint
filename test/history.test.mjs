import test from 'node:test';
import assert from 'node:assert/strict';

import { createHistory } from '../src/label/history.js';

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
