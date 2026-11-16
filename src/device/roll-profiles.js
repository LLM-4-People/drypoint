/** Per-roll geometry memory, keyed by the RFID barcode (the roll SKU). */

import { CONFIG, storageKey } from '../core/config.js';
import { geometry } from '../core/geometry.js';
import { createLogger } from '../core/log.js';
import { createStore } from '../core/store.js';

const log = createLogger('device.rolls');

const store = createStore({ profiles: {} }, {
  key: storageKey('rolls'),
  version: 1,
  onError: (error, phase) =>
    log.warn(phase === 'load' ? 'stored roll profiles could not be read' : 'roll profiles could not be saved', {
      message: error.message,
    }),
});

const copyProfile = (profile) => (profile ? { ...profile } : null);

function readProfiles() {
  return store.get().profiles ?? {};
}

/** Keep only fields the app can use; unknown or invalid values are dropped. */
function sanitiseProfile(profile) {
  const clean = {};
  const lengthMm = Number(profile?.lengthMm);
  if (Number.isFinite(lengthMm) && lengthMm >= CONFIG.geometry.minLengthMm && lengthMm <= geometry().maxLengthMm) {
    clean.lengthMm = Math.round(lengthMm);
  }
  const labelType = Number(profile?.labelType);
  if (CONFIG.print.labelTypes[labelType]) clean.labelType = labelType;
  return clean;
}

export function getRollProfile(barcode) {
  if (!barcode) return null;
  return copyProfile(readProfiles()[barcode]);
}

export function rememberRoll(barcode, profile) {
  if (!barcode) return null;
  const clean = sanitiseProfile(profile);
  if (!Object.keys(clean).length) return null;

  const profiles = readProfiles();
  const next = { ...profiles, [barcode]: { ...profiles[barcode], ...clean, updatedAt: Date.now() } };

  // Bound the map: drop the least recently updated profiles until it fits.
  const oldestFirst = Object.entries(next)
    .filter(([key]) => key !== barcode)
    .sort(([, a], [, b]) => (a.updatedAt ?? 0) - (b.updatedAt ?? 0));
  while (Object.keys(next).length > CONFIG.device.maxRollProfiles && oldestFirst.length) {
    delete next[oldestFirst.shift()[0]];
  }

  store.set({ profiles: next });
  return copyProfile(next[barcode]);
}

export function allRollProfiles() {
  return Object.fromEntries(Object.entries(readProfiles()).map(([barcode, profile]) => [barcode, copyProfile(profile)]));
}

/**
 * Reapply a stored profile to the current label and job settings. Only fields
 * this printer can honour are applied, so the README's "remembers the length
 * and the tape type" is true rather than half-true.
 *
 * @returns {Array<{field:'length'|'labelType', value:number}>} what changed
 */
export function applyRollProfile(profile, { capabilities, lengthMm, labelType, setLength, setLabelType }) {
  const applied = [];
  if (Number.isFinite(profile?.lengthMm) && profile.lengthMm !== lengthMm) {
    setLength(profile.lengthMm);
    applied.push({ field: 'length', value: profile.lengthMm });
  }
  const supported = capabilities?.labelTypes ?? [];
  if (profile?.labelType && supported.includes(profile.labelType) && String(profile.labelType) !== String(labelType)) {
    setLabelType(String(profile.labelType));
    applied.push({ field: 'labelType', value: profile.labelType });
  }
  return applied;
}
