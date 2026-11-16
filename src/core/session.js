/**
 * Pure normalization for the per-label view session.
 *
 * A session is view state, not label content: which element is selected, which
 * panel is open, and where the stage, layer list and panel were scrolled. Each
 * field is repaired on its own, so one bad value cannot discard the rest. The
 * stored shape is shared with `core/label-session.js` and the reader in
 * `core/library.js`.
 */

import { CONFIG } from './config.js';
import { clamp } from './format.js';

/** The only tabs the panel exposes. */
const SESSION_TABS = Object.freeze(['design', 'print']);
const DEFAULT_SESSION_TAB = 'design';

/** The four scroll offsets a session persists, in one owner. */
const SESSION_SCROLL_KEYS = Object.freeze(['stageX', 'stageY', 'layersY', 'panelY']);

function finiteScroll(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return clamp(Math.round(number), 0, CONFIG.ui.persistence.scrollMaxPx);
}

function selectionValue(value) {
  if (value === null) return null;
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text || text.length > CONFIG.bounds.maxIdChars) return null;
  return text;
}

/**
 * Normalize one stored or partial session.
 *
 * @param {unknown} value
 * @returns {{selection: string|null, tab: string, scroll: {stageX: number, stageY: number, layersY: number, panelY: number}}}
 */
export function normalizeSession(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const scrollSource = source.scroll && typeof source.scroll === 'object' && !Array.isArray(source.scroll) ? source.scroll : {};
  const scroll = {};
  for (const key of SESSION_SCROLL_KEYS) scroll[key] = finiteScroll(scrollSource[key]);
  return {
    selection: selectionValue(source.selection),
    tab: SESSION_TABS.includes(source.tab) ? source.tab : DEFAULT_SESSION_TAB,
    scroll,
  };
}

/**
 * Merge a partial patch into the current session. The scroll object is merged
 * field by field so persisting one axis cannot reset the other three.
 *
 * @param {object|null} current
 * @param {object} [patch]
 */
export function mergeSession(current, patch = {}) {
  const base = normalizeSession(current);
  const source = patch && typeof patch === 'object' && !Array.isArray(patch) ? patch : {};
  const merged = { ...base, ...source };
  if (Object.prototype.hasOwnProperty.call(source, 'scroll')) {
    const extra = source.scroll && typeof source.scroll === 'object' && !Array.isArray(source.scroll) ? source.scroll : {};
    merged.scroll = { ...base.scroll, ...extra };
  } else {
    merged.scroll = base.scroll;
  }
  return normalizeSession(merged);
}

/**
 * The session a label starts with: its last element selected on the design
 * tab, scrolled to the origin.
 *
 * @param {object} document a validated label document
 */
export function defaultSession(document) {
  const last = Array.isArray(document?.elements) ? document.elements.at(-1) : null;
  return normalizeSession({ selection: last?.id ?? null, tab: DEFAULT_SESSION_TAB });
}
