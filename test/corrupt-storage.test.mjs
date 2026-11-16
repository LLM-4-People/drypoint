/**
 * PR-F1, end to end: an unreadable stored label is kept, not silently replaced.
 *
 * The unit suite proves the store veto and the alert copy. This drives the real
 * page: seed `localStorage` the way a truncated write or a hand-edited value
 * would, reload, then prove the banner is visible, an edit does not overwrite
 * the raw value, a second reload still has it, and only the reset button
 * replaces it.
 *
 * Skips when no Chromium binary is available.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { openApp, withPage } from './helpers/browser-page.mjs';

const KEY = 'drypoint.document';
const INVALID = '{"lengthMm":40,"elements":"nope"}';
const TRUNCATED = '{"lengthMm":40,"elements":[{"type":"text","text":"Hi"';

/**
 * Seed storage, reload, and report what the page shows.
 * @param {{send: Function, evaluate: Function}} cdp
 * @param {number} port
 * @param {string} raw
 */
async function seedAndReload(cdp, port, raw) {
  await cdp.evaluate(`localStorage.setItem(${JSON.stringify(KEY)}, ${JSON.stringify(raw)})`);
  await openApp(cdp, port);
  return cdp.evaluate(`(() => {
    const alert = document.querySelector('#storageAlert');
    return {
      raw: localStorage.getItem(${JSON.stringify(KEY)}),
      visible: Boolean(alert) && !alert.hidden,
      text: document.querySelector('#storageAlertText')?.textContent ?? '',
      label: document.querySelector('#docName')?.value ?? '',
      layers: document.querySelectorAll('#layerList .layer-row').length,
    };
  })()`);
}

test('an invalid stored label is kept until the operator resets it', async (t) => {
  await withPage(t, async ({ cdp, port }) => {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1024, height: 900, deviceScaleFactor: 1, mobile: false });
    await openApp(cdp, port);

    const first = await seedAndReload(cdp, port, INVALID);
    assert.equal(first.raw, INVALID, 'the raw value is untouched');
    assert.equal(first.visible, true, 'the persistent notice is visible');
    assert.match(first.text, /could not be read/);
    assert.match(first.text, /kept exactly as it is/);
    assert.match(first.text, /until you reset it/);
    assert.match(first.text, /Export the raw value first/, 'export is offered as the backup step');
    assert.doesNotMatch(first.text, /or reset the label/, 'export never releases the write veto');
    assert.ok(first.layers > 0, 'the app is still usable with a blank label');

    // An edit must not overwrite the value it could not read.
    const afterEdit = await cdp.evaluate(`(async () => {
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const name = document.querySelector('#docName');
      name.value = 'Edited while unreadable';
      name.dispatchEvent(new Event('input', { bubbles: true }));
      await wait(500);
      return localStorage.getItem(${JSON.stringify(KEY)});
    })()`);
    assert.equal(afterEdit, INVALID, 'the edit was not persisted over the raw value');

    // A reload keeps both the raw value and the notice, and the unrelated
    // library label still has the edit that was saved beside it.
    const second = await seedAndReload(cdp, port, INVALID);
    assert.equal(second.raw, INVALID);
    assert.equal(second.visible, true);
    assert.equal(second.label, 'Edited while unreadable', 'the library label saved and reloaded');

    // Export the raw value: the download owner runs and reports success.
    const exported = await cdp.evaluate(`(async () => {
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      document.querySelector('#storageExportRaw').click();
      await wait(200);
      return {
        toasts: [...document.querySelectorAll('#toasts *')].map((node) => node.textContent).join(' '),
        raw: localStorage.getItem(${JSON.stringify(KEY)}),
      };
    })()`);
    assert.match(exported.toasts, /Raw stored label exported/, 'the export reaches the one toast channel');
    assert.equal(exported.raw, INVALID, 'exporting does not modify the stored value');

    // Reset asks first. A cancel keeps the raw value, the banner and the veto.
    const cancelled = await cdp.evaluate(`(async () => {
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      document.querySelector('#storageReset').click();
      await wait(100);
      const dialog = document.querySelector('.modal');
      const cancel = [...document.querySelectorAll('.modal-foot button')].find((button) => button.textContent.trim() === 'Cancel');
      cancel?.click();
      await wait(200);
      const name = document.querySelector('#docName');
      name.value = 'Edited after a cancelled reset';
      name.dispatchEvent(new Event('input', { bubbles: true }));
      await wait(300);
      const alert = document.querySelector('#storageAlert');
      return {
        raw: localStorage.getItem(${JSON.stringify(KEY)}),
        visible: Boolean(alert) && !alert.hidden,
        dialogWasOpen: Boolean(dialog),
        dialogClosed: !document.querySelector('.modal'),
      };
    })()`);
    assert.equal(cancelled.dialogWasOpen, true, 'the reset opened the shared confirmation');
    assert.equal(cancelled.dialogClosed, true, 'Cancel closes it');
    assert.equal(cancelled.raw, INVALID, 'a cancelled reset keeps the raw value');
    assert.equal(cancelled.visible, true, 'and the quarantine banner');
    assert.equal(cancelled.dialogClosed && cancelled.raw === INVALID, true, 'the write veto still holds');

    // Reset is the only path that replaces it.
    const reset = await cdp.evaluate(`(async () => {
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      document.querySelector('#storageReset').click();
      await wait(100);
      const confirm = [...document.querySelectorAll('.modal-foot button')].find(
        (button) => button.textContent.trim() === 'Reset the label'
      );
      confirm?.click();
      await wait(500);
      const alert = document.querySelector('#storageAlert');
      return {
        raw: localStorage.getItem(${JSON.stringify(KEY)}),
        visible: Boolean(alert) && !alert.hidden,
      };
    })()`);
    assert.equal(reset.visible, false, 'the notice disappears after the reset');
    assert.equal(reset.raw, null, 'the legacy key is removed, not overwritten');
    const fresh = await cdp.evaluate(`(() => ({
      name: document.querySelector('#docName')?.value ?? '',
      layers: document.querySelectorAll('#layerList .layer-row').length,
    }))()`);
    assert.equal(fresh.name, 'Untitled', 'a fresh default label is open');
    assert.ok(fresh.layers > 0, 'the fresh label is usable');

    // And a fresh reload no longer warns.
    await openApp(cdp, port);
    const settled = await cdp.evaluate(`(() => ({
      visible: !document.querySelector('#storageAlert').hidden,
      raw: localStorage.getItem(${JSON.stringify(KEY)}),
    }))()`);
    assert.equal(settled.visible, false);
  });
});

test('a truncated stored label is quarantined the same way', async (t) => {
  await withPage(t, async ({ cdp, port }) => {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1024, height: 900, deviceScaleFactor: 1, mobile: false });
    await openApp(cdp, port);

    const state = await seedAndReload(cdp, port, TRUNCATED);
    assert.equal(state.raw, TRUNCATED, 'the truncated text survives exactly');
    assert.equal(state.visible, true, 'the notice is shown for a parse failure too');
    assert.match(state.text, /could not be read/);
  });
});

test('a v3 label with a non-array element list is quarantined, not blanked', async (t) => {
  // Triple-check Low: the v3 migration used to turn this into an empty label,
  // so the next edit overwrote the only copy. It is a shape error now, and the
  // same banner and write veto apply.
  const V3_INVALID = '{"version":3,"lengthMm":40,"elements":"nope"}';
  await withPage(t, async ({ cdp, port }) => {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1024, height: 900, deviceScaleFactor: 1, mobile: false });
    await openApp(cdp, port);

    const state = await seedAndReload(cdp, port, V3_INVALID);
    assert.equal(state.raw, V3_INVALID, 'the raw v3 value is kept exactly');
    assert.equal(state.visible, true, 'the quarantine banner is shown');
    assert.match(state.text, /could not be read/);
    assert.match(state.text, /until you reset it/);

    const afterEdit = await cdp.evaluate(`(async () => {
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const name = document.querySelector('#docName');
      name.value = 'Edited while unreadable v3';
      name.dispatchEvent(new Event('input', { bubbles: true }));
      await wait(500);
      return localStorage.getItem(${JSON.stringify(KEY)});
    })()`);
    assert.equal(afterEdit, V3_INVALID, 'an edit cannot overwrite the quarantined v3 value');
  });
});
