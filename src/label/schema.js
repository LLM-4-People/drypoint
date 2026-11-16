/**
 * Label document model: element factories, bounds, validation and migration.
 * The document is plain JSON so it can be persisted, exported and versioned.
 */

import { CONFIG } from '../core/config.js';
import { clamp, createId, deepClone } from '../core/format.js';
import { geometry, mmToPx } from '../core/geometry.js';
import { SYMBOLOGIES } from './barcode.js';
import { DITHER } from './dither.js';
import { EC_LEVELS } from './qr.js';

export const ELEMENT_TYPES = Object.freeze({
  TEXT: 'text',
  QR: 'qr',
  BARCODE: 'barcode',
  IMAGE: 'image',
  RECT: 'rect',
});

export const ROTATIONS = Object.freeze([0, 90, 180, 270]);
export const ALIGNMENTS = Object.freeze(['left', 'center', 'right']);
export const VALIGNMENTS = Object.freeze(['top', 'middle', 'bottom']);
export const FIT_MODES = Object.freeze(['contain', 'cover', 'stretch']);
const DITHER_MODES = Object.freeze(Object.values(DITHER));
export const IMAGE_DITHERS = Object.freeze(['auto', ...DITHER_MODES]);
const SYMBOLOGY_IDS = Object.freeze(Object.keys(SYMBOLOGIES));

const { minLengthMm, defaultLengthMm, paddingPx } = CONFIG.geometry;
const { maxElements, maxTextChars, maxValueChars, maxNameChars, maxSrcChars, maxSourceChars, maxNotices, maxNoticeChars } = CONFIG.bounds;

function defaultsFor(type) {
  const widthPx = geometry().widthPx;
  const common = {
    id: createId(type),
    type,
    name: '',
    x: paddingPx,
    y: paddingPx,
    w: widthPx - paddingPx * 2,
    h: 80,
    rotation: 0,
    locked: false,
    visible: true,
  };
  switch (type) {
    case ELEMENT_TYPES.TEXT:
      return { ...common, text: 'Text', fontPx: 0, bold: true, align: 'center', valign: 'middle', rotation: 0 };
    case ELEMENT_TYPES.QR:
      return { ...common, value: 'https://', ecLevel: 'M', w: 80, h: 80 };
    case ELEMENT_TYPES.BARCODE:
      return { ...common, value: 'ABC-123', symbology: 'code128', showText: true, h: 60 };
    case ELEMENT_TYPES.IMAGE:
      return { ...common, src: '', fit: 'contain', dither: 'auto' };
    case ELEMENT_TYPES.RECT:
      return { ...common, strokePx: 2, filled: false, radiusPx: 0 };
    default:
      throw new Error(`Unknown element type: ${type}`);
  }
}

export function createElement(type, props = {}) {
  if (!Object.values(ELEMENT_TYPES).includes(type)) throw new Error(`Unknown element type: ${type}`);
  return { ...defaultsFor(type), ...props, type };
}

export function createDocument(overrides = {}) {
  const document = {
    version: CONFIG.app.documentVersion,
    name: 'Untitled',
    copies: CONFIG.print.copies.default,
    ...overrides,
    // The length is clamped before anything sizes itself from it, so a seeded
    // frame can never be built from a tape longer than the printer supports.
    lengthMm: clamp(finite(overrides.lengthMm ?? defaultLengthMm, defaultLengthMm), minLengthMm, geometry().maxLengthMm),
    elements: [],
  };
  // Callers that supply elements own them; only the first-run document seeds
  // the default text block. Validation clamps length and copies on the way out.
  if (!Array.isArray(overrides.elements)) {
    document.elements = [
      createElement(ELEMENT_TYPES.TEXT, {
        text: 'Hello',
        ...defaultTextFrame(document),
      }),
    ];
  } else {
    document.elements = overrides.elements;
  }
  return validateDocument(document);
}

/** Default text box: full width, most of the height, leaving room to align. */
export function defaultTextFrame(document) {
  const pad = paddingPx;
  const widthPx = geometry().widthPx;
  const height = Math.max(
    CONFIG.geometry.minElementPx,
    Math.round((widthPx - pad * 2) * CONFIG.geometry.textBoxHeightRatio)
  );
  return {
    x: pad,
    y: Math.round((widthPx - height) / 2),
    w: documentWidthPx(document) - pad * 2,
    h: height,
  };
}

/**
 * The box a new element of this type starts with. The barcode is the one type
 * whose width needs a fit check, so it is resolved by the caller instead.
 * @returns {{w:number,h:number,rotation:number}|null}
 */
export function newElementFrame(type, document) {
  const pad = paddingPx;
  const width = documentWidthPx(document);
  const height = documentHeightPx(document);
  switch (type) {
    case ELEMENT_TYPES.TEXT:
      return defaultTextFrame(document);
    case ELEMENT_TYPES.QR: {
      const size = height - pad * 2;
      return { w: size, h: size, rotation: 0 };
    }
    case ELEMENT_TYPES.RECT:
      return { w: width - pad * 2, h: height - pad * 2, rotation: 0 };
    case ELEMENT_TYPES.IMAGE:
      return { w: width - pad * 2, h: defaultsFor(ELEMENT_TYPES.IMAGE).h, rotation: 0 };
    default:
      return null;
  }
}

/** Long axis of the label, in printer dots (the tape length). */
export function documentWidthPx(document) {
  return mmToPx(document.lengthMm);
}

/** Short axis of the label, in printer dots (the print head width). */
export function documentHeightPx() {
  return geometry().widthPx;
}

/** Axis-aligned box in label pixels. Rotation happens inside this box. */
export function boundsOf(element) {
  return { x: element.x, y: element.y, w: element.w, h: element.h };
}

export function pointInside(element, point) {
  const { x, y, w, h } = boundsOf(element);
  return point.x >= x && point.x <= x + w && point.y >= y && point.y <= y + h;
}

/** Keep an element inside the label and above the minimum size. */
export function clampElement(element, document) {
  const min = CONFIG.geometry.minElementPx;
  const maxW = documentWidthPx(document);
  const maxH = documentHeightPx(document);
  const w = clamp(Math.round(element.w), min, maxW);
  const h = clamp(Math.round(element.h), min, maxH);
  return {
    ...element,
    w,
    h,
    x: clamp(Math.round(element.x), 0, maxW - w),
    y: clamp(Math.round(element.y), 0, maxH - h),
  };
}

/**
 * A usable number or the fallback. Only finite numbers and non-empty numeric
 * strings are converted: `Number()` throws on `{"toString":null}` and happily
 * turns booleans and arrays into 0/1, which would silently move an element.
 */
function finite(value, fallback) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : fallback;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return fallback;
    const number = Number(trimmed);
    return Number.isFinite(number) ? number : fallback;
  }
  return fallback;
}

function pick(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}

/**
 * Trust-boundary boolean. JSON, form fields and imported files can carry
 * "false" as a string, which is truthy; only an explicit true-like value is
 * true, and anything unreadable keeps the type default.
 */
function toBool(value, fallback) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value !== 0 : fallback;
  if (typeof value === 'string') {
    const text = value.trim().toLowerCase();
    if (text === 'true' || text === '1') return true;
    if (text === 'false' || text === '0' || text === '') return false;
  }
  return fallback;
}

/**
 * Trust-boundary string. The document is plain JSON: an import, a hand-edited
 * file or a hostile payload can carry any type in a field that must be text.
 * Only text can be painted, so primitives are stringified and every other
 * value (array, object, null, undefined) becomes empty text.
 */
function toText(value) {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
  return '';
}

/** One string value, cut to its declared character cap. */
function clampText(value, max) {
  return value.length > max ? value.slice(0, max) : value;
}

/**
 * One wording for the image-source cap, shared by document validation and the
 * editor's add/update paths so an operator sees the same reason everywhere.
 */
export function droppedSourceNotice() {
  return `An image source was dropped because it is longer than ${maxSrcChars} characters.`;
}

/**
 * One wording for the per-document image budget. An element may be within the
 * per-source cap and still push the label past what one transfer file can
 * carry, because every element repeats its own source in the serialised
 * document.
 */
export function sourceBudgetNotice(count = 1) {
  const subject = count === 1 ? '1 image source was' : `${count} image sources were`;
  return `${subject} dropped because the label's image data exceeds ${maxSourceChars} characters. Remove or reuse an image.`;
}

/**
 * The refusal the editor shows when one more source would pass the document
 * budget. Same owner and limit as `sourceBudgetNotice`, different action.
 */
export function sourceBudgetRefusalNotice() {
  return `Adding this image would give the label more than ${maxSourceChars} characters of image data. Remove or reuse an image first.`;
}

/**
 * One wording for text shortened by the input bounds, shared by the storage
 * validation and the editor's add/update paths so an edit-path truncation is
 * never silent.
 */
export function truncatedNotice(count = 1) {
  return count === 1
    ? '1 element had text shortened to fit the label limits.'
    : `${count} elements had text shortened to fit the label limits.`;
}

/**
 * The one input-bound policy for element strings. The stored label, an import
 * and the inspector all pass through here, so one owner decides how much text a
 * field may carry. An image source longer than the cap is dropped whole:
 * truncating a data URL would leave a corrupt image that looks valid.
 * @returns {{element:object, droppedSrc:boolean, truncated:boolean}}
 */
export function boundElementText(element) {
  let truncated = false;
  const clampField = (value, max) => {
    const text = clampText(value, max);
    if (text.length !== value.length) truncated = true;
    return text;
  };
  if (typeof element.name === 'string') element.name = clampField(element.name, maxNameChars);
  if (element.type === ELEMENT_TYPES.TEXT && typeof element.text === 'string') {
    element.text = clampField(element.text, maxTextChars);
  }
  if ((element.type === ELEMENT_TYPES.QR || element.type === ELEMENT_TYPES.BARCODE) && typeof element.value === 'string') {
    element.value = clampField(element.value, maxValueChars);
  }
  if (element.type === ELEMENT_TYPES.IMAGE && typeof element.src === 'string' && element.src.length > maxSrcChars) {
    element.src = '';
    return { element, droppedSrc: true, truncated };
  }
  return { element, droppedSrc: false, truncated };
}

/** Normalise one element against its type defaults without mutating the input. */
function normaliseElement(input, defaults) {
  const element = { ...defaults, ...input };
  // An element id is a non-empty string: numbers, whitespace and empty values
  // are replaced, and the replacement stays unique in validateDocument.
  if (typeof element.id !== 'string' || !element.id.trim()) element.id = defaults.id;
  else element.id = element.id.trim();
  element.name = toText(element.name);

  const rotation = finite(element.rotation, defaults.rotation);
  element.rotation = ROTATIONS.includes(rotation) ? rotation : defaults.rotation;
  element.locked = toBool(element.locked, defaults.locked);
  element.visible = toBool(element.visible, defaults.visible);
  element.x = finite(element.x, defaults.x);
  element.y = finite(element.y, defaults.y);
  element.w = finite(element.w, defaults.w);
  element.h = finite(element.h, defaults.h);

  switch (element.type) {
    case ELEMENT_TYPES.TEXT:
      element.text = toText(element.text);
      element.align = pick(element.align, ALIGNMENTS, defaults.align);
      element.valign = pick(element.valign, VALIGNMENTS, defaults.valign);
      element.bold = toBool(element.bold, defaults.bold);
      // 0 means auto-size; a manual size is clamped to the range the renderer
      // can actually paint, so a stored value is always what is printed. The
      // gap below minFontPx is not a size the app can show: it would be stored
      // as 1..7 and painted at 8.
      const fontPx = finite(element.fontPx, defaults.fontPx);
      element.fontPx = fontPx > 0 ? clamp(fontPx, CONFIG.geometry.minFontPx, CONFIG.geometry.maxFontPx) : 0;
      break;
    case ELEMENT_TYPES.QR:
      element.value = toText(element.value);
      element.ecLevel = pick(element.ecLevel, EC_LEVELS, defaults.ecLevel);
      break;
    case ELEMENT_TYPES.BARCODE:
      element.value = toText(element.value);
      element.symbology = pick(element.symbology, SYMBOLOGY_IDS, defaults.symbology);
      element.showText = toBool(element.showText, defaults.showText);
      break;
    case ELEMENT_TYPES.IMAGE:
      element.src = toText(element.src);
      element.fit = pick(element.fit, FIT_MODES, defaults.fit);
      element.dither = pick(element.dither, IMAGE_DITHERS, defaults.dither);
      break;
    case ELEMENT_TYPES.RECT:
      element.strokePx = Math.max(1, finite(element.strokePx, defaults.strokePx));
      element.radiusPx = Math.max(0, finite(element.radiusPx, defaults.radiusPx));
      element.filled = toBool(element.filled, defaults.filled);
      break;
    default:
      break;
  }
  return boundElementText(element);
}

/**
 * Normalise a document without mutating the input: drop unknown element types,
 * clamp geometry, validate enums and keep a valid length. An empty elements
 * array is legal; createDocument is the only owner of the first-run "Hello".
 */
export function validateDocument(input) {
  const source = deepClone(input && typeof input === 'object' ? input : {});
  const lengthMm = clamp(finite(source.lengthMm, defaultLengthMm), minLengthMm, geometry().maxLengthMm);
  const document = {
    ...source,
    version: CONFIG.app.documentVersion,
    name: clampText(typeof source.name === 'string' ? source.name : 'Untitled', maxNameChars),
    lengthMm,
    copies: clamp(Math.round(finite(source.copies, 1)), CONFIG.print.copies.min, CONFIG.print.copies.max),
    elements: [],
  };
  // Migration notices explain content this document no longer has. They are
  // part of the label, not of one render, so they survive validation and reach
  // the operator through the same warnings path as any layout problem.
  const notices = Array.isArray(source.notices)
    ? [...new Set(source.notices.filter((notice) => typeof notice === 'string' && notice.trim()).map((notice) => notice.trim()))]
    : [];
  delete document.notices;
  const seen = new Set();
  let droppedElements = 0;
  let droppedSources = 0;
  let droppedUnknown = 0;
  let truncatedElements = 0;
  let droppedBudget = 0;
  let sourceChars = 0;
  for (const raw of Array.isArray(source.elements) ? source.elements : []) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !Object.values(ELEMENT_TYPES).includes(raw.type)) {
      droppedUnknown++;
      continue;
    }
    // The input cap comes before the expensive normalisation: a pasted
    // 2000-element document must not cost a normalise pass per element.
    if (document.elements.length >= maxElements) {
      droppedElements++;
      continue;
    }
    if (raw.type === ELEMENT_TYPES.IMAGE && typeof raw.src === 'string' && raw.src.length > maxSrcChars) droppedSources++;
    // A source that survives the per-element cap still shares one document
    // budget: the serialised label repeats a source once per element, so a
    // reused image grows the file too. Drop the source here, at the same owner
    // that bounds every stored and imported document.
    let candidate = raw;
    if (raw.type === ELEMENT_TYPES.IMAGE && typeof raw.src === 'string' && raw.src.length && raw.src.length <= maxSrcChars) {
      if (sourceChars + raw.src.length > maxSourceChars) {
        droppedBudget++;
        candidate = { ...raw, src: '' };
      } else {
        sourceChars += raw.src.length;
      }
    }
    const { element, truncated } = normaliseElement(candidate, defaultsFor(candidate.type));
    if (truncated) truncatedElements++;
    if (seen.has(element.id)) element.id = createId(raw.type);
    seen.add(element.id);
    document.elements.push(clampElement(element, document));
  }
  if (droppedUnknown) {
    notices.push(
      droppedUnknown === 1
        ? '1 element was dropped because it is not a valid element for this version.'
        : `${droppedUnknown} elements were dropped because they are not valid elements for this version.`
    );
  }
  if (droppedElements) {
    notices.push(
      droppedElements === 1
        ? `1 element was dropped: a label holds at most ${maxElements} elements.`
        : `${droppedElements} elements were dropped: a label holds at most ${maxElements} elements.`
    );
  }
  if (truncatedElements) {
    notices.push(truncatedNotice(truncatedElements));
  }
  if (droppedBudget) {
    notices.push(sourceBudgetNotice(droppedBudget));
  }
  if (droppedSources) {
    notices.push(droppedSourceNotice());
  }
  if (notices.length) {
    document.notices = notices.slice(0, maxNotices).map((notice) => clampText(notice, maxNoticeChars));
  }
  return document;
}

/**
 * True when the document cannot be printed as it stands: its tape is longer
 * than the live printer supports, or a visible element sits outside the label.
 *
 * Undo can restore a document authored against a longer tape, and print never
 * re-checked it. This is the one print-boundary predicate: the flow revalidates
 * before rendering and the primary button reports the same condition.
 */
export function exceedsPrinterLimits(labelDocument) {
  if (!labelDocument || typeof labelDocument !== 'object') return false;
  if (finite(labelDocument.lengthMm, 0) > geometry().maxLengthMm) return true;
  const width = documentWidthPx(labelDocument);
  const height = documentHeightPx(labelDocument);
  return (Array.isArray(labelDocument.elements) ? labelDocument.elements : []).some((element) => {
    if (!element || element.visible === false) return false;
    const box = boundsOf(element);
    return box.x < 0 || box.y < 0 || box.x + box.w > width || box.y + box.h > height;
  });
}

/**
 * A stored version counts only when it is a finite number or a non-empty
 * numeric string. `Number('')`, `Number('   ')`, `Number(true)` and `Number([])`
 * are all 0, which used to rotate an unversioned document as if it were v3.
 * @returns {number|null} the version, or null when the value is not one.
 */
function documentVersionOf(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const version = Number(value);
    return Number.isFinite(version) ? version : null;
  }
  return null;
}

/**
 * v4 moved the model from portrait (96 wide) to landscape (length wide).
 * Portrait x runs along the print head and maps to landscape y, so with the
 * existing +270° rotation the position pair is x' = y, y' = headWidth - x - w.
 */
export function migrateDocument(input) {
  if (!input || typeof input !== 'object') return createDocument();
  const version = documentVersionOf(input.version);
  // A document from the future is loaded as far as this version understands it,
  // and says so: coercing it silently lost every type this build does not know.
  if (version !== null && version > CONFIG.app.documentVersion) {
    const notices = Array.isArray(input.notices) ? [...input.notices] : [];
    notices.push(
      `This label was saved by a newer version of the app (document version ${version}); content this version does not understand may be missing.`
    );
    return validateDocument({ ...input, notices });
  }
  // A document without a readable version is already the current model. Only
  // an explicit older version is rotated from the portrait layout.
  if (version === null || version >= CONFIG.app.documentVersion) {
    return validateDocument(input);
  }
  const headWidthPx = geometry().widthPx;
  // One malformed entry must cost that entry, not the whole label: the map
  // below cannot rotate null, a number or an array. An unknown element type is
  // dropped for the same reason and counted in the same notice: the current
  // model has no way to paint it.
  const knownType = (element) => Object.values(ELEMENT_TYPES).includes(element.type);
  const source = Array.isArray(input.elements) ? input.elements : [];
  const notices = Array.isArray(input.notices) ? [...input.notices] : [];
  if (input.elements !== undefined && !Array.isArray(input.elements)) {
    notices.push('The saved label had no element list, so it was loaded with no elements.');
  }
  const valid = source.filter((element) => element && typeof element === 'object' && !Array.isArray(element) && knownType(element));
  const dropped = source.length - valid.length;
  const elements = valid.map((element) => {
    const x = finite(element.x, 0);
    const y = finite(element.y, 0);
    const w = finite(element.w, 8);
    const h = finite(element.h, 8);
    return {
      ...element,
      x: y,
      y: headWidthPx - x - w,
      w: h,
      h: w,
      rotation: (finite(element.rotation, 0) + 270) % 360,
    };
  });
  // Clone before writing: migration owns the result, never the caller's array.
  if (dropped) {
    notices.push(
      dropped === 1
        ? '1 legacy element was dropped because it was not a valid element.'
        : `${dropped} legacy elements were dropped because they were not valid elements.`
    );
  }
  return validateDocument({ ...input, version: CONFIG.app.documentVersion, elements, notices });
}
