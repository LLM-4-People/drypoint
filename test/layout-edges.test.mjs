/**
 * Measured layout edges: the automatic zoom between the compact breakpoint and
 * 1100 px, and the narrow header pill. Both were clipping at the 200 % default
 * or rendering "Connect p…"; a source grep cannot see either.
 *
 * Skips when no Chromium is available; CI fails instead of skipping.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { delay, openApp, withPage } from './helpers/browser-page.mjs';

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


test('a short phone keeps the stage scrollable and the inspector reachable', async (t) => {
  // P-F2 gives the compact stage a fixed 40vh height so the boot fit cannot
  // move the rest of the shell. That cap must still hold the whole scaled
  // canvas, and the form below it must stay reachable on the shortest phones.
  await withPage(t, async ({ cdp, port }) => {
    for (const [width, height] of [[375, 667], [360, 640]]) {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile: true });
      await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: 0, left: 0, bottom: 0, right: 0 } });
      await openApp(cdp, port);

      const state = await cdp.evaluate(`(() => {
        const stage = document.querySelector('#stageScroll');
        const canvas = document.querySelector('#labelCanvas');
        const inspector = document.querySelector('.inspector');
        const box = stage.getBoundingClientRect();
        const label = canvas.getBoundingClientRect();
        const fields = document.querySelectorAll('#panelBody input, #panelBody select, #panelBody textarea').length;
        window.scrollTo(0, inspector.offsetTop);
        const reached = inspector.getBoundingClientRect();
        return {
          stageHeight: Math.round(box.height),
          viewportHeight: window.innerHeight,
          canvasInside: label.top >= box.top - 1 && label.bottom <= box.bottom + 1,
          canvasWidthInside: label.width <= stage.clientWidth + 1,
          clipsSideways: stage.scrollWidth - stage.clientWidth,
          pageScrolls: document.documentElement.scrollHeight > window.innerHeight,
          fields,
          reachedTop: Math.round(reached.top),
          reachedBottom: Math.round(reached.bottom),
        };
      })()`);

      const label = `${width}x${height}`;
      assert.ok(state.stageHeight >= Math.round(state.viewportHeight * 0.4) - 2, `${label}: the 40vh stage keeps its height (${state.stageHeight})`);
      assert.ok(state.stageHeight <= Math.round(state.viewportHeight * 0.4) + 2, `${label}: the stage is not content-sized (${state.stageHeight})`);
      assert.equal(state.canvasInside, true, `${label}: the fitted canvas is wholly inside the stage`);
      assert.equal(state.canvasWidthInside, true, `${label}: the canvas is not clipped sideways`);
      assert.ok(state.clipsSideways <= 1, `${label}: the stage does not scroll sideways (${state.clipsSideways})`);
      assert.equal(state.pageScrolls, true, `${label}: the page still scrolls to the panels`);
      assert.ok(state.fields > 0, `${label}: the design fields mounted`);
      assert.ok(state.reachedTop >= 0 && state.reachedTop < state.viewportHeight, `${label}: the inspector scrolls into reach (top ${state.reachedTop})`);
      assert.ok(state.reachedBottom > 0, `${label}: the inspector is not collapsed (bottom ${state.reachedBottom})`);
    }
  });
});


test('the compact stage keeps its height when the label zoom changes', async (t) => {
  // The fixed 40vh stage is what keeps first-load layout independent of the
  // canvas: a content-capped stage collapsed when the fit shrank the label, and
  // an early first paint then moved the whole shell. Zooming out is the same
  // dependency in miniature.
  await withPage(t, async ({ cdp, port }) => {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 412, height: 823, deviceScaleFactor: 2, mobile: true });
    await openApp(cdp, port);
    const measure = () => cdp.evaluate(`(() => ({
      stage: Math.round(document.querySelector('#stageScroll').getBoundingClientRect().height),
      canvas: Math.round(document.querySelector('#labelCanvas').getBoundingClientRect().height),
      zoom: document.querySelector('.zoom-value')?.textContent ?? '',
    }))()`);
    const before = await measure();
    await cdp.evaluate(`(() => {
      const out = document.querySelector('[aria-label="Zoom out"]');
      for (let index = 0; index < 3; index++) out.click();
    })()`);
    await delay(150);
    const after = await measure();

    assert.ok(after.canvas < before.canvas, `the label really zoomed out (${before.canvas} -> ${after.canvas})`);
    assert.notEqual(after.zoom, before.zoom, 'the zoom control reports the new scale');
    assert.equal(after.stage, before.stage, `the reserved stage did not collapse (${before.stage} -> ${after.stage})`);
  });
});
