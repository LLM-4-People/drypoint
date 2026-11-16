/**
 * R5D-2: a toast raised while a dialog is open must be readable above it.
 *
 * The log viewer's Export action reports "Diagnostics exported" through the
 * one toast layer while its own modal is still open. This runs the real page in
 * Chromium and asks the browser what is painted at the toast's centre.
 *
 * Skips when no Chromium binary is available.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { delay, withPage } from './helpers/browser-page.mjs';

test('a toast raised from a dialog is painted above the dialog', async (t) => {
  await withPage(t, async ({ cdp, port }) => {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: false });
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${port}/` });
    await delay(1300);

    const state = await cdp.evaluate(`(async () => {
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      document.querySelector('#tab-print').click();
      await wait(80);
      const openLog = [...document.querySelectorAll('button')].find((button) => button.textContent.trim() === 'Open log');
      if (!openLog) return { failure: 'no Open log button' };
      openLog.click();
      await wait(150);
      const backdrop = document.querySelector('.modal-backdrop');
      if (!backdrop) return { failure: 'no dialog opened' };
      const exportButton = [...backdrop.querySelectorAll('button')].find((button) => button.textContent.trim() === 'Export');
      if (!exportButton) return { failure: 'no Export action' };
      exportButton.click();
      await wait(150);
      const toast = document.querySelector('#toasts .toast');
      if (!toast) return { failure: 'no toast raised' };
      const rect = toast.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      return {
        toastText: toast.textContent,
        hitInsideToast: Boolean(hit && (toast === hit || toast.contains(hit))),
        hitTag: hit ? hit.tagName + '.' + hit.className : null,
        toastZ: getComputedStyle(document.querySelector('#toasts')).zIndex,
        backdropZ: getComputedStyle(backdrop).zIndex,
      };
    })()`);

    assert.equal(state.failure, undefined, state.failure);
    assert.match(state.toastText, /Diagnostics exported/);
    assert.equal(state.hitInsideToast, true, `elementFromPoint shows ${state.hitTag}, not the toast`);
    assert.equal(Number(state.toastZ), 80, 'the toast layer is above the backdrop');
    assert.equal(Number(state.backdropZ), 70, 'the backdrop itself did not move');
  });
});
