/**
 * Pure formatting helpers for the visible label library.
 *
 * Kept apart from the dialog so the list's wording is testable without a DOM
 * and there is one owner for the relative-time and element-count text.
 */

import { CONFIG } from '../core/config.js';
import { DEFAULT_LABEL_NAME } from '../label/schema.js';

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

function pad2(value) {
  return String(value).padStart(2, '0');
}

/**
 * A stable relative time for a saved label. It is computed once per opening,
 * never on a timer, so a row cannot change while the operator is reading it.
 *
 * @param {number} at epoch milliseconds
 * @param {number} [now] epoch milliseconds
 * @returns {string}
 */
export function relativeLabelTime(at, now = Date.now()) {
  const time = Number(at);
  const current = Number(now);
  if (!Number.isFinite(current) || !Number.isFinite(time) || time <= 0) return 'unknown time';
  const diff = Math.max(0, current - time);
  if (diff < MINUTE_MS) return 'just now';
  const minutes = Math.floor(diff / MINUTE_MS);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(diff / HOUR_MS);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(diff / DAY_MS);
  if (days < 7) return `${days} d ago`;
  const date = new Date(time);
  if (!Number.isFinite(date.getTime())) return 'unknown time';
  return `on ${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

/** The one element-count wording in the library list. */
export function elementCountLabel(count) {
  const value = Number.isInteger(count) && count > 0 ? count : 0;
  return `${value} element${value === 1 ? '' : 's'}`;
}

/**
 * The next free name in the `Untitled`, `Untitled 2`, ... series.
 *
 * Names are compared case-insensitively because two labels that differ only by
 * case read as duplicates in the list. The result respects the document name
 * bound, including the numeric suffix.
 *
 * @param {string[]} names
 * @param {{base?: string, max?: number}} [options]
 * @returns {string}
 */
export function nextLabelName(names, { base = DEFAULT_LABEL_NAME, max = CONFIG.bounds.maxNameChars } = {}) {
  const taken = new Set(
    (Array.isArray(names) ? names : [])
      .filter((name) => typeof name === 'string')
      .map((name) => name.trim().toLowerCase())
      .filter(Boolean)
  );
  const root = typeof base === 'string' && base.trim() ? base.trim() : DEFAULT_LABEL_NAME;
  const limit = Number.isInteger(max) && max > 0 ? max : CONFIG.bounds.maxNameChars;
  if (!taken.has(root.toLowerCase())) return root.slice(0, limit);
  // The taken set is finite, so a suffix above its size must be free unless
  // truncation collapsed two candidates into the same name.
  for (let index = 2; index <= taken.size + 2; index += 1) {
    const suffix = ` ${index}`;
    const stem = root.slice(0, Math.max(1, limit - suffix.length));
    const candidate = `${stem}${suffix}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  const suffix = ` ${Date.now()}`;
  return `${root.slice(0, Math.max(1, limit - suffix.length))}${suffix}`.slice(0, limit);
}
