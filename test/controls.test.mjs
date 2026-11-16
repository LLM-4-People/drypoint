import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isTextEntry,
  numberField,
  segmented,
  select,
  slider,
  textArea,
  textField,
  toggle,
} from '../src/ui/controls.js';
import { createInspector } from '../src/ui/inspector.js';
import { createDocument } from '../src/label/schema.js';
import { installDom } from './helpers/fake-dom.mjs';

const dom = installDom();

function inputOf(control) {
  return control.element;
}

function allInputs(root) {
  const found = [];
  const walk = (node) => {
    for (const child of node.children) {
      if (child.tagName === 'INPUT') found.push(child);
      child.tagName !== 'INPUT' && walk(child);
    }
  };
  walk(root);
  return found;
}

function valueLabel(control) {
  return control.node.querySelector('.value');
}

function rangeHarness({ value = 5, format = null, unit = ' px' } = {}) {
  const calls = [];
  const control = slider({
    label: 'Size',
    min: 0,
    max: 100,
    step: 1,
    value,
    unit,
    format,
    onInput: (next) => calls.push(next),
  });
  const input = control.node.querySelector('input');
  return { control, input, calls };
}

test('a cleared number field keeps the previous value instead of committing 0', () => {
  const changes = [];
  const field = numberField({ label: 'X', value: 4.5, min: 0, max: 40, step: 0.1, unit: 'mm', onChange: (value) => changes.push(value) });
  const input = inputOf(field);

  input.value = '';
  input.dispatch('change');
  assert.deepEqual(changes, [], 'an empty field never reaches the controller');
  assert.equal(input.value, '4.5', 'the previous value is restored');

  input.value = '6.2';
  input.dispatch('change');
  assert.deepEqual(changes, [6.2]);

  input.value = 'not a number';
  input.dispatch('change');
  assert.deepEqual(changes, [6.2], 'unreadable input is ignored');
  assert.equal(input.value, '6.2', 'the last accepted value is restored');

  field.set(7);
  input.value = '';
  input.dispatch('change');
  assert.equal(input.value, '7', 'set() updates the value restored after a clear');
});

test('geometry fields step in tenths of a millimetre, matching what they display', () => {
  const labelDocument = createDocument({ lengthMm: 40 });
  const selected = labelDocument.elements[0];
  const controller = {
    document: labelDocument,
    selection: selected.id,
    get selected() {
      return this.document.elements.find((element) => element.id === this.selection) ?? null;
    },
    updateElement() {},
    setDocumentLength() {},
    reorder() {},
    removeElement() {},
    duplicateElement() {},
    alignElement() {},
    rotateElement() {},
  };
  const container = dom.createElement('div');
  const inspector = createInspector({ container, controller, onPickImage: async () => null });
  inspector.render();

  const labels = ['X', 'Y', 'Width', 'Height'].map((label) => `${label} (mm)`);
  const geometry = allInputs(container).filter((input) => labels.includes(input.getAttribute('aria-label')));
  assert.equal(geometry.length, 4, 'X, Y, Width and Height are present');
  for (const input of geometry) {
    const label = input.getAttribute('aria-label');
    assert.equal(Number(input.step), 0.1, `${label} steps in tenths`);
    assert.ok(Number.isFinite(Number(input.min)), `${label} declares a minimum`);
    assert.ok(Number.isFinite(Number(input.max)), `${label} declares a maximum`);
    assert.ok(Number(input.max) > Number(input.min), `${label} has a usable range`);
    const value = Number(input.value);
    const steps = value / Number(input.step);
    assert.ok(
      Math.abs(steps - Math.round(steps)) < 1e-9,
      `${label} ${value} mm is a whole number of ${input.step} mm steps (a 0.5 step rejected it)`
    );
  }
});

test('a touch tap seeks, shows the value, and commits once on release', () => {
  const { control, input, calls } = rangeHarness({ value: 5 });
  input.dispatch('pointerdown', { pointerType: 'touch', pointerId: 3 });
  input.value = '42';
  input.dispatch('input');
  assert.deepEqual(calls, [], 'a touch gesture does not commit while it is in flight');
  assert.equal(valueLabel(control).textContent, '42 px');

  input.dispatch('pointerup', { pointerType: 'touch', pointerId: 3 });
  assert.deepEqual(calls, [42], 'pointerup commits exactly once');
});

test('a horizontal touch drag commits only the final value', () => {
  const { control, input, calls } = rangeHarness({ value: 5 });
  input.dispatch('pointerdown', { pointerType: 'touch', pointerId: 4 });
  for (const next of [12, 24, 36]) {
    input.value = String(next);
    input.dispatch('input');
  }
  assert.deepEqual(calls, [], 'no intermediate value reaches the controller');
  assert.equal(valueLabel(control).textContent, '36 px', 'the label still follows the finger');
  input.dispatch('pointerup', { pointerType: 'touch', pointerId: 4 });
  assert.deepEqual(calls, [36]);
});

test('a cancelled touch restores the committed value and never commits', () => {
  const { control, input, calls } = rangeHarness({ value: 5 });
  input.dispatch('pointerdown', { pointerType: 'touch', pointerId: 5 });
  input.value = '37';
  input.dispatch('input');
  assert.equal(valueLabel(control).textContent, '37 px');

  input.dispatch('pointercancel', { pointerType: 'touch', pointerId: 5 });
  assert.deepEqual(calls, [], 'a vertical scroll is not an edit');
  assert.equal(input.value, '5', 'the control snaps back to the committed value');
  assert.equal(valueLabel(control).textContent, '5 px', 'the label follows the value back');

  input.value = '60';
  input.dispatch('input');
  input.dispatch('pointerdown', { pointerType: 'touch', pointerId: 6 });
  input.value = '61';
  input.dispatch('input');
  input.dispatch('lostpointercapture', { pointerType: 'touch', pointerId: 6 });
  assert.deepEqual(calls, [60], 'losing capture cancels the second gesture only');
  assert.equal(input.value, '60');
});

test('keyboard and mouse changes commit immediately', () => {
  const { input, calls } = rangeHarness({ value: 5 });
  input.value = '12';
  input.dispatch('input');
  input.value = '13';
  input.dispatch('input');
  assert.deepEqual(calls, [12, 13], 'a key press is a real edit on every step');

  input.dispatch('pointerdown', { pointerType: 'mouse', pointerId: 9 });
  input.value = '20';
  input.dispatch('input');
  assert.deepEqual(calls, [12, 13, 20], 'a mouse drag is not deferred');
});

test('sliders expose their formatted value as aria-valuetext', () => {
  const { control, input } = rangeHarness({ value: 0, format: (value) => (value === 0 ? 'Auto' : `${value} px`) });
  assert.equal(input.getAttribute('aria-valuetext'), 'Auto');
  input.value = '12';
  input.dispatch('input');
  assert.equal(input.getAttribute('aria-valuetext'), '12 px');
  control.set(0);
  assert.equal(input.getAttribute('aria-valuetext'), 'Auto');
});

test('a number field carries its unit in the accessible name and follows setMax', () => {
  const field = numberField({ label: 'X', value: 4.5, min: 0, max: 40, step: 0.1, unit: 'mm' });
  const input = inputOf(field);
  assert.equal(input.getAttribute('aria-label'), 'X (mm)', 'a spinbutton announced only as X has no unit');
  assert.equal(Number(input.min), 0);
  assert.equal(Number(input.max), 40);
  field.setMax(30);
  assert.equal(Number(input.max), 30, 'a device limit can change without a rebuild');
});

test('only caret-owning controls count as text entry', () => {
  const cases = [
    // A number field has no usable caret: the model must be able to correct a
    // value the document rejected (999 -> the clamped length).
    [numberField({ label: 'X', value: 1, onChange() {} }).element, false],
    [textField({ label: 'Name', value: '' }).element, true],
    [textArea({ label: 'Text', value: '' }).element, true],
    [slider({ label: 'Size', min: 0, max: 10, value: 1 }).node.querySelector('input'), false],
    [toggle({ label: 'Bold' }).node.querySelector('button'), false],
    [segmented({ label: 'Align', options: [['left', 'Left']], value: 'left' }).node.querySelector('button'), false],
    [select({ label: 'Fit', options: [['A', 'A']], value: 'A' }).element, false],
    [dom.createElement('div'), false],
  ];
  for (const [node, expected] of cases) {
    assert.equal(isTextEntry(node), expected, `${node.tagName} ${node.type ?? ''}`);
  }
});

test('a switch never announces a state it has not read', () => {
  const control = toggle({ label: 'Bluetooth sound', checked: null, hintId: 'soundHint' });
  const button = control.node.querySelector('button');
  assert.equal(button.getAttribute('aria-checked'), null, 'unknown is not "off"');
  assert.equal(button.getAttribute('role'), null, 'an unknown value is not a switch without its required state');
  assert.equal(button.getAttribute('aria-describedby'), 'soundHint', 'the hint explains the unknown state');

  control.set(true);
  assert.equal(button.getAttribute('role'), 'switch');
  assert.equal(button.getAttribute('aria-checked'), 'true');
  assert.equal(button.getAttribute('aria-describedby'), null, 'a known value needs no description');

  control.set(null);
  assert.equal(button.getAttribute('aria-checked'), null);
  assert.equal(button.getAttribute('role'), null);
  assert.equal(button.getAttribute('aria-describedby'), 'soundHint');

  control.set(false);
  assert.equal(button.getAttribute('role'), 'switch');
  assert.equal(button.getAttribute('aria-checked'), 'false');
});

/* ---------------- slider gesture keys (R5C-5) ---------------- */

test('each slider gesture carries its own id and keyboard edits carry none', () => {
  const calls = [];
  const control = slider({
    label: 'Size',
    min: 0,
    max: 100,
    value: 20,
    onInput: (value, info) => calls.push([value, info?.gesture ?? null]),
  });
  const input = control.node.querySelector('input');

  input.dispatch('pointerdown', { pointerType: 'mouse', pointerId: 1 });
  input.value = '30';
  input.dispatch('input');
  input.dispatch('pointerup', { pointerType: 'mouse', pointerId: 1 });

  input.dispatch('pointerdown', { pointerType: 'mouse', pointerId: 2 });
  input.value = '40';
  input.dispatch('input');
  input.dispatch('pointerup', { pointerType: 'mouse', pointerId: 2 });

  input.value = '45';
  input.dispatch('input');

  assert.deepEqual(calls.map(([value]) => value), [30, 40, 45]);
  assert.equal(calls[0][1], 'g1');
  assert.equal(calls[1][1], 'g2', 'a new press is a new gesture');
  assert.notEqual(calls[0][1], calls[1][1]);
  assert.equal(calls[2][1], null, 'a keyboard change is not a gesture');
});

test('a touch slider commits its final value with its gesture', () => {
  const calls = [];
  const control = slider({ label: 'Size', min: 0, max: 100, value: 20, onInput: (value, info) => calls.push([value, info?.gesture ?? null]) });
  const input = control.node.querySelector('input');
  input.dispatch('pointerdown', { pointerType: 'touch', pointerId: 7 });
  input.value = '55';
  input.dispatch('input');
  assert.deepEqual(calls, [], 'the drag is deferred until pointerup');
  input.dispatch('pointerup', { pointerType: 'touch', pointerId: 7 });
  assert.deepEqual(calls, [[55, 'g1']]);
});

/* ---------------- select option replacement (R5F-8) ---------------- */

test('select.setOptions replaces the list and the selection together', () => {
  const control = select({
    label: 'Auto power-off',
    options: [
      ['1', 'Off'],
      ['2', '5 minutes'],
    ],
    value: '1',
  });
  const node = control.element;
  assert.equal(control.hasOption('2'), true);
  assert.equal(control.hasOption('5'), false, 'a value the list cannot show is reported honestly');

  control.setOptions(
    [
      ['1', 'Off'],
      ['5', '30 minutes'],
    ],
    '5'
  );
  assert.deepEqual(
    [...node.querySelectorAll('option')].map((option) => [option.value, option.textContent]),
    [
      ['1', 'Off'],
      ['5', '30 minutes'],
    ]
  );
  assert.equal(node.value, '5');

  // The same list with a new selection does not rebuild the options.
  control.setOptions(
    [
      ['1', 'Off'],
      ['5', '30 minutes'],
    ],
    '1'
  );
  assert.equal(node.value, '1');
  assert.equal(node.querySelectorAll('option').length, 2);
});
