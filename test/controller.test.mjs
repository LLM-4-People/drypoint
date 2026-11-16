import test from 'node:test';
import assert from 'node:assert/strict';

import { createEditor } from '../src/editor/controller.js';
import { createDocument, defaultTextFrame, documentHeightPx, documentWidthPx, validateDocument } from '../src/label/schema.js';
import { documentSourceChars } from '../src/label/images.js';
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

/* ---------------- the image-source cap on an edit (U-F2) ---------------- */

/** A harness with exactly 16 distinct image elements and nothing else. */
function sixteenSourcesHarness() {
  const changes = [];
  const refusals = [];
  const sources = Array.from({ length: CONFIG.image.cacheLimit }, (_, index) => `cap-image-${index}.png`);
  const editor = createEditor({
    document: createDocument({
      lengthMm: 200,
      elements: sources.map((src) => ({ type: 'image', src, x: 4, y: 4, w: 40, h: 40 })),
    }),
    onChange: (document) => changes.push(document),
    onRefusal: (message) => refusals.push(message),
  });
  return { editor, changes, refusals, sources };
}

test('at the cap, replacing one image with a new source is allowed', () => {
  const { editor, changes, refusals, sources } = sixteenSourcesHarness();
  const target = editor.document.elements[0];
  const committed = changes.length;

  const replaced = editor.updateElement(target.id, { src: 'cap-image-new.png' });
  assert.ok(replaced, 'the replacement is returned');
  assert.equal(replaced.src, 'cap-image-new.png', 'the source changed');
  assert.equal(editor.document.elements.length, CONFIG.image.cacheLimit, 'no element was added');
  const distinct = new Set(editor.document.elements.map((element) => element.src));
  assert.equal(distinct.size, CONFIG.image.cacheLimit, 'the result still uses 16 distinct sources');
  assert.equal(changes.length, committed + 1, 'the edit is one content step');
  assert.deepEqual(changes.at(-1).notices, undefined, 'a legal replacement stores no refusal notice');
  assert.deepEqual(refusals, [], 'nothing was refused');
  assert.ok(sources.length === CONFIG.image.cacheLimit);
});

test('at the cap, replacing with a source another element already uses is allowed', () => {
  const { editor, refusals } = sixteenSourcesHarness();
  const target = editor.document.elements[0];
  const replacement = editor.document.elements[1].src;

  const replaced = editor.updateElement(target.id, { src: replacement });
  assert.ok(replaced, 'reuse never needs a new slot');
  const distinct = new Set(editor.document.elements.map((element) => element.src));
  assert.equal(distinct.size, CONFIG.image.cacheLimit - 1, 'the result uses 15 distinct sources');
  assert.deepEqual(refusals, []);
});

test('at the cap, adding a seventeenth distinct image element is refused with the resulting count', () => {
  const { editor, changes, refusals, sources } = sixteenSourcesHarness();
  const committed = changes.length;

  assert.equal(editor.addElement('image', { src: 'cap-image-17.png' }), null, 'the cap refuses the add');
  assert.equal(editor.document.elements.length, CONFIG.image.cacheLimit, 'nothing was inserted');
  assert.equal(refusals.length, 1, 'the refusal reaches the toast channel');
  assert.match(refusals[0], /this one uses 17/, 'the count is the document the add would have produced');
  assert.match(refusals[0], /adding another image/, 'the wording names the action');
  assert.ok(changes.at(-1).notices?.some((notice) => /this one uses 17/.test(notice)), 'the notice is published');
  assert.equal(changes.length, committed + 1, 'only the refusal notification was emitted');
  assert.deepEqual(sources, Array.from({ length: CONFIG.image.cacheLimit }, (_, index) => `cap-image-${index}.png`));

  // Reusing an existing source is still allowed at the cap.
  assert.ok(editor.addElement('image', { src: sources[0] }), 'a reused source consumes no slot');
});

test('a shared source keeps its slot, so replacing one of its users at the cap is still refused', () => {
  // Two elements use src0. Excluding the replaced element leaves src0 in the
  // set through the other element, so the result would be 17 distinct sources.
  // A naive "filter the old source string" fix would allow this edit.
  const changes = [];
  const refusals = [];
  const shared = 'shared-source.png';
  const others = Array.from({ length: CONFIG.image.cacheLimit - 1 }, (_, index) => `shared-image-${index}.png`);
  const editor = createEditor({
    document: createDocument({
      lengthMm: 200,
      elements: [shared, shared, ...others].map((src) => ({ type: 'image', src, x: 4, y: 4, w: 40, h: 40 })),
    }),
    onChange: (document) => changes.push(document),
    onRefusal: (message) => refusals.push(message),
  });
  const distinctBefore = new Set(editor.document.elements.map((element) => element.src));
  assert.equal(distinctBefore.size, CONFIG.image.cacheLimit, 'the fixture starts at 16 distinct sources');

  const target = editor.document.elements[0];
  assert.equal(editor.updateElement(target.id, { src: 'shared-source-new.png' }), null, 'the result would be 17');
  assert.equal(editor.document.elements[0].src, shared, 'the old source is untouched');
  assert.equal(refusals.length, 1);
  assert.match(refusals[0], /this one uses 17/);
  assert.match(refusals[0], /replacing this image/, 'the wording names the replacement');
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

/* ---------------- the document budget at the authoring boundary (A-F1) ---------------- */

test('an over-budget update is refused; the existing document is untouched', () => {
  const refusals = [];
  const src = 'a'.repeat(CONFIG.bounds.maxSrcChars);
  // Sixteen distinct sources plus one repeated occurrence: 68 M characters of
  // image text, over the 64 M authoring budget. Only a legacy or imported
  // document can be in this state; the editor must not grow it further.
  const elements = Array.from({ length: CONFIG.image.cacheLimit }, () => ({ type: 'image', src, x: 4, y: 4, w: 40, h: 40 }));
  elements.push({ type: 'image', src, x: 4, y: 4, w: 40, h: 40 });
  const editor = createEditor({ document: createDocument({ lengthMm: 200, elements }), onRefusal: (message) => refusals.push(message) });
  assert.ok(documentSourceChars(editor.document) > CONFIG.bounds.maxSourceChars, 'the fixture is over the budget');

  const target = editor.document.elements[0];
  const replacement = 'b'.repeat(1000);
  assert.equal(editor.updateElement(target.id, { src: replacement }), null, 'the budget refuses the edit');
  assert.equal(editor.document.elements[0].src, src, 'the stored source is untouched');
  assert.match(refusals[0], /more than \d+ characters of image data/);

  // Reusing a source is still allowed: only occurrences grow the file.
  assert.ok(editor.updateElement(target.id, { src }), 'the same source is accepted');
});

test('validation, undo, revalidate and the print target preserve every source', () => {
  // A legacy document can hold more image text than the authoring budget (the
  // real storage quota is ~5.2 M characters, so this is an import-only shape).
  // Once it exists, no normalise pass may rewrite it: validation is called by
  // undo, revalidate and the print boundary.
  const src = `data:image/png;base64,${'B'.repeat(CONFIG.bounds.maxSrcChars - 30)}`;
  // Sixteen distinct sources plus one repeated occurrence: over the authoring
  // budget, under the per-source cap, and legal for storage to hold.
  const elements = Array.from({ length: CONFIG.image.cacheLimit }, (_, index) => ({
    id: `img_${index}`,
    type: 'image',
    src,
    x: 4,
    y: 4,
    w: 40,
    h: 40,
  }));
  elements.push({ id: 'img_repeat', type: 'image', src, x: 4, y: 4, w: 40, h: 40 });
  const over = { lengthMm: 200, elements };
  const count = CONFIG.image.cacheLimit + 1;
  const preserved = validateDocument(over);
  assert.equal(preserved.elements.filter((element) => element.src).length, count);
  assert.ok(
    preserved.elements.reduce((total, element) => total + element.src.length, 0) > CONFIG.bounds.maxSourceChars,
    'the fixture is genuinely over the authoring budget'
  );

  const editor = createEditor({ document: preserved });
  assert.equal(editor.document.elements.filter((element) => element.src).length, count);
  editor.revalidate();
  assert.equal(editor.document.elements.filter((element) => element.src).length, count, 'revalidate preserves');
  editor.updateElement(editor.document.elements[0].id, { x: 8 });
  assert.ok(editor.undo());
  assert.equal(editor.document.elements.filter((element) => element.src).length, count, 'undo preserves');
  // The print target is the same document the renderer/flow reads.
  assert.equal(editor.documentForDisplay().elements.filter((element) => element.src).length, count);
});

/* ---------------- notices survive a replacement (PR-F2) ---------------- */

test('replaceDocument keeps the imported document’s notices and stays one undo step', () => {
  const changes = [];
  const editor = createEditor({
    document: createDocument({ lengthMm: 40 }),
    onChange: (document) => changes.push(document),
  });
  const notice = '1 element had text shortened to fit the label limits.';
  const imported = validateDocument({
    lengthMm: 60,
    elements: [{ type: 'text', text: 't'.repeat(CONFIG.bounds.maxTextChars + 1) }],
  });
  assert.deepEqual(imported.notices, [notice]);

  editor.replaceDocument(imported);
  const published = changes.at(-1);
  assert.deepEqual(published.notices, [notice], 'the persistent channel keeps the fact');
  assert.equal(published.elements.length, 1);
  assert.equal(editor.canUndo(), true, 'the replacement is one undoable step');

  // A reload goes through the store’s hydrate path: validateDocument keeps it.
  assert.deepEqual(validateDocument(JSON.parse(JSON.stringify(published))).notices, [notice]);
  assert.equal(editor.undo(), true);
  assert.equal(editor.document.lengthMm, 40, 'one undo restores the previous label');
});

test('a refused add reaches the refusal channel even when the stage summary is saturated', () => {
  const changes = [];
  const refusals = [];
  const editor = createEditor({
    document: createDocument({
      lengthMm: 200,
      elements: Array.from({ length: CONFIG.bounds.maxElements }, () => ({ type: 'rect', w: 200, h: 96 })),
    }),
    onChange: (document) => changes.push(document),
    onRefusal: (message) => refusals.push(message),
  });
  const committed = changes.length;
  assert.equal(editor.addElement('rect', { w: 10, h: 10 }), null);
  assert.equal(editor.document.elements.length, CONFIG.bounds.maxElements);
  assert.deepEqual(refusals, ['A label holds at most 200 elements.'], 'the operator hears the reason once');
  assert.ok(changes.at(-1).notices?.includes('A label holds at most 200 elements.'));
  assert.equal(changes.length, committed + 1, 'one notification, not a content step');

  // The same refusal twice must not toast twice.
  assert.equal(editor.addElement('rect', { w: 10, h: 10 }), null);
  assert.equal(refusals.length, 1, 'a duplicate refusal is not re-announced');
});

/* ---------------- persisted selection and history ---------------- */

const sample = (name, ids = ['a']) =>
  createDocument({
    name,
    elements: ids.map((id) => ({ id, type: 'text', text: id })),
  });

test('persisted selection and history hydrate silently at construction', () => {
  const historyChanges = [];
  const editor = createEditor({
    document: sample('Present', ['a', 'b']),
    selection: 'a',
    history: { past: [sample('Past')], future: [sample('Future')] },
    onHistoryChange: () => historyChanges.push('changed'),
  });
  assert.equal(editor.selection, 'a', 'the restored selection is kept');
  assert.equal(editor.canUndo(), true, 'the past stack hydrated');
  assert.equal(editor.canRedo(), true, 'the future stack hydrated');
  assert.deepEqual(historyChanges, [], 'hydration is not a change notification');
  assert.equal(editor.historyState().past[0].name, 'Past');
});

test('a persisted null selection stays a deselection, a missing id selects the last element', () => {
  const deselected = createEditor({ document: sample('Present', ['a', 'b']), selection: null });
  assert.equal(deselected.selection, null);

  const repaired = createEditor({ document: sample('Present', ['a', 'b']), selection: 'gone' });
  assert.equal(repaired.selection, 'b', 'a vanished id selects the last element');
});

test('loadDocument replaces document and history without committing the previous label', () => {
  const changes = [];
  const selections = [];
  const historyChanges = [];
  const editor = createEditor({
    document: sample('Before', ['a']),
    history: { past: [sample('Before past')], future: [] },
    selection: 'a',
    onChange: (document) => changes.push(document),
    onSelection: (selection) => selections.push(selection),
    onHistoryChange: () => historyChanges.push('changed'),
  });

  const next = sample('After', ['c', 'd']);
  editor.loadDocument(next, { history: { past: [sample('After past')], future: [sample('After future')] }, selection: 'missing' });

  assert.equal(editor.document.name, 'After');
  assert.equal(editor.selection, 'd', 'a missing restored id is repaired');
  assert.equal(changes.at(-1).name, 'After', 'the new document is announced');
  assert.deepEqual(selections, ['d'], 'the repaired selection is announced');
  assert.equal(historyChanges.length, 1, 'the load marks history dirty');
  assert.equal(editor.historyState().past[0].name, 'After past');
  assert.equal(editor.historyState().past.some((snapshot) => snapshot.name === 'Before'), false, 'the old label is not an undo step');
  assert.equal(editor.undo(), true);
  assert.equal(editor.document.name, 'After past', 'undo follows the loaded history, not the previous label');
});

test('onHistoryChange fires after commit, undo and redo', () => {
  let changes = 0;
  const editor = createEditor({
    document: sample('Present', ['a']),
    onHistoryChange: () => { changes += 1; },
  });
  const added = editor.addElement('rect', { w: 10, h: 10 });
  assert.equal(changes, 1, 'commit notified');
  editor.undo();
  assert.equal(changes, 2, 'undo notified');
  editor.redo();
  assert.equal(changes, 3, 'redo notified');
  assert.ok(added);
});

test('replaceDocument stays an undoable edit', () => {
  const editor = createEditor({ document: sample('Before', ['a']) });
  editor.replaceDocument(sample('Template', ['b']));
  assert.equal(editor.canUndo(), true);
  editor.undo();
  assert.equal(editor.document.name, 'Before');
});


/* ---------------- the refusal notice list is bounded (B-core-F5) ---------------- */

test('a refused 201st add keeps the cap message inside the notice bound', () => {
  const refusals = [];
  const full = Array.from({ length: CONFIG.bounds.maxNotices }, (_, index) => `existing notice ${index}`);
  const editor = createEditor({
    document: {
      version: 4,
      lengthMm: 200,
      copies: 1,
      name: 'Full',
      notices: full,
      elements: Array.from({ length: CONFIG.bounds.maxElements }, () => ({ type: 'rect', w: 10, h: 10 })),
    },
    onRefusal: (message) => refusals.push(message),
  });
  assert.equal(editor.document.notices.length, CONFIG.bounds.maxNotices, 'the fixture starts full');

  assert.equal(editor.addElement('rect', { w: 10, h: 10 }), null);
  assert.equal(editor.document.notices.length, CONFIG.bounds.maxNotices, 'the list never grows past the bound');
  assert.equal(editor.document.notices.at(-1), 'A label holds at most 200 elements.', 'the refusal is kept');
  assert.deepEqual(refusals, ['A label holds at most 200 elements.'], 'and announced once');
  // The oldest entry gives way; the rest of the recent history is intact.
  assert.equal(editor.document.notices.includes('existing notice 0'), false);
  assert.equal(editor.document.notices.includes('existing notice 1'), true);
});
