import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ALIGNMENTS,
  ELEMENT_TYPES,
  FIT_MODES,
  IMAGE_DITHERS,
  ROTATIONS,
  VALIGNMENTS,
  createDocument,
  createElement,
  exceedsPrinterLimits,
  documentWidthPx,
  validateDocument,
  migrateDocument,
} from '../src/label/schema.js';
import { TEMPLATES } from '../src/label/templates.js';
import { EC_LEVELS } from '../src/label/qr.js';
import { CONFIG } from '../src/core/config.js';
import { resetGeometry, setGeometry } from '../src/core/geometry.js';

test('validateDocument never mutates its input', () => {
  const input = {
    lengthMm: 40,
    elements: [{ id: '', type: 'text', x: 10, y: 10, w: 40, h: 20, align: 'diagonal', text: 'x' }],
  };
  const snapshot = JSON.stringify(input);
  const doc = validateDocument(input);
  assert.equal(JSON.stringify(input), snapshot, 'the caller document must be untouched');
  assert.notEqual(doc.elements[0], input.elements[0]);
});

test('validateDocument generates ids for falsy and duplicate ids', () => {
  const doc = validateDocument({
    lengthMm: 40,
    elements: [
      { id: '', type: 'text', text: 'a' },
      { type: 'rect' },
      { id: 'same', type: 'qr', value: 'https://a' },
      { id: 'same', type: 'qr', value: 'https://b' },
    ],
  });
  const ids = doc.elements.map((element) => element.id);
  assert.equal(ids.length, 4);
  assert.ok(ids.every(Boolean));
  assert.equal(new Set(ids).size, 4, 'ids must be unique');
});

test('validateDocument falls back to per-type defaults for invalid enums', () => {
  const doc = validateDocument({
    lengthMm: 40,
    elements: [
      { type: 'text', rotation: 45, align: 'diagonal', valign: 'sky', text: 'x' },
      { type: 'qr', value: 'https://a', ecLevel: 'Z' },
      { type: 'barcode', value: 'ABC', symbology: 'ean13' },
      { type: 'image', src: 'data:x', fit: 'zoom', dither: 'bayer' },
    ],
  });
  const [text, qr, barcode, image] = doc.elements;
  assert.equal(text.rotation, 0);
  assert.equal(text.align, 'center');
  assert.equal(text.valign, 'middle');
  assert.equal(qr.ecLevel, 'M');
  assert.equal(barcode.symbology, 'code128');
  assert.equal(image.fit, 'contain');
  assert.equal(image.dither, 'auto');
  // The declared enum owners are literal contracts, not "whatever the
  // implementation happens to accept".
  assert.deepEqual(ALIGNMENTS, ['left', 'center', 'right']);
  assert.deepEqual(VALIGNMENTS, ['top', 'middle', 'bottom']);
  assert.deepEqual(EC_LEVELS, ['L', 'M', 'Q', 'H']);
  assert.deepEqual(FIT_MODES, ['contain', 'cover', 'stretch']);
  assert.deepEqual(IMAGE_DITHERS, ['auto', 'threshold', 'floyd', 'atkinson']);
  assert.deepEqual(ROTATIONS, [0, 90, 180, 270]);
});

test('validateDocument turns unusable geometry into the type defaults', () => {
  const doc = validateDocument({
    lengthMm: 40,
    elements: [
      { type: 'text', x: Number.NaN, y: undefined, w: 'wide', h: Number.NaN, text: 'x' },
      { type: 'text', x: 0, y: 0, w: 10, h: Infinity, text: 'y' },
    ],
  });
  const [fallback, infinite] = doc.elements;
  assert.equal(fallback.x, CONFIG.geometry.paddingPx);
  assert.equal(fallback.y, CONFIG.geometry.paddingPx);
  assert.equal(fallback.w, CONFIG.geometry.widthPx - CONFIG.geometry.paddingPx * 2);
  assert.equal(fallback.h, 80);
  // Infinity is not a finite number: the type default applies, never a clamped
  // 96px box the caller did not ask for.
  assert.equal(infinite.h, 80);
});

test('validateDocument allows an empty document and does not seed "Hello"', () => {
  assert.deepEqual(validateDocument({ lengthMm: 40 }).elements, []);
  assert.deepEqual(validateDocument({ lengthMm: 40, elements: [] }).elements, []);
  // createDocument remains the only owner of the first-run document.
  const fresh = createDocument({ lengthMm: 40 });
  assert.equal(fresh.elements.length, 1);
  assert.equal(fresh.elements[0].text, 'Hello');
});

test('validateDocument coerces booleans at the trust boundary', () => {
  const doc = validateDocument({
    lengthMm: 40,
    elements: [
      { type: 'text', text: 'x', visible: 'false', locked: 'false', bold: 'false' },
      { type: 'text', text: 'y', visible: 'true', locked: 'true', bold: 'true' },
      { type: 'text', text: 'z', visible: 0, locked: 1, bold: 'nonsense' },
      { type: 'barcode', value: 'ABC', showText: 'false' },
      { type: 'rect', filled: 'false' },
    ],
  });
  const [falseStrings, trueStrings, numbers, barcode, rect] = doc.elements;
  // "false" is a non-empty string and therefore truthy in a plain Boolean().
  assert.equal(falseStrings.visible, false);
  assert.equal(falseStrings.locked, false);
  assert.equal(falseStrings.bold, false);
  assert.equal(trueStrings.visible, true);
  assert.equal(trueStrings.locked, true);
  assert.equal(trueStrings.bold, true);
  assert.equal(numbers.visible, false);
  assert.equal(numbers.locked, true);
  assert.equal(numbers.bold, true, 'an unreadable value keeps the type default');
  assert.equal(barcode.showText, false);
  assert.equal(rect.filled, false);
});

test('validateDocument requires a non-empty string id', () => {
  const doc = validateDocument({
    lengthMm: 40,
    elements: [
      { id: 123, type: 'text', text: 'a' },
      { id: '   ', type: 'text', text: 'b' },
      { id: ' kept ', type: 'text', text: 'c' },
    ],
  });
  const ids = doc.elements.map((element) => element.id);
  assert.ok(ids.every((id) => typeof id === 'string' && id.length > 0));
  assert.notEqual(ids[0], '123', 'a numeric id is replaced');
  assert.equal(ids[1].trim(), ids[1], 'a generated id has no surrounding space');
  assert.equal(ids[2], 'kept', 'a real id is trimmed, not replaced');
});

test('stored fontPx is 0 (auto) or inside minFontPx..maxFontPx, never 1..7', () => {
  const doc = validateDocument({
    lengthMm: 40,
    elements: [
      { type: 'text', text: 'auto', fontPx: 0 },
      { type: 'text', text: 'tiny', fontPx: 3 },
      { type: 'text', text: 'edge', fontPx: 7 },
      { type: 'text', text: 'smallest', fontPx: 8 },
      { type: 'text', text: 'huge', fontPx: 999 },
      { type: 'text', text: 'negative', fontPx: -20 },
      { type: 'text', text: 'fraction', fontPx: 24.6 },
    ],
  });
  const [auto, tiny, edge, smallest, huge, negative, fraction] = doc.elements;
  assert.equal(auto.fontPx, 0, '0 keeps its auto-size meaning');
  // A size the renderer cannot paint (it clamps 1..7 up to minFontPx) must not
  // be stored as if it were the painted size.
  assert.equal(tiny.fontPx, CONFIG.geometry.minFontPx);
  assert.equal(edge.fontPx, CONFIG.geometry.minFontPx);
  assert.equal(smallest.fontPx, 8);
  assert.equal(huge.fontPx, CONFIG.geometry.maxFontPx, 'the stored size matches what renders');
  assert.equal(negative.fontPx, 0);
  assert.equal(fraction.fontPx, 24.6);
  for (const element of doc.elements) {
    const stored = element.fontPx;
    assert.ok(
      stored === 0 || (stored >= CONFIG.geometry.minFontPx && stored <= CONFIG.geometry.maxFontPx),
      `fontPx ${stored} is neither auto nor paintable`
    );
  }
});

test('createDocument honours supplied elements and validates length and copies', () => {
  const doc = createDocument({
    lengthMm: 5000,
    copies: 999,
    elements: [{ id: 'only', type: 'rect', x: 0, y: 0, w: 20, h: 20 }],
  });
  assert.equal(doc.version, CONFIG.app.documentVersion);
  assert.equal(doc.copies, CONFIG.print.copies.max);
  assert.equal(doc.elements.length, 1);
  assert.equal(doc.elements[0].id, 'only');

  // An explicitly empty document stays empty; no seeded "Hello".
  assert.deepEqual(createDocument({ lengthMm: 40, elements: [] }).elements, []);
  // Without elements, the first-run text block is still created and validated.
  const fresh = createDocument({ lengthMm: 40 });
  assert.equal(fresh.elements.length, 1);
  assert.equal(fresh.elements[0].text, 'Hello');
  assert.ok(fresh.elements[0].id);
});

test('migrateDocument treats a missing version as the current model', () => {
  const migrated = migrateDocument({
    lengthMm: 40,
    elements: [{ id: 'a', type: 'rect', x: 10, y: 30, w: 40, h: 20, rotation: 0 }],
  });
  const element = migrated.elements[0];
  assert.deepEqual(
    { x: element.x, y: element.y, w: element.w, h: element.h, rotation: element.rotation },
    { x: 10, y: 30, w: 40, h: 20, rotation: 0 },
    'an unversioned document is never rotated as if it were portrait v3'
  );
  assert.equal(migrated.version, CONFIG.app.documentVersion);
});

test('only a finite number or a non-empty numeric string is a version', () => {
  const elementOf = (version) =>
    migrateDocument({
      version,
      lengthMm: 40,
      elements: [{ id: 'a', type: 'rect', x: 10, y: 30, w: 40, h: 20, rotation: 0 }],
    }).elements[0];
  // Number() turns all of these into 0 or 1, which used to look like a
  // pre-v4 portrait document and rotate a landscape label.
  for (const version of ['', '   ', true, false, [], {}, Number.NaN, Number.POSITIVE_INFINITY, null, undefined]) {
    const element = elementOf(version);
    assert.deepEqual(
      { x: element.x, y: element.y, w: element.w, h: element.h, rotation: element.rotation },
      { x: 10, y: 30, w: 40, h: 20, rotation: 0 },
      `${JSON.stringify(version)} must be treated as the current model`
    );
  }
  for (const version of [3, '3', ' 3 ']) {
    assert.equal(elementOf(version).rotation, 270, `${JSON.stringify(version)} is a portrait version`);
  }
  for (const version of [4, '4', 5]) {
    assert.equal(elementOf(version).rotation, 0, `${JSON.stringify(version)} is current or newer`);
  }
});

test('validateDocument keeps migration notices and drops unreadable ones', () => {
  assert.deepEqual(validateDocument({ lengthMm: 40, notices: ['a', 'a', '', 5, ' b '] }).notices, ['a', 'b']);
  assert.equal(validateDocument({ lengthMm: 40, notices: 'nope' }).notices, undefined);
  assert.equal(validateDocument({ lengthMm: 40 }).notices, undefined, 'a clean document carries no notice key');
});

test('createDocument clamps the length before it seeds the text frame', () => {
  const doc = createDocument({ lengthMm: 5000 });
  assert.equal(doc.lengthMm, 200);
  assert.equal(documentWidthPx(doc), 1600);
  const [text] = doc.elements;
  assert.deepEqual(
    { x: text.x, y: text.y, w: text.w, h: text.h },
    { x: 4, y: 17, w: 1592, h: 62 },
    'the seeded frame is sized from the clamped 200 mm tape, not the requested 5000 mm'
  );
  assert.ok(text.x + text.w <= documentWidthPx(doc));
  assert.equal(doc.elements.length, 1);
});

test('every template validates to its intended element count', () => {
  const expected = { text: 1, name: 1, qr: 2, cable: 2, frame: 2, blank: 0 };
  assert.deepEqual(
    TEMPLATES.map((template) => template.id).sort(),
    Object.keys(expected).sort(),
    'every template has a declared count'
  );
  for (const template of TEMPLATES) {
    const doc = validateDocument(template.build());
    assert.equal(doc.elements.length, expected[template.id], `${template.id} element count`);
  }
});

test('the blank template stays empty through validation', () => {
  const blank = TEMPLATES.find((template) => template.id === 'blank');
  assert.equal(blank.build().elements.length, 0);
  assert.equal(validateDocument(blank.build()).elements.length, 0);
});

test('element factories still produce one of each declared type', () => {
  for (const type of Object.values(ELEMENT_TYPES)) {
    assert.equal(createElement(type).type, type);
  }
});

/* ---------------- hostile string fields (R8-1) ---------------- */

const STRING_FIELDS = [
  { type: ELEMENT_TYPES.TEXT, field: 'text' },
  { type: ELEMENT_TYPES.TEXT, field: 'name' },
  { type: ELEMENT_TYPES.QR, field: 'value' },
  { type: ELEMENT_TYPES.BARCODE, field: 'value' },
  { type: ELEMENT_TYPES.IMAGE, field: 'src' },
];

const HOSTILE_VALUES = [
  ['a string', 'kept', 'kept'],
  ['an empty string', '', ''],
  ['null', null, ''],
  ['undefined', undefined, ''],
  ['a number', 123, '123'],
  ['zero', 0, '0'],
  ['a boolean', true, 'true'],
  ['an array', ['a', 'b'], ''],
  ['an object', { nested: 1 }, ''],
];

for (const { type, field } of STRING_FIELDS) {
  test(`the schema coerces ${type}.${field} at the boundary`, () => {
    for (const [label, input, expected] of HOSTILE_VALUES) {
      const raw = { ...createElement(type), [field]: input };
      if (input === undefined) raw[field] = undefined;
      const [element] = validateDocument({ lengthMm: 40, elements: [raw] }).elements;
      assert.equal(element[field], expected, `${type}.${field} with ${label}`);
      assert.equal(typeof element[field], 'string', `${type}.${field} is always text`);
    }
  });
}

test('one non-string text field cannot brick boot-time derivations', () => {
  // The stored document is untrusted JSON: every consumer must see text.
  const [element] = validateDocument({ lengthMm: 40, elements: [{ type: 'text', text: 123 }] }).elements;
  assert.equal(element.text, '123');
  assert.equal(element.text.split('\n')[0], '123');
});

/* ---------------- legacy migration robustness (R8-2/R2-7/R2-8) ---------------- */

test('a non-object entry in a legacy v3 document costs that entry, not the label', () => {
  const migrated = migrateDocument({ version: 3, lengthMm: 40, elements: [null, { type: 'text', text: 'Survivor' }] });
  assert.deepEqual(migrated.elements.map((element) => element.text), ['Survivor']);
  assert.ok(
    migrated.notices.some((notice) => /1 legacy element was dropped because it was not a valid element/.test(notice)),
    `the drop is reported: ${JSON.stringify(migrated.notices)}`
  );
});

test('several invalid legacy entries are counted in one notice', () => {
  const migrated = migrateDocument({ version: 3, lengthMm: 40, elements: [null, 7, ['x'], { type: 'text', text: 'Kept' }] });
  assert.deepEqual(migrated.elements.map((element) => element.text), ['Kept']);
  assert.ok(migrated.notices.some((notice) => /3 legacy elements were dropped because they were not valid elements/.test(notice)));
});

test('hostile numeric fields never throw and fall back to the type defaults', () => {
  // `Number({toString: null})` throws, and booleans/arrays coerce to 0/1; both
  // used to discard the whole label. Every field below goes through finite().
  const hostile = [
    { toString: null },
    { valueOf: null, toString: null },
    [],
    [12],
    true,
    false,
    'wide',
    '  ',
    '',
    null,
    undefined,
    10n,
  ];
  for (const value of hostile) {
    const label = Object.prototype.toString.call(value);
    const doc = validateDocument({
      lengthMm: value,
      elements: [
        { type: 'text', x: value, y: value, w: value, h: value, fontPx: value, text: 'x' },
        { type: ELEMENT_TYPES.RECT, x: value, y: value, w: value, h: value, strokePx: value, radiusPx: value },
      ],
    });
    assert.equal(doc.lengthMm, CONFIG.geometry.defaultLengthMm, `${label} length falls back`);
    assert.equal(doc.elements.length, 2, 'both elements survive');
    for (const element of doc.elements) {
      assert.ok(Number.isFinite(element.x) && Number.isFinite(element.y), 'position is finite');
      assert.ok(Number.isFinite(element.w) && element.w > 0, 'width is usable');
      assert.ok(Number.isFinite(element.h) && element.h > 0, 'height is usable');
    }
    const frame = doc.elements[1];
    assert.ok(Number.isFinite(frame.strokePx) && frame.strokePx >= 1);
    assert.ok(Number.isFinite(frame.radiusPx) && frame.radiusPx >= 0);
  }

  // Numeric strings still work: the form and persisted data rely on it.
  const numeric = validateDocument({ lengthMm: '55', elements: [{ type: 'text', x: '4', y: ' 6 ', w: '20', h: '10', text: 'x' }] });
  assert.equal(numeric.lengthMm, 55);
  assert.equal(numeric.elements[0].y, 6);
});

test('v3 migration never writes into the caller’s notices array', () => {
  const notices = [];
  const migrated = migrateDocument({
    version: 3,
    lengthMm: 40,
    notices,
    elements: [null, { type: 'text', text: 'Survivor', x: 4, y: 4, w: 20, h: 10 }],
  });
  assert.deepEqual(notices, [], 'the input array is untouched');
  assert.equal(migrated.elements.length, 1, 'the valid element survives');
  assert.match(migrated.notices.join(' '), /1 legacy element was dropped/);
});

/* ---------------- hostile rotation and legacy numerics (R5B-1/R5H-1) ---------------- */

test('a hostile rotation falls back to the type default like every numeric field', () => {
  // `Number({toString: null})` throws; the raw cast used to discard the whole
  // stored label and the next edit persisted over it.
  const hostile = [
    { toString: null },
    { valueOf: null, toString: null },
    [],
    [90],
    true,
    false,
    '',
    '  ',
    'wide',
    null,
    undefined,
    10n,
    Number.NaN,
    Number.POSITIVE_INFINITY,
  ];
  for (const value of hostile) {
    const label = Object.prototype.toString.call(value);
    const doc = validateDocument({
      lengthMm: 40,
      elements: [{ type: ELEMENT_TYPES.TEXT, text: 'x', rotation: value }],
    });
    assert.equal(doc.elements.length, 1, `${label}: the element survives`);
    assert.equal(doc.elements[0].rotation, 0, `${label}: rotation falls back`);
  }
  // The rotation matrix still adds the value it already accepted.
  assert.equal(validateDocument({ lengthMm: 40, elements: [{ type: 'text', text: 'x', rotation: '90' }] }).elements[0].rotation, 90);
  assert.equal(validateDocument({ lengthMm: 40, elements: [{ type: 'text', text: 'x', rotation: 45 }] }).elements[0].rotation, 0);
});

test('the element count is capped with one notice', () => {
  const elements = Array.from({ length: CONFIG.bounds.maxElements + 3 }, (_, index) => ({
    id: `e${index}`,
    type: 'text',
    text: 'x',
  }));
  const doc = validateDocument({ lengthMm: 40, elements });
  assert.equal(doc.elements.length, CONFIG.bounds.maxElements);
  assert.ok(doc.notices?.some((notice) => /3 elements were dropped: a label holds at most 200 elements/.test(notice)));

  const one = validateDocument({ lengthMm: 40, elements: [...elements.slice(0, CONFIG.bounds.maxElements), { type: 'text', text: 'y' }] });
  assert.ok(one.notices?.some((notice) => /^1 element was dropped/.test(notice)));
});

test('text, value and name are cut to their declared caps at the boundary', () => {
  const { maxTextChars, maxValueChars, maxNameChars } = CONFIG.bounds;
  const doc = validateDocument({
    lengthMm: 40,
    elements: [
      { type: 'text', name: 'n'.repeat(maxNameChars + 5), text: 't'.repeat(maxTextChars + 5) },
      { type: 'qr', value: 'q'.repeat(maxValueChars + 5) },
      { type: 'barcode', value: 'b'.repeat(maxValueChars + 5) },
    ],
  });
  assert.equal(doc.elements[0].text.length, maxTextChars);
  assert.equal(doc.elements[0].name.length, maxNameChars);
  assert.equal(doc.elements[1].value.length, maxValueChars);
  assert.equal(doc.elements[2].value.length, maxValueChars);
});

test('a current-version document notices unknown types and shortened text', () => {
  const doc = validateDocument({
    version: CONFIG.app.documentVersion,
    lengthMm: 40,
    elements: [
      { type: 'text', text: 'kept' },
      { type: 'future-chart', value: 'not something this version paints' },
      { type: 'qr', value: 'q'.repeat(CONFIG.bounds.maxValueChars + 5) },
    ],
  });
  assert.equal(doc.elements.length, 2, 'the known elements survive');
  assert.ok(
    doc.notices?.some((notice) => /^1 element was dropped because it is not a valid element for this version\.$/.test(notice)),
    'the unknown type is reported, not silently discarded'
  );
  assert.ok(
    doc.notices?.some((notice) => /^1 element had text shortened to fit the label limits\.$/.test(notice)),
    'the truncation is reported'
  );
  assert.equal(doc.elements[1].value.length, CONFIG.bounds.maxValueChars);

  const many = validateDocument({
    lengthMm: 40,
    elements: [
      { type: 'text', text: 'a'.repeat(CONFIG.bounds.maxTextChars + 1) },
      { type: 'text', name: 'n'.repeat(CONFIG.bounds.maxNameChars + 1), text: 'b' },
      { type: 'nope' },
      { type: 'nope' },
    ],
  });
  assert.ok(many.notices.some((notice) => /^2 elements had text shortened/.test(notice)));
  assert.ok(many.notices.some((notice) => /^2 elements were dropped because they are not valid elements/.test(notice)));
});

test('an over-long image source is dropped whole, never truncated, with one notice', () => {
  const src = `data:image/png;base64,${'A'.repeat(CONFIG.bounds.maxSrcChars)}`;
  const doc = validateDocument({
    lengthMm: 40,
    elements: [
      { type: 'image', src },
      { type: 'image', src },
      { type: 'text', text: 'kept' },
    ],
  });
  assert.equal(doc.elements.length, 3, 'the elements survive; only their source is dropped');
  assert.equal(doc.elements[0].src, '', 'the data URL is not truncated to a corrupt prefix');
  assert.equal(doc.elements[1].src, '');
  const notices = doc.notices.filter((notice) => /image source was dropped/.test(notice));
  assert.equal(notices.length, 1, 'one notice for the whole document');
  assert.match(notices[0], /longer than 4000000 characters/);

  // A source exactly at the cap is untouched.
  const atCap = validateDocument({ lengthMm: 40, elements: [{ type: 'image', src: 'a'.repeat(CONFIG.bounds.maxSrcChars) }] });
  assert.equal(atCap.elements[0].src.length, CONFIG.bounds.maxSrcChars);
  assert.equal(atCap.notices, undefined);
});

test('notices are bounded in count and length', () => {
  const notices = Array.from({ length: CONFIG.bounds.maxNotices + 4 }, (_, index) => `notice ${index} ${'z'.repeat(CONFIG.bounds.maxNoticeChars)}`);
  const doc = validateDocument({ lengthMm: 40, notices });
  assert.equal(doc.notices.length, CONFIG.bounds.maxNotices);
  assert.equal(doc.notices[0].length, CONFIG.bounds.maxNoticeChars);
});

/* ---------------- migration honesty (R5B-7) ---------------- */

test('legacy migration counts unknown element types as dropped, not silently', () => {
  const migrated = migrateDocument({
    version: 3,
    lengthMm: 40,
    elements: [
      { type: 'text', text: 'Kept', x: 4, y: 4, w: 20, h: 10 },
      { type: 'sparkle', x: 4, y: 4, w: 20, h: 10 },
      { type: 'sparkle', x: 4, y: 4, w: 20, h: 10 },
    ],
  });
  assert.deepEqual(migrated.elements.map((element) => element.text), ['Kept']);
  assert.ok(migrated.notices.some((notice) => /2 legacy elements were dropped because they were not valid elements/.test(notice)));
});

test('a non-array legacy element list is reported instead of silently emptied', () => {
  const migrated = migrateDocument({ version: 3, lengthMm: 40, elements: { type: 'text', text: 'x' } });
  assert.deepEqual(migrated.elements, []);
  assert.ok(migrated.notices.some((notice) => /had no element list, so it was loaded with no elements/.test(notice)));
  // A document that simply has no elements key is not noise.
  const empty = migrateDocument({ version: 3, lengthMm: 40 });
  assert.equal(empty.notices, undefined);
});

test('a label saved by a newer version says so instead of being coerced silently', () => {
  const migrated = migrateDocument({
    version: CONFIG.app.documentVersion + 1,
    lengthMm: 40,
    elements: [
      { type: 'text', text: 'Known' },
      { type: 'hologram', value: 'future' },
    ],
  });
  assert.deepEqual(migrated.elements.map((element) => element.type), ['text']);
  assert.ok(migrated.notices.some((notice) => /saved by a newer version of the app \(document version 5\)/.test(notice)));
});

/* ---------------- print-boundary geometry (R5B-3) ---------------- */

test('exceedsPrinterLimits reports an over-long tape or an element past the label', () => {
  assert.equal(exceedsPrinterLimits(validateDocument({ lengthMm: 40, elements: [{ type: 'text', text: 'x' }] })), false);

  setGeometry({ discovered: true, headWidthPx: 96, dpi: 203, maxLengthMm: 30 });
  try {
    const restored = validateDocument({ lengthMm: 60, elements: [{ type: 'text', text: 'x', x: 4, y: 4, w: 40, h: 20 }] });
    assert.equal(restored.lengthMm, 30, 'validation clamps to the live maximum');
    // A stored document that bypassed validation (an undo snapshot) still
    // reports the over-long tape.
    assert.equal(exceedsPrinterLimits({ lengthMm: 60, elements: [] }), true);
    assert.equal(exceedsPrinterLimits({ lengthMm: 30, elements: [{ x: 220, y: 4, w: 40, h: 20 }] }), true);
    assert.equal(exceedsPrinterLimits({ lengthMm: 30, elements: [{ x: 220, y: 4, w: 40, h: 20, visible: false }] }), false);
    assert.equal(exceedsPrinterLimits({ lengthMm: 30, elements: [{ x: 4, y: 90, w: 40, h: 20 }] }), true, 'past the head');
  } finally {
    resetGeometry();
  }
});
