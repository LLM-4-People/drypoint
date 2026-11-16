/**
 * R7-9: the page is the theme owner and the Android shell follows it. Both
 * themes must hand the exact `--bg` token to the bridge; a hard-coded native
 * colour used to leave the system bars dark in the light theme.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { applyTheme } from '../src/ui/theme.js';
import { readProjectFile } from './helpers/project-files.mjs';

function harness(theme, prefersDark = false, bridge = null) {
  const calls = [];
  const classes = new Set();
  const root = {
    dataset: {},
    classList: {
      add: (name) => classes.add(name),
      remove: (name) => classes.delete(name),
      contains: (name) => classes.has(name),
    },
    removeAttribute(name) {
      delete this.dataset[name];
    },
  };
  const meta = {
    content: '',
    setAttribute(name, value) {
      if (name === 'content') this.content = value;
    },
  };
  const computedStyle = () => ({
    getPropertyValue: (name) => (name === '--bg' ? (root.dataset.theme === 'light' ? ' #f7f7f4 ' : ' #08080a ') : ''),
  });
  const result = applyTheme({
    theme,
    prefersDark,
    root,
    meta,
    bridge: bridge ?? { setSystemBars: (hex) => calls.push(hex) },
    computedStyle,
  });
  return { root, meta, calls, result, classes };
}

test('both themes hand the applied background to the native system bars', () => {
  const dark = harness('dark');
  assert.equal(dark.result.dark, true);
  assert.equal(dark.root.dataset.theme, undefined, 'the dark theme is the stylesheet default');
  assert.equal(dark.meta.content, '#08080a', 'the address bar follows the page');
  assert.deepEqual(dark.calls, ['#08080a'], 'so do the Android status and navigation bars');

  const light = harness('light');
  assert.equal(light.result.dark, false);
  assert.equal(light.root.dataset.theme, 'light');
  assert.equal(light.meta.content, '#f7f7f4');
  assert.deepEqual(light.calls, ['#f7f7f4']);
});

test('auto follows the media query and still notifies the shell', () => {
  assert.equal(harness('auto', true).result.dark, true);
  assert.deepEqual(harness('auto', true).calls, ['#08080a']);
  assert.equal(harness('auto', false).result.dark, false);
  assert.deepEqual(harness('auto', false).calls, ['#f7f7f4']);
});

test('the composition root wires the live setting and the shell bridge', () => {
  const main = readProjectFile('src/main.js');
  assert.match(main, /import \{ applyTheme as applyThemeSetting \} from '\.\/ui\/theme\.js'/);
  assert.match(main, /theme: getSetting\('appearance\.theme'\)/);
  assert.match(main, /prefersDark: window\.matchMedia\('\(prefers-color-scheme: dark\)'\)\.matches/);
  assert.match(main, /bridge: typeof window !== 'undefined' \? window\.NiimbotBLE : null/);
});

test('a browser without the bridge, or an older shell, is not an error', () => {
  const classList = { add() {}, remove() {} };
  assert.doesNotThrow(() => applyTheme({ theme: 'light', root: { dataset: {}, removeAttribute() {}, classList }, computedStyle: null }));
  assert.doesNotThrow(() =>
    applyTheme({
      theme: 'light',
      root: { dataset: {}, removeAttribute() {}, classList },
      bridge: {},
      computedStyle: () => ({ getPropertyValue: () => '#f7f7f4' }),
    })
  );
});

/* ---------------- the theme switch suppresses transitions (C-1) ---------------- */

test('the theme switch holds the transition-suppression class for two frames', () => {
  const classes = new Set();
  const frames = [];
  const root = {
    dataset: {},
    classList: {
      add: (name) => classes.add(name),
      remove: (name) => classes.delete(name),
      contains: (name) => classes.has(name),
    },
    removeAttribute(name) {
      delete this.dataset[name];
    },
  };
  applyTheme({
    theme: 'light',
    root,
    computedStyle: () => ({ getPropertyValue: () => '#f7f7f4' }),
    requestFrame: (callback) => frames.push(callback),
  });
  assert.equal(classes.has('theme-switching'), true, 'suppressed before the attribute flips');
  assert.equal(root.dataset.theme, 'light');
  assert.equal(frames.length, 1);
  frames.shift()();
  assert.equal(classes.has('theme-switching'), true, 'still suppressed after one frame');
  assert.equal(frames.length, 1);
  frames.shift()();
  assert.equal(classes.has('theme-switching'), false, 'transitions return after two frames');
});

test('without requestAnimationFrame the suppression class is removed synchronously', () => {
  const classes = new Set();
  const root = {
    dataset: {},
    classList: {
      add: (name) => classes.add(name),
      remove: (name) => classes.delete(name),
      contains: (name) => classes.has(name),
    },
    removeAttribute(name) {
      delete this.dataset[name];
    },
  };
  applyTheme({
    theme: 'dark',
    root,
    computedStyle: () => ({ getPropertyValue: () => '#08080a' }),
    requestFrame: null,
  });
  assert.equal(classes.has('theme-switching'), false);
});
