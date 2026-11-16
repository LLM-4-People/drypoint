/**
 * R5D-3: #stageHint is a role=status live region. Rewriting it with identical
 * text makes assistive technology re-announce the same warning on every
 * rerender. The shared setText owner skips an unchanged value, so five edits
 * that leave the footer text the same must produce zero mutations.
 *
 * Skips when no Chromium binary is available.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { openApp, withPage } from './helpers/browser-page.mjs';

test('an unchanged stage footer produces no live-region mutation', async (t) => {
  await withPage(t, async ({ cdp, port }) => {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1024, height: 900, deviceScaleFactor: 1, mobile: false });
    await openApp(cdp, port);

    const result = await cdp.evaluate(`(async () => {
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const hint = document.querySelector('#stageHint');
      if (!hint) return { failure: 'no stage hint' };
      const name = document.querySelector('#docName');
      if (!name) return { failure: 'no document name field' };
      // Give the label a real, stable warning: a QR over the default text.
      const addQr = document.querySelector('#toolRail button[title="Add QR code"]');
      if (!addQr) return { failure: 'no add-QR button' };
      addQr.click();
      await wait(200);
      if (!hint.textContent.trim()) return { failure: 'expected a warning in the footer' };
      let records = 0;
      const observer = new MutationObserver((entries) => {
        records += entries.length;
      });
      observer.observe(hint, { childList: true, characterData: true, subtree: true });
      name.focus();
      for (const value of ['A', 'AB', 'ABC', 'ABCD', 'ABCDE']) {
        name.value = value;
        name.dispatchEvent(new Event('input', { bubbles: true }));
        await wait(40);
      }
      await wait(80);
      observer.disconnect();
      return { records, text: hint.textContent };
    })()`);

    assert.equal(result.failure, undefined, result.failure);
    assert.equal(result.records, 0, `the live region was rewritten ${result.records} times`);

    assert.equal(result.failure, undefined, result.failure);
    assert.equal(result.records, 0, `the live region was rewritten ${result.records} times`);
  });
});
