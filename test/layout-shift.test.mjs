import test from 'node:test';
import assert from 'node:assert/strict';

import { delay, mountTimeoutMs, openApp, withPage } from './helpers/browser-page.mjs';

/**
 * Every region in the order the compact layout must paint it. The inspector
 * sits under the add rail, and the three panels follow it.
 */
const COMPACT_ORDER = ['.stage', '.rail', '.inspector', '.layers-panel', '.templates-panel', '.document-panel'];

/** Top edges of the named regions, in document order, rounded to a pixel. */
const regionTops = (selectors) => `(() => (${JSON.stringify(selectors)}).map((selector) => {
  const rect = document.querySelector(selector).getBoundingClientRect();
  return { selector, top: Math.round(rect.top), left: Math.round(rect.left) };
}))()`;

/** Block the module graph so the CSS-only, pre-script layout is measurable. */
async function blockScripts(cdp) {
  await cdp.send('Network.enable');
  await cdp.send('Network.setBlockedURLs', { urls: ['*src/main.js*'] });
}

async function waitForLoad(cdp, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ready = await cdp.evaluate('document.readyState');
    if (ready === 'complete') return;
    await delay(50);
  }
  throw new Error('the pre-script shell did not finish loading');
}

test('the compact shell paints in its final order before any script runs', async (t) => {
  await withPage(t, async ({ cdp, port }) => {
    await blockScripts(cdp);
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 412,
      height: 823,
      deviceScaleFactor: 2,
      mobile: true,
    });
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${port}/` });
    await waitForLoad(cdp);

    const tops = await cdp.evaluate(regionTops(COMPACT_ORDER));
    assert.deepEqual(
      tops.map((entry) => entry.selector),
      COMPACT_ORDER,
      'all six regions exist in the static shell'
    );
    for (let index = 1; index < tops.length; index++) {
      assert.ok(
        tops[index].top > tops[index - 1].top,
        `${tops[index].selector} (${tops[index].top}) paints below ${tops[index - 1].selector} (${tops[index - 1].top}) before boot`
      );
    }

    // The sidebar's surface used to come from its box; with display: contents
    // each flattened row must paint that surface itself.
    const surfaces = await cdp.evaluate(`(() => ['.rail', '.inspector', '.layers-panel'].map((selector) => {
      const style = getComputedStyle(document.querySelector(selector));
      return { selector, background: style.backgroundColor };
    }))()`);
    for (const { selector, background } of surfaces) {
      assert.notEqual(background, 'rgba(0, 0, 0, 0)', `${selector} paints a surface, not the bare workspace`);
    }

  });
});

test('the desktop columns are unchanged before boot', async (t) => {
  await withPage(t, async ({ cdp, port }) => {
    await blockScripts(cdp);
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 1280,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${port}/` });
    await waitForLoad(cdp);

    const [rail, stage, inspector] = await cdp.evaluate(regionTops(['.rail', '.stage', '.inspector']));
    assert.equal(rail.top, stage.top, 'the rail and stage share the first grid row');
    assert.equal(inspector.top, stage.top, 'the inspector shares the first grid row');
    assert.ok(rail.left < stage.left, 'the rail stays the left column');
    assert.ok(stage.left < inspector.left, 'the inspector stays the right column');
    assert.ok(stage.left - rail.left > 100, 'the rail keeps its column width, not a compact stack');
  });
});

test('a throttled first load keeps cumulative layout shift under 0.1', async (t) => {
  await withPage(t, async ({ cdp, port }) => {
    // The phone Lighthouse measured: 412x823, 4x CPU, slow 4G (150 ms RTT,
    // 1.6 Mb/s down). The observer is installed before any page script so a
    // shift caused by boot is counted, and it ignores input-driven shifts as
    // the metric does.
    await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions', {
      offline: false,
      latency: 150,
      downloadThroughput: (1.6 * 1024 * 1024) / 8,
      uploadThroughput: (750 * 1024) / 8,
      connectionType: 'cellular4g',
    });
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 412,
      height: 823,
      deviceScaleFactor: 2,
      mobile: true,
    });
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `
        window.__layoutShift = { total: 0, shifts: [] };
        new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            if (entry.hadRecentInput) continue;
            window.__layoutShift.total += entry.value;
            window.__layoutShift.shifts.push({
              value: entry.value,
              at: Math.round(entry.startTime),
              sources: (entry.sources || []).map((source) => ({
                node: source.node ? source.node.id || source.node.className || source.node.tagName : null,
                top: Math.round(source.currentRect?.top ?? 0),
                previousTop: Math.round(source.previousRect?.top ?? 0),
              })),
            });
          }
        }).observe({ type: 'layout-shift', buffered: true });
      `,
    });

    await openApp(cdp, port, { timeoutMs: Math.max(mountTimeoutMs(), 60000) });
    // The fit, the hydration pass and the action-bar measurement all settle in
    // the first frames; give late work a bounded window before reading the sum.
    await delay(2000);
    const measured = await cdp.evaluate('window.__layoutShift');
    assert.ok(measured, 'the layout-shift observer installed');
    assert.ok(
      measured.total < 0.1,
      `cumulative layout shift ${measured.total.toFixed(4)} is not under 0.1: ${JSON.stringify(measured.shifts)}`
    );
  });
});
