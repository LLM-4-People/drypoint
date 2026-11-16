/**
 * K-F8: an import that had to drop something still says so.
 *
 * The success path in main.js builds one toast from `parseDocument`'s notices.
 * A mutation that removed that branch survived the suite, so this drives the
 * real file input with a real File and reads the real toast.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { delay, openApp, withPage } from './helpers/browser-page.mjs';

test('an import with a dropped element reports it in the one success toast', async (t) => {
  await withPage(t, async ({ cdp, port }) => {
    await openApp(cdp, port);

    const dropped = await cdp.evaluate(`(async () => {
      const body = JSON.stringify({
        format: 'drypoint',
        version: 4,
        // One valid element and one the schema must drop: the import succeeds
        // and carries one notice.
        document: {
          lengthMm: 40,
          elements: [
            { type: 'text', text: 'Kept' },
            { type: 'marquee', text: 'Not a label element' },
          ],
        },
      });
      const file = new File([body], 'label.json', { type: 'application/json' });
      const transfer = new DataTransfer();
      transfer.items.add(file);
      const input = document.querySelector('#importDocumentInput');
      input.files = transfer.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));

      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const text = document.querySelector('#toasts').textContent;
        if (text.includes('Label imported')) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      return {
        toast: document.querySelector('#toasts').textContent,
        layers: document.querySelectorAll('#layerList li').length,
        canvasLabel: document.querySelector('#labelCanvas').getAttribute('aria-label'),
      };
    })()`);

    assert.match(dropped.toast, /Label imported\./, 'the import succeeded');
    assert.match(
      dropped.toast,
      /1 element was dropped because it is not a valid element for this version\./,
      'the notice is in the success toast, not only the stage footer'
    );
    assert.equal(dropped.layers, 1, 'the valid element reached the one document owner');
    assert.match(dropped.canvasLabel, /1 element/, 'the canvas name follows the imported document');

    // The notice is also the persistent record on the imported document, so it
    // survives the transient toast (PR-F2).
    await delay(50);
    const hint = await cdp.evaluate("document.querySelector('#stageHint').textContent");
    assert.match(hint, /was dropped/, 'the stage footer carries the same notice');
  });
});
