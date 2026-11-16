/**
 * Snapshot undo/redo for the label document. Documents are small, so full
 * snapshots are simpler and safer than diffs.
 */

import { CONFIG } from '../core/config.js';
import { deepClone } from '../core/format.js';

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

export function createHistory({ limit = CONFIG.history.maxEntries, initial = null, onChange = () => {} } = {}) {
  let past = [];
  let future = [];
  let present = initial ? deepClone(initial) : null;
  let coalesce = { key: null, at: 0 };

  function notify() {
    onChange({ canUndo: past.length > 0, canRedo: future.length > 0, size: past.length });
  }

  return {
    get present() {
      return present === null ? null : deepClone(present);
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
        if (present) {
          past.push(present);
          if (past.length > limit) past.shift();
        }
        future = [];
      }
      present = deepClone(document);
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
