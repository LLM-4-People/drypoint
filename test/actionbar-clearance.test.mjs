/**
 * The action bar is measured, not guessed: a wrapped status line (and the
 * safe-area padding) makes the bar taller than any static token. This runs the
 * real page in Chromium and asserts the toast clears the bar at 390 with no
 * insets and at 360 with 44/44/34/44 insets.
 *
 * It skips when no Chromium binary is available; the rest of the suite needs no
 * browser.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { delay, withPage } from './helpers/browser-page.mjs';

test('the toasts clear the measured action bar with a status line and insets', async (t) => {
  await withPage(t, async ({ cdp, port }) => {
    const measure = async ({ width, height, insets }) => {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: true });
      const applied = await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets });
      assert.equal(applied.error, undefined, 'this Chromium supports safe-area emulation');
      await cdp.send('Page.navigate', { url: `http://127.0.0.1:${port}/` });
      await delay(1300);
      const state = await cdp.evaluate('location.href + " | " + document.title + " | " + Boolean(document.querySelector("#status"))');
      assert.equal(state.endsWith('true'), true, `the app document is loaded: ${state}`);
      return cdp.evaluate(`(async () => {
        const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const status = document.querySelector('#status');
        status.textContent = 'Printer stopped acknowledging writes; the link is closed';
        const host = document.querySelector('#toasts');
        host.innerHTML = '<div class="toast" style="min-height:40px">Changes are not being saved</div>';
        await wait(300);
        const barNode = document.querySelector('.actionbar');
        const bar = barNode.getBoundingClientRect();
        const toast = host.querySelector('.toast').getBoundingClientRect();
        return {
          barTop: bar.top,
          barHeight: bar.height,
          barOffset: barNode.offsetHeight,
          toastBottom: toast.bottom,
          token: getComputedStyle(document.documentElement).getPropertyValue('--actionbar-clearance').trim(),
          overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          pillWidth: document.querySelector('.device-pill').getBoundingClientRect().width,
        };
      })()`);
    };

    const plain = await measure({ width: 390, height: 844, insets: { top: 0, left: 0, bottom: 0, right: 0 } });
    assert.ok(plain.barHeight > 84, 'the wrapped status makes the bar taller than the old token');
    assert.equal(plain.token, `${plain.barOffset + 8}px`, 'the token is the measured height plus the one gap');
    assert.ok(plain.toastBottom <= plain.barTop - 7, `390: toast ${plain.toastBottom} clears bar ${plain.barTop}`);
    assert.equal(plain.overflowX, 0);

    const inset = await measure({ width: 360, height: 740, insets: { top: 44, left: 44, bottom: 34, right: 44 } });
    assert.ok(inset.barHeight > plain.barHeight, 'the safe-area padding is in the measured height');
    assert.equal(inset.token, `${inset.barOffset + 8}px`, 'the inset height is measured too, not assumed');
    assert.ok(inset.toastBottom <= inset.barTop - 7, `360+insets: toast ${inset.toastBottom} clears bar ${inset.barTop}`);
    assert.equal(inset.overflowX, 0, 'the 44px coarse pill still fits');
    assert.ok(inset.pillWidth >= 44, 'the device pill keeps a 44px tap target');
  });
});
