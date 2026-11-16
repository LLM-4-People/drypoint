/**
 * Tiny reactive store with optional persistence. State is replaced immutably;
 * listeners are notified once per microtask so bursts of updates coalesce into
 * a single render.
 *
 * Persistence is never silent: read and write failures are reported through
 * `onError(error, 'load'|'persist')` while the in-memory state keeps working.
 */

import { debounce } from './format.js';
import { createLogger } from './log.js';

const log = createLogger('core.store');

export function createStore(initialState, options = {}) {
  const {
    key = null,
    version = 1,
    hydrate = null,
    persistMs = 250,
    onChange = null,
    onError = null,
    onPersist = null,
    /** A write may be vetoed while the operator has an unreadable value. */
    canPersist = () => true,
    /** Raw stores keep their own shape; the version envelope is opt-out only. */
    envelope = true,
  } = options;
  const listeners = new Set();
  let state = load();
  let pending = false;
  /** True once a write is owed; cleared only by a successful persist. */
  let dirty = false;

  /**
   * Read the stored value.
   *
   * The raw string is handed to `onError` on every failure — a parse error, a
   * rejected shape or a failed hydrate. The caller needs it to keep an
   * unreadable label intact instead of replacing it with a fresh one.
   */
  function load() {
    if (!key || typeof localStorage === 'undefined') return initialState;
    let raw = null;
    try {
      raw = localStorage.getItem(key);
      if (!raw) return initialState;
      const parsed = JSON.parse(raw);
      if (!envelope) return hydrate ? hydrate(parsed, version) : parsed;
      if (!parsed || typeof parsed !== 'object') return initialState;
      // A version-matching payload is still untrusted: a hand-edited or
      // partially written value must be normalised, never merged raw.
      if (hydrate) return { ...initialState, ...hydrate(parsed.data ?? {}, parsed.version) };
      return parsed.version === version ? { ...initialState, ...parsed.data } : initialState;
    } catch (error) {
      onError?.(error, 'load', { raw });
      return initialState;
    }
  }

  const persist = key
    ? debounce(() => {
        if (typeof localStorage === 'undefined') return;
        // The owner may veto a write. An unreadable stored label must survive
        // edits and reloads until the operator exports or resets it, so the
        // write is skipped while the veto holds and the state stays dirty.
        if (!canPersist()) return;
        try {
          localStorage.setItem(key, JSON.stringify(envelope ? { version, data: state } : state));
          dirty = false;
          onPersist?.(state);
        } catch (error) {
          // Storage full or blocked: the app keeps working in memory, and the
          // owner decides how to surface it.
          onError?.(error, 'persist');
        }
      }, persistMs)
    : () => {};

  function notify() {
    if (pending) return;
    pending = true;
    queueMicrotask(() => {
      pending = false;
      onChange?.(state);
      for (const listener of [...listeners]) {
        try {
          listener(state);
        } catch (error) {
          // A failing subscriber must not break the others, but it must not
          // vanish either: the diagnostics log names the owner.
          log.debug('store subscriber threw', { message: error?.message ?? String(error) });
        }
      }
    });
  }

  return {
    get: () => state,
    /** True while a write is owed: pagehide can skip a clean document. */
    get dirty() {
      return dirty;
    },
    set(patch) {
      state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) };
      dirty = true;
      persist();
      notify();
      return state;
    },
    replace(next) {
      state = next;
      dirty = true;
      persist();
      notify();
      return state;
    },
    subscribe(listener, { immediate = true } = {}) {
      listeners.add(listener);
      if (immediate) listener(state);
      return () => listeners.delete(listener);
    },
    /** Subscribe to a slice; the listener runs only when the slice changes. */
    select(selector, listener, options) {
      let previous = selector(state);
      return this.subscribe((next) => {
        const value = selector(next);
        if (value !== previous) {
          previous = value;
          listener(value);
        }
      }, { ...options, immediate: options?.immediate ?? true });
    },
    flush: () => {
      // Force only an owed write: a clean store has nothing to say, and a tab
      // that never edited must not overwrite newer work from another tab.
      if (dirty) persist.flush();
    },
  };
}
