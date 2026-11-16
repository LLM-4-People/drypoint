import test from 'node:test';
import assert from 'node:assert/strict';

import { confirmDialog, openModal } from '../src/ui/modal.js';
import { clearLog, getLogEntries, setLogLevel } from '../src/core/log.js';
import { installDom } from './helpers/fake-dom.mjs';

const dom = installDom();

/** The shell the dialog inerts and the root it mounts into. */
function harness() {
  dom.body.textContent = '';
  dom.activeElement = null;
  const app = dom.createElement('div');
  app.id = 'app';
  app.setAttribute('id', 'app');
  const modalRoot = dom.createElement('div');
  modalRoot.setAttribute('id', 'modalRoot');
  const opener = dom.createElement('button');
  opener.setAttribute('aria-label', 'Open');
  app.append(opener);
  dom.body.append(app, modalRoot);
  opener.focus();
  return { app, modalRoot, opener };
}

const dialogOf = (root) => root.querySelector('.modal');
const buttonsOf = (root) => root.querySelectorAll('button');

test.after(() => clearLog());

test('the dialog inerts the shell, traps Tab and restores focus on close', () => {
  const { app, modalRoot, opener } = harness();
  const { close } = openModal({ title: 'Settings', body: dom.createElement('div'), actions: [{ label: 'Save' }] });

  assert.equal(app.inert, true, 'the shell leaves the tab order while a dialog is open');
  assert.ok(dialogOf(modalRoot), 'the dialog is mounted');
  const focusables = buttonsOf(modalRoot);
  assert.ok(focusables.length >= 2, 'the close button and the action are focusable');

  // Tab from the last focusable wraps to the first.
  focusables.at(-1).focus();
  const tab = window.dispatch('keydown', { key: 'Tab', shiftKey: false });
  assert.equal(tab.defaultPrevented, true);
  assert.equal(dom.activeElement, focusables[0]);

  // Shift+Tab from the first wraps to the last.
  focusables[0].focus();
  window.dispatch('keydown', { key: 'Tab', shiftKey: true });
  assert.equal(dom.activeElement, focusables.at(-1));

  close();
  assert.equal(app.inert, false, 'the shell comes back when the last dialog closes');
  assert.equal(dom.activeElement, opener, 'focus returns to whatever opened it');
});

test('Escape closes only the topmost dialog and keeps the shell inert underneath', () => {
  const { app, modalRoot } = harness();
  const first = openModal({ title: 'First', body: dom.createElement('div') });
  const second = openModal({ title: 'Second', body: dom.createElement('div') });

  window.dispatch('keydown', { key: 'Escape' });
  assert.equal(modalRoot.querySelectorAll('.modal').length, 1, 'one dialog closed');
  assert.equal(dialogOf(modalRoot).getAttribute('aria-label'), 'First');
  assert.equal(app.inert, true, 'the remaining dialog still owns the shell');

  window.dispatch('keydown', { key: 'Escape' });
  assert.equal(modalRoot.querySelectorAll('.modal').length, 0);
  assert.equal(app.inert, false);
  assert.equal(first.close instanceof Function, true);
  assert.equal(second.close instanceof Function, true);
});

test('confirmDialog resolves true for the confirm action and false for cancel', async () => {
  const { modalRoot } = harness();
  const answer = confirmDialog('Delete?', 'This removes the layer.', { confirmLabel: 'Delete' });
  const confirm = buttonsOf(modalRoot).find((button) => button.textContent === 'Delete');
  assert.ok(confirm);
  confirm.dispatch('click');
  assert.equal(await answer, true);
  assert.equal(modalRoot.querySelectorAll('.modal').length, 0, 'confirming closes the dialog');

  const cancelled = confirmDialog('Delete?', 'This removes the layer.');
  const cancel = buttonsOf(modalRoot).find((button) => button.textContent === 'Cancel');
  cancel.dispatch('click');
  assert.equal(await cancelled, false);
});

test('a rejected dialog action is reported and keeps the dialog open', async (t) => {
  t.mock.method(console, 'error', () => {});
  clearLog();
  setLogLevel('debug');
  const { modalRoot } = harness();
  const boom = new Error('Reset failed');
  openModal({
    title: 'Reset',
    body: dom.createElement('div'),
    actions: [
      {
        label: 'Reset',
        onClick: async () => {
          throw boom;
        },
      },
    ],
  });

  const reset = buttonsOf(modalRoot).find((button) => button.textContent === 'Reset');
  reset.dispatch('click');
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(modalRoot.querySelectorAll('.modal').length, 1, 'the dialog stays open for a retry');
  const entry = getLogEntries().find((item) => item.message === 'dialog action failed');
  assert.ok(entry, 'the rejection is in the diagnostics log');
  assert.match(String(entry.detail), /Reset failed/);
});
