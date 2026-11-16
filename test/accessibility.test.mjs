/**
 * P-F4 / PR-F5: the real page has one heading, two uniquely named landmarks and
 * a named design canvas. axe reported `landmark-unique` (two unlabeled
 * `<aside>`s) and `page-has-heading-one` (no h1); a source grep cannot see
 * either, so this runs the real page.
 *
 * Skips when no Chromium binary is available.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { openApp, withPage } from './helpers/browser-page.mjs';

test('the page has one heading, two unique landmarks and a named canvas', async (t) => {
  await withPage(t, async ({ cdp, port }) => {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1024, height: 900, deviceScaleFactor: 1, mobile: false });
    await openApp(cdp, port);

    const state = await cdp.evaluate(`(() => {
      const headings = [...document.querySelectorAll('h1')];
      const h1 = headings[0];
      const style = h1 ? getComputedStyle(h1) : null;
      const asides = [...document.querySelectorAll('aside')].map((node) => ({
        label: node.getAttribute('aria-label'),
        role: node.getAttribute('role'),
        text: node.textContent.trim().slice(0, 20),
      }));
      const canvas = document.querySelector('#labelCanvas');
      const overlay = document.querySelector('#overlayCanvas');
      const gate = document.querySelector('#printGateReason');
      const print = document.querySelector('#printButton');
      return {
        headingCount: headings.length,
        headingText: h1?.textContent ?? '',
        headingVisible: Boolean(h1) && h1.getBoundingClientRect().width > 0 && h1.getBoundingClientRect().height > 0,
        headingDisplay: style?.display ?? '',
        asides,
        canvasRole: canvas?.getAttribute('role'),
        canvasName: canvas?.getAttribute('aria-label') ?? '',
        overlayHidden: overlay?.getAttribute('aria-hidden'),
        gateRole: gate?.getAttribute('role'),
        gateLabel: print?.getAttribute('aria-label') ?? '',
      };
    })()`);

    assert.equal(state.headingCount, 1, 'exactly one h1');
    assert.equal(state.headingText, 'Drypoint label designer');
    assert.equal(state.headingDisplay, 'block', 'the heading is visually hidden, never display:none');
    assert.ok(state.headingVisible, 'a 1px clipped heading is still in the accessibility tree');

    assert.equal(state.asides.length, 2, 'the sidebar and the inspector are landmarks');
    const names = state.asides.map((aside) => aside.label);
    for (const name of names) assert.ok(name && name.length > 0, 'every landmark is named');
    assert.equal(new Set(names).size, names.length, 'landmark names are unique');

    assert.equal(state.canvasRole, 'img', 'the canvas is an image');
    assert.match(state.canvasName, /^Label design, \d+(?:\.\d)? × \d+ mm, \d+ element/, 'the name carries the size and content');
    assert.equal(state.overlayHidden, 'true', 'the interaction layer is decorative');
    assert.equal(state.gateRole, 'status', 'a new gate refusal is announced without a focus change');
  });
});
