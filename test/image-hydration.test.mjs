/**
 * A1 regression: a hidden image is never decoded at boot. When the operator
 * reveals it, the next repaint must start the decode; otherwise the canvas
 * paints "still loading" forever. The unit suite cannot see the missing
 * document argument; only the real page can.
 *
 * Skips when no Chromium binary is available.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { clearStorage, openApp, withPage } from './helpers/browser-page.mjs';

const IMAGE = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAEklEQVR42mO4IyLyHxkzkC4AAEOYIDG5ZtfkAAAAAElFTkSuQmCC';

test('a hidden image revealed after boot is decoded and painted', async (t) => {
  await withPage(t, async ({ cdp, port }) => {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1024, height: 900, deviceScaleFactor: 1, mobile: false });
    await openApp(cdp, port);
    // Start from an empty library so the seeded legacy value is the one the
    // migration reads, not a second label beside the boot default.
    await clearStorage(cdp);

    // Seed the one stored document the app reads at boot. The image starts
    // hidden, so neither the boot hydration nor the first render decodes it.
    await cdp.evaluate(`(() => {
      const document = {
        version: 4,
        name: 'Hidden image',
        lengthMm: 40,
        copies: 1,
        elements: [{
          id: 'image_1', type: 'image', name: 'Photo',
          src: ${JSON.stringify(IMAGE)},
          x: 4, y: 4, w: 40, h: 40,
          rotation: 0, locked: false, visible: false,
          fit: 'contain', dither: 'threshold',
        }],
      };
      localStorage.setItem('drypoint.document', JSON.stringify(document));
      return true;
    })()`);
    await openApp(cdp, port);

    const before = await cdp.evaluate(`(() => {
      const canvas = document.querySelector('#labelCanvas');
      const ctx = canvas.getContext('2d');
      const pixel = [...ctx.getImageData(24, 24, 1, 1).data];
      return {
        hint: document.querySelector('#stageHint').textContent,
        rows: document.querySelectorAll('#layerList .layer-row').length,
        pixel,
      };
    })()`);
    assert.equal(before.rows, 1, 'the hidden layer is listed');
    assert.equal(before.hint, '', 'a hidden image produces no loading warning');
    assert.deepEqual(before.pixel.slice(0, 3), [255, 255, 255], 'the hidden image is not painted');

    const after = await cdp.evaluate(`(async () => {
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const row = document.querySelector('#layerList .layer-row[data-id="image_1"]');
      if (!row) return { failure: 'no image layer row' };
      const toggle = row.querySelector('button[data-action="visibility"]');
      if (!toggle) return { failure: 'no visibility action' };
      toggle.click();
      const deadline = Date.now() + 5000;
      let hint = '';
      let pixel = [255, 255, 255, 255];
      while (Date.now() < deadline) {
        hint = document.querySelector('#stageHint').textContent;
        pixel = [...document.querySelector('#labelCanvas').getContext('2d').getImageData(24, 24, 1, 1).data];
        if (pixel[0] < 128 && !/still loading/.test(hint)) break;
        await wait(50);
      }
      await wait(100);
      hint = document.querySelector('#stageHint').textContent;
      const selection = document.querySelector('#layerList .layer-row[data-id="image_1"] .layer-select');
      return {
        hint,
        pixel: [...document.querySelector('#labelCanvas').getContext('2d').getImageData(24, 24, 1, 1).data],
        visible: selection?.getAttribute('aria-current') !== null,
      };
    })()`);

    assert.equal(after.failure, undefined, after.failure);
    assert.doesNotMatch(after.hint, /still loading/, 'revealing the image started its decode');
    assert.ok(after.pixel[0] < 128, `the revealed image is painted (pixel ${after.pixel.join(',')})`);
  });
});
