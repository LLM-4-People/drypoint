/**
 * The visible label library in a real page: the Document panel button, the
 * Labels modal, create/switch/rename/duplicate/delete/import, the live count,
 * focus behavior and the two measured layouts.
 *
 * Skips when no Chromium binary is available.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { CONFIG } from '../src/core/config.js';
import { delay, openApp, withPage } from './helpers/browser-page.mjs';

const NAME = "document.querySelector('#docName').value";
const COUNT = "document.querySelector('#libraryCount').textContent";

async function waitFor(cdp, expression, label, timeout = 7000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await cdp.evaluate(expression)) return;
    await delay(50);
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function openLabels(cdp) {
  await cdp.evaluate("document.querySelector('#openLibraryButton').click()");
  await waitFor(cdp, "Boolean(document.querySelector('.modal .label-list, .modal .empty'))", 'the Labels modal');
}

async function clickRow(cdp, name) {
  const clicked = await cdp.evaluate(`(() => {
    const row = [...document.querySelectorAll('.modal .label-row')].find(
      (node) => node.querySelector('.label-open')?.textContent === ${JSON.stringify(name)}
    );
    if (!row) return false;
    row.querySelector('.label-open').click();
    return true;
  })()`);
  assert.equal(clicked, true, `the row for ${name} exists`);
}

async function clickRowAction(cdp, name, action) {
  const clicked = await cdp.evaluate(`(() => {
    const row = [...document.querySelectorAll('.modal .label-row')].find(
      (node) => node.querySelector('.label-open')?.textContent === ${JSON.stringify(name)}
    );
    if (!row) return false;
    const button = [...row.querySelectorAll('.label-actions button')].find(
      (node) => node.textContent === ${JSON.stringify(action)}
    );
    if (!button) return false;
    button.click();
    return true;
  })()`);
  assert.equal(clicked, true, `${action} ${name} exists`);
}

async function clickFooter(cdp, label) {
  const clicked = await cdp.evaluate(`(() => {
    const button = [...document.querySelectorAll('.modal-foot button')].find(
      (node) => node.textContent === ${JSON.stringify(label)}
    );
    if (!button) return false;
    button.click();
    return true;
  })()`);
  assert.equal(clicked, true, `the ${label} footer action exists`);
}

async function confirmDelete(cdp) {
  await waitFor(cdp, "document.querySelectorAll('.modal').length === 2", 'the delete confirmation');
  const clicked = await cdp.evaluate(`(() => {
    const modals = [...document.querySelectorAll('.modal')];
    const confirm = modals.at(-1);
    const button = [...confirm.querySelectorAll('.modal-foot button')].find((node) => node.textContent === 'Delete');
    if (!button) return false;
    button.click();
    return true;
  })()`);
  assert.equal(clicked, true, 'the delete confirmation has a Delete action');
  await waitFor(cdp, "document.querySelectorAll('.modal').length === 0", 'the dialogs to close');
}

async function dismiss(cdp) {
  await cdp.evaluate(
    "window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))"
  );
  await waitFor(cdp, "!document.querySelector('.modal')", 'the dialog to close');
}

test('the Labels modal creates, switches, renames, duplicates, deletes and imports labels', async (t) => {
  await withPage(t, async ({ cdp, port }) => {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    await openApp(cdp, port);
    await waitFor(cdp, `${COUNT} === '1'`, 'the first label count');
    assert.equal(await cdp.evaluate(NAME), 'Untitled');

    // Give the first label a different canvas so a switch is visible in the
    // editor, not only in the header.
    await cdp.evaluate("document.querySelector('#toolRail button[title=\"Add QR code\"]').click()");
    await delay(700);
    assert.equal(await cdp.evaluate("document.querySelectorAll('#layerList .layer-row').length"), 2);

    await openLabels(cdp);
    const opened = await cdp.evaluate(`(() => {
      const dialog = document.querySelector('.modal');
      const current = document.querySelector('.label-row[aria-current="true"]');
      return {
        title: dialog?.querySelector('.modal-head h2')?.textContent,
        role: dialog?.getAttribute('role'),
        modal: dialog?.getAttribute('aria-modal'),
        inert: document.querySelector('#app').inert,
        listLabel: dialog?.querySelector('.label-list')?.getAttribute('aria-label'),
        rows: dialog?.querySelectorAll('.label-row').length,
        current: Boolean(current),
        badge: current?.querySelector('.label-current')?.textContent ?? '',
        openName: current?.querySelector('.label-open')?.textContent ?? '',
        count: document.querySelector('#libraryCount').textContent,
        countName: document.querySelector('#openLibraryButton').getAttribute('aria-label'),
        actions: [...(current?.querySelectorAll('.label-actions button') ?? [])].map((node) => node.textContent),
      };
    })()`);
    assert.equal(opened.title, 'Labels', 'the shared modal is titled Labels');
    assert.equal(opened.role, 'dialog');
    assert.equal(opened.modal, 'true');
    assert.equal(opened.inert, true, 'the app shell is inert behind the dialog');
    assert.equal(opened.listLabel, 'Saved labels');
    assert.equal(opened.rows, 1);
    assert.equal(opened.current, true, 'the open label is the current row');
    assert.equal(opened.badge, 'Current');
    assert.equal(opened.openName, 'Untitled');
    assert.equal(opened.count, '1');
    assert.equal(opened.countName, 'Open labels, 1 label', 'the count is in the accessible name');
    assert.deepEqual(opened.actions, ['Duplicate', 'Export', 'Delete']);

    await clickFooter(cdp, 'New label');
    await waitFor(cdp, "!document.querySelector('.modal')", 'the create action to close the dialog');
    await waitFor(cdp, `${NAME} === 'Untitled 2'`, 'the first new label');
    assert.equal(await cdp.evaluate(COUNT), '2');

    await openLabels(cdp);
    await clickFooter(cdp, 'New label');
    await waitFor(cdp, `${NAME} === 'Untitled 3'`, 'the second new label');
    assert.equal(await cdp.evaluate(COUNT), '3');
    assert.equal(
      await cdp.evaluate("document.querySelector('#openLibraryButton').getAttribute('aria-label')"),
      'Open labels, 3 labels'
    );

    await openLabels(cdp);
    await clickRow(cdp, 'Untitled');
    await waitFor(cdp, `${NAME} === 'Untitled'`, 'the switch to the first label');
    assert.equal(await cdp.evaluate("document.querySelectorAll('#layerList .layer-row').length"), 2, 'the first canvas follows');

    await openLabels(cdp);
    await clickRow(cdp, 'Untitled 2');
    await waitFor(cdp, `${NAME} === 'Untitled 2'`, 'the switch to the second label');
    assert.equal(await cdp.evaluate("document.querySelectorAll('#layerList .layer-row').length"), 1, 'the second canvas follows');

    await cdp.evaluate(`(() => {
      const input = document.querySelector('#docName');
      input.value = 'Renamed label';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await delay(700);

    await openLabels(cdp);
    const renamed = await cdp.evaluate(`(() => {
      const names = [...document.querySelectorAll('.label-row .label-open')].map((node) => node.textContent);
      return { names, current: document.querySelector('.label-row[aria-current="true"] .label-open')?.textContent ?? '' };
    })()`);
    assert.ok(renamed.names.includes('Renamed label'), 'the reopened list shows the new name');
    assert.equal(renamed.current, 'Renamed label');
    assert.equal(await cdp.evaluate(COUNT), '3', 'a rename does not change the count');

    await clickRowAction(cdp, 'Renamed label', 'Duplicate');
    await waitFor(cdp, "!document.querySelector('.modal')", 'the duplicate action to close the dialog');
    await waitFor(cdp, `${NAME} === 'Renamed label copy'`, 'the duplicated label to open');
    assert.equal(await cdp.evaluate(COUNT), '4');

    await openLabels(cdp);
    await clickRowAction(cdp, 'Renamed label copy', 'Delete');
    await confirmDelete(cdp);
    await waitFor(cdp, `${NAME} === 'Renamed label'`, 'the next label after deleting the current one');
    assert.equal(await cdp.evaluate(COUNT), '3', 'deleting the current label lowers the count');

    await openLabels(cdp);
    await clickRowAction(cdp, 'Untitled 3', 'Delete');
    await confirmDelete(cdp);
    assert.equal(await cdp.evaluate(NAME), 'Renamed label', 'deleting another label keeps the current one');
    assert.equal(await cdp.evaluate(COUNT), '2');

    await openLabels(cdp);
    const remaining = await cdp.evaluate(
      "[...document.querySelectorAll('.label-row .label-open')].map((node) => node.textContent)"
    );
    assert.deepEqual(remaining, ['Renamed label', 'Untitled'], 'the deleted rows are gone and the kept labels remain');

    // The modal's Import action must close the dialog and trigger the one
    // hidden file input. Replace only that element's click during the probe so
    // the headless browser never opens a native picker.
    const imported = await cdp.evaluate(`(() => {
      const input = document.querySelector('#importDocumentInput');
      input.click = () => { input.dataset.importTriggered = 'yes'; };
      const button = [...document.querySelectorAll('.modal-foot button')].find((node) => node.textContent === 'Import label');
      if (!button) return { clicked: false };
      button.click();
      return {
        clicked: true,
        triggered: input.dataset.importTriggered ?? '',
        modalOpen: Boolean(document.querySelector('.modal')),
      };
    })()`);
    assert.equal(imported.clicked, true, 'the modal has an Import label action');
    assert.equal(imported.triggered, 'yes', 'the modal import triggers the existing hidden input');
    assert.equal(imported.modalOpen, false, 'the modal closes before the file input opens');

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
            type: 'text',
            text: 'Imported label',
            x: 4,
            y: 17,
            w: 472,
            h: 62,
          },
        ],
      },
    };
    await cdp.evaluate(`(async () => {
      const input = document.querySelector('#importDocumentInput');
      delete input.click;
      const file = new File([${JSON.stringify(JSON.stringify(envelope, null, 2))}], 'label.json', { type: 'application/json' });
      const transfer = new DataTransfer();
      transfer.items.add(file);
      input.files = transfer.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await waitFor(cdp, `${NAME} === 'Imported label'`, 'the imported label to open');
    await waitFor(cdp, `${COUNT} === '3'`, 'the imported label count');
    assert.equal(await cdp.evaluate("document.querySelector('#labelSize').textContent"), '12 × 60 mm');

    await openLabels(cdp);
    const afterImport = await cdp.evaluate(`(() => ({
      names: [...document.querySelectorAll('.label-row .label-open')].map((node) => node.textContent),
      current: document.querySelector('.label-row[aria-current="true"] .label-open')?.textContent ?? '',
    }))()`);
    assert.ok(afterImport.names.includes('Renamed label'), 'import keeps the previously open label');
    assert.ok(afterImport.names.includes('Untitled'), 'import keeps every earlier label');
    assert.equal(afterImport.current, 'Imported label', 'the imported label is current');
    await dismiss(cdp);

    await openApp(cdp, port);
    await waitFor(cdp, `${NAME} === 'Imported label'`, 'the current label after a reload');
    await waitFor(cdp, `${COUNT} === '3'`, 'the count after a reload');
    await openLabels(cdp);
    assert.equal(
      await cdp.evaluate("document.querySelector('.label-row[aria-current=\"true\"] .label-open')?.textContent"),
      'Imported label'
    );
  });
});

test('the Labels dialog traps focus, closes on Escape and returns focus', async (t) => {
  await withPage(t, async ({ cdp, port }) => {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1024, height: 900, deviceScaleFactor: 1, mobile: false });
    await openApp(cdp, port);
    await waitFor(cdp, `${COUNT} === '1'`, 'the first label count');

    await cdp.evaluate(`(() => {
      const button = document.querySelector('#openLibraryButton');
      button.focus();
      button.click();
    })()`);
    await waitFor(cdp, "Boolean(document.querySelector('.modal'))", 'the Labels modal');

    const initialFocus = await cdp.evaluate("document.activeElement.getAttribute('aria-label')");
    assert.equal(initialFocus, 'Close', 'focus starts inside the dialog');

    // Shift+Tab from the first focusable wraps to the last one.
    const wrappedBack = await cdp.evaluate(`(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }));
      return document.activeElement.textContent.trim();
    })()`);
    assert.equal(wrappedBack, 'Import label', 'backward Tab wraps to the last dialog action');

    // Tab from the last focusable wraps to the first one.
    const wrappedForward = await cdp.evaluate(`(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
      return document.activeElement.getAttribute('aria-label');
    })()`);
    assert.equal(wrappedForward, 'Close', 'forward Tab wraps to the first dialog control');

    await cdp.evaluate(
      "window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))"
    );
    await waitFor(cdp, "!document.querySelector('.modal')", 'Escape to close the dialog');
    assert.equal(
      await cdp.evaluate("document.activeElement.id"),
      'openLibraryButton',
      'focus returns to the control that opened the dialog'
    );
    assert.equal(await cdp.evaluate("document.querySelector('#app').inert"), false, 'the shell is released');
  });
});

test('the Labels dialog fits 375 and 1280 without horizontal overflow', async (t) => {
  await withPage(t, async ({ cdp, port }) => {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    await openApp(cdp, port);
    await waitFor(cdp, `${COUNT} === '1'`, 'the first label count');

    // Enough rows that the modal body has to scroll on a phone.
    for (let index = 0; index < 5; index += 1) {
      await openLabels(cdp);
      await clickFooter(cdp, 'New label');
      await waitFor(cdp, `!document.querySelector('.modal') && ${COUNT} === '${index + 2}'`, 'the next label');
    }

    for (const [width, height, mobile] of [
      [375, 667, true],
      [1280, 900, false],
    ]) {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile });
      await delay(300);
      await openLabels(cdp);
      const layout = await cdp.evaluate(`(() => {
        const dialog = document.querySelector('.modal');
        const body = dialog.querySelector('.modal-body');
        const rows = [...dialog.querySelectorAll('.label-row')];
        const bodyRect = body.getBoundingClientRect();
        const dialogRect = dialog.getBoundingClientRect();
        return {
          pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          bodyOverflow: body.scrollWidth - body.clientWidth,
          bodyScrolls: body.scrollHeight > body.clientHeight,
          bodyOverflowY: getComputedStyle(body).overflowY,
          rows: rows.length,
          rowsInside: rows.every((row) => {
            const box = row.getBoundingClientRect();
            return box.left >= bodyRect.left - 1 && box.right <= bodyRect.right + 1;
          }),
          dialogWidth: Math.round(dialogRect.width),
          viewport: window.innerWidth,
          focused: Boolean(document.activeElement && dialog.contains(document.activeElement)),
        };
      })()`);
      const label = `${width}x${height}`;
      assert.equal(layout.pageOverflow, 0, `${label}: the page has no horizontal overflow`);
      assert.equal(layout.bodyOverflow, 0, `${label}: the dialog body has no horizontal overflow`);
      assert.equal(layout.rows, 6, `${label}: every saved label is listed`);
      assert.equal(layout.rowsInside, true, `${label}: every row stays inside the body`);
      assert.equal(layout.bodyOverflowY, 'auto', `${label}: the body owns vertical scrolling`);
      assert.equal(layout.focused, true, `${label}: focus stays inside the dialog`);
      assert.ok(layout.dialogWidth <= layout.viewport - 40, `${label}: the dialog clears the backdrop`);
      if (width === 375) assert.equal(layout.bodyScrolls, true, 'the phone dialog body scrolls');
      await dismiss(cdp);
    }
  });
});
