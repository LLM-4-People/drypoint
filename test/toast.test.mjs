import test from 'node:test';
import assert from 'node:assert/strict';

import { installDom } from './helpers/fake-dom.mjs';

const dom = installDom();
const { el } = await import('../src/core/dom.js');
const { toast } = await import('../src/ui/toast.js');

function host() {
  document.body.textContent = '';
  const node = el('div', { id: 'toasts' });
  document.body.append(node);
  return node;
}

const toastsIn = (node) => node.querySelectorAll('.toast').length;

test('a persistent toast has no timer and is removed only by its owner', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const node = host();
  const remove = toast('Changes are not being saved — storage is full or blocked', { tone: 'error', timeout: null, key: 'save' });
  assert.equal(toastsIn(node), 1);
  t.mock.timers.tick(60_000);
  assert.equal(toastsIn(node), 1, 'a persistent toast never times out');

  remove();
  t.mock.timers.tick(160);
  assert.equal(toastsIn(node), 0, 'the owner removes it');
});

test('a deduplicated key never stacks a second copy', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const node = host();
  const first = toast('Storage is blocked', { tone: 'error', timeout: null, key: 'save' });
  const second = toast('Storage is blocked', { tone: 'error', timeout: null, key: 'save' });
  assert.equal(first, second, 'the same key returns the same remover');
  assert.equal(toastsIn(node), 1, 'the duplicate is not stacked');
  first();
  t.mock.timers.tick(160);
  assert.equal(toastsIn(node), 0);
  // After the owner cleared it, the same failure can surface again.
  toast('Storage is blocked', { tone: 'error', timeout: null, key: 'save' });
  assert.equal(toastsIn(node), 1);
});

test('a transient toast still clears itself', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const node = host();
  toast('Saved', { timeout: 20 });
  assert.equal(toastsIn(node), 1);
  t.mock.timers.tick(20);
  t.mock.timers.tick(160);
  assert.equal(toastsIn(node), 0);
});

test('a persistent toast carries a real close button and one shared remover', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const node = host();
  let dismissals = 0;
  const remove = toast('Changes are not being saved', { tone: 'error', timeout: null, onDismiss: () => dismissals++ });
  const close = node.querySelector('.toast-close');
  assert.ok(close, 'a keyboard user needs a focusable control');
  assert.equal(close.tagName, 'BUTTON');
  assert.equal(close.type, 'button');
  assert.equal(close.getAttribute('aria-label'), 'Dismiss');

  // The button, the toast's click handler and the owner's remover all reach the
  // same remover; the guard makes the outcome single.
  close.dispatch('click');
  remove();
  node.dispatch('click');
  assert.equal(dismissals, 1, 'one dismissal is reported once');
  t.mock.timers.tick(160);
  assert.equal(toastsIn(node), 0);
});

test('a transient toast stays plain', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const node = host();
  toast('Saved', { timeout: 20 });
  assert.equal(node.querySelector('.toast-close'), null, 'a toast that clears itself needs no close control');
  t.mock.timers.tick(20);
  t.mock.timers.tick(160);
  assert.equal(toastsIn(node), 0);
});
