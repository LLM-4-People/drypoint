/**
 * Snapshot undo/redo for the label document. Documents are small, so full
 * snapshots are simpler and safer than diffs.
 */

import { CONFIG } from '../core/config.js';
import { deepClone } from '../core/format.js';
import { validateDocument } from './schema.js';

/** Per-snapshot overhead that excludes the strings inside the snapshot. */
const DOCUMENT_OVERHEAD_BYTES = 256;

/**
 * The length one string occupies in JSON output, in UTF-16 code units,
 * including its quotes.
 *
 * Counting `length + 2` undercounts every escape: a newline is two characters
 * (`\n`), a C0 control is six (`\u0001`), a lone surrogate is six (JSON is
 * well-formed), while a valid surrogate pair stays two. A snapshot of 200 lines
 * of text was reported at half its real size because of this.
 *
 * @param {string} text
 * @returns {number}
 */
function escapedLength(text) {
  let length = 2;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code === 0x22 || code === 0x5c) {
      length += 2;
    } else if (code === 0x08 || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d) {
      length += 2;
    } else if (code < 0x20) {
      length += 6;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        // A valid surrogate pair is one code point and is emitted as two units.
        length += 2;
        index += 1;
      } else {
        length += 6;
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      length += 6;
    } else {
      length += 1;
    }
  }
  return length;
}

/**
 * Retained size of one plain-JSON value, without serialising it.
 *
 * Every retained string counts, whatever its key: the estimate is a memory
 * bound, not a schema. Counting only known fields let a hostile import keep
 * 250 kB unknown strings in 80 snapshots while the budget reported 29 kB. The
 * result is an upper bound: JSON punctuation (quotes, escapes, braces, commas
 * and colons) is counted exactly, so a document that fits the budget can never
 * be larger than its serialisation, and the overhead is a few bytes per object.
 *
 * @returns {number} UTF-16 code units plus JSON punctuation
 */
function retainedChars(value) {
  if (typeof value === 'string') return escapedLength(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value).length;
  if (Array.isArray(value)) {
    let sum = 2;
    for (const item of value) sum += retainedChars(item) + 1;
    return sum;
  }
  if (value && typeof value === 'object') {
    let sum = 2;
    for (const key of Object.keys(value)) sum += escapedLength(key) + 2 + retainedChars(value[key]);
    return sum;
  }
  // null
  return 4;
}

/**
 * Retained size of one plain-JSON snapshot: an upper bound on its serialised
 * length.
 *
 * Image data URLs dominate a label: a 3.8 M-character source is most of a
 * snapshot. This runs on every commit, so it must not allocate a second copy of
 * the document through `JSON.stringify`.
 */
export function estimateDocumentBytes(document) {
  if (!document || typeof document !== 'object') return 0;
  return DOCUMENT_OVERHEAD_BYTES + retainedChars(document);
}

/**
 * Normalize a persisted `{ past, future }` history.
 *
 * Persistence is a trust boundary: every snapshot must pass
 * `validateDocument`; an invalid one is dropped without rejecting the rest.
 * The entry cap and the byte budget are reapplied, so a stored history cannot
 * exceed the limits the live history already enforces. The one-step floor is
 * kept: a single past snapshot larger than the budget still remains so the
 * operator has an honest undo target.
 *
 * @param {unknown} value
 * @param {{limit?: number, maxBytes?: number}} [options]
 * @returns {{past: object[], future: object[]}}
 */
export function normaliseHistory(value, { limit = CONFIG.history.maxEntries, maxBytes = CONFIG.history.maxBytes } = {}) {
  const entryLimit = Number.isFinite(limit) && limit > 0 ? Math.max(1, Math.floor(limit)) : CONFIG.history.maxEntries;
  const byteBudget = Number.isFinite(maxBytes) && maxBytes > 0 ? maxBytes : CONFIG.history.maxBytes;
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const valid = (list) => {
    const snapshots = [];
    for (const entry of Array.isArray(list) ? list : []) {
      try {
        snapshots.push(validateDocument(entry));
      } catch {
        // One unreadable snapshot costs that snapshot, not the label history.
      }
    }
    return snapshots;
  };
  // `past` grows at the end, so the newest entries are kept. `future` is popped
  // from the end, so the nearest redo entries are the ones at the front.
  let past = valid(source.past).slice(-entryLimit);
  let future = valid(source.future).slice(0, entryLimit);
  let bytes = 0;
  for (const snapshot of past) bytes += estimateDocumentBytes(snapshot);
  for (const snapshot of future) bytes += estimateDocumentBytes(snapshot);
  while (bytes > byteBudget && past.length > 1) {
    bytes -= estimateDocumentBytes(past.shift());
  }
  while (bytes > byteBudget && future.length > 0) {
    bytes -= estimateDocumentBytes(future.pop());
  }
  return { past, future };
}

/**
 * Structural comparison that ignores object key order. Documents are plain
 * JSON, so a clone that only reordered keys must not create an undo step.
 */
function sameValue(a, b) {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((value, index) => sameValue(value, b[index]));
  }
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((key) => Object.prototype.hasOwnProperty.call(b, key) && sameValue(a[key], b[key]));
}

export function createHistory({
  limit = CONFIG.history.maxEntries,
  maxBytes = CONFIG.history.maxBytes,
  initial = null,
  onChange = () => {},
} = {}) {
  let past = [];
  let future = [];
  let present = initial ? deepClone(initial) : null;
  let coalesce = { key: null, at: 0 };
  // An entry cap of zero would make undo impossible; the budget always keeps
  // one undo step, so the count keeps the same promise.
  const entryLimit = Number.isFinite(limit) && limit > 0 ? Math.max(1, Math.floor(limit)) : CONFIG.history.maxEntries;
  const byteBudget = Number.isFinite(maxBytes) && maxBytes > 0 ? maxBytes : CONFIG.history.maxBytes;

  function retainedBytes() {
    let bytes = present === null ? 0 : estimateDocumentBytes(present);
    for (const document of past) bytes += estimateDocumentBytes(document);
    for (const document of future) bytes += estimateDocumentBytes(document);
    return bytes;
  }

  /**
   * Drop the oldest snapshots until both the entry cap and the byte budget
   * hold. The present document and at least one undo step stay: a single
   * snapshot larger than the whole budget still needs an honest undo target.
   */
  function trim() {
    while (past.length > entryLimit) past.shift();
    while (past.length > 1 && retainedBytes() > byteBudget) past.shift();
  }

  function notify() {
    onChange({ canUndo: past.length > 0, canRedo: future.length > 0, size: past.length, retainedBytes: retainedBytes() });
  }

  return {
    get present() {
      return present === null ? null : deepClone(present);
    },
    /** Estimated bytes of every retained snapshot, used by the budget tests. */
    get retainedBytes() {
      return retainedBytes();
    },
    /** Snapshots still retained, including the present document. */
    get retainedEntries() {
      return past.length + future.length + (present === null ? 0 : 1);
    },
    /** The persisted half of the history: every undo and redo document. */
    snapshot() {
      return { past: deepClone(past), future: deepClone(future) };
    },
    /**
     * Replace the present document and both stacks without recording an undo
     * step. Hydration passes `silent: true`; a later edit, undo or redo still
     * notifies normally.
     *
     * @param {{present: object, past?: object[], future?: object[]}} value
     * @param {{silent?: boolean}} [options]
     */
    restore({ present: nextPresent, past: nextPast = [], future: nextFuture = [] } = {}, { silent = false } = {}) {
      const normalised = normaliseHistory({ past: nextPast, future: nextFuture }, { limit: entryLimit, maxBytes: byteBudget });
      present = nextPresent === null || nextPresent === undefined ? null : deepClone(nextPresent);
      past = normalised.past;
      future = normalised.future;
      coalesce = { key: null, at: 0 };
      trim();
      if (!silent) notify();
    },
    reset(document) {
      present = deepClone(document);
      past = [];
      future = [];
      coalesce = { key: null, at: 0 };
      notify();
    },
    /**
     * Record a new state. Passing the same coalesceKey in quick succession
     * merges the entries so typing does not fill the stack.
     */
    commit(document, { coalesceKey = null, coalesceMs = 600 } = {}) {
      if (present && sameValue(document, present)) return;
      const now = Date.now();
      const merge = coalesceKey && coalesceKey === coalesce.key && now - coalesce.at < coalesceMs;
      if (!merge) {
        if (present) past.push(present);
        future = [];
      }
      present = deepClone(document);
      // A merge can replace the present with a larger document, so the budget
      // is re-applied on every accepted commit, not only when a past entry was
      // appended.
      trim();
      coalesce = { key: coalesceKey, at: now };
      notify();
    },
    undo() {
      if (!past.length) return null;
      future.push(present);
      present = past.pop();
      coalesce = { key: null, at: 0 };
      notify();
      return deepClone(present);
    },
    redo() {
      if (!future.length) return null;
      past.push(present);
      present = future.pop();
      coalesce = { key: null, at: 0 };
      notify();
      return deepClone(present);
    },
    canUndo: () => past.length > 0,
    canRedo: () => future.length > 0,
  };
}
