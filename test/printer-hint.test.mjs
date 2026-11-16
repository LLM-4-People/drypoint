/**
 * The saved-printer hint in the real Print panel: absent with no stored
 * identity, present while idle, and never a claim that the old link is live.
 *
 * The connected case is unit-tested in print-panel.test.mjs because a headless
 * page has no printer to connect.
 *
 * Skips when no Chromium binary is available.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { storageKey } from '../src/core/config.js';
import { delay, openApp, withPage } from './helpers/browser-page.mjs';

async function openPrintTab(cdp) {
  await cdp.evaluate("document.querySelector('#tab-print').click()");
  await delay(200);
}

test('the Print panel shows the saved printer only while idle', async (t) => {
  await withPage(t, async ({ cdp, port }) => {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1024, height: 900, deviceScaleFactor: 1, mobile: false });
    await openApp(cdp, port);
    await openPrintTab(cdp);

    const absent = await cdp.evaluate(`(() => {
      const hint = document.querySelector('.printer-hint');
      return { exists: Boolean(hint), hidden: hint?.hidden ?? null, text: hint?.textContent ?? '' };
    })()`);
    assert.equal(absent.exists, true, 'the printer group owns the hint line');
    assert.equal(absent.hidden, true, 'no stored identity means no hint');
    assert.equal(absent.text, '', 'a hidden hint carries no stale text');

    await cdp.evaluate(`localStorage.setItem(
      ${JSON.stringify(storageKey('printer'))},
      JSON.stringify({ version: 1, data: { kind: 'serial', id: '', name: 'D110 desk' } })
    )`);
    await openApp(cdp, port);
    await openPrintTab(cdp);

    const present = await cdp.evaluate(`(() => {
      const hint = document.querySelector('.printer-hint');
      return {
        hidden: hint?.hidden ?? null,
        text: hint?.textContent ?? '',
        connected: document.querySelector('#deviceDot')?.dataset.state ?? '',
      };
    })()`);
    assert.equal(present.hidden, false, 'an idle printer with a saved identity shows the hint');
    assert.equal(present.text, 'Last printer: D110 desk. Connect to use it again.');
    assert.equal(present.connected, 'offline', 'the hint does not invent a connection');
  });
});
