import test from 'node:test';
import assert from 'node:assert/strict';

import { createLayersPanel } from '../src/ui/layers.js';
import { createDocument } from '../src/label/schema.js';
import { installDom, setDisplayResolver } from './helpers/fake-dom.mjs';

const dom = installDom();

const state = { coarse: false };

/**
 * Model the stylesheet's display rules, which the fake DOM would otherwise
 * ignore: the action strip only exists while its row is hovered or focused
 * (fine pointer) or its menu is open (coarse pointer), and the overflow trigger
 * only exists on coarse pointers for the selected row.
 */
setDisplayResolver((node) => {
  const strip = node.closest?.('.layer-actions');
  if (strip) {
    const row = strip.closest('.layer-row');
    if (!row) return '';
    const open = row.dataset.menu === 'open';
    const focused = row.contains(dom.activeElement);
    return open || (!state.coarse && focused) ? 'flex' : 'none';
  }
  const menu = node.closest?.('.layer-menu');
  if (menu) {
    const row = menu.closest('.layer-row');
    const visible = row.dataset.selected === 'true' || row.dataset.menu === 'open' || row.contains(dom.activeElement);
    return state.coarse && visible ? 'grid' : 'none';
  }
  return '';
});

function setCoarse(value) {
  state.coarse = value;
  globalThis.window.matchMedia = (query) => ({ matches: /\(pointer: coarse\)/.test(query) ? value : false, addEventListener() {} });
}

function harness({ coarse = false } = {}) {
  setCoarse(coarse);
  const controller = {
    document: createDocument({ lengthMm: 40 }),
    selection: null,
    select(id) {
      this.selection = id;
    },
    updateElement(id, patch) {
      this.document = {
        ...this.document,
        elements: this.document.elements.map((element) => (element.id === id ? { ...element, ...patch } : element)),
      };
    },
    reorder(id, delta) {
      this.reordered = [...(this.reordered ?? []), [id, delta]];
    },
    removeElement(id) {
      this.document = { ...this.document, elements: this.document.elements.filter((element) => element.id !== id) };
      if (this.selection === id) this.selection = this.document.elements.at(-1)?.id ?? null;
    },
    duplicateElement(id) {
      const source = this.document.elements.find((element) => element.id === id);
      // The real controller unlocks the copy: a locked source must still yield
      // an editable duplicate.
      const copy = { ...source, id: `${id}-copy`, locked: false };
      this.duplicated = (this.duplicated ?? 0) + 1;
      this.document = { ...this.document, elements: [...this.document.elements, copy] };
      this.selection = copy.id;
    },
  };
  controller.selection = controller.document.elements[0].id;
  const container = dom.createElement('ul');
  // The app's list is .layer-list and scrolls; the panel uses both facts when
  // it decides whether a scroll event came from its own scrollIntoView.
  container.className = 'layer-list';
  container.scrollTop = 0;
  const countNode = dom.createElement('span');
  const panel = createLayersPanel({ container, countNode, controller });
  panel.render();
  return { controller, container, panel };
}

function rowOf(container, id) {
  return [...container.querySelectorAll('.layer-row')].find((item) => item.dataset.id === id) ?? null;
}

function actionButton(container, rowId, action) {
  return rowOf(container, rowId)?.querySelector(`button[data-action="${action}"]`) ?? null;
}

test('focus returns to the layer action that ran after a rebuild', () => {
  const { controller, container, panel } = harness();
  const rowId = controller.selection;
  const row = rowOf(container, rowId);
  // Keyboard use on a fine pointer: the row select reveals the strip first.
  row.querySelector('.layer-select').focus();
  const duplicate = actionButton(container, rowId, 'duplicate');
  duplicate.focus();
  assert.equal(dom.activeElement, duplicate, 'the action is reachable once the row is focused');

  const before = dom.focusLog.length;
  duplicate.dispatch('click');
  assert.notEqual(controller.selection, rowId, 'duplicating selects the copy and changes the signature');

  panel.render();
  const focused = dom.activeElement;
  assert.ok(container.contains(focused), 'focus stays in the live list, never on the body');
  assert.equal(focused.dataset.action, 'duplicate', 'focus stays on the same action');
  assert.equal(focused.closest('.layer-row').dataset.id, rowId, 'and on the same row');

  const order = dom.focusLog.slice(before);
  assert.equal(order[0].className, 'layer-select', 'the row is focused first, which reveals the strip');
  assert.ok(order.includes(focused), 'the action is focused second');
});

test('a locked row still duplicates, and the copy is editable', () => {
  const { controller, container, panel } = harness();
  const id = controller.document.elements[0].id;
  controller.updateElement(id, { locked: true });
  panel.render();

  // Delete and restack are geometry-class mutations: the owner refuses them, so
  // the row must not offer them either.
  for (const action of ['delete', 'forward', 'backward']) {
    assert.equal(actionButton(container, id, action).disabled, true, `${action} is disabled on a locked element`);
  }
  for (const action of ['duplicate', 'lock', 'visibility']) {
    assert.equal(actionButton(container, id, action).disabled, false, `${action} stays available`);
  }

  actionButton(container, id, 'duplicate').dispatch('click');
  assert.equal(controller.duplicated, 1, 'the click reached duplicateElement, not just the DOM');
  const copy = controller.document.elements.at(-1);
  assert.notEqual(copy.id, id);
  assert.equal(copy.locked, false, 'the copy is unlocked and ready to edit');
  assert.equal(controller.selection, copy.id);
});

test('focus follows a visibility toggle without falling back to the row button', () => {
  const { controller, container, panel } = harness();
  const rowId = controller.selection;
  rowOf(container, rowId).querySelector('.layer-select').focus();
  const visibility = actionButton(container, rowId, 'visibility');
  visibility.focus();
  visibility.dispatch('click');
  assert.equal(controller.document.elements[0].visible, false);

  panel.render();
  assert.ok(container.contains(dom.activeElement));
  assert.equal(dom.activeElement.dataset.action, 'visibility');
});

test('a deleted row hands focus to the row that takes its place', () => {
  const { controller, container, panel } = harness();
  const removedId = controller.selection;
  const added = controller.document.elements[0];
  controller.document = { ...controller.document, elements: [...controller.document.elements, { ...added, id: 'second' }] };
  panel.render();

  rowOf(container, removedId).querySelector('.layer-select').focus();
  const deleteButton = actionButton(container, removedId, 'delete');
  deleteButton.focus();
  deleteButton.dispatch('click');
  assert.equal(controller.document.elements.length, 1);

  panel.render();
  assert.ok(container.contains(dom.activeElement));
  assert.equal(dom.activeElement.className, 'layer-select', 'a vanished action falls back to a row button');
  assert.equal(dom.activeElement.closest('.layer-row').dataset.id, 'second');
});

test('deleting the last layer keeps focus in the list, never on the body', () => {
  const { controller, container, panel } = harness();
  rowOf(container, controller.selection).querySelector('.layer-select').focus();
  const deleteButton = actionButton(container, controller.selection, 'delete');
  deleteButton.focus();
  deleteButton.dispatch('click');
  assert.equal(controller.document.elements.length, 0);

  panel.render();
  assert.equal(dom.activeElement, container, 'the list itself is the stable focus target');
});

test('opening the coarse menu moves focus into it and closing restores the trigger', () => {
  const { controller, container, panel } = harness({ coarse: true });
  const row = rowOf(container, controller.selection);
  const trigger = row.querySelector('.layer-menu');
  trigger.focus();
  trigger.dispatch('click');

  assert.equal(row.dataset.menu, 'open');
  assert.equal(trigger.getAttribute('aria-expanded'), 'true');
  assert.equal(dom.activeElement.dataset.action, 'visibility', 'focus lands on the first action');

  dom.dispatch('keydown', { key: 'Escape' });
  assert.equal(row.dataset.menu, undefined, 'Escape closes the menu');
  assert.equal(trigger.getAttribute('aria-expanded'), 'false');
  assert.equal(dom.activeElement, trigger, 'the trigger keeps focus instead of the body');
  assert.equal(controller.document.elements.length, 1, 'no action ran');
});

test('a coarse-pointer action returns focus to the live row select, not the action', () => {
  const { controller, container, panel } = harness({ coarse: true });
  const rowId = controller.selection;
  const row = rowOf(container, rowId);
  const trigger = row.querySelector('.layer-menu');
  trigger.focus();
  trigger.dispatch('click');
  const duplicate = actionButton(container, rowId, 'duplicate');
  duplicate.dispatch('click');

  panel.render();
  assert.ok(container.contains(dom.activeElement), 'focus never falls to the body');
  assert.equal(dom.activeElement.className, 'layer-select', 'the visible row control keeps focus');
  assert.equal(dom.activeElement.closest('.layer-row').dataset.id, rowId);
});

test('the selected row is marked with aria-current and never as an option', () => {
  const { controller, container, panel } = harness();
  const rows = container.querySelectorAll('.layer-row');
  const selected = rows.find((row) => row.dataset.id === controller.selection);
  assert.equal(selected.querySelector('.layer-select').getAttribute('aria-current'), 'true');
  assert.equal(rows.filter((row) => row.querySelector('[role="option"]')).length, 0);
  assert.equal(container.getAttribute('role'), null, 'the list is a plain list, not a listbox');

  controller.select(null);
  panel.render();
  assert.equal(container.querySelector('.layer-select').getAttribute('aria-current'), null);
});

test('opening the coarse menu scrolls the in-row grid into view', () => {
  // The grid lives in the row's flow, so the list's overflow-y never clips it;
  // it only has to be scrolled clear of that overflow.
  const { controller, container } = harness({ coarse: true });
  const row = rowOf(container, controller.selection);
  const actions = row.querySelector('.layer-actions');
  const seen = [];
  actions.scrollIntoView = (options) => seen.push(options);

  row.querySelector('.layer-menu').dispatch('click');
  assert.deepEqual(seen, [{ block: 'nearest' }], 'a missing scrollIntoView left the last row clipped');
  assert.equal(row.dataset.menu, 'open');
});

test('a focus move out of the row closes the coarse menu; one inside keeps it', () => {
  const { controller, container } = harness({ coarse: true });
  const row = rowOf(container, controller.selection);
  const trigger = row.querySelector('.layer-menu');
  const outside = dom.createElement('button');
  dom.body.append(outside);

  trigger.dispatch('click');
  assert.equal(row.dataset.menu, 'open');

  // The first action received focus after opening; a focusin for it must not
  // close the menu the user just opened.
  dom.dispatch('focusin', { target: row.querySelector('button[data-action]') });
  assert.equal(row.dataset.menu, 'open', 'focus inside the row keeps it open');

  dom.dispatch('focusin', { target: outside });
  assert.equal(row.dataset.menu, undefined, 'tabbing away dismisses the menu');
  assert.equal(trigger.getAttribute('aria-expanded'), 'false', 'aria-expanded cannot stay true');
});

test('a scroll or a resize closes the coarse menu', () => {
  for (const type of ['scroll', 'resize']) {
    const { controller, container } = harness({ coarse: true });
    const row = rowOf(container, controller.selection);
    row.querySelector('.layer-menu').dispatch('click');
    assert.equal(row.dataset.menu, 'open', `${type}: open first`);

    globalThis.window.dispatch(type);
    assert.equal(row.dataset.menu, undefined, `${type} dismisses the in-row menu`);
    assert.equal(row.querySelector('.layer-menu').getAttribute('aria-expanded'), 'false');
  }
});

test('the scroll the open itself caused does not dismiss the menu', () => {
  // Opening the menu scrolls the grid into view. Treating that event as a user
  // scroll closed the menu on the very row that needed scrolling (the last).
  const { controller, container } = harness({ coarse: true });
  const row = rowOf(container, controller.selection);
  row.querySelector('.layer-menu').dispatch('click');
  assert.equal(row.dataset.menu, 'open');

  globalThis.window.dispatch('scroll', { target: container });
  assert.equal(row.dataset.menu, 'open', 'the list is where the open scrolled to');

  container.scrollTop = 40; // a real scroll moves the list
  globalThis.window.dispatch('scroll', { target: container });
  assert.equal(row.dataset.menu, undefined, 'a later list scroll dismisses');
});

/* ---------------- hostile document fields (R8-1) ---------------- */

test('a non-string text field cannot break the layer list', () => {
  const { controller, container, panel } = harness();
  const [element] = controller.document.elements;
  // Simulate a document that bypassed the schema boundary: the panel must not
  // throw while naming the row at boot.
  controller.document = { ...controller.document, elements: [{ ...element, text: 123 }] };
  controller.selection = element.id;
  assert.doesNotThrow(() => panel.render());
  assert.equal(rowOf(container, element.id).querySelector('.layer-select').title, '123');
});

test('a null text or value field falls back to the type name', () => {
  const { controller, container, panel } = harness();
  const [element] = controller.document.elements;
  controller.document = { ...controller.document, elements: [{ ...element, name: null, text: null }] };
  controller.selection = element.id;
  assert.doesNotThrow(() => panel.render());
  assert.equal(rowOf(container, element.id).querySelector('.layer-select').title, 'Text');
});

test('the layer row reads select, trigger, actions in DOM order', () => {
  const { controller, container } = harness({ coarse: true });
  const row = rowOf(container, controller.selection);
  assert.deepEqual(
    [...row.children].map((node) => node.className),
    ['layer-select', 'layer-menu', 'layer-actions'],
    'Tab reaches the trigger before the actions it controls'
  );
});

test('a scroll dismissal restores the trigger without scrolling the list', () => {
  const { controller, container } = harness({ coarse: true });
  const row = rowOf(container, controller.selection);
  const trigger = row.querySelector('.layer-menu');
  trigger.dispatch('click');
  assert.equal(row.dataset.menu, 'open');
  // Focus was moved into the action grid by openMenu.
  assert.ok(row.querySelector('.layer-actions').contains(dom.activeElement));

  const calls = [];
  trigger.focus = (options) => calls.push(options);
  globalThis.window.dispatch('scroll', { target: dom.createElement('div') });

  assert.equal(row.dataset.menu, undefined, 'the scroll closed the menu');
  assert.deepEqual(calls, [{ preventScroll: true }], 'focus returns without snapping the list back');
});

/* ---------------- one restack spec (R5G-8) ---------------- */

test('the layer restack buttons move in the direction the shared spec names', () => {
  const { controller, container } = harness();
  const id = controller.selection;
  actionButton(container, id, 'forward').dispatch('click');
  actionButton(container, id, 'backward').dispatch('click');
  assert.deepEqual(controller.reordered, [
    [id, 1],
    [id, -1],
  ]);
});
