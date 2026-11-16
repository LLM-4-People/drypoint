/**
 * P-F1: once the worker controls the page, an in-scope deep link must boot the
 * real app. Before the base rewrite the shell answered 200 but every relative
 * URL resolved under the deep path, so the browser painted unstyled HTML with
 * no layers.
 *
 * The site is served under `/drypoint/` (the Pages layout) because the worker
 * scope is what a deep path has to stay inside. Skips without Chromium.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { delay, mountTimeoutMs } from './helpers/browser-page.mjs';
import { openApp, withPage } from './helpers/browser-page.mjs';

const BASE_PATH = '/drypoint/';
const DEEP = `${BASE_PATH}library/deep/path#/label/abc-123`;

/** Wait until the page is controlled by its worker. */
async function waitForControl(cdp, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const controlled = await cdp.evaluate(`(async () => {
      if (!('serviceWorker' in navigator)) return 'no-worker-api';
      if (navigator.serviceWorker.controller) return true;
      try {
        await navigator.serviceWorker.ready;
        return Boolean(navigator.serviceWorker.controller);
      } catch {
        return false;
      }
    })()`);
    if (controlled === true) return true;
    if (controlled === 'no-worker-api') return false;
    await delay(100);
  }
  return false;
}

/** Wait until the editor mounted at the deep URL. */
async function waitForMount(cdp, timeoutMs = mountTimeoutMs()) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await cdp.evaluate(`(() => ({
      ready: document.readyState,
      tools: document.querySelectorAll('#toolRail button').length,
    }))()`);
    if (state?.ready === 'complete' && state.tools > 0) return true;
    await delay(100);
  }
  return false;
}

test('a deep in-scope navigation boots the real app under its base', async (t) => {
  await withPage(
    t,
    async ({ cdp, port }) => {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1024, height: 900, deviceScaleFactor: 1, mobile: false });
      await openApp(cdp, port, { path: BASE_PATH });
      const controlled = await waitForControl(cdp);
      assert.equal(controlled, true, 'the worker installed and controls the pages in its scope');

      // Navigate to a deep in-scope path with a hash route: the host answers
      // 404 for it, so the worker has to serve the cached shell.
      await cdp.send('Page.navigate', { url: `http://127.0.0.1:${port}${DEEP}` });
      assert.equal(await waitForMount(cdp), true, 'the deep navigation booted the editor');

      const state = await cdp.evaluate(`(async () => {
        const canvas = document.querySelector('#labelCanvas');
        const probes = {};
        for (const path of ['assets/app.css', 'src/main.js', 'src/vendor/qrcode.js']) {
          try {
            const response = await fetch(path, { cache: 'reload' });
            probes[path] = response.status;
          } catch (error) {
            probes[path] = 'error: ' + error.message;
          }
        }
        const base = document.querySelector('base');
        const sheet = [...document.styleSheets].find((entry) => String(entry.href).endsWith('/drypoint/assets/app.css'));
        return {
          href: location.href,
          pathname: location.pathname,
          hash: location.hash,
          baseHref: base ? base.getAttribute('href') : null,
          baseURI: document.baseURI,
          canvasWidth: canvas ? canvas.width : 0,
          layers: document.querySelectorAll('#layerList .layer-row').length,
          styled: sheet ? sheet.cssRules.length > 0 : false,
          appDisplay: getComputedStyle(document.querySelector('.app')).display,
          railGap: getComputedStyle(document.querySelector('.rail')).gap,
          probes,
        };
      })()`);

      assert.equal(state.pathname, `${BASE_PATH}library/deep/path`, 'the document URL stays deep');
      assert.equal(state.hash, '#/label/abc-123', 'the hash route is preserved');
      assert.equal(state.baseHref, `http://127.0.0.1:${port}${BASE_PATH}`, 'the injected base is the worker scope');
      assert.equal(state.baseURI, `http://127.0.0.1:${port}${BASE_PATH}`, 'relative URLs resolve at the app root');
      assert.ok(state.canvasWidth > 0, `the canvas is sized (${state.canvasWidth} px)`);
      assert.ok(state.layers > 0, `the layer list is populated (${state.layers})`);
      assert.equal(state.styled, true, 'the stylesheet applied');
      assert.equal(state.appDisplay, 'grid', 'the shell is laid out by the stylesheet');
      assert.ok(state.railGap && state.railGap !== 'normal', 'a CSS rule from app.css is in effect');
      for (const [path, status] of Object.entries(state.probes)) {
        assert.equal(status, 200, `${path} answers 200 under the deep path`);
      }
    },
    { basePath: BASE_PATH }
  );
});
