import test from 'node:test';
import assert from 'node:assert/strict';

import { createInspector } from '../src/ui/inspector.js';
import { createEditor } from '../src/editor/controller.js';
import { createDocument, createElement, ELEMENT_TYPES } from '../src/label/schema.js';
import { CONFIG } from '../src/core/config.js';
import { resetGeometry, setGeometry } from '../src/core/geometry.js';
import { installDom } from './helpers/fake-dom.mjs';

const dom = installDom();

function harness(type, props = {}) {
  const element = createElement(type, props);
  const calls = [];
  const controller = {
    document: createDocument({ elements: [element] }),
    selection: element.id,
    get selected() {
      return this.document.elements.find((item) => item.id === this.selection) ?? null;
    },
    updateElement(id, patch) {
      this.document = {
        ...this.document,
        elements: this.document.elements.map((item) => (item.id === id ? { ...item, ...patch } : item)),
      };
    },
    reorder(id, delta) {
      calls.push(['reorder', id, delta]);
    },
    removeElement(id) {
      calls.push(['remove', id]);
    },
    duplicateElement(id) {
      calls.push(['duplicate', id]);
    },
    setDocumentLength(value) {
      calls.push(['length', value]);
    },
    select(id) {
      this.selection = id;
    },
  };
  const container = dom.createElement('div');
  const inspector = createInspector({ container, controller, onPickImage: async () => null });
  inspector.render();
  return { container, controller, inspector, calls, element };
}

function arrange(container) {
  const groups = [...container.querySelectorAll('.group')];
  return groups.find((node) => node.querySelector('.group-title')?.textContent.trim() === 'Arrange') ?? null;
}

function buttonNamed(container, name) {
  return container.querySelector(`button[aria-label="${name}"]`);
}

for (const type of Object.values(ELEMENT_TYPES)) {
  test(`the Arrange group keeps Forward, Backward and Delete for ${type}`, () => {
    const { container } = harness(type);
    const group = arrange(container);
    assert.ok(group, 'the Arrange group exists');
    const labels = [...group.querySelectorAll('.btn')].map((node) => node.textContent.trim());
    assert.deepEqual(labels, ['Forward', 'Backward', 'Delete']);
  });
}

test('the Arrange actions reach the controller in the right direction', () => {
  const { container, calls, element } = harness(ELEMENT_TYPES.TEXT);
  const buttons = [...arrange(container).querySelectorAll('.btn')];
  buttons[0].dispatch('click');
  buttons[1].dispatch('click');
  buttons[2].dispatch('click');
  assert.deepEqual(calls, [
    ['reorder', element.id, 1],
    ['reorder', element.id, -1],
    ['remove', element.id],
  ]);
});

test('sync updates a focused switch, so undo reaches a Bold control', () => {
  const { container, controller, inspector, element } = harness(ELEMENT_TYPES.TEXT);
  const bold = buttonNamed(container, 'Bold');
  assert.equal(bold.getAttribute('aria-checked'), 'true', 'text defaults to bold');
  bold.focus();

  controller.updateElement(element.id, { bold: false });
  inspector.sync();

  assert.equal(bold.getAttribute('aria-checked'), 'false', 'a focused switch still follows the model');
});

test('sync never rewrites a focused text field', () => {
  const { container, controller, inspector, element } = harness(ELEMENT_TYPES.TEXT);
  const textarea = container.querySelector('textarea');
  textarea.focus();
  textarea.value = 'draft in progress';

  controller.updateElement(element.id, { text: 'model value' });
  inspector.sync();

  assert.equal(textarea.value, 'draft in progress', 'the caret and the typed text are left alone');
});

test('a locked element can still be duplicated; its other actions are disabled', () => {
  const { container } = harness(ELEMENT_TYPES.TEXT, { locked: true });
  const duplicate = buttonNamed(container, 'Duplicate');
  const alignLeft = buttonNamed(container, 'Align left');
  assert.equal(duplicate.disabled, false, 'the copy is unlocked and supported');
  assert.equal(alignLeft.disabled, true, 'element-scoped actions stay locked');
});

test('a locked element disables Forward, Backward and Delete in the inspector', () => {
  const { container } = harness(ELEMENT_TYPES.TEXT, { locked: true });
  const zButton = (name) => [...container.querySelectorAll('.btn')].find((node) => node.textContent.trim() === name);
  for (const name of ['Forward', 'Backward', 'Delete']) {
    assert.equal(zButton(name).disabled, true, `${name} is element-scoped`);
  }
  // The controls that legitimately survive a lock stay available.
  assert.equal(buttonNamed(container, 'Duplicate').disabled, false);
});

test('the inspector Duplicate click runs duplicateElement and unlocks the copy', () => {
  const element = createElement(ELEMENT_TYPES.TEXT, { locked: true });
  const editor = createEditor({ document: createDocument({ elements: [element] }) });
  const container = dom.createElement('div');
  createInspector({ container, controller: editor, onPickImage: async () => null }).render();

  buttonNamed(container, 'Duplicate').dispatch('click');
  assert.equal(editor.document.elements.length, 2, 'the click reached the controller');
  const copy = editor.document.elements.at(-1);
  assert.notEqual(copy.id, element.id);
  assert.equal(copy.locked, false, 'a copy of a locked element is editable');
  assert.equal(editor.selection, copy.id);
});

test('the device maximum length reaches the field and the presets live', (t) => {
  t.after(resetGeometry);
  const { container, inspector } = harness(ELEMENT_TYPES.TEXT);
  const length = container.querySelector('input[aria-label="Length (mm)"]');
  assert.ok(length);
  assert.equal(Number(length.max), CONFIG.geometry.maxLengthMm);

  setGeometry({ discovered: true, dpi: 203, headWidthPx: 96, maxLengthMm: 30 });
  inspector.sync();

  assert.equal(Number(length.max), 30, 'the field follows the reported device limit');
  const presets = [...container.querySelectorAll('.btn')].filter((button) => /^\d+ mm$/.test(button.textContent.trim()));
  assert.deepEqual(
    presets.map((button) => [button.textContent.trim(), button.disabled]),
    [
      ['25 mm', false],
      ['30 mm', false],
      ['40 mm', true],
      ['50 mm', true],
      ['70 mm', true],
    ],
    'presets above the device maximum are disabled'
  );
});

test('a number field shows the value the document accepted, not the typed one', (t) => {
  t.after(resetGeometry);
  const controller = createEditor({ document: createDocument({ lengthMm: 40 }) });
  // The device reports a shorter tape after the document was authored.
  setGeometry({ discovered: true, dpi: 203, headWidthPx: 96, maxLengthMm: 30 });
  const container = dom.createElement('div');
  const inspector = createInspector({ container, controller, onPickImage: async () => null });
  inspector.render();

  const field = container.querySelector('input[aria-label="Length (mm)"]');
  assert.ok(field, 'the length field is a spinbutton');
  field.focus();
  field.value = '999';
  field.dispatch('change');
  // The app re-renders (and syncs) after the controller clamps the value.
  inspector.sync();

  assert.equal(controller.document.lengthMm, 30, 'the typed 999 was clamped to the device limit');
  assert.equal(field.value, '30', 'the field shows what will print');

  field.dispatch('blur');
  inspector.sync();
  assert.equal(field.value, '30', 'and it stays correct after blur');
});

/* ---------------- geometry bounds and slider gestures (R5C-4/R5C-5) ---------------- */

function liveHarness(element) {
  const editor = createEditor({ document: createDocument({ elements: [element] }) });
  const container = document.createElement('div');
  const inspector = createInspector({ container, controller: editor, onPickImage: async () => null });
  inspector.render();
  return { editor, container, inspector };
}

test('a length change refreshes the X/Y/Width/Height bounds', () => {
  const element = createElement(ELEMENT_TYPES.TEXT, { text: 'Hi', x: 4, y: 4, w: 40, h: 20 });
  const { editor, container, inspector } = liveHarness(element);
  const field = (label) =>
    container.querySelectorAll('input').find((input) => input.type === 'number' && input.getAttribute('aria-label') === label);
  const maxOf = (label) => Number(field(label).max);

  assert.equal(maxOf('X (mm)'), 40);
  editor.setDocumentLength(200);
  inspector.sync();
  assert.equal(maxOf('X (mm)'), 200, 'the X bound follows the label length');
  assert.equal(maxOf('Width (mm)'), 200);
  assert.equal(maxOf('Y (mm)'), 12);
  assert.equal(maxOf('Height (mm)'), 12);

  editor.setDocumentLength(40);
  inspector.sync();
  assert.equal(maxOf('X (mm)'), 40, 'and back down again');
});

test('two deliberate slider drags are two undo steps', () => {
  const element = createElement(ELEMENT_TYPES.TEXT, { text: 'Hi', fontPx: 20 });
  const { editor, container, inspector } = liveHarness(element);
  inspector.render();
  const size = container.querySelectorAll('input').find((input) => input.type === 'range' && input.getAttribute('aria-label') === 'Size');
  const drag = (pointerId, value) => {
    size.dispatch('pointerdown', { pointerType: 'mouse', pointerId });
    size.value = String(value);
    size.dispatch('input');
    size.dispatch('pointerup', { pointerType: 'mouse', pointerId });
  };

  drag(1, 40);
  assert.equal(editor.selected.fontPx, 40);
  drag(2, 51);
  assert.equal(editor.selected.fontPx, 51);
  assert.ok(editor.undo());
  assert.equal(editor.selected.fontPx, 40, 'the second drag is its own undo step');
  assert.ok(editor.undo());
  assert.equal(editor.selected.fontPx, 20, 'the first drag is its own step too');
});
