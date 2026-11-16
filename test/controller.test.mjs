import test from 'node:test';
import assert from 'node:assert/strict';

import { createEditor } from '../src/editor/controller.js';
import { createDocument, defaultTextFrame, documentHeightPx, documentWidthPx } from '../src/label/schema.js';
import { resetGeometry, setGeometry } from '../src/core/geometry.js';
import { CONFIG } from '../src/core/config.js';

function editorHarness() {
  const changes = [];
  const selections = [];
  const editor = createEditor({
    document: createDocument({ lengthMm: 40 }),
    onChange: (document) => changes.push(document),
    onSelection: (id) => selections.push(id),
  });
  return { editor, changes, selections };
}

test('document mutations never announce a selection change', () => {
  const { editor, changes, selections } = editorHarness();
  const id = editor.selection;
  editor.updateElement(id, { text: 'Typed' });
  editor.updateElement(id, { text: 'Typed more' });
  assert.equal(changes.length, 2);
  assert.equal(selections.length, 0, 'typing must not rebuild the inspector');
});

test('selecting the same element twice announces once', () => {
  const { editor, selections } = editorHarness();
  const id = editor.selection;
  editor.select(id);
  assert.equal(selections.length, 0);
  editor.select(null);
  editor.select(null);
  assert.deepEqual(selections, [null]);
});

test('adding, duplicating and removing announce the new selection', () => {
  const { editor, selections } = editorHarness();
  const added = editor.addElement('qr', { value: 'https://example.com' });
  assert.deepEqual(selections, [added.id]);

  const copy = editor.duplicateElement(added.id);
  assert.deepEqual(selections, [added.id, copy.id]);

  editor.removeElement(copy.id);
  assert.equal(selections.length, 3);
  assert.notEqual(selections[2], copy.id);
});

test('undo and redo keep the selection inside the document', () => {
  const { editor } = editorHarness();
  const added = editor.addElement('rect', {});
  editor.updateElement(added.id, { w: 40 });
  editor.undo();
  assert.ok(editor.document.elements.some((element) => element.id === added.id));
  editor.redo();
  assert.ok(editor.selected);
});

test('revalidate reports and commits a device-truncated label, undoably', (t) => {
  t.after(resetGeometry);
  const { editor } = editorHarness();
  assert.equal(editor.revalidate(), false, 'nothing changes with the fallback geometry');
  // A reported 200-dpi class is 7.87 dots/mm, not the fallback 8: the dot model
  // is rewritten once so the operator's millimetres stay true.
  setGeometry({ discovered: true, dpi: 200, headWidthPx: 96, maxLengthMm: 100 });
  assert.equal(editor.revalidate(), true, 'the reported pitch rewrites the dot geometry');
  assert.equal(editor.revalidate(), false, 'the rewrite is idempotent');
  // A wider head at 300 dpi fits the same 40 mm document; the dots scale.
  setGeometry({ discovered: true, dpi: 300, headWidthPx: 128, maxLengthMm: 100 });
  assert.equal(editor.revalidate(), false, 'a wider head keeps the millimetre document');
  assert.equal(documentWidthPx(editor.document), Math.round(40 * (300 / 25.4)));
  setGeometry({ discovered: true, dpi: 300, headWidthPx: 128, maxLengthMm: 30 });
  assert.equal(editor.revalidate(), true);
  assert.equal(editor.document.lengthMm, 30);
  assert.equal(editor.canUndo(), true, 'a truncation is an undoable edit, not a silent rewrite');
  const notice = editor.document.notices.at(-1);
  assert.match(notice, /shortened from 40 mm to 30 mm/);
  assert.match(notice, /\d+ elements? moved or resized/);
  editor.undo();
  assert.equal(editor.document.lengthMm, 40, 'the operator can undo the truncation');
});

test('a new text box leaves vertical slack so alignment is observable', () => {
  const doc = createDocument({ lengthMm: 40 });
  const frame = defaultTextFrame(doc);
  assert.equal(frame.w, documentWidthPx(doc) - CONFIG.geometry.paddingPx * 2);
  assert.ok(frame.h < documentHeightPx(doc));
  assert.ok(frame.h >= documentHeightPx(doc) * 0.5);
  assert.equal(frame.y, Math.round((documentHeightPx(doc) - frame.h) / 2));
});

test('replaceDocument is undoable and announces exactly one selection change', () => {
  const { editor, changes, selections } = editorHarness();
  const previous = editor.document;
  const previousIds = previous.elements.map((element) => element.id);

  editor.replaceDocument(createDocument({ lengthMm: 50 }));

  assert.equal(changes.length, 1, 'the document change is emitted once');
  assert.equal(selections.length, 1, 'the inspector rebinds exactly once');
  assert.equal(editor.canUndo(), true, 'a template apply is a normal undoable edit');
  assert.equal(editor.document.lengthMm, 50);
  assert.equal(editor.selection, editor.document.elements.at(-1).id);

  assert.equal(editor.undo(), true);
  assert.equal(editor.document.lengthMm, previous.lengthMm);
  assert.deepEqual(editor.document.elements.map((element) => element.id), previousIds);
});

test('duplicating a locked element produces an unlocked, editable copy', () => {
  const { editor } = editorHarness();
  const id = editor.selection;
  editor.updateElement(id, { locked: true });

  const copy = editor.duplicateElement(id);
  assert.equal(copy.locked, false, 'the copy is usable');
  assert.equal(editor.selection, copy.id);
  assert.equal(editor.selected.locked, false);
  assert.ok(editor.updateElement(copy.id, { x: 1 }), 'the copy accepts geometry edits');
  assert.equal(editor.document.elements.find((element) => element.id === id).locked, true, 'the original stays locked');
});

test('a locked element survives every removal and restack path', () => {
  const { editor, changes } = editorHarness();
  editor.addElement('text', { text: 'Second' });
  const elements = editor.document.elements;
  const id = editor.selection;
  editor.updateElement(id, { locked: true });
  const before = editor.document.elements.map((element) => element.id);
  const committed = changes.length;

  assert.equal(editor.removeElement(id), false, 'the removal owner refuses a locked element');
  editor.reorder(id, 1);
  editor.reorder(id, -1);
  assert.deepEqual(editor.document.elements.map((element) => element.id), before, 'nothing moved or vanished');
  assert.equal(changes.length, committed, 'a refused action never reaches history');

  editor.updateElement(id, { locked: false });
  assert.equal(editor.removeElement(id), true, 'unlocking restores deletion');
  assert.ok(!editor.document.elements.some((element) => element.id === id));
});

test('a locked element rejects property mutations but accepts lock and visibility', () => {
  const { editor, changes } = editorHarness();
  const id = editor.selection;
  editor.updateElement(id, { locked: true });
  const before = editor.document.elements.find((element) => element.id === id);
  const committed = changes.length;

  assert.equal(editor.updateElement(id, { x: 1 }), null, 'geometry edits are rejected');
  assert.equal(editor.updateElement(id, { text: 'nope' }), null, 'content edits are rejected');
  editor.alignElement(id, 'left');
  editor.rotateElement(id, 90);
  assert.equal(changes.length, committed, 'rejected edits never reach history');
  const after = editor.document.elements.find((element) => element.id === id);
  assert.equal(after.x, before.x);
  assert.equal(after.text, before.text);
  assert.equal(after.rotation, before.rotation);

  assert.ok(editor.updateElement(id, { visible: false }), 'visibility stays editable');
  assert.equal(editor.selected.visible, false);
  assert.ok(editor.updateElement(id, { locked: false }), 'the lock itself stays editable');
  assert.ok(editor.updateElement(id, { x: 0 }), 'unlocking restores normal edits');
});

for (const gesture of ['drag', 'resize', 'nudge']) {
  test(`one ${gesture} gesture is element-scoped, so two elements are two undo steps`, (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: 1000 });
    const { editor } = editorHarness();
    const a = editor.selection;
    const b = editor.addElement('rect', {}).id;
    const startA = editor.document.elements.find((element) => element.id === a).x;
    const startB = editor.document.elements.find((element) => element.id === b).x;

    editor.updateElement(a, { x: startA + 1 }, { coalesceKey: gesture });
    editor.updateElement(a, { x: startA + 2 }, { coalesceKey: gesture });
    editor.updateElement(b, { x: startB + 5 }, { coalesceKey: gesture });

    editor.undo();
    assert.equal(editor.document.elements.find((element) => element.id === b).x, startB, 'only the last element moves back');
    assert.equal(editor.document.elements.find((element) => element.id === a).x, startA + 2, 'the other gesture is untouched');
  });
}

test('two length presets are two undo steps, not one', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1000 });
  const { editor } = editorHarness();
  editor.setDocumentLength(25);
  editor.setDocumentLength(30);

  editor.undo();
  assert.equal(editor.document.lengthMm, 25, 'the last preset only');
  editor.undo();
  assert.equal(editor.document.lengthMm, 40, 'then the one before it');
});

/* ---------------- migration notices (R2-2) ---------------- */

test('a deliberate edit dismisses the migration notices it supersedes', () => {
  const editor = createEditor({
    document: createDocument({ lengthMm: 199, notices: ['Label lengthened from 40 mm to 199 mm to fit the migrated content.'] }),
  });
  assert.ok(editor.document.notices?.length, 'the migrated label starts with its notice');
  editor.setDocumentLength(40);
  assert.equal(editor.document.notices, undefined, 'resetting the length answers the stale notice');
  assert.equal(editor.document.lengthMm, 40);
});

test('dismissing notices is not a content edit and creates no undo step', () => {
  const editor = createEditor({
    document: createDocument({ lengthMm: 40, notices: ['One legacy element was dropped because it was not a valid element.'] }),
  });
  assert.equal(editor.canUndo(), false);
  assert.equal(editor.dismissNotices(), true);
  assert.equal(editor.document.notices, undefined);
  assert.equal(editor.canUndo(), false, 'the document content did not change');
  assert.equal(editor.dismissNotices(), false, 'nothing is left to dismiss');
});

test('a revalidated truncation notice survives its own commit', () => {
  const { editor } = editorHarness();
  setGeometry({ discovered: true, dpi: 300, headWidthPx: 128, maxLengthMm: 30 });
  try {
    editor.revalidate();
    assert.ok(editor.document.notices?.some((notice) => /shortened from 40 mm to 30 mm/.test(notice)));
  } finally {
    resetGeometry();
  }
});

/* ---------------- input bounds at the inspector path (R5H-2) ---------------- */

test('the inspector path applies the same string bounds as validation', () => {
  const { editor, changes } = editorHarness();
  const id = editor.selection;
  editor.updateElement(id, { text: 't'.repeat(CONFIG.bounds.maxTextChars + 100) });
  assert.equal(editor.selected.text.length, CONFIG.bounds.maxTextChars);
  assert.equal(changes.at(-1).elements.find((element) => element.id === id).text.length, CONFIG.bounds.maxTextChars);

  const qr = editor.addElement('qr', { value: 'https://example.test' });
  editor.updateElement(qr.id, { value: 'q'.repeat(CONFIG.bounds.maxValueChars + 100) });
  assert.equal(editor.selected.value.length, CONFIG.bounds.maxValueChars);

  const image = editor.addElement('image', { src: 'data:image/png;base64,AAAA' });
  editor.updateElement(image.id, { src: `data:image/png;base64,${'A'.repeat(CONFIG.bounds.maxSrcChars)}` });
  assert.equal(editor.selected.src, '', 'an over-long data URL is dropped, never truncated');
});

test('addElement refuses past the element cap with one notice', () => {
  const { editor, changes } = editorHarness();
  // Fill to the cap through the inspector path (one text element already).
  for (let index = editor.document.elements.length; index < CONFIG.bounds.maxElements; index++) {
    assert.ok(editor.addElement('rect', { w: 10, h: 10 }), `element ${index} is accepted`);
  }
  const before = editor.document.elements.length;
  assert.equal(editor.addElement('text', { text: 'one too many' }), null);
  assert.equal(editor.document.elements.length, before);
  assert.ok(changes.at(-1).notices?.some((notice) => /holds at most 200 elements/.test(notice)));
  assert.equal(editor.canUndo(), true, 'the refusal is not a content edit');
});

/* ---------------- notice acknowledgement (R5B-2) ---------------- */

test('an answered notice never comes back through undo or a later edit', () => {
  const changes = [];
  const editor = createEditor({
    document: createDocument({ lengthMm: 40, notices: ['One legacy element was dropped because it was not a valid element.'] }),
    onChange: (document) => changes.push(document),
  });
  const notice = editor.document.notices[0];
  const id = editor.selection;
  editor.dismissNotices();
  assert.equal(changes.at(-1).notices, undefined, 'the store never sees the answered notice');

  // Edit, then undo: the history snapshot still carries the notice (history is
  // never rewritten) but the published document strips it.
  editor.updateElement(id, { text: 'Changed' });
  assert.ok(editor.undo());
  assert.equal(changes.at(-1).notices, undefined, 'an undo cannot resurrect it');
  assert.equal(editor.document.notices?.includes(notice), true, 'history keeps the original fact');
  assert.ok(editor.redo());
  assert.equal(changes.at(-1).notices, undefined, 'a redo cannot resurrect it either');
});

test('a different document clears the acknowledgement set', () => {
  const changes = [];
  const editor = createEditor({
    document: createDocument({ lengthMm: 40, notices: ['Notice A'] }),
    onChange: (document) => changes.push(document),
  });
  editor.dismissNotices();
  assert.equal(changes.at(-1).notices, undefined);
  // Replacing the label is a new document: its own history starts here. An
  // undo back to the previous label shows that label's notice again.
  editor.replaceDocument(createDocument({ lengthMm: 40, notices: ['Notice A'] }));
  assert.ok(editor.undo());
  assert.deepEqual(changes.at(-1).notices, ['Notice A'], 'the acknowledgement did not carry into the new document');
});

/* ---------------- restack boundaries (R5G-11) ---------------- */

test('restacking at either end changes nothing; the middle moves both ways', () => {
  const document = createDocument({
    lengthMm: 40,
    elements: [
      { id: 'a', type: 'text', text: 'A' },
      { id: 'b', type: 'text', text: 'B' },
      { id: 'c', type: 'text', text: 'C' },
    ],
  });
  const changes = [];
  const editor = createEditor({ document, onChange: (next) => changes.push(next) });
  const order = () => editor.document.elements.map((element) => element.id);

  editor.reorder('a', -1);
  assert.deepEqual(order(), ['a', 'b', 'c'], 'the first layer cannot go further back');
  editor.reorder('c', 1);
  assert.deepEqual(order(), ['a', 'b', 'c'], 'the last layer cannot go further forward');
  assert.equal(changes.length, 0, 'a refused reorder is not an edit');
  assert.equal(editor.canUndo(), false);

  editor.reorder('b', 1);
  assert.deepEqual(order(), ['a', 'c', 'b'], 'the middle moves forward');
  editor.reorder('b', -1);
  assert.deepEqual(order(), ['a', 'b', 'c'], 'and back again');
});

/* ---------------- the display document (R1) ---------------- */

test('the display document strips an answered notice that undo restored', () => {
  const notice = 'One legacy element was dropped because it was not a valid element.';
  const changes = [];
  const editor = createEditor({
    document: createDocument({ lengthMm: 40, notices: [notice] }),
    onChange: (document) => changes.push(document),
  });
  const id = editor.selection;
  editor.dismissNotices();
  editor.updateElement(id, { text: 'Changed' });
  assert.ok(editor.undo());

  assert.equal(editor.document.notices?.includes(notice), true, 'history keeps the original fact');
  assert.equal(editor.documentForDisplay().notices, undefined, 'the display owner strips the answered notice');
  assert.equal(changes.at(-1).notices, undefined, 'the published store stays clean too');
  assert.equal(editor.documentForDisplay(), editor.documentForDisplay(), 'one memoized copy per raw document');
});

/* ---------------- collection and string bounds (R3) ---------------- */

test('duplicating at the element cap refuses with the same notice', () => {
  const { editor, changes } = editorHarness();
  for (let index = editor.document.elements.length; index < CONFIG.bounds.maxElements; index++) {
    assert.ok(editor.addElement('rect', { w: 10, h: 10 }), `element ${index} is accepted`);
  }
  const source = editor.document.elements[0].id;
  const before = editor.document.elements.length;
  assert.equal(editor.duplicateElement(source), null);
  assert.equal(editor.document.elements.length, before, 'the collection never grows past the cap');
  assert.ok(changes.at(-1).notices?.some((notice) => /holds at most 200 elements/.test(notice)));
});

test('addElement applies the string-bound policy and reports a dropped source', () => {
  const { editor, changes } = editorHarness();
  const text = editor.addElement('text', { text: 't'.repeat(CONFIG.bounds.maxTextChars + 50) });
  assert.equal(text.text.length, CONFIG.bounds.maxTextChars, 'the text cap reaches addElement');
  assert.equal(changes.at(-1).elements.find((element) => element.id === text.id).text.length, CONFIG.bounds.maxTextChars);

  const image = editor.addElement('image', { src: 'a'.repeat(CONFIG.bounds.maxSrcChars + 1) });
  assert.equal(image.src, '', 'an over-long source is dropped whole');
  assert.ok(changes.at(-1).notices?.some((notice) => /An image source was dropped/.test(notice)), 'the drop is reported');
});

test('updateElement reports a dropped source instead of blanking it silently', () => {
  const { editor, changes } = editorHarness();
  const image = editor.addElement('image', { src: 'data:image/png;base64,AAAA' });
  editor.updateElement(image.id, { src: 'a'.repeat(CONFIG.bounds.maxSrcChars + 1) });
  assert.equal(editor.selected.src, '');
  const published = changes.at(-1);
  assert.equal(published.elements.find((element) => element.id === image.id).src, '');
  assert.ok(
    published.notices?.some((notice) => /An image source was dropped/.test(notice)),
    'the published document carries the reason'
  );
});

/* ---------------- the image-source cap on an edit (A2) ---------------- */

test('updateElement refuses a seventeenth distinct image source', () => {
  const { editor, changes } = editorHarness();
  const sources = Array.from({ length: CONFIG.image.cacheLimit }, (_, index) => `edit-image-${index}.png`);
  for (const src of sources) assert.ok(editor.addElement('image', { src }));
  const target = editor.document.elements.find((element) => element.type === 'image');
  const committed = changes.length;

  assert.equal(editor.updateElement(target.id, { src: 'edit-image-17.png' }), null, 'the cap refuses the edit');
  assert.equal(
    editor.document.elements.find((element) => element.id === target.id).src,
    sources[0],
    'the existing source is untouched'
  );
  assert.equal(editor.document.elements.length, CONFIG.image.cacheLimit + 1, 'nothing was inserted');
  assert.ok(changes.at(-1).notices?.some((notice) => /at most 16 different images/.test(notice)), 'the reason is published');
  assert.equal(editor.canUndo(), true, 'the refused edit is not a content step');
  assert.equal(changes.length, committed + 1, 'only the refusal notification was emitted');

  assert.equal(
    editor.updateElement(target.id, { src: sources[1] }).src,
    sources[1],
    'reusing an existing source is still allowed'
  );
});

test('the document image budget refuses another copy of a large source', () => {
  const { editor, changes } = editorHarness();
  const src = 'a'.repeat(CONFIG.bounds.maxSrcChars);
  const copies = CONFIG.bounds.maxSourceChars / src.length;
  for (let index = 0; index < copies; index++) assert.ok(editor.addElement('image', { src }), `copy ${index}`);
  const committed = changes.length;

  // Reusing the source passes the distinct-source cap, so only the shared
  // character budget can refuse the next occurrence.
  assert.equal(editor.addElement('image', { src }), null, 'the budget refuses the next copy');
  assert.equal(editor.document.elements.filter((element) => element.type === 'image').length, copies);
  assert.ok(changes.at(-1).notices?.some((notice) => /more than \d+ characters of image data/.test(notice)));
  assert.equal(changes.length, committed + 1, 'only the refusal notification was emitted');

  // A duplicate is another occurrence in the serialised document.
  const first = editor.document.elements.find((element) => element.type === 'image');
  assert.equal(editor.duplicateElement(first.id), null, 'the budget refuses the duplicate');
  assert.equal(editor.document.elements.filter((element) => element.type === 'image').length, copies);
});

/* ---------------- edit-path truncation is reported (A6) ---------------- */

test('an edit that shortens text reports the load-path truncation notice', () => {
  const { editor, changes } = editorHarness();
  const long = 't'.repeat(CONFIG.bounds.maxTextChars + 1);
  editor.updateElement(editor.selection, { text: long });
  assert.equal(editor.selected.text.length, CONFIG.bounds.maxTextChars);
  const loaded = createDocument({ elements: [{ type: 'text', text: long }] });
  assert.deepEqual(changes.at(-1).notices, loaded.notices, 'the same owner and wording as validation');

  const added = editor.addElement('text', { text: long });
  assert.equal(added.text.length, CONFIG.bounds.maxTextChars);
  assert.ok(changes.at(-1).notices?.includes('1 element had text shortened to fit the label limits.'));
});
