/**
 * The browser harness timeout knob has one parser and two defaults; the page
 * mount honours the same knob the DevTools start already did.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { chromeTimeoutMs } from './helpers/env-timeout.mjs';

test('the Chrome timeout knob accepts only a positive finite override', () => {
  assert.equal(chromeTimeoutMs({}, 15000), 15000);
  assert.equal(chromeTimeoutMs({ D110_CHROME_TIMEOUT_MS: '' }, 15000), 15000);
  assert.equal(chromeTimeoutMs({ D110_CHROME_TIMEOUT_MS: '45000' }, 15000), 45000);
  for (const value of ['0', '-5', 'NaN', 'soon']) {
    assert.equal(chromeTimeoutMs({ D110_CHROME_TIMEOUT_MS: value }, 15000), 15000, `${value} falls back`);
  }
});

test('openApp waits for the mount under the configured timeout', async () => {
  // The harness is imported dynamically and driven with a fake CDP peer: no
  // Chromium is started, so this stays a unit test while proving the real
  // openApp default flows through the shared parser.
  const { mountTimeoutMs, openApp } = await import('./helpers/browser-page.mjs');
  assert.equal(mountTimeoutMs({ D110_CHROME_TIMEOUT_MS: '4321' }), 4321);

  const calls = [];
  const cdp = {
    send: async (method) => calls.push(method),
    evaluate: async () => ({ ready: 'loading', tools: 0, title: 'booting' }),
  };
  await assert.rejects(
    openApp(cdp, 1234, { timeoutMs: mountTimeoutMs({ D110_CHROME_TIMEOUT_MS: '50' }) }),
    /the editor did not mount within 50 ms/
  );
  assert.deepEqual(calls, ['Page.navigate']);
});
