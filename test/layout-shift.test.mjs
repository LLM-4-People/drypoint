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

/**
 * The four desktop regions, as the browser lays them out. `rows` is kept for
 * the failure message; it is the fact that regressed.
 */
const desktopBoxes = () => `(() => {
  const box = (selector) => {
    const node = document.querySelector(selector);
    const rect = node.getBoundingClientRect();
    return { top: rect.top, bottom: rect.bottom, height: rect.height };
  };
  const app = document.querySelector('.app');
  return {
    viewport: innerHeight,
    rows: getComputedStyle(app).gridTemplateRows,
    alert: { ...box('#storageAlert'), display: getComputedStyle(document.querySelector('#storageAlert')).display },
    workspace: box('.workspace'),
    actionbar: box('.actionbar'),
    print: box('#printButton'),
    scrollHeight: document.documentElement.scrollHeight,
  };
})()`;

function assertDesktopLayout(state, label, { minWorkspace, alertVisible = false }) {
  assert.equal(state.alert.display, alertVisible ? 'flex' : 'none', `${label}: alert visibility`);
  assert.ok(state.actionbar.top < state.viewport - 1, `${label}: the action bar starts inside the viewport (rows ${state.rows})`);
  assert.ok(
    state.actionbar.height > 0 && state.actionbar.height < 120,
    `${label}: the action bar is its content height (${state.actionbar.height}), not the 1fr remainder`
  );
  assert.ok(
    Math.abs(state.workspace.bottom - state.actionbar.top) <= 1,
    `${label}: the workspace ends where the action bar starts (workspace ${state.workspace.bottom}, bar ${state.actionbar.top})`
  );
  assert.ok(state.workspace.height > minWorkspace, `${label}: the workspace takes the flexible remainder (${state.workspace.height})`);
  assert.ok(state.print.bottom <= state.viewport, `${label}: Print is inside the viewport (${state.print.bottom} <= ${state.viewport})`);
  assert.ok(state.scrollHeight <= state.viewport, `${label}: no forced page scroll (${state.scrollHeight} > ${state.viewport})`);
  if (alertVisible) {
    assert.ok(state.alert.height > 0, `${label}: the alert row has a real height`);
    assert.ok(
      Math.abs(state.alert.bottom - state.workspace.top) <= 1,
      `${label}: the alert sits between the header and the workspace (${state.alert.bottom} vs ${state.workspace.top})`
    );
  }
}

test('the desktop grid keeps the action bar out of the flexible row', async (t) => {
  // The alert is display:none while hidden, so auto-placement used to put the
  // workspace in row 2 and the action bar in the 1fr row: the workspace shrank
  // to its content, Print fell below the viewport and the page scrolled. Each
  // region names its grid area, so the rows survive the missing item.
  await withPage(t, async ({ cdp, port }) => {
    for (const [width, height, minWorkspace] of [[1280, 900, 300], [1280, 800, 200]]) {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
      await openApp(cdp, port);
      const state = await cdp.evaluate(desktopBoxes());
      assertDesktopLayout(state, `${width}x${height}`, { minWorkspace });
    }

    // The quarantine banner is visible: the same four regions, one more row
    // with content, and no overflow.
    await cdp.evaluate("localStorage.setItem('drypoint.document', '{\"version\":3,\"lengthMm\":40,\"elements\":\"nope\"}')");
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    await openApp(cdp, port);
    const alerted = await cdp.evaluate(desktopBoxes());
    assert.equal(alerted.alert.display, 'flex', 'the seeded value shows the banner');
    assertDesktopLayout(alerted, 'alert 1280x900', { minWorkspace: 200, alertVisible: true });

    // Pre-paint: the same placement with the module graph blocked.
    await cdp.evaluate("localStorage.removeItem('drypoint.document')");
    await blockScripts(cdp);
    for (const [width, height, minWorkspace] of [[1280, 900, 300], [1280, 800, 200]]) {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
      await cdp.send('Page.navigate', { url: `http://127.0.0.1:${port}/` });
      await waitForLoad(cdp);
      const state = await cdp.evaluate(desktopBoxes());
      assertDesktopLayout(state, `${width}x${height} pre-paint`, { minWorkspace });
    }
  });
});
