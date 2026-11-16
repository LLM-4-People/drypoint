/**
 * E regression: the real hidden file input imports a transfer document, the
 * canvas and layers rebind to it, and one undo restores the previous label.
 * The parser and controller are unit-tested; this proves the wiring.
 *
 * Skips when no Chromium binary is available.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { CONFIG } from '../src/core/config.js';
import { openApp, withPage } from './helpers/browser-page.mjs';

test('the import input applies a document as one undoable step', async (t) => {
  await withPage(t, async ({ cdp, port }) => {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1024, height: 900, deviceScaleFactor: 1, mobile: false });
    await openApp(cdp, port);

    const envelope = {
      format: CONFIG.app.id,
      version: CONFIG.app.documentVersion,
      document: {
        version: CONFIG.app.documentVersion,
        name: 'Imported label',
        lengthMm: 60,
        copies: 1,
        elements: [
          {
            id: 'text_imported',
            type: 'text',
            name: 'Imported',
            text: 'Imported label',
            fontPx: 0,
            bold: true,
            align: 'center',
            valign: 'middle',
            x: 4,
            y: 17,
            w: 472,
            h: 62,
            rotation: 0,
            locked: false,
            visible: true,
          },
        ],
      },
    };

    const state = await cdp.evaluate(`(async () => {
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const input = document.querySelector('#importDocumentInput');
      if (!input) return { failure: 'no import input' };
      const file = new File([${JSON.stringify(JSON.stringify(envelope, null, 2))}], 'label.json', { type: 'application/json' });
      const transfer = new DataTransfer();
      transfer.items.add(file);
      input.files = transfer.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));

      const deadline = Date.now() + 5000;
      let layer = '';
      while (Date.now() < deadline) {
        layer = document.querySelector('#layerList .layer-name')?.textContent ?? '';
        if (layer === 'Imported') break;
        await wait(50);
      }
      await wait(150);
      const imported = {
        layer,
        name: document.querySelector('#docName').value,
        size: document.querySelector('#labelSize').textContent,
        canvasWidth: document.querySelector('#labelCanvas').width,
        undoDisabled: document.querySelector('#undoButton').disabled,
      };

      document.querySelector('#undoButton').click();
      const undoDeadline = Date.now() + 5000;
      while (Date.now() < undoDeadline) {
        layer = document.querySelector('#layerList .layer-name')?.textContent ?? '';
        if (layer === 'Hello') break;
        await wait(50);
      }
      return {
        imported,
        restored: {
          layer,
          name: document.querySelector('#docName').value,
          size: document.querySelector('#labelSize').textContent,
          canvasWidth: document.querySelector('#labelCanvas').width,
        },
      };
    })()`);

    assert.equal(state.failure, undefined, state.failure);
    assert.equal(state.imported.layer, 'Imported', 'the layer list shows the imported element');
    assert.equal(state.imported.name, 'Imported label', 'the document name follows the import');
    assert.equal(state.imported.size, '12 × 60 mm', 'the document length follows the import');
    assert.equal(state.imported.canvasWidth, 60 * 8, 'the canvas backing store was resized for 60 mm');
    assert.equal(state.imported.undoDisabled, false, 'the import is an undoable step');

    assert.equal(state.restored.layer, 'Hello', 'one undo restores the previous label');
    assert.equal(state.restored.name, 'Untitled');
    assert.equal(state.restored.size, '12 × 40 mm');
    assert.equal(state.restored.canvasWidth, 40 * 8);
  });
});
