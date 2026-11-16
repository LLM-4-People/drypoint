/**
 * Label document export and import: one owner for the transfer envelope, the
 * size bound, the format check and the validation path.
 *
 * The exported document is the same plain JSON the app stores; the envelope
 * names the app and the document version so a foreign file is refused with one
 * specific message instead of being half-interpreted. Import validates through
 * `validateDocument`, the owner storage already uses, so every input bound and
 * every migration notice has one implementation.
 */

import { CONFIG } from '../core/config.js';
import { sourceBudgetProblem } from './images.js';
import { migrateDocument } from './schema.js';

/** The one format token a transfer file must carry. */
export const TRANSFER_FORMAT = CONFIG.app.id;

/** The one byte bound, derived from the image and document owners in CONFIG. */
export const TRANSFER_MAX_BYTES = CONFIG.document.transfer.maxBytes;

/** Human size for the one transfer message. */
function formatBytes(bytes) {
  const value = Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

/** The one "file is bigger than a valid document can be" message. */
export function transferTooLargeMessage(bytes) {
  return `That label file is too large (${formatBytes(bytes)}); this app imports files up to ${formatBytes(TRANSFER_MAX_BYTES)}.`;
}

/**
 * The transfer envelope. `downloadJson` serialises it with two-space
 * indentation, so the exported file is readable as well as round-trippable.
 *
 * @param {object} document a validated label document
 * @returns {{format: string, version: number, document: object}}
 */
export function serializeDocument(document) {
  return {
    format: TRANSFER_FORMAT,
    version: CONFIG.app.documentVersion,
    document,
  };
}

/**
 * A timestamped, bridge-safe file name. The Android `saveFile` bridge refuses a
 * duplicate display name and any path segment, so the authored label name is
 * reduced to one slug and the timestamp supplies uniqueness.
 *
 * @param {string} name the document name (untrusted)
 * @param {number} [at] epoch milliseconds, injectable for tests
 * @returns {string}
 */
export function documentFilename(name, at = Date.now()) {
  const slug =
    String(name ?? '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'label';
  const stamp = new Date(Number.isFinite(at) ? at : Date.now()).toISOString().toLowerCase().replace(/[:.]/g, '-');
  return `${CONFIG.app.id}-${slug}-${stamp}.json`;
}

/**
 * Parse one transfer file.
 *
 * The byte bound runs before JSON.parse, so an over-size file never becomes a
 * huge in-memory object graph. The reviver drops the two prototype keys a
 * hostile file could use to reach an object prototype. The document then takes
 * the same `migrateDocument` path storage takes, so an older document rotates
 * on import exactly as it does on load and reports the same notice.
 *
 * @param {string} text the file contents
 * @returns {{document: object, notices: string[]}}
 */
/** The longest untrusted token a message may quote. */
const FORMAT_EXCERPT_CHARS = 24;

/**
 * Quote a bounded, escaped excerpt of an untrusted value for a message.
 *
 * A message is a toast and a log line. JSON.parse happily yields a 1 MB
 * `format`, and echoing it whole produced a 1,000,073-character toast. The
 * excerpt keeps the value recognisable, the message short, and JSON quoting
 * escapes newlines and controls. Objects are stringified rather than coerced,
 * so a value with a null `toString` cannot throw inside the error path.
 *
 * @param {unknown} value
 * @param {number} [limit] maximum quoted source characters
 * @returns {string}
 */
function quotedExcerpt(value, limit = FORMAT_EXCERPT_CHARS) {
  const text = typeof value === 'string' ? value : JSON.stringify(value) ?? String(value);
  const head = text.slice(0, limit);
  return `${JSON.stringify(head)}${text.length > limit ? '…' : ''}`;
}

export function parseDocument(text) {
  if (typeof text !== 'string') throw new Error('That label file could not be read.');
  // UTF-8 bytes are never fewer than UTF-16 code units, so this rejects the
  // obvious over-size case before allocating an encoded copy.
  if (text.length > TRANSFER_MAX_BYTES) throw new Error(transferTooLargeMessage(text.length));
  const bytes = new TextEncoder().encode(text).byteLength;
  if (bytes > TRANSFER_MAX_BYTES) throw new Error(transferTooLargeMessage(bytes));

  let envelope;
  try {
    envelope = JSON.parse(text, (key, value) =>
      key === '__proto__' || key === 'constructor' ? undefined : value
    );
  } catch {
    throw new Error('That label file is incomplete or is not valid JSON.');
  }
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
    throw new Error(`That file is not a ${CONFIG.app.name} label document.`);
  }
  if (envelope.format !== TRANSFER_FORMAT) {
    const found = envelope.format === undefined ? 'missing' : quotedExcerpt(envelope.format);
    throw new Error(
      `That file is not a ${CONFIG.app.name} label: its format is ${found}, expected ${JSON.stringify(TRANSFER_FORMAT)}.`
    );
  }
  if (!Number.isInteger(envelope.version) || envelope.version <= 0) {
    throw new Error('That label file has no valid transfer version.');
  }
  if (envelope.version > CONFIG.app.documentVersion) {
    throw new Error(
      `That label file was made by a newer version of ${CONFIG.app.name}; update the app before importing it.`
    );
  }
  if (!envelope.document || typeof envelope.document !== 'object' || Array.isArray(envelope.document)) {
    throw new Error('That label file has no label document.');
  }

  // The version check and the v3 rotation live in one owner, the same one the
  // stored label uses. A file that this build cannot read as a label is refused
  // by the shape owner with one message.
  const document = migrateDocument(envelope.document);
  // Both source budgets are an authoring boundary, not a normalise step: the
  // importer refuses the file whole instead of silently emptying a source. The
  // same decision guards export, so a label this app can save is a label it can
  // import.
  const problem = sourceBudgetProblem(document, { action: 'importing this label' });
  if (problem) throw new Error(problem);
  return {
    document,
    notices: Array.isArray(document.notices) ? [...document.notices] : [],
  };
}
