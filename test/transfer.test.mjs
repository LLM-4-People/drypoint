import test from 'node:test';
import assert from 'node:assert/strict';

import { CONFIG } from '../src/core/config.js';
import { createEditor } from '../src/editor/controller.js';
import { imageSources } from '../src/label/images.js';
import { createDocument, migrateDocument, validateDocument } from '../src/label/schema.js';
import {
  TRANSFER_FORMAT,
  TRANSFER_MAX_BYTES,
  documentFilename,
  parseDocument,
  serializeDocument,
} from '../src/label/transfer.js';

const json = (document) => JSON.stringify(serializeDocument(document), null, 2);

function everyTypeDocument() {
  return validateDocument({
    version: CONFIG.app.documentVersion,
    name: 'Every type',
    lengthMm: 60,
    copies: 3,
    elements: [
      { id: 'text_1', type: 'text', text: 'Hello', fontPx: 22, bold: true, align: 'right', valign: 'top', x: 6, y: 8, w: 120, h: 40 },
      { id: 'qr_1', type: 'qr', value: 'https://example.test', ecLevel: 'Q', x: 8, y: 8, w: 50, h: 50 },
      { id: 'barcode_1', type: 'barcode', value: 'ABC-123', symbology: 'code128', showText: false, x: 70, y: 8, w: 180, h: 56 },
      { id: 'image_1', type: 'image', src: 'data:image/png;base64,AAAA', fit: 'cover', dither: 'atkinson', x: 10, y: 10, w: 40, h: 40 },
      { id: 'rect_1', type: 'rect', strokePx: 3, radiusPx: 6, filled: true, x: 4, y: 4, w: 100, h: 80 },
    ],
  });
}

test('the transfer envelope names the app and the document version', () => {
  const document = everyTypeDocument();
  assert.deepEqual(serializeDocument(document), {
    format: CONFIG.app.id,
    version: CONFIG.app.documentVersion,
    document,
  });
  assert.equal(TRANSFER_FORMAT, CONFIG.app.id);
  assert.equal(JSON.parse(json(document)).format, CONFIG.app.id);
});

test('a round trip preserves every element type and the label length', () => {
  const source = everyTypeDocument();
  const { document, notices } = parseDocument(json(source));
  assert.deepEqual(notices, []);
  assert.equal(document.lengthMm, source.lengthMm);
  assert.equal(document.name, source.name);
  assert.equal(document.copies, source.copies);
  assert.deepEqual(document.elements.map((element) => element.type), ['text', 'qr', 'barcode', 'image', 'rect']);
  for (const element of document.elements) {
    const before = source.elements.find((candidate) => candidate.id === element.id);
    assert.deepEqual(element, before, `${element.id} survives the round trip unchanged`);
  }
});

test('the transfer cap derives from the image and document owners, not 8 MiB', () => {
  assert.equal(CONFIG.bounds.maxSourceChars, CONFIG.image.cacheLimit * CONFIG.bounds.maxSrcChars, 'the one image budget');
  assert.ok(TRANSFER_MAX_BYTES >= CONFIG.bounds.maxSourceChars, 'every valid maximum-size document fits');
  assert.ok(TRANSFER_MAX_BYTES <= CONFIG.bounds.maxSourceChars + 4 * 1024 * 1024, 'the envelope overhead stays bounded');
  assert.ok(TRANSFER_MAX_BYTES > 8 * 1024 * 1024, 'an 8 MiB cap would reject the app’s own export');
  assert.equal(TRANSFER_MAX_BYTES, CONFIG.document.transfer.maxBytes);
});

test('a multi-image document larger than 8 MiB still round trips', () => {
  // Three image sources near the per-image cap: a valid document the app can
  // produce, and larger than the arbitrary 8 MiB cap this test replaced.
  const src = (index) => `data:image/png;base64,${String(index).repeat(3_000_000)}`;
  const source = validateDocument({
    lengthMm: 60,
    copies: 1,
    elements: [0, 1, 2].map((index) => ({ type: 'image', src: src(index) })),
  });
  const text = json(source);
  assert.ok(new TextEncoder().encode(text).byteLength > 8 * 1024 * 1024, `the fixture is larger than 8 MiB (${text.length} chars)`);

  const { document } = parseDocument(text);
  assert.equal(document.lengthMm, 60);
  assert.deepEqual(imageSources(document), imageSources(source), 'all three sources survive');
});

test('a wrong format is refused with the expected token', () => {
  const text = JSON.stringify({ format: 'other-app', version: CONFIG.app.documentVersion, document: createDocument() });
  assert.throws(() => parseDocument(text), (error) => {
    assert.match(error.message, /not a Drypoint label/);
    assert.ok(error.message.includes('"other-app"'));
    assert.ok(error.message.includes(`"${CONFIG.app.id}"`));
    return true;
  });
});

test('truncated JSON has one specific message', () => {
  const text = json(createDocument()).slice(0, 40);
  assert.throws(() => parseDocument(text), /incomplete or is not valid JSON/);
});

test('prototype keys are dropped, never assigned', () => {
  const text = `{
    "format": ${JSON.stringify(CONFIG.app.id)},
    "version": ${CONFIG.app.documentVersion},
    "document": {
      "lengthMm": 40,
      "elements": [],
      "__proto__": { "polluted": true },
      "constructor": { "polluted": true }
    }
  }`;
  const { document } = parseDocument(text);
  assert.equal(document.polluted, undefined);
  assert.equal(Object.prototype.polluted, undefined, 'Object.prototype is untouched');
  assert.equal(Object.hasOwn(document, '__proto__'), false, 'the key never becomes an own property');
  assert.equal(Object.hasOwn(document, 'constructor'), false);
});

test('non-finite geometry is bounded instead of reaching the renderer', () => {
  const text = `{
    "format": ${JSON.stringify(CONFIG.app.id)},
    "version": ${CONFIG.app.documentVersion},
    "document": {
      "lengthMm": 40,
      "elements": [{ "type": "text", "text": "x", "x": 1e999, "y": null, "w": null, "h": 1e999 }]
    }
  }`;
  const { document } = parseDocument(text);
  const element = document.elements[0];
  for (const key of ['x', 'y', 'w', 'h']) assert.ok(Number.isFinite(element[key]), `${key} is finite`);
  assert.ok(element.x >= 0 && element.y >= 0 && element.w > 0 && element.h > 0);
});

test('a 5000-character text is bounded with the load-path notice', () => {
  const text = 't'.repeat(5000);
  const source = validateDocument({ lengthMm: 40, elements: [{ type: 'text', text }] });
  assert.equal(source.elements[0].text.length, CONFIG.bounds.maxTextChars);
  const { document, notices } = parseDocument(json(source));
  assert.equal(document.elements[0].text.length, CONFIG.bounds.maxTextChars);
  // The document was validated once on the way out, so its notice is already in
  // the envelope; parse keeps the same wording rather than inventing another.
  assert.ok(notices.some((notice) => /shortened to fit the label limits/.test(notice)));
});

test('a seventeenth distinct image is refused with the print-limit wording', () => {
  const source = validateDocument({
    lengthMm: 40,
    elements: Array.from({ length: CONFIG.image.cacheLimit + 1 }, (_, index) => ({ type: 'image', src: `transfer-${index}.png` })),
  });
  assert.throws(() => parseDocument(json(source)), (error) => {
    assert.match(error.message, new RegExp(`at most ${CONFIG.image.cacheLimit} different images`));
    assert.match(error.message, /uses 17/);
    return true;
  });
});

test('an over-budget image document is refused whole, never partially imported', () => {
  const src = 'a'.repeat(CONFIG.bounds.maxSrcChars);
  const over = {
    lengthMm: 40,
    elements: Array.from({ length: CONFIG.image.cacheLimit + 1 }, () => ({ type: 'image', src })),
  };
  // Validation preserves the document: the importer is the boundary that
  // refuses it (A-F1), so no source is silently emptied on the way in.
  const preserved = validateDocument(over);
  assert.equal(preserved.elements.filter((element) => element.src).length, CONFIG.image.cacheLimit + 1);
  assert.throws(() => parseDocument(json(preserved)), (error) => {
    assert.match(error.message, /characters of image data/);
    assert.match(error.message, new RegExp(String(CONFIG.bounds.maxSourceChars)));
    assert.match(error.message, /Remove or reuse an image/);
    return true;
  });
  // Exactly the budget still imports.
  const atCap = validateDocument({ lengthMm: 40, elements: Array.from({ length: CONFIG.image.cacheLimit }, () => ({ type: 'image', src })) });
  assert.equal(parseDocument(json(atCap)).document.elements.length, CONFIG.image.cacheLimit);
});

test('an imported v3 document rotates exactly like the stored one and says so', () => {
  const legacy = {
    version: 3,
    lengthMm: 40,
    elements: [{ id: 'a', type: 'text', x: 4, y: 4, w: 88, h: 312, rotation: 90, text: 'Hi' }],
  };
  const text = JSON.stringify({ format: TRANSFER_FORMAT, version: CONFIG.app.documentVersion, document: legacy });
  const { document, notices } = parseDocument(text);
  const stored = migrateDocument(legacy);
  assert.deepEqual(document, stored, 'import and storage share one migration path');
  assert.equal(document.version, CONFIG.app.documentVersion);
  assert.equal(document.elements[0].w, 312, 'the portrait box was rotated');
  assert.equal(document.elements[0].rotation, 0);
  assert.deepEqual(notices, stored.notices ?? [], 'the import reports exactly the storage path’s notices');
  assert.equal(
    notices.filter((notice) => /older portrait layout and was rotated to fit the current label format/.test(notice)).length,
    1,
    'the import carries the rotation notice'
  );

  // A legacy document that loses an element says so on import too: the notice
  // is produced by the one migration owner, not by the importer.
  const lossy = { ...legacy, elements: [...legacy.elements, { type: 'sparkle' }, { type: 'sparkle' }] };
  const lossyText = JSON.stringify({ format: TRANSFER_FORMAT, version: CONFIG.app.documentVersion, document: lossy });
  const parsed = parseDocument(lossyText);
  assert.ok(parsed.notices.some((notice) => /2 legacy elements were dropped/.test(notice)));
  assert.ok(
    parsed.notices.some((notice) => /older portrait layout and was rotated/.test(notice)),
    'the rotation notice survives beside the drop notice'
  );
  assert.deepEqual(parsed.notices, migrateDocument(lossy).notices);
});

test('an over-size file is refused before JSON.parse', () => {
  const oversized = 'x'.repeat(TRANSFER_MAX_BYTES + 1);
  assert.throws(() => parseDocument(oversized), /too large/);
  assert.throws(() => parseDocument('x'), /not valid JSON/, 'a small non-JSON file still reaches the parser');
});

test('a structurally wrong element list is refused with the shape owner’s message', () => {
  const text = JSON.stringify({
    format: TRANSFER_FORMAT,
    version: CONFIG.app.documentVersion,
    document: { lengthMm: 40, elements: 'nope' },
  });
  assert.throws(() => parseDocument(text), /no valid element list/);
});

/* ---------------- envelope errors (K-F12) ---------------- */

test('every envelope defect has one specific message', () => {
  const document = validateDocument({ lengthMm: 40, elements: [] });
  const cases = [
    [[], /not a Drypoint label document/],
    [null, /not a Drypoint label document/],
    [{ format: CONFIG.app.id, version: 0, document }, /no valid transfer version/],
    [{ format: CONFIG.app.id, version: 1.5, document }, /no valid transfer version/],
    [{ format: CONFIG.app.id, version: '4', document }, /no valid transfer version/],
    [{ format: CONFIG.app.id, version: CONFIG.app.documentVersion + 1, document }, /newer version/],
    [{ format: CONFIG.app.id, version: CONFIG.app.documentVersion }, /no label document/],
    [{ format: CONFIG.app.id, version: CONFIG.app.documentVersion, document: [] }, /no label document/],
    [{ version: CONFIG.app.documentVersion, document }, /its format is missing/],
  ];
  for (const [value, expected] of cases) {
    assert.throws(() => parseDocument(JSON.stringify(value)), expected, JSON.stringify(value));
  }
});

test('a document saved by a newer version imports with the migration notice', () => {
  const text = JSON.stringify({
    format: TRANSFER_FORMAT,
    version: CONFIG.app.documentVersion,
    document: { version: CONFIG.app.documentVersion + 1, lengthMm: 40, elements: [{ type: 'text', text: 'x' }] },
  });
  const { document, notices } = parseDocument(text);
  assert.equal(document.elements.length, 1);
  assert.ok(notices.some((notice) => /saved by a newer version/.test(notice)));
});

test('an imported document is one undoable step', () => {
  const changes = [];
  const editor = createEditor({ document: createDocument({ lengthMm: 40 }), onChange: (document) => changes.push(document) });
  const beforeIds = editor.document.elements.map((element) => element.id);
  const { document } = parseDocument(json(everyTypeDocument()));

  editor.replaceDocument(document);
  assert.equal(changes.length, 1, 'one change reaches the store');
  assert.equal(editor.document.lengthMm, 60);
  assert.equal(editor.canUndo(), true);

  assert.equal(editor.undo(), true);
  assert.equal(editor.document.lengthMm, 40);
  assert.deepEqual(editor.document.elements.map((element) => element.id), beforeIds, 'one undo restores the previous label');
});

test('the export filename is timestamped and bridge-safe', () => {
  const name = documentFilename('My / Label .. ☃', Date.UTC(2026, 10, 16, 0, 45, 12, 345));
  assert.equal(name, 'drypoint-my-label-2026-11-16t00-45-12-345z.json');
  for (const [value, at] of [
    ['', 0],
    ['..', 1],
    ['a\u0000b/c\\d', 2],
  ]) {
    const filename = documentFilename(value, at);
    assert.match(filename, /^[a-z0-9][a-z0-9.-]*\.json$/, `${JSON.stringify(value)} becomes one safe segment`);
    assert.ok(!filename.includes('/') && !filename.includes('\\') && !filename.includes('\u0000'));
    assert.ok(!filename.split('.').includes('..'), 'no parent-directory segment');
  }
});

test('an untrusted format is quoted as a bounded, escaped excerpt', () => {
  // Triple-check Low: a 1 MB `format` was echoed whole into the error, which
  // becomes a toast and a log line. The one excerpt owner keeps the message
  // short, keeps a normal wrong format recognisable, and cannot throw on a
  // hostile value (an object with a null toString).
  const document = validateDocument({ lengthMm: 40, elements: [] });
  const attempt = (format) => {
    try {
      parseDocument(JSON.stringify({ format, version: CONFIG.app.documentVersion, document }));
      return null;
    } catch (error) {
      return error.message;
    }
  };

  const huge = attempt('x'.repeat(1_000_000));
  assert.ok(huge.length < 300, `the message is bounded (${huge.length} chars)`);
  assert.match(huge, /its format is "x{24}"…/);

  const normal = attempt('other-app');
  assert.match(normal, /its format is "other-app"/, 'a normal wrong format is still named');

  const hostile = attempt({ toString: null });
  assert.ok(hostile.length < 300, `an object format is bounded (${hostile.length} chars)`);
  assert.match(hostile, /its format is "\{\\"toString\\":null\}"/);

  const missing = attempt(undefined);
  assert.match(missing, /its format is missing/);
});
