import test from 'node:test';
import assert from 'node:assert/strict';

import { isFieldElement, shortcutIntent } from '../src/editor/shortcuts.js';

const key = (props) => ({ key: '', ctrlKey: false, metaKey: false, shiftKey: false, ...props });

test('Ctrl+D never duplicates from a text field', () => {
  const event = key({ key: 'd', ctrlKey: true });
  assert.equal(shortcutIntent(event, { inField: true, hasSelection: true }), null);
  assert.deepEqual(shortcutIntent(event, { inField: false, hasSelection: true }), { type: 'duplicate' });
  assert.equal(shortcutIntent(event, { inField: false, hasSelection: false }), null);
  assert.equal(shortcutIntent(key({ key: 'd' }), { inField: false, hasSelection: true }), null, 'plain D is typing');
});

test('native undo and redo keep the field when one is focused', () => {
  assert.equal(shortcutIntent(key({ key: 'z', ctrlKey: true }), { inField: true }), null);
  assert.equal(shortcutIntent(key({ key: 'y', ctrlKey: true }), { inField: true }), null);
  assert.deepEqual(shortcutIntent(key({ key: 'z', ctrlKey: true }), {}), { type: 'undo' });
  assert.deepEqual(shortcutIntent(key({ key: 'z', ctrlKey: true, shiftKey: true }), {}), { type: 'redo' });
  assert.deepEqual(shortcutIntent(key({ key: 'y', metaKey: true }), {}), { type: 'redo' });
});

test('Ctrl+Enter prints, except while a dialog owns the keyboard', () => {
  assert.deepEqual(shortcutIntent(key({ key: 'Enter', ctrlKey: true }), { inField: true }), { type: 'print' });
  assert.equal(shortcutIntent(key({ key: 'Enter', ctrlKey: true }), { hasDialog: true }), null);
  assert.equal(shortcutIntent(key({ key: 'Enter' }), {}), null);
});

test('editor keys stay inert while a field is focused', () => {
  const context = { inField: true, hasSelection: true };
  for (const event of [key({ key: 'Delete' }), key({ key: 'Backspace' }), key({ key: 'Escape' }), key({ key: 'ArrowLeft' })]) {
    assert.equal(shortcutIntent(event, context), null, event.key);
  }
});

test('delete, escape and nudge map to editor intents', () => {
  assert.deepEqual(shortcutIntent(key({ key: 'Delete' }), { hasSelection: true }), { type: 'delete' });
  assert.deepEqual(shortcutIntent(key({ key: 'Backspace' }), { hasSelection: true }), { type: 'delete' });
  assert.equal(shortcutIntent(key({ key: 'Delete' }), { hasSelection: false }), null);
  assert.deepEqual(shortcutIntent(key({ key: 'Escape' }), {}), { type: 'deselect' });
  assert.deepEqual(shortcutIntent(key({ key: 'ArrowLeft' }), { hasSelection: true }), { type: 'nudge', key: 'ArrowLeft', step: 1 });
  assert.deepEqual(shortcutIntent(key({ key: 'ArrowUp', shiftKey: true }), { hasSelection: true }), { type: 'nudge', key: 'ArrowUp', step: 8 });
  assert.equal(shortcutIntent(key({ key: 'ArrowLeft' }), { hasSelection: false }), null);
});

test('the field detector matches the elements that own the keyboard', () => {
  assert.equal(isFieldElement({ tagName: 'INPUT' }), true);
  assert.equal(isFieldElement({ tagName: 'TEXTAREA' }), true);
  assert.equal(isFieldElement({ tagName: 'SELECT' }), true);
  assert.equal(isFieldElement({ tagName: 'BUTTON' }), false);
  assert.equal(isFieldElement(null), false);
});
