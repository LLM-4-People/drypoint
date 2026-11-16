/**
 * Snapshot undo/redo for the label document. Documents are small, so full
 * snapshots are simpler and safer than diffs.
 */

import { CONFIG } from '../core/config.js';
import { deepClone } from '../core/format.js';

/** Per-snapshot and per-element overhead, excluding the strings inside them. */
const DOCUMENT_OVERHEAD_BYTES = 256;
const ELEMENT_OVERHEAD_BYTES = 96;
const ELEMENT_STRING_FIELDS = Object.freeze(['name', 'text', 'value', 'src']);

/**
 * Retained size of one plain-JSON snapshot, without serialising it.
 *
 * Image data URLs dominate a label: a 3.8 M-character source is most of a
 * snapshot. Element count and every element string are counted here, and the
 * fixed overhead keeps a document with many small fields from looking free.
 * This runs on every commit, so it must not allocate a second copy of the
 * document through `JSON.stringify`.
 */
export function estimateDocumentBytes(document) {
  if (!document || typeof document !== 'object') return 0;
  let bytes = DOCUMENT_OVERHEAD_BYTES;
  if (typeof document.name === 'string') bytes += document.name.length;
  if (Array.isArray(document.notices)) {
    for (const notice of document.notices) if (typeof notice === 'string') bytes += notice.length;
  }
  const elements = Array.isArray(document.elements) ? document.elements : [];
  for (const element of elements) {
    bytes += ELEMENT_OVERHEAD_BYTES;
    if (!element || typeof element !== 'object') continue;
    for (const field of ELEMENT_STRING_FIELDS) {
      if (typeof element[field] === 'string') bytes += element[field].length;
    }
  }
  return bytes;
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
