/**
 * The Content-Security-Policy is not decoration: the real page is loaded in
 * Chromium with a `securitypolicyviolation` listener installed before any
 * document script runs, and the app must boot with zero violations.
 *
 * A policy that breaks the app would look fine in a source check and fail here;
 * a policy that is absent would let the violations list stay empty while remote
 * code was allowed, so the same test proves a remote script is refused.
 *
 * It skips when no Chromium binary is available; the rest of the suite needs no
 * browser.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { delay, withPage } from './helpers/browser-page.mjs';

/** Collected before the document parses, so no violation can be missed. */
const LISTENER = `
  window.__cspViolations = [];
  document.addEventListener('securitypolicyviolation', (event) => {
    window.__cspViolations.push({
      directive: event.effectiveDirective,
      blocked: event.blockedURI,
      sample: event.sample,
    });
  });
`;

test('the app boots with no Content-Security-Policy violation', async (t) => {
  await withPage(t, async ({ cdp, port }) => {
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: LISTENER });
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${port}/` });
    await delay(1500);

    const booted = await cdp.evaluate(`(() => {
      const app = document.querySelector('#app');
      const canvas = document.querySelector('#labelCanvas');
      return {
        title: document.title,
        app: Boolean(app),
        canvas: Boolean(canvas),
        width: canvas ? canvas.width : 0,
        rail: document.querySelectorAll('#toolRail button').length,
        ready: document.readyState,
      };
    })()`);
    assert.equal(booted.title, 'Drypoint', 'the document loaded');
    assert.equal(booted.ready, 'complete');
    assert.equal(booted.app, true);
    assert.equal(booted.canvas, true, 'the editor canvas exists');
    assert.ok(booted.width > 0, `the canvas is rendered (${booted.width} px)`);
    assert.ok(booted.rail > 0, 'the module graph ran and built the tool rail');

    const violations = await cdp.evaluate('window.__cspViolations');
    assert.deepEqual(violations, [], 'the app runs without a single CSP violation');
  });
});

test('the policy refuses a remote script', async (t) => {
  await withPage(t, async ({ cdp, port }) => {
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: LISTENER });
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${port}/` });
    await delay(800);

    const blocked = await cdp.evaluate(`(async () => {
      const script = document.createElement('script');
      script.src = 'https://example.test/remote.js';
      const settled = new Promise((resolve) => script.addEventListener('error', () => resolve('error')));
      document.head.appendChild(script);
      const outcome = await Promise.race([settled, new Promise((resolve) => setTimeout(() => resolve('timeout'), 3000))]);
      return { outcome, violations: window.__cspViolations };
    })()`);
    assert.equal(blocked.outcome, 'error', 'the remote script never loads');
    assert.ok(blocked.violations.length > 0, `the browser reports the blocked origin: ${JSON.stringify(blocked.violations)}`);
    assert.equal(blocked.violations[0].directive, 'script-src-elem');
    assert.match(blocked.violations[0].blocked, /^https:\/\/example\.test\//);
  });
});
