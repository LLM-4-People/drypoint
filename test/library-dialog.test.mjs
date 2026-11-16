/**
 * The Labels dialog's own structure in a fake DOM: the empty state and the
 * current-row marker. The browser suite covers the live page and layout.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { installDom } from './helpers/fake-dom.mjs';

const dom = installDom();
const { el } = await import('../src/core/dom.js');
for (const id of ['app', 'modalRoot', 'toasts']) dom.body.append(el('div', { id }));

const { createLibraryDialog } = await import('../src/ui/library-dialog.js');

function buildDialog(overrides = {}) {
  return createLibraryDialog({
    list: async () => [],
    currentId: () => null,
    onOpen: async () => {},
    onNew: async () => {},
    onDuplicate: async () => {},
    onExport: async () => {},
    onDelete: async () => {},
    onImport: () => {},
    notify: () => {},
    confirm: async () => false,
    ...overrides,
  });
}

function modalRoot() {
  return dom.body.querySelector('#modalRoot');
}

test('an empty library shows the empty state and the same New label footer', async () => {
  await buildDialog().open();
  const modal = modalRoot().querySelector('.modal');
  assert.ok(modal, 'the shared modal opens');
  assert.ok(modal.querySelector('.empty'), 'the empty state reuses .empty');
  assert.match(modal.textContent, /No saved labels yet/);
  assert.match(modal.textContent, /Use New label to start one/);
  const actions = [...modal.querySelectorAll('.btn')].map((node) => node.textContent);
  assert.deepEqual(actions, ['New label', 'Import label'], 'the footer still offers both create paths');
  modal.querySelector('.icon-btn').click();
  assert.equal(modalRoot().querySelector('.modal'), null, 'the shared close control removes the dialog');
});

test('the current row carries the marker, badge and label-named actions', async () => {
  const now = Date.now();
  await buildDialog({
    list: async () => [
      { id: 'newer', name: 'Newer', updatedAt: now, createdAt: now - 2000, elementCount: 2 },
      { id: 'older', name: 'Older', updatedAt: now - 5000, createdAt: now - 9000, elementCount: 1 },
    ],
    currentId: () => 'older',
  }).open();

  const rows = [...modalRoot().querySelectorAll('.label-row')];
  assert.equal(rows.length, 2, 'one row per saved label');
  assert.equal(rows[0].getAttribute('aria-current'), null, 'the non-current row has no marker');
  assert.equal(rows[1].getAttribute('aria-current'), 'true', 'the current row is marked');
  assert.equal(rows[1].querySelector('.label-current').textContent, 'Current');
  assert.match(rows[0].querySelector('.label-meta').textContent, /2 elements/);
  assert.equal(rows[0].querySelector('.label-open').textContent, 'Newer');

  const actions = [...rows[0].querySelectorAll('.label-action')].map((node) => ({
    text: node.textContent,
    label: node.getAttribute('aria-label'),
  }));
  assert.deepEqual(actions, [
    { text: 'Duplicate', label: 'Duplicate Newer' },
    { text: 'Export', label: 'Export Newer' },
    { text: 'Delete', label: 'Delete Newer' },
  ]);
});
