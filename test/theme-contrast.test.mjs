import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../assets/app.css', import.meta.url), 'utf8');

/** Read the custom properties declared in the first matching rule block. */
function tokens(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
  assert.ok(match, `missing rule block: ${selector}`);
  const out = {};
  const body = match[1].replace(/\/\*[\s\S]*?\*\//g, '');
  for (const line of body.split(';')) {
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim();
    if (key.startsWith('--')) out[key.slice(2)] = line.slice(colon + 1).trim();
  }
  return out;
}

function rgb(value) {
  const hex = value.trim();
  const match = hex.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  assert.ok(match, `expected a hex token, got ${value}`);
  const digits = match[1].length === 3 ? [...match[1]].map((d) => d + d).join('') : match[1];
  return [0, 2, 4].map((offset) => parseInt(digits.slice(offset, offset + 2), 16));
}

function channel(value) {
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function luminance(value) {
  const [r, g, b] = rgb(value);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(a, b) {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}

/** Mix an accent into paper white, matching the CSS color-mix in srgb. */
function tint(accent, accentShare, white = '#ffffff') {
  const [r, g, b] = rgb(accent);
  const w = rgb(white);
  const hex = [r, g, b]
    .map((value, index) => Math.round(value * accentShare + w[index] * (1 - accentShare)))
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');
  return `#${hex}`;
}

const dark = tokens(':root');
const light = tokens(':root[data-theme="light"]');

test('dark mode tokens are unchanged', () => {
  assert.equal(dark.accent, '#c8f751');
  assert.equal(dark.danger, '#ff6b5e');
  assert.equal(dark.warn, '#ffc46b');
  assert.equal(dark['accent-ink'], '#0c1200');
});

test('light status and accent colours reach AA on the light surfaces', () => {
  for (const name of ['accent', 'danger', 'warn']) {
    const value = light[name];
    assert.ok(contrast(value, light.bg) >= 4.5, `${name} on --bg is ${contrast(value, light.bg).toFixed(2)}:1`);
    assert.ok(contrast(value, light['surface-2']) >= 4.5, `${name} on --surface-2 is ${contrast(value, light['surface-2']).toFixed(2)}:1`);
  }
});

test('light field borders reach 3:1 against the field background', () => {
  const ratio = contrast(light['field-border'], light['surface-2']);
  assert.ok(ratio >= 3, `field border is ${ratio.toFixed(2)}:1`);
});

test('dark field borders reach 3:1 against the field background', () => {
  // The divider tone (--line-2) is 1.37:1 here; the field border is its own
  // token so dividers and control boundaries can differ.
  const ratio = contrast(dark['field-border'], dark['surface-2']);
  assert.ok(ratio >= 3, `dark field border is ${ratio.toFixed(2)}:1`);
  assert.notEqual(dark['field-border'], dark['line-2']);
});

test('the switch knob reaches 3:1 against its track in both themes', () => {
  assert.match(css, /\.switch i\s*\{[^}]*background:\s*var\(--muted\)/);
  for (const [name, theme] of [
    ['dark', dark],
    ['light', light],
  ]) {
    const ratio = contrast(theme.muted, theme['surface-3']);
    assert.ok(ratio >= 3, `${name} knob is ${ratio.toFixed(2)}:1 against the track`);
  }
});

test('the segmented control boundary and selected state reach 3:1', () => {
  // S6: the group border was --line-2 (1.40:1 light) and the selected chip was
  // a 1.08:1 fill change with no non-colour cue. Both now use --field-border,
  // and the pressed chip is filled with the same surface as the group so the
  // ring has one adjacency to clear.
  assert.match(css, /\.segmented\s*\{[^}]*border:\s*1px solid var\(--field-border\)/);
  // Every chip reserves the ring's 1px border, so selecting one cannot reflow.
  assert.match(css, /\.segmented button\s*\{[^}]*border:\s*1px solid transparent/);
  const pressed = css.match(/\.segmented button\[aria-pressed="true"\]\s*\{([^}]*)\}/);
  assert.ok(pressed, 'missing pressed-chip rule');
  assert.match(pressed[1], /border-color:\s*var\(--field-border\)/);
  assert.match(pressed[1], /background:\s*var\(--surface-2\)/);
  assert.match(pressed[1], /font-weight:\s*650/, 'weight difference is a non-colour cue');
  assert.match(pressed[1], /box-shadow:\s*inset 0 -3px 0 var\(--accent\)/, 'edge bar is a non-colour cue');
  for (const [name, theme] of [
    ['dark', dark],
    ['light', light],
  ]) {
    const ratio = contrast(theme['field-border'], theme['surface-2']);
    assert.ok(ratio >= 3, `${name} segmented ring is ${ratio.toFixed(2)}:1`);
  }
});

test('light accent-soft and accent-ink derive from the selected accent', () => {
  assert.match(light['accent-soft'], /color-mix\(in srgb, var\(--accent\)/);
  assert.match(light['accent-ink'], /var\(--accent\)/);

  const inkMix = light['accent-ink'].match(/var\(--accent\)\s+(\d+)%/);
  assert.ok(inkMix, 'accent-ink should mix a share of the accent');
  const share = Number(inkMix[1]) / 100;
  for (const selector of [':root[data-theme="light"]', ':root[data-theme="light"][data-accent="amber"]', ':root[data-theme="light"][data-accent="sky"]', ':root[data-theme="light"][data-accent="violet"]']) {
    const accent = tokens(selector).accent;
    const ink = tint(accent, share);
    assert.ok(contrast(ink, accent) >= 4.5, `${selector}: ink on accent is ${contrast(ink, accent).toFixed(2)}:1`);
    assert.ok(contrast(accent, light.bg) >= 4.5, `${selector}: accent on --bg is ${contrast(accent, light.bg).toFixed(2)}:1`);
  }
});
