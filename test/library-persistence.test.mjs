/**
 * The library persistence contract in a real page: the current label and its
 * undo/redo history survive a reload, and selection, tab and scroll restore.
 *
 * Skips when no Chromium binary is available.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { openApp, withPage, delay } from './helpers/browser-page.mjs';

const NAME_INPUT = "document.querySelector('#docName')";

async function rename(cdp, name) {
  await cdp.evaluate(`(() => {
    const input = ${NAME_INPUT};
    input.value = ${JSON.stringify(name)};
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  // 120 ms document debounce and 250 ms history debounce, with room to spare.
  await delay(700);
}

test('the current label and its undo and redo history survive a reload', async (t) => {
  await withPage(t, async ({ cdp, port }) => {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1024, height: 900, deviceScaleFactor: 1, mobile: false });
    await openApp(cdp, port);
    await delay(200);

    await rename(cdp, 'History first');
    await rename(cdp, 'History second');

    await openApp(cdp, port);
    await delay(300);
    const loaded = await cdp.evaluate(`(() => ({
      name: ${NAME_INPUT}.value,
      undoDisabled: document.querySelector('#undoButton').disabled,
      redoDisabled: document.querySelector('#redoButton').disabled,
    }))()`);
    assert.equal(loaded.name, 'History second', 'the current label reloaded');
    assert.equal(loaded.undoDisabled, false, 'undo is available after the reload');
    assert.equal(loaded.redoDisabled, true, 'there is nothing to redo yet');

    await cdp.evaluate("document.querySelector('#undoButton').click()");
    await delay(700);
    assert.equal(await cdp.evaluate(`${NAME_INPUT}.value`), 'History first', 'undo works after the reload');

    await openApp(cdp, port);
    await delay(300);
    const reloaded = await cdp.evaluate(`(() => ({
      name: ${NAME_INPUT}.value,
      redoDisabled: document.querySelector('#redoButton').disabled,
    }))()`);
    assert.equal(reloaded.name, 'History first', 'the undone document was saved');
    assert.equal(reloaded.redoDisabled, false, 'redo survived the second reload');

    await cdp.evaluate("document.querySelector('#redoButton').click()");
    await delay(700);
    assert.equal(await cdp.evaluate(`${NAME_INPUT}.value`), 'History second', 'redo works after the reload');

    await openApp(cdp, port);
    await delay(300);
    assert.equal(await cdp.evaluate(`${NAME_INPUT}.value`), 'History second', 'the redone document was saved');
  });
});

test('selection, tab and scroll offsets restore after a reload', async (t) => {
  await withPage(t, async ({ cdp, port }) => {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1024, height: 600, deviceScaleFactor: 1, mobile: false });
    await openApp(cdp, port);
    await delay(200);

    // Enough layers to overflow the list, and a high zoom so the stage scrolls.
    await cdp.evaluate(`(() => {
      const add = document.querySelector('#toolRail button[title="Add text"]');
      for (let index = 0; index < 14; index++) add.click();
      const zoom = document.querySelector('#zoomControls button[title="Zoom in"]');
      for (let index = 0; index < 20; index++) zoom.click();
    })()`);
    await delay(700);

    const selected = await cdp.evaluate(`(() => {
      const row = document.querySelectorAll('#layerList .layer-row')[4];
      row.querySelector('.layer-select').click();
      return row.dataset.id;
    })()`);

    await cdp.evaluate(`(() => {
      const stage = document.querySelector('#stageScroll');
      stage.scrollLeft = 240;
      stage.scrollTop = 120;
      document.querySelector('#layerList').scrollTop = 180;
      document.querySelector('#tab-print').click();
      document.querySelector('#panelBody').scrollTop = 200;
    })()`);
    await delay(700);

    const expected = await cdp.evaluate(`(() => {
      const stage = document.querySelector('#stageScroll');
      return {
        selected: document.querySelector('#layerList .layer-row[data-selected="true"]')?.dataset.id ?? '',
        tab: document.querySelector('#tab-print').getAttribute('aria-selected'),
        stageX: stage.scrollLeft,
        stageY: stage.scrollTop,
        layersY: document.querySelector('#layerList').scrollTop,
        panelY: document.querySelector('#panelBody').scrollTop,
      };
    })()`);
    assert.equal(expected.selected, selected, 'the chosen layer is selected before the reload');
    assert.equal(expected.tab, 'true', 'the Print tab is active before the reload');
    assert.ok(expected.stageX > 0 && expected.stageY > 0, `the stage scrolled (${expected.stageX}, ${expected.stageY})`);
    assert.ok(expected.layersY > 0, `the layer list scrolled (${expected.layersY})`);
    assert.ok(expected.panelY > 0, `the panel scrolled (${expected.panelY})`);

    await openApp(cdp, port);
    await delay(500);
    const restored = await cdp.evaluate(`(() => {
      const stage = document.querySelector('#stageScroll');
      return {
        selected: document.querySelector('#layerList .layer-row[data-selected="true"]')?.dataset.id ?? '',
        tab: document.querySelector('#tab-print').getAttribute('aria-selected'),
        designTab: document.querySelector('#tab-design').getAttribute('aria-selected'),
        panelLabel: document.querySelector('#panelBody').getAttribute('aria-labelledby'),
        stageX: stage.scrollLeft,
        stageY: stage.scrollTop,
        layersY: document.querySelector('#layerList').scrollTop,
        panelY: document.querySelector('#panelBody').scrollTop,
      };
    })()`);
    assert.equal(restored.selected, expected.selected, 'the selection restored');
    assert.equal(restored.tab, 'true', 'the Print tab restored');
    assert.equal(restored.designTab, 'false');
    assert.equal(restored.panelLabel, 'tab-print', 'the panel is labelled by the restored tab');
    assert.ok(Math.abs(restored.stageX - expected.stageX) <= 1, `stage X restored (${restored.stageX})`);
    assert.ok(Math.abs(restored.stageY - expected.stageY) <= 1, `stage Y restored (${restored.stageY})`);
    assert.ok(Math.abs(restored.layersY - expected.layersY) <= 1, `layer scroll restored (${restored.layersY})`);
    assert.ok(Math.abs(restored.panelY - expected.panelY) <= 1, `panel scroll restored (${restored.panelY})`);
  });
});

test('an unreadable stored record does not block saving a readable label', async (t) => {
  await withPage(t, async ({ cdp, port }) => {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1024, height: 900, deviceScaleFactor: 1, mobile: false });
    await openApp(cdp, port);
    await delay(200);
    await rename(cdp, 'Readable label');

    // A hand-edited or partially written record: valid metadata, a document
    // that cannot pass validation, and the current pointer aimed at it.
    await cdp.evaluate(`(async () => {
      const request = indexedDB.open('drypoint', 1);
      const db = await new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      await new Promise((resolve, reject) => {
        const transaction = db.transaction(['labels', 'documents', 'meta'], 'readwrite');
        transaction.objectStore('labels').put({
          id: 'corrupt-label', name: 'Corrupt', createdAt: 1, updatedAt: Date.now() + 100000, elementCount: 1,
        });
        transaction.objectStore('documents').put({ id: 'corrupt-label', document: { lengthMm: 40, elements: 'nope' } });
        transaction.objectStore('meta').put({ key: 'currentLabelId', value: 'corrupt-label' });
        transaction.oncomplete = resolve;
        transaction.onerror = () => reject(transaction.error);
      });
      db.close();
    })()`);

    await openApp(cdp, port);
    await delay(300);
    assert.equal(await cdp.evaluate(`${NAME_INPUT}.value`), 'Readable label', 'boot skipped the unreadable record');

    await rename(cdp, 'Still saves beside a corrupt record');
    await openApp(cdp, port);
    await delay(300);
    assert.equal(await cdp.evaluate(`${NAME_INPUT}.value`), 'Still saves beside a corrupt record');

    const corrupt = await cdp.evaluate(`(async () => {
      const request = indexedDB.open('drypoint', 1);
      const db = await new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const record = await new Promise((resolve, reject) => {
        const transaction = db.transaction('documents', 'readonly');
        const get = transaction.objectStore('documents').get('corrupt-label');
        get.onsuccess = () => resolve(get.result);
        get.onerror = () => reject(get.error);
      });
      db.close();
      return record?.document?.elements ?? null;
    })()`);
    assert.equal(corrupt, 'nope', 'the unreadable record was kept, not overwritten');
  });
});
