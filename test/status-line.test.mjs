/**
 * K-F9: the status line's hold and its cancellation, on a fake clock.
 *
 * main.js used to own this timer inline, so the two behaviours that matter,
 * a toned line reverts, an untoned line survives an earlier timer, had no
 * test. The owner is now shared and injectable.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { createStatusLine } from '../src/ui/status-line.js';

function clock() {
  let next = 1;
  const jobs = new Map();
  return {
    schedule(callback) {
      const id = next++;
      jobs.set(id, callback);
      return id;
    },
    cancel(id) {
      jobs.delete(id);
    },
    advance() {
      const pending = [...jobs.values()];
      jobs.clear();
      for (const callback of pending) callback();
    },
    get pending() {
      return jobs.size;
    },
  };
}

const element = () => ({ textContent: '', dataset: {} });

test('a toned status holds, then falls back to the live connection state', () => {
  for (const connected of [true, false]) {
    const node = element();
    const timers = clock();
    const line = createStatusLine({ element: node, connected: () => connected, holdMs: 4000, ...timers });

    line.write('Saved', 'ok');
    assert.equal(node.textContent, 'Saved');
    assert.equal(node.dataset.tone, 'ok');
    assert.equal(timers.pending, 1, 'one pending revert');

    timers.advance();
    assert.equal(node.textContent, connected ? 'Ready' : '');
    assert.equal(node.dataset.tone, '');
    assert.equal(timers.pending, 0);
  }
});

test('an untoned status cancels a pending revert and stands', () => {
  const node = element();
  const timers = clock();
  const line = createStatusLine({ element: node, connected: () => true, holdMs: 4000, ...timers });

  line.write('Saved', 'ok');
  line.write('Disconnected');
  assert.equal(timers.pending, 0, 'the earlier timer cannot wipe the disconnect line');

  timers.advance();
  assert.equal(node.textContent, 'Disconnected', 'an idle disconnect stays until something replaces it');
  assert.equal(node.dataset.tone, '');
});

test('a newer toned status replaces the older timer, never stacks it', () => {
  const node = element();
  const timers = clock();
  const line = createStatusLine({ element: node, connected: () => false, holdMs: 4000, ...timers });

  line.write('First', 'ok');
  line.write('Second', 'error');
  assert.equal(timers.pending, 1, 'one timer for the newest status');
  timers.advance();
  assert.equal(node.textContent, '', 'the newest timer owns the revert');
  assert.equal(node.dataset.tone, '');
});
