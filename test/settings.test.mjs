import test from 'node:test';
import assert from 'node:assert/strict';

import { CONFIG } from '../src/core/config.js';
import { LEVELS } from '../src/core/log.js';
import { installDom } from './helpers/fake-dom.mjs';
import { readProjectFile } from './helpers/project-files.mjs';

// A browser-shaped storage stub before settings.js is evaluated: the store
// reads localStorage at import time.
const values = new Map();
globalThis.localStorage = {
  getItem: (key) => values.get(key) ?? null,
  setItem: (key, value) => values.set(key, value),
  removeItem: (key) => values.delete(key),
};

const { SETTINGS_SCHEMA, settingsForSurface } = await import('../src/core/settings.js');

test('every setting belongs to exactly one UI surface', () => {
  const settings = settingsForSurface('settings').map((definition) => definition.key);
  const print = settingsForSurface('print').map((definition) => definition.key);
  assert.deepEqual(
    [...settings, ...print].sort(),
    SETTINGS_SCHEMA.map((definition) => definition.key).sort(),
    'no setting is unowned or owned twice'
  );
});

test('diagnostics live next to the Print panel viewer, not in the settings sheet', () => {
  assert.ok(settingsForSurface('print').some((definition) => definition.key === 'diagnostics.logLevel'));
  assert.ok(!settingsForSurface('settings').some((definition) => definition.key === 'diagnostics.logLevel'));
});

test('printer controls have one schema owner on the print surface', () => {
  const keys = ['print.density', 'print.speed', 'print.labelType'];
  const storedInPrinter = new Set(['print.density', 'print.labelType']);
  for (const key of keys) {
    const definition = SETTINGS_SCHEMA.find((item) => item.key === key);
    assert.equal(definition.surface, 'print', `${key} belongs to the Print panel`);
    assert.equal(definition.scope, undefined, `${key} has no second surface filter`);
    assert.equal(Boolean(definition.live), storedInPrinter.has(key), `${key}: only a value the printer stores needs a live link`);
    assert.ok(definition.label, `${key} has a label`);
  }
  assert.equal(SETTINGS_SCHEMA.find((item) => item.key === 'print.speed').label, 'Print quality');
  assert.equal(
    settingsForSurface('settings').some((definition) => keys.includes(definition.key)),
    false,
    'the settings sheet never renders the same control twice'
  );
});

test('a version-matching but corrupt settings payload is coerced on load', async () => {  globalThis.localStorage = {
    getItem: () =>
      JSON.stringify({
        version: CONFIG.app.documentVersion,
        data: {
          'print.density': 'hot',
          'print.threshold': 999,
          'print.speed': 'warp',
          'appearance.theme': 'neon',
          'editor.snap': 'yes',
          'editor.grid': 'false',
          'unknown.key': 1,
        },
      }),
    setItem() {},
  };
  try {
    // A fresh module instance reads the fake storage at import time.
    const { coerceSetting, settingsStore } = await import('../src/core/settings.js?case=corrupt-load');
    const state = settingsStore.get();

    assert.equal(state['print.density'], CONFIG.print.density.default, 'non-numeric density falls back');
    assert.equal(state['print.threshold'], 95, 'out-of-range numbers are clamped');
    assert.equal(state['print.speed'], 'normal', 'unknown enum values fall back');
    assert.equal(state['appearance.theme'], 'auto', 'unknown enum values fall back');
    assert.equal(state['editor.snap'], true, 'toggles are coerced to booleans');
    assert.equal(state['editor.grid'], false, 'the string "false" is not truthy');
    assert.ok(!('unknown.key' in state), 'unknown keys are dropped');
    for (const definition of SETTINGS_SCHEMA) assert.ok(definition.key in state, `${definition.key} is present`);

    assert.equal(coerceSetting('print.density', null), CONFIG.print.density.default, 'null falls back');
    assert.equal(coerceSetting('editor.snap', 'false'), false, 'explicit false strings stay false');
  } finally {
    globalThis.localStorage = { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  }
});

test('every schema type builds one real control with no fallback', async () => {
  installDom();
  const { buildSettingControl } = await import('../src/ui/setting-control.js');
  const types = new Set(SETTINGS_SCHEMA.map((definition) => definition.type));
  assert.deepEqual([...types].sort(), ['enum', 'range', 'toggle'], 'the schema uses only the declared types');

  for (const definition of SETTINGS_SCHEMA) {
    const control = buildSettingControl(definition);
    assert.ok(control?.node, `${definition.key} builds a node`);
    assert.equal(typeof control.set, 'function', `${definition.key} follows the model`);
    assert.equal(typeof control.setDisabled, 'function', `${definition.key} can be disabled`);
  }
});

/* ---------------- a poisoned setting costs one key (O3) ---------------- */

test('a hostile stored value is quarantined without resetting the other settings', async () => {
  const stored = [];
  globalThis.localStorage = {
    getItem: () =>
      JSON.stringify({
        version: CONFIG.app.documentVersion,
        data: {
          'editor.snap': { toString: null }, // toggle
          'print.density': { valueOf: null, toString: null }, // range
          'appearance.theme': { toString: null }, // enum
          'print.speed': 'quality', // a valid neighbour that must survive
          'print.threshold': 60,
          'editor.grid': false,
        },
      }),
    setItem: (key, value) => stored.push([key, value]),
  };
  try {
    const { coerceSetting, settingsStore, takeSettingsLoadIssue } = await import('../src/core/settings.js?case=poisoned-load');
    const state = settingsStore.get();

    assert.equal(state['editor.snap'], true, 'the toggle falls back to its default');
    assert.equal(state['print.density'], CONFIG.print.density.default, 'the range falls back to its default');
    assert.equal(state['appearance.theme'], 'auto', 'the enum falls back to its default');
    assert.equal(state['print.speed'], 'quality', 'a valid neighbour is not reset');
    assert.equal(state['print.threshold'], 60);
    assert.equal(state['editor.grid'], false);

    const issue = takeSettingsLoadIssue();
    assert.ok(issue, 'the load is reported');
    assert.deepEqual([...issue.keys].sort(), ['appearance.theme', 'editor.snap', 'print.density']);
    assert.match(issue.message, /Some saved settings could not be read and were reset/);
    assert.equal(takeSettingsLoadIssue(), null, 'the notice is shown once');

    // The clean payload replaced the corrupt one synchronously.
    assert.ok(stored.length > 0, 'a clean settings payload was persisted');
    const persisted = JSON.parse(stored.at(-1)[1]);
    assert.equal(persisted.data['print.speed'], 'quality');
    assert.equal(persisted.data['editor.snap'], true);
    assert.equal(typeof persisted.data['appearance.theme'], 'string');

    // The exported coercion is defensive on its own.
    assert.equal(coerceSetting('editor.snap', { toString: null }), true);
    assert.equal(coerceSetting('print.density', { valueOf: null, toString: null }), CONFIG.print.density.default);
    assert.equal(coerceSetting('appearance.theme', { toString: null }), 'auto');
  } finally {
    globalThis.localStorage = { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  }
});


/* ---------------- option contracts (P2b) ---------------- */

test('every accent option has a CSS palette', () => {
  const definition = SETTINGS_SCHEMA.find((item) => item.key === 'appearance.accent');
  assert.ok(definition, 'the accent setting exists');
  const css = readProjectFile('assets/app.css');
  for (const [value] of definition.options) {
    if (value === definition.default) {
      // The default accent is the root palette; it has no attribute block.
      assert.match(css, /^:root\s*\{[^}]*--accent:/m, `the default accent ${value} has root tokens`);
    } else {
      assert.match(css, new RegExp(`:root\\[data-accent="${value}"\\]`), `accent ${value} has a dark palette`);
      assert.match(
        css,
        new RegExp(`:root\\[data-theme="light"\\]\\[data-accent="${value}"\\]`),
        `accent ${value} has a light palette`
      );
    }
  }
});

test('every log-level option exists in the one LEVELS table', () => {
  const definition = SETTINGS_SCHEMA.find((item) => item.key === 'diagnostics.logLevel');
  assert.ok(definition, 'the log-level setting exists');
  for (const [value] of definition.options) {
    assert.ok(Object.prototype.hasOwnProperty.call(LEVELS, value), `${value} is a real log level`);
  }
  assert.ok(Object.prototype.hasOwnProperty.call(LEVELS, definition.default), 'the default level is real');
  assert.ok(Object.prototype.hasOwnProperty.call(LEVELS, CONFIG.log.level), 'the configured level is real');
});
