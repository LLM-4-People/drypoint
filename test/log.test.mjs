import test from 'node:test';
import assert from 'node:assert/strict';

import { CONFIG } from '../src/core/config.js';
import { clearLog, createLogger, describeValue, getLogEntries, setLogLevel } from '../src/core/log.js';

test.after(() => {
  clearLog();
  setLogLevel(CONFIG.log.level);
});

function silence(t) {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  t.mock.method(console, 'error', () => {});
}

test('secret-shaped detail keys, bearer tokens and URL credentials are redacted', (t) => {
  silence(t);
  clearLog();
  setLogLevel('trace');
  const logger = createLogger('test.redaction');

  logger.info('auth Bearer abc.def-123', {
    password: 'hunter2',
    apiKey: 'k-123',
    nested: { access_token: 'tok-456', note: 'Authorization: Bearer zzz' },
    url: 'https://user:pass@example.com/path',
    plain: 'visible',
  });

  const [entry] = getLogEntries();
  const detail = String(entry.detail);
  for (const secret of ['hunter2', 'k-123', 'tok-456', 'abc.def-123', 'zzz', 'user:pass']) {
    assert.ok(!detail.includes(secret), `${secret} is not in the detail`);
    assert.ok(!entry.message.includes(secret), `${secret} is not in the message`);
  }
  assert.match(detail, /\[redacted\]/);
  assert.match(detail, /visible/);
  assert.match(detail, /https:\/\/\[redacted\]@example\.com\/path/);
});

test('the ring buffer keeps the newest entries and stays bounded', (t) => {
  silence(t);
  clearLog();
  setLogLevel('trace');
  const logger = createLogger('test.limit');
  const total = CONFIG.log.bufferSize + 5;

  for (let index = 0; index < total; index++) logger.info(`entry ${index}`);

  const entries = getLogEntries();
  assert.equal(entries.length, CONFIG.log.bufferSize);
  assert.equal(entries[0].message, 'entry 5');
  assert.equal(entries.at(-1).message, `entry ${total - 1}`);
});

test('the minimum level filters before anything is buffered', (t) => {
  silence(t);
  clearLog();
  setLogLevel('warn');
  const logger = createLogger('test.level');

  logger.info('hidden');
  logger.warn('shown');

  assert.deepEqual(getLogEntries().map((entry) => entry.message), ['shown']);
});

test('binary details are truncated to the configured byte budget', () => {
  const bytes = new Uint8Array(CONFIG.log.maxBytesShown + 4).fill(0);
  const described = describeValue(bytes);
  const [hex, suffix] = described.split(' … ');
  assert.equal(hex.split(' ').length, CONFIG.log.maxBytesShown);
  assert.equal(suffix, `(${bytes.length} bytes)`);
});

test('query-string secrets are redacted but the rest of the URL survives', async () => {
  const { redactText } = await import('../src/core/log.js');
  const text = redactText(
    'GET https://api.example.com/v1/items?access_token=tok-1&page=2&api_key=k-2 and /x?token=t-3&secret=s-4&password=p-5'
  );
  for (const secret of ['tok-1', 'k-2', 't-3', 's-4', 'p-5']) {
    assert.ok(!text.includes(secret), `${secret} is redacted`);
  }
  assert.match(text, /access_token=\[redacted\]/);
  assert.match(text, /api_key=\[redacted\]/);
  assert.match(text, /page=2/, 'an ordinary parameter is untouched');
  assert.match(text, /https:\/\/api\.example\.com\/v1\/items/);
});
