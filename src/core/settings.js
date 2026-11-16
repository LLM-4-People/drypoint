/**
 * User settings: one declarative schema that drives both the stored values and
 * the generated settings UI. Adding a setting means adding one entry here.
 */

import { CONFIG, storageKey } from './config.js';
import { createLogger } from './log.js';
import { createStore } from './store.js';

const log = createLogger('settings');

/**
 * @typedef {'toggle'|'range'|'enum'} SettingType
 * @typedef {{key:string, group:string, label:string, type:SettingType, default:unknown,
 *            surface?:'settings'|'print', live?:boolean, description?:string,
 *            options?:Array<[string,string]>,
 *            min?:number, max?:number, step?:number, unit?:string, onChange?:string}} SettingDef
 */

/** @type {SettingDef[]} */
export const SETTINGS_SCHEMA = [
  {
    key: 'appearance.theme',
    group: 'Appearance',
    label: 'Theme',
    type: 'enum',
    default: 'auto',
    options: [
      ['auto', 'System'],
      ['dark', 'Dark'],
      ['light', 'Light'],
    ],
  },
  {
    key: 'appearance.accent',
    group: 'Appearance',
    label: 'Accent',
    type: 'enum',
    default: 'lime',
    options: [
      ['lime', 'Lime'],
      ['amber', 'Amber'],
      ['sky', 'Sky'],
      ['violet', 'Violet'],
    ],
  },

  {
    key: 'editor.snap',
    group: 'Editor',
    label: 'Snap to grid',
    type: 'toggle',
    default: true,
  },
  {
    key: 'editor.grid',
    group: 'Editor',
    label: 'Show grid',
    type: 'toggle',
    default: true,
  },
  {
    key: 'editor.gridMm',
    group: 'Editor',
    label: 'Grid step',
    type: 'enum',
    default: String(CONFIG.geometry.gridMm),
    options: [
      ['1', '1 mm'],
      ['2', '2 mm'],
      ['5', '5 mm'],
    ],
    unit: 'mm',
  },
  {
    key: 'editor.showGuides',
    group: 'Editor',
    label: 'Alignment guides',
    type: 'toggle',
    default: true,
  },

  {
    key: 'print.density',
    group: 'Printing',
    label: 'Density',
    type: 'range',
    default: CONFIG.print.density.default,
    min: CONFIG.print.density.min,
    max: CONFIG.print.density.max,
    step: 1,
    surface: 'print',
    /** Stored in the printer, so editing it needs a live link. */
    live: true,
    description: 'Heat level. Higher is darker but slower.',
  },
  {
    key: 'print.labelType',
    group: 'Printing',
    label: 'Tape type',
    type: 'enum',
    default: String(CONFIG.print.defaultLabelType),
    options: Object.entries(CONFIG.print.labelTypes).map(([id, label]) => [id, label]),
    surface: 'print',
    /** Stored in the printer, so editing it needs a live link. */
    live: true,
    description: 'Must match the roll loaded in the printer.',
  },
  {
    key: 'print.speed',
    group: 'Printing',
    label: 'Print quality',
    type: 'enum',
    default: 'normal',
    options: [
      ['normal', 'Normal'],
      ['quality', 'Quality'],
    ],
    surface: 'print',
    description: 'Quality prints slower. Sent in the job header.',
  },
  {
    key: 'print.dither',
    group: 'Printing',
    label: 'Image mode',
    type: 'enum',
    default: 'threshold',
    options: [
      ['threshold', 'Crisp text'],
      ['floyd', 'Photos (diffusion)'],
      ['atkinson', 'Photos (soft)'],
    ],
    description: 'How continuous tones are converted to 1-bit.',
  },
  {
    key: 'print.threshold',
    group: 'Printing',
    label: 'Threshold',
    type: 'range',
    default: CONFIG.print.threshold.default,
    min: CONFIG.print.threshold.min,
    max: CONFIG.print.threshold.max,
    step: CONFIG.print.threshold.step,
    unit: '%',
    description: 'Lower keeps more white; higher prints more ink.',
  },

  {
    key: 'device.transport',
    group: 'Device',
    label: 'Connection',
    type: 'enum',
    default: 'auto',
    options: [
      ['auto', 'Automatic'],
      ['serial', 'Serial (SPP)'],
      ['ble', 'Bluetooth LE'],
    ],
    description: 'Automatic prefers serial on desktop and BLE on Android.',
  },
  {
    key: 'device.autoConnect',
    group: 'Device',
    label: 'Reconnect on open',
    type: 'toggle',
    default: true,
  },
  {
    key: 'device.readSettings',
    group: 'Device',
    label: 'Read printer settings',
    type: 'toggle',
    default: true,
    description: 'Mirror density and tape type from the printer when connecting.',
  },

  {
    key: 'diagnostics.logLevel',
    group: 'Diagnostics',
    label: 'Log level',
    type: 'enum',
    default: CONFIG.log.level,
    surface: 'print',
    options: [
      ['error', 'Errors'],
      ['warn', 'Warnings'],
      ['info', 'Info'],
      ['debug', 'Debug'],
      ['trace', 'Trace'],
    ],
  },
];

const SETTINGS_BY_KEY = new Map(SETTINGS_SCHEMA.map((definition) => [definition.key, definition]));

/** The schema entry that owns a key, or undefined for an unknown key. */
function settingDefinition(key) {
  return SETTINGS_BY_KEY.get(key);
}

/**
 * Settings owned by a UI surface. Diagnostics live next to the log viewer in
 * the Print panel, so the settings sheet only builds the 'settings' surface.
 * Printer controls carry their labels and option lists in this schema too; the
 * panel builds them with capability overrides instead of keeping a copy.
 */
export function settingsForSurface(surface = 'settings') {
  return SETTINGS_SCHEMA.filter((definition) => (definition.surface ?? 'settings') === surface);
}

function defaultSettings() {
  const defaults = {};
  for (const definition of SETTINGS_SCHEMA) defaults[definition.key] = definition.default;
  return defaults;
}

/**
 * Coerce one raw value against its schema entry. This is the part that may
 * throw on a hostile value (`String({toString:null})`, `Number({valueOf:null})`);
 * callers that need to know add their own boundary.
 */
function coerceUnsafe(definition, value) {
  switch (definition.type) {
    case 'toggle':
      if (typeof value === 'boolean') return value;
      if (typeof value === 'number') return value !== 0;
      return !['false', '0', 'off', 'no', ''].includes(String(value).toLowerCase());
    case 'range': {
      if (value === null || value === undefined || value === '') return definition.default;
      const number = Number(value);
      if (!Number.isFinite(number)) return definition.default;
      return Math.min(definition.max ?? number, Math.max(definition.min ?? number, number));
    }
    case 'enum': {
      const allowed = definition.options?.map(([id]) => id) ?? [];
      return allowed.includes(String(value)) ? String(value) : definition.default;
    }
    default:
      return String(value);
  }
}

/** Coerce a raw value to the type declared in the schema. */
export function coerceSetting(key, value) {
  const definition = settingDefinition(key);
  if (!definition) return value;
  try {
    return coerceUnsafe(definition, value);
  } catch {
    // A stored value that cannot even be stringified is not a setting.
    return definition.default;
  }
}

/**
 * One bad stored value must cost that key only. The previous implementation let
 * `coerceSetting` throw from inside the loop, so the store treated the whole
 * payload as unreadable and reset every setting while leaving the corrupt JSON
 * on disk. `loadIssue` carries the one visible notice for the boot path.
 */
let loadIssue = null;

function hydrateSettings(data) {
  const next = defaultSettings();
  const badKeys = [];
  for (const [key, value] of Object.entries(data ?? {})) {
    const definition = SETTINGS_BY_KEY.get(key);
    if (!definition) continue;
    try {
      next[key] = coerceUnsafe(definition, value);
    } catch {
      // Quarantine the key: the type default applies and the valid neighbours
      // survive untouched.
      badKeys.push(key);
    }
  }
  if (badKeys.length) {
    loadIssue = {
      keys: badKeys,
      message: `Some saved settings could not be read and were reset: ${badKeys.join(', ')}`,
    };
  }
  return next;
}

export const settingsStore = createStore(defaultSettings(), {
  key: storageKey('settings'),
  version: CONFIG.app.documentVersion,
  hydrate: hydrateSettings,
  onError: (error, phase) =>
    log.warn(phase === 'load' ? 'stored settings could not be read' : 'settings could not be saved', { message: error.message }),
});

// The clean, complete object replaces the corrupt payload instead of waiting
// for the operator's next settings change to do it.
if (loadIssue) {
  settingsStore.set({});
  // Write the clean payload now: leaving the corrupt JSON for the debounce (or
  // a tab that closes first) is how a quarantined key came back next boot.
  settingsStore.flush();
}

/**
 * The one visible notice for a settings load that had to quarantine a key.
 * The boot path shows it once; tests use it to pin the report.
 */
export function takeSettingsLoadIssue() {
  const issue = loadIssue;
  loadIssue = null;
  return issue;
}

export function getSetting(key) {
  const value = settingsStore.get()[key];
  return value === undefined ? settingDefinition(key)?.default : value;
}

/**
 * Every setting a print job reads, in one selector: the schema decides the
 * list, so the canvas renderer and the device manager can never disagree about
 * which keys a job needs.
 */
export function printSettingsSnapshot() {
  const snapshot = {};
  for (const definition of SETTINGS_SCHEMA) {
    if (definition.group === 'Printing') snapshot[definition.key] = getSetting(definition.key);
  }
  return snapshot;
}

export function setSetting(key, value) {
  const coerced = coerceSetting(key, value);
  settingsStore.set({ [key]: coerced });
  return coerced;
}
