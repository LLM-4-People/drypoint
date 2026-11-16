import test from 'node:test';
import assert from 'node:assert/strict';

import * as domModule from '../src/core/dom.js';
import { el, movePreservingFocus } from '../src/core/dom.js';
import { installDom } from './helpers/fake-dom.mjs';

const dom = installDom();

test('moving a focused field restores focus and the text selection', () => {
  const home = el('div', {});
  const slot = el('div', {});
  const input = el('input', { type: 'text' });
  input.value = 'Label name';
  home.append(input);
  input.focus();
  input.setSelectionRange(2, 7, 'backward');

  const restored = movePreservingFocus(input, () => slot.append(input));

  assert.equal(restored, true);
  assert.equal(input.parentNode, slot, 'the node really moved');
  assert.equal(dom.activeElement, input, 'focus follows the node instead of falling to the body');
  assert.equal(input.selectionStart, 2, 'the caret selection is preserved');
  assert.equal(input.selectionEnd, 7);
  assert.equal(input.selectionDirection, 'backward');
});

test('moving a container keeps focus on its focused descendant', () => {
  const workspace = el('div', {});
  const sidebar = el('div', {});
  const panel = el('div', {});
  const field = el('input', { type: 'number' });
  panel.append(field);
  workspace.append(panel);
  workspace.append(sidebar);
  field.focus();

  movePreservingFocus(panel, () => sidebar.after(panel));

  assert.equal(workspace.children[1], panel, 'the panel really moved after the sidebar');
  assert.equal(dom.activeElement, field, 'a breakpoint move does not drop the keyboard');
});

test('a move never steals focus from somewhere else', () => {
  const a = el('div', {});
  const b = el('div', {});
  const other = el('button', {});
  a.append(el('input', { type: 'text' }));
  b.append(other);
  other.focus();

  const restored = movePreservingFocus(a, () => b.prepend(a));

  assert.equal(restored, false);
  assert.equal(dom.activeElement, other, 'unrelated focus is untouched');
});

/* ---------------- live focus tracking (R3-2) ---------------- */

test('a control the browser already dropped to the body still gets focus back', () => {
  const home = el('div', {});
  const slot = el('div', {});
  const input = el('input', { type: 'text' });
  input.value = 'Label name';
  home.append(input);
  document.body.append(home);
  // Focus arrived while the control was still mounted and visible.
  input.focus();
  dom.dispatch('focusin', { target: input });
  assert.equal(dom.activeElement, input);

  // Chromium's hide-fixup ran before the breakpoint handler did: the body owns
  // focus, without a focusout event.
  dom.activeElement = document.body;

  movePreservingFocus(home, () => slot.append(input));
  assert.equal(dom.activeElement, input, 'the live snapshot restores focus');
});

test('a focus fixup that lands on the next frame is re-asserted once', () => {
  const frames = [];
  const previous = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = (callback) => frames.push(callback);
  try {
    const home = el('div', {});
    const slot = el('div', {});
    const input = el('input', { type: 'text' });
    home.append(input);
    document.body.append(home);
    input.focus();
    input.setSelectionRange(1, 3, 'forward');

    movePreservingFocus(home, () => slot.append(input));
    assert.equal(dom.activeElement, input, 'restored immediately');
    assert.equal(frames.length, 1, 'one re-assert is scheduled');

    // The browser's own fixup lands after the handler: focus is on the body.
    dom.activeElement = document.body;
    frames.shift()();
    assert.equal(dom.activeElement, input, 'the next frame recovers the control');
    assert.equal(input.selectionStart, 1, 'with the caret where the user left it');
    assert.equal(input.selectionEnd, 3);
  } finally {
    globalThis.requestAnimationFrame = previous;
  }
});

test('the next-frame re-assert leaves focus alone when the user moved it', () => {
  const frames = [];
  const previous = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = (callback) => frames.push(callback);
  try {
    const home = el('div', {});
    const slot = el('div', {});
    const input = el('input', { type: 'text' });
    const other = el('input', { type: 'text' });
    home.append(input);
    document.body.append(home, other);
    input.focus();
    movePreservingFocus(home, () => slot.append(input));

    other.focus();
    frames.shift()();
    assert.equal(dom.activeElement, other, 'a deliberate move to another control wins');
  } finally {
    globalThis.requestAnimationFrame = previous;
  }
});

test('setText makes no mutation when the text is already current', () => {
  const { setText } = domModule;
  const node = document.createElement('span');
  let writes = 0;
  let value = 'a · b';
  Object.defineProperty(node, 'textContent', {
    configurable: true,
    get: () => value,
    set: (next) => {
      writes++;
      value = next;
    },
  });
  setText(node, 'a · b');
  assert.equal(writes, 0, 'identical text is not written again');
  setText(node, 'a · c');
  assert.equal(writes, 1);
  assert.equal(node.textContent, 'a · c');
  setText(node, '');
  assert.equal(writes, 2);
});

/* ---------------- JSON download paths (R5G-6) ---------------- */

test('downloadJson hands the filename and pretty JSON to the Android bridge', () => {
  const calls = [];
  globalThis.window.NiimbotBLE = {
    saveFile(filename, text) {
      calls.push([filename, text]);
      return false;
    },
  };
  try {
    const data = { generatedAt: 'now', entries: [{ level: 'info' }] };
    assert.equal(domModule.downloadJson('drypoint-report.json', data), false, 'the bridge result is returned unchanged');
    assert.deepEqual(calls, [['drypoint-report.json', JSON.stringify(data, null, 2)]]);
    assert.match(calls[0][1], /\n  "generatedAt"/, 'the bridge receives pretty-printed JSON');
  } finally {
    delete globalThis.window.NiimbotBLE;
  }
});

test('downloadJson falls back to a temporary Blob link without a bridge', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const originalCreate = URL.createObjectURL;
  const originalRevoke = URL.revokeObjectURL;
  let blob = null;
  const revoked = [];
  URL.createObjectURL = (value) => {
    blob = value;
    return 'blob:drypoint-test';
  };
  URL.revokeObjectURL = (url) => revoked.push(url);
  try {
    const before = document.created.length;
    const data = { report: true };
    assert.equal(domModule.downloadJson('report.json', data), true);

    const anchor = document.created.slice(before).find((node) => node.tagName === 'A');
    assert.ok(anchor, 'a download link was created');
    assert.equal(anchor.download, 'report.json');
    assert.equal(anchor.href, 'blob:drypoint-test');
    assert.equal(anchor.parentNode, null, 'the link does not stay in the document');

    assert.ok(blob, 'the JSON was put in a Blob');
    assert.deepEqual(JSON.parse(await blob.text()), data);
    assert.match(await blob.text(), /\n  "report": true/, 'the exported file is readable JSON');
    assert.equal(blob.type, 'application/json');

    t.mock.timers.tick(1000);
    assert.deepEqual(revoked, ['blob:drypoint-test'], 'the object URL is released');
  } finally {
    URL.createObjectURL = originalCreate;
    URL.revokeObjectURL = originalRevoke;
  }
});
