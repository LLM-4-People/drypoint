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

import { delay, openApp, withPage } from './helpers/browser-page.mjs';

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

    // N7: the one h1 must live inside a landmark. The AX tree is the check: a
    // body-level h1 is outside every region, which axe reports as `region`.
    await cdp.send('Accessibility.enable');
    const tree = await cdp.send('Accessibility.getFullAXTree');
    const nodes = tree.result?.nodes ?? [];
    const byId = new Map(nodes.map((node) => [node.nodeId, node]));
    const headingNode = nodes.find((node) => node.role?.value === 'heading');
    assert.ok(headingNode, 'the heading is in the accessibility tree');
    const chain = [];
    for (let node = headingNode; node; node = byId.get(node.parentId)) {
      chain.push(node.role?.value ?? node.nodeId);
      if (chain.length > 20) break;
    }
    assert.ok(chain.includes('banner'), `the h1 is inside the banner landmark (${chain.join(' > ')})`);
    assert.equal(
      nodes.filter((node) => node.role?.value === 'heading' && node.name?.value === 'Drypoint label designer').length,
      1,
      'still one h1'
    );
  });
});


test('the compact display:contents sidebar keeps its landmark and name', async (t) => {
  // P-F2 removes the sidebar's box at compact widths so its rail, inspector and
  // panels can be ordered like the final shell before boot. `display: contents`
  // must not drop the aside from the accessibility tree: the AX domain is the
  // only check that can see it, because querySelectorAll('aside') still finds
  // the element either way.
  await withPage(t, async ({ cdp, port }) => {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 412, height: 823, deviceScaleFactor: 2, mobile: true });
    await openApp(cdp, port);
    assert.equal(
      await cdp.evaluate("getComputedStyle(document.querySelector('.sidebar')).display"),
      'contents',
      'the compact layout uses the pre-paint order'
    );

    await cdp.send('Accessibility.enable');
    const tree = await cdp.send('Accessibility.getFullAXTree');
    const landmarks = (tree.result?.nodes ?? [])
      .filter((node) => !node.ignored && node.role?.value === 'complementary')
      .map((node) => node.name?.value ?? '');
    assert.deepEqual(landmarks.sort(), ['Elements and layers', 'Properties'], 'both named asides survive');
  });
});

test('the header repository link keeps its name and layout at 375 and 1280', async (t) => {
  await withPage(t, async ({ cdp, port }) => {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    await openApp(cdp, port);
    await cdp.send('Accessibility.enable');

    for (const [width, height, mobile] of [
      [375, 667, true],
      [1280, 900, false],
    ]) {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile });
      await delay(200);

      const state = await cdp.evaluate(`(() => {
        const link = document.querySelector('#brandLink');
        const header = document.querySelector('.topbar');
        const box = link.getBoundingClientRect();
        const bar = header.getBoundingClientRect();
        return {
          tag: link.tagName,
          href: link.href,
          target: link.target,
          rel: link.rel,
          title: link.title,
          text: link.textContent.replace(/\\s+/g, ' ').trim(),
          width: Math.round(box.width),
          height: Math.round(box.height),
          insideHeader: box.top >= bar.top - 1 && box.bottom <= bar.bottom + 1 && box.left >= bar.left - 1 && box.right <= bar.right + 1,
          overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          headingCount: document.querySelectorAll('h1').length,
        };
      })()`);

      const label = `${width}x${height}`;
      assert.equal(state.tag, 'A', `${label}: the brand is the link`);
      assert.equal(state.href, 'https://github.com/LLM-4-People/drypoint', `${label}: the href is the repository`);
      assert.equal(state.target, '_blank', `${label}: the link opens a new tab`);
      assert.equal(state.rel, 'noopener', `${label}: the new tab cannot reach back`);
      assert.equal(state.title, 'Drypoint on GitHub', `${label}: the tooltip names the destination`);
      assert.equal(state.text, 'Drypoint on GitHub', `${label}: the hidden suffix supplies the full name`);
      assert.equal(state.headingCount, 1, `${label}: still one h1`);
      assert.equal(state.overflowX, 0, `${label}: no horizontal overflow`);
      assert.ok(state.width >= 22 && state.height >= 14, `${label}: the brand mark keeps its size`);
      assert.equal(state.insideHeader, true, `${label}: the brand stays inside the header`);

      const tree = await cdp.send('Accessibility.getFullAXTree');
      const brandLink = (tree.result?.nodes ?? []).find(
        (node) => !node.ignored && node.role?.value === 'link' && node.name?.value === 'Drypoint on GitHub'
      );
      assert.ok(brandLink, `${label}: the brand link has an accessible name`);
    }
  });
});
