/**
 * Measured layout edges: the automatic zoom between the compact breakpoint and
 * 1100 px, and the narrow header pill. Both were clipping at the 200 % default
 * or rendering "Connect p…"; a source grep cannot see either.
 *
 * Skips when no Chromium is available; CI fails instead of skipping.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { openApp, withPage } from './helpers/browser-page.mjs';

const WIDTHS = [901, 1000, 1100];

test('the boot zoom fits the stage from 901 to 1100 px and the 360 px pill stays whole', async (t) => {
  await withPage(t, async ({ cdp, port }) => {
    const measureStage = async (width) => {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width, height: 800, deviceScaleFactor: 1, mobile: false });
      await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: 0, left: 0, bottom: 0, right: 0 } });
      await openApp(cdp, port);
      return cdp.evaluate(`(() => {
        const stage = document.querySelector('#stageScroll');
        const canvas = document.querySelector('#labelCanvas');
        return {
          zoom: document.querySelector('.zoom-value')?.textContent ?? '',
          stageWidth: stage.clientWidth,
          stageScrollWidth: stage.scrollWidth,
          canvasWidth: canvas.getBoundingClientRect().width,
          overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        };
      })()`);
    };

    for (const width of WIDTHS) {
      const state = await measureStage(width);
      assert.equal(state.overflowX, 0, `${width}: the page does not scroll sideways`);
      assert.ok(
        state.stageScrollWidth <= state.stageWidth + 1,
        `${width}: the canvas is not clipped (scroll ${state.stageScrollWidth} > stage ${state.stageWidth})`
      );
      assert.ok(
        state.canvasWidth <= state.stageWidth,
        `${width}: the fitted canvas ${state.canvasWidth} fits the stage ${state.stageWidth}`
      );
      assert.ok(parseInt(state.zoom, 10) < 200, `${width}: the default 200% was replaced by a fit (${state.zoom})`);
    }

    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 360, height: 740, deviceScaleFactor: 1, mobile: true });
    await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: 44, left: 44, bottom: 34, right: 44 } });
    await openApp(cdp, port);
    const pill = await cdp.evaluate(`(() => {
      const button = document.querySelector('#deviceButton');
      const full = document.querySelector('#deviceLabel');
      const short = document.querySelector('#deviceShortLabel');
      const visible = (node) => Boolean(node) && getComputedStyle(node).display !== 'none' && node.getBoundingClientRect().width > 0;
      return {
        fullText: full.textContent,
        fullVisible: visible(full),
        shortText: short.textContent,
        shortVisible: visible(short),
        aria: button.getAttribute('aria-label'),
        pillWidth: button.getBoundingClientRect().width,
        overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      };
    })()`);
    assert.equal(pill.overflowX, 0, 'the narrow header does not scroll sideways');
    assert.equal(pill.fullVisible, false, 'the long label is not the visible one at 360');
    assert.equal(pill.shortVisible, true, 'a whole short label is visible');
    assert.equal(pill.shortText, 'Connect');
    assert.doesNotMatch(pill.shortText, /…/, 'the pill never renders a truncated "Connect p…"');
    assert.equal(pill.aria, 'Connect printer', 'the accessible name is the full action');
    assert.ok(pill.pillWidth >= 44, 'the pill keeps its tap target');
  });
});
