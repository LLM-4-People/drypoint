/**
 * The web printer identity that survives a reload.
 *
 * A live BLE or serial connection cannot survive navigation, so only the
 * identity is kept: enough to prefer the same granted port or device on the
 * next connect. The Android shell keeps its own native `lastDevice` and never
 * reads this key.
 */

import { CONFIG, storageKey } from '../core/config.js';
import { createLogger } from '../core/log.js';

const log = createLogger('device.last-printer');

const LAST_PRINTER_KEY = storageKey('printer');
const LAST_PRINTER_VERSION = 1;
const PRINTER_KINDS = Object.freeze(['ble', 'serial']);

function defaultStorage() {
  try {
    return globalThis.localStorage ?? null;
  } catch (error) {
    log.debug('localStorage is not reachable for the printer identity', { message: error.message });
    return null;
  }
}

function bounded(value, max) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (text.length > max) return null;
  return text;
}

/** Normalise one identity or return null when it is malformed. */
function normalizePrinterIdentity(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (!PRINTER_KINDS.includes(value.kind)) return null;
  const id = bounded(value.id, CONFIG.device.lastPrinter.maxIdChars);
  const name = bounded(value.name, CONFIG.device.lastPrinter.maxNameChars);
  if (id === null || name === null) return null;
  // A BLE device without an id cannot be matched on the next connect. Serial
  // has no stable id and legitimately stores an empty one.
  if (value.kind === 'ble' && !id) return null;
  return { kind: value.kind, id, name };
}

/**
 * @param {Storage|null} [storage]
 * @returns {{kind: 'ble'|'serial', id: string, name: string}|null}
 */
export function readLastPrinter(storage = defaultStorage()) {
  if (!storage || typeof storage.getItem !== 'function') return null;
  let raw;
  try {
    raw = storage.getItem(LAST_PRINTER_KEY);
  } catch (error) {
    log.debug('the saved printer identity could not be read', { message: error.message });
    return null;
  }
  if (!raw) return null;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    log.debug('the saved printer identity is not JSON', { message: error.message });
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || parsed.version !== LAST_PRINTER_VERSION) {
    log.debug('the saved printer identity has an unknown envelope');
    return null;
  }
  const identity = normalizePrinterIdentity(parsed.data);
  if (!identity) log.debug('the saved printer identity is malformed');
  return identity;
}

/**
 * @param {{kind: string, id: string, name: string}} identity
 * @param {Storage|null} [storage]
 * @returns {boolean} whether the value was written
 */
export function writeLastPrinter(identity, storage = defaultStorage()) {
  const normalised = normalizePrinterIdentity(identity);
  if (!normalised) {
    log.warn('the printer identity was refused', { kind: identity?.kind });
    return false;
  }
  if (!storage || typeof storage.setItem !== 'function') {
    log.debug('the printer identity has no storage to write');
    return false;
  }
  try {
    storage.setItem(LAST_PRINTER_KEY, JSON.stringify({ version: LAST_PRINTER_VERSION, data: normalised }));
    return true;
  } catch (error) {
    log.warn('the printer identity could not be saved', { message: error.message });
    return false;
  }
}

/** @param {Storage|null} [storage] */
export function clearLastPrinter(storage = defaultStorage()) {
  if (!storage || typeof storage.removeItem !== 'function') return false;
  try {
    storage.removeItem(LAST_PRINTER_KEY);
    return true;
  } catch (error) {
    log.warn('the printer identity could not be cleared', { message: error.message });
    return false;
  }
}
