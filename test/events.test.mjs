import test from 'node:test';
import assert from 'node:assert/strict';

import { createEmitter } from '../src/core/events.js';
import { clearLog, getLogEntries, setLogLevel } from '../src/core/log.js';

test.after(() => clearLog());

test('a throwing handler does not stop the others and is logged at debug', (t) => {
  t.mock.method(console, 'log', () => {});
  clearLog();
  setLogLevel('debug');

  const events = createEmitter();
  const seen = [];
  events.on('state', () => {
    throw new Error('handler exploded');
  });
  events.on('state', (payload) => seen.push(payload));

  events.emit('state', { status: 'connected' });

  assert.deepEqual(seen, [{ status: 'connected' }]);
  const entry = getLogEntries().find((item) => item.message === 'event handler threw');
  assert.ok(entry, 'the failure is in the diagnostics log');
  assert.match(String(entry.detail), /handler exploded/);
  assert.match(String(entry.detail), /state/, 'the event type is named');
});

test('on, once and off are the only subscription lifecycle', () => {
  const events = createEmitter();
  const calls = [];
  const off = events.on('x', (value) => calls.push(value));
  events.once('x', (value) => calls.push(`once:${value}`));

  events.emit('x', 1);
  events.emit('x', 2);
  assert.deepEqual(calls, [1, 'once:1', 2]);

  off();
  events.emit('x', 3);
  assert.deepEqual(calls, [1, 'once:1', 2]);

  events.clear();
  events.emit('x', 4);
  assert.deepEqual(calls, [1, 'once:1', 2]);
});
