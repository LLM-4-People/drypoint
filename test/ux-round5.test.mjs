/**
 * Round-5 product findings: the gate banner must sit in normal flow, the
 * unknown sound controls must be valid buttons, the quarantine recovery
 * controls must meet the coarse-pointer target, and the empty-state copy must
 * be true in both layouts.
 *
 * Every check runs the real page in Chromium. The fake printer below answers
 * the same protocol frames the manager sends, so a real refused model (D101)
 * produces the real gate banner.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { delay, openApp, withPage } from './helpers/browser-page.mjs';

const SOUND_SWITCHES = 'button.switch[aria-label="Bluetooth sound"], button.switch[aria-label="Power sound"]';
const SOUNDS_JS = JSON.stringify(SOUND_SWITCHES);

/**
 * A NIIMBOT D101 over Web Serial. Discovery succeeds, the model is refused by
 * the support gate, and the sound command answers without a state (the panel's
 * honest unknown). No print path is needed by these tests.
 */
const FAKE_PRINTER = String.raw`
(() => {
  const HEAD = 0x55;
  const TAIL = 0xaa;
  const crc = (bytes) => bytes.reduce((acc, byte) => acc ^ byte, 0);
  const frame = (cmd, data = []) => {
    const payload = Array.from(data);
    return Uint8Array.from([HEAD, HEAD, cmd, payload.length, ...payload, crc([cmd, payload.length, ...payload]), TAIL, TAIL]);
  };
  let controller = null;
  let closed = false;
  const push = (bytes) => {
    if (closed || !controller) return;
    try { controller.enqueue(bytes); } catch (error) { /* closed */ }
  };
  const reply = (cmd, data) => push(frame(cmd, data));
  const readable = new ReadableStream({ start(c) { controller = c; } });

  const info = (key) => {
    switch (key) {
      case 0x01: return [3];
      case 0x02: return [1];
      case 0x03: return [1];
      case 0x04: return [0x00, 0x60];
      case 0x07: return [3];
      case 0x08: return window.__model === 'D110_M' ? [0x09, 0x10] : [0x0a, 0x00]; // D101 is refused for its 24 mm head
      case 0x09: return [4, 23];
      case 0x0a: return [4];
      case 0x0b: return [0x44, 0x31, 0x31, 0x30, 0x30, 0x30, 0x30, 0x31];
      case 0x0c: return [4, 1];
      case 0x0d: return [0x11, 0x22, 0x33, 0x44, 0x55, 0x66];
      case 0x0e: return [1];
      case 0x0f: return [0x00, 0x60, 0x06, 0x40];
      default: return [0];
    }
  };
  const caps = () => {
    const tlv = (id, bytes) => [id, bytes.length, ...bytes];
    return [
      ...tlv(0x04, [0x00, 0xcb]),
      ...tlv(0x05, [0]),
      ...tlv(0x07, [5, 1]),
      ...tlv(0x08, [3, 1]),
      ...tlv(0x09, [0, 0, 0, 0x0e]),
      ...tlv(0x0b, [0x06, 0x40]),
      ...tlv(0x0e, [1]),
      ...tlv(0x11, [2, 0]),
      ...tlv(0x12, [0]),
      ...tlv(0x17, [1]),
      ...tlv(0x1a, [0]),
      ...tlv(0x20, [0]),
    ];
  };
  const onWrite = (bytes) => {
    const data = Uint8Array.from(bytes);
    if (data.length < 7 || data[0] !== HEAD || data[1] !== HEAD) return;
    const cmd = data[2];
    const length = data[3];
    const payload = Array.from(data.subarray(4, 4 + length));
    switch (cmd) {
      case 0x40: reply(0x40 + payload[0], info(payload[0])); return;
      case 0xa5: reply(0xb5, [0, 1, 2, 3, 4, 5, 6, 7, 8, 30, 0, 4, 0]); return;
      case 0xdc:
        if (payload[0] === 0x03) reply(0xde, [1, 4, 4, 23, 0x00, 0x60, 2, 0, 1, 0]);
        else reply(0xd9, [0x0d, 0xac, 4, 25, 0, 0, 1, 0, 0]);
        return;
      case 0xaf: reply(0xbf, caps()); return;
      case 0x1a:
        reply(0x1b, [1, 2, 3, 4, 5, 6, 7, 8, 12, 82, 79, 76, 76, 45, 65, 49, 66, 50, 67, 51, 68, 52, 4, 65, 66, 67, 68, 0, 100, 0, 40, 1]);
        return;
      // Unknown by default (no third byte); a test may boot with a known state.
      case 0x58: {
        const known = window.__soundState;
        const state = known === 'on' ? [1] : known === 'off' ? [0] : [];
        reply(0x68, [0, payload[1] ?? 1, ...state]);
        return;
      }
      default: return;
    }
  };
  const writer = {
    async write(bytes) { onWrite(bytes); },
    releaseLock() {},
    async close() {},
  };
  const port = {
    getInfo: () => ({ bluetoothServiceClassId: '00001101-0000-1000-8000-00805f9b34fb' }),
    async open() {},
    async close() { closed = true; try { controller.close(); } catch (error) { /* already closed */ } },
    readable: { getReader: () => readable.getReader() },
    writable: { getWriter: () => writer },
  };
  Object.defineProperty(navigator, 'serial', {
    configurable: true,
    value: { getPorts: async () => [port], requestPort: async () => port },
  });
})();
`;

async function inject(cdp, source) {
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source });
}

async function setViewport(cdp, { width, height, mobile }) {
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: mobile ? 2 : 1,
    mobile,
  });
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: mobile, maxTouchPoints: mobile ? 5 : 1 });
  await delay(250);
}

async function waitFor(cdp, expression, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cdp.evaluate(expression)) return true;
    await delay(80);
  }
  throw new Error(`condition was never reached: ${expression}`);
}

async function center(cdp, selector) {
  return cdp.evaluate(`(() => {
    const node = document.querySelector(${JSON.stringify(selector)});
    const rect = node.getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, width: rect.width, height: rect.height };
  })()`);
}

async function hitTest(cdp, selector) {
  return cdp.evaluate(`(() => {
    const node = document.querySelector(${JSON.stringify(selector)});
    const rect = node.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
    return {
      hit: hit ? hit.id || hit.className || hit.tagName : null,
      own: hit === node,
      x: rect.x + rect.width / 2,
      y: rect.y + rect.height / 2,
      width: rect.width,
      height: rect.height,
    };
  })()`);
}

async function clickAt(cdp, x, y) {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
}

function once(cdp, method, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cdp.socket.removeEventListener('message', onMessage);
      reject(new Error(`no ${method} event within ${timeoutMs} ms`));
    }, timeoutMs);
    const onMessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.method !== method) return;
      clearTimeout(timer);
      cdp.socket.removeEventListener('message', onMessage);
      resolve(message.params);
    };
    cdp.socket.addEventListener('message', onMessage);
  });
}

test('a refused model never covers the tabs or the Document actions', async (t) => {
  await withPage(t, async ({ cdp, port }) => {
    await setViewport(cdp, { width: 375, height: 667, mobile: true });
    await inject(cdp, FAKE_PRINTER);
    await openApp(cdp, port);
    await waitFor(
      cdp,
      `document.querySelector('#deviceDot').dataset.state === 'online' && !document.querySelector('#printGateReason').hidden`
    );
    await delay(250);

    for (const [width, height] of [
      [375, 667],
      [412, 823],
    ]) {
      await setViewport(cdp, { width, height, mobile: true });
      await cdp.evaluate('window.scrollTo(0, 0)');
      await delay(250);

      const gate = await cdp.evaluate(`(() => {
        const node = document.querySelector('#printGateReason');
        const rect = node.getBoundingClientRect();
        return {
          hidden: node.hidden,
          height: rect.height,
          text: node.textContent,
          inBar: Boolean(node.closest('.actionbar')),
          barTop: document.querySelector('.actionbar').getBoundingClientRect().top,
        };
      })()`);
      assert.equal(gate.hidden, false, `${width}: the refusal is visible`);
      assert.ok(gate.height > 0, `${width}: the refusal takes real space`);
      assert.match(gate.text, /D101 is not supported/, `${width}: the refusal names the model`);
      assert.equal(gate.inBar, true, `${width}: the banner is part of the action bar flow`);

      for (const [tab, selected] of [
        ['#tab-print', '#tab-print'],
        ['#tab-design', '#tab-design'],
      ]) {
        const hit = await hitTest(cdp, tab);
        assert.equal(hit.own, true, `${width}: ${tab} is the topmost control at its centre (hit ${hit.hit})`);
        await clickAt(cdp, hit.x, hit.y);
        await delay(200);
        assert.equal(
          await cdp.evaluate(`document.querySelector(${JSON.stringify(selected)}).getAttribute('aria-selected')`),
          'true',
          `${width}: a trusted click switches ${tab}`
        );
      }

      await cdp.evaluate('window.scrollTo(0, document.documentElement.scrollHeight)');
      await delay(300);
      const gateAtBottom = await cdp.evaluate(`(() => {
        const rect = document.querySelector('#printGateReason').getBoundingClientRect();
        return { top: rect.top, bottom: rect.bottom, height: rect.height, viewport: innerHeight };
      })()`);
      assert.ok(gateAtBottom.height > 0, `${width}: the banner keeps its content`);
      assert.ok(gateAtBottom.top >= 0 && gateAtBottom.bottom <= gateAtBottom.viewport + 1, `${width}: the banner is visible at maximum scroll`);
      const exportHit = await hitTest(cdp, '#exportDocumentButton');
      assert.equal(exportHit.own, true, `${width}: Export is reachable at maximum scroll (hit ${exportHit.hit})`);
      const importHit = await hitTest(cdp, '#importDocumentButton');
      assert.equal(importHit.own, true, `${width}: Import is reachable at maximum scroll (hit ${importHit.hit})`);

      await cdp.send('Page.setInterceptFileChooserDialog', { enabled: true });
      const chooser = once(cdp, 'Page.fileChooserOpened');
      await clickAt(cdp, importHit.x, importHit.y);
      await chooser;
      await cdp.send('Page.setInterceptFileChooserDialog', { enabled: false });

      await clickAt(cdp, exportHit.x, exportHit.y);
      await delay(400);
      assert.ok(
        await cdp.evaluate(`[...document.querySelectorAll('.toast')].some((node) => node.textContent.includes('Label exported'))`),
        `${width}: a trusted click exports the label`
      );
      assert.equal(
        await cdp.evaluate('document.documentElement.scrollWidth - document.documentElement.clientWidth'),
        0,
        `${width}: the taller bar introduces no horizontal overflow`
      );
      await delay(4000);
    }

    for (const height of [800, 900]) {
      await setViewport(cdp, { width: 1280, height, mobile: false });
      await cdp.evaluate('window.scrollTo(0, 0)');
      await delay(250);
      const desktop = await cdp.evaluate(`(() => {
        const print = document.querySelector('#printButton').getBoundingClientRect();
        return {
          scrollHeight: document.documentElement.scrollHeight,
          innerHeight,
          printBottom: print.bottom,
          overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        };
      })()`);
      assert.equal(desktop.scrollHeight, desktop.innerHeight, `1280x${height}: the page does not scroll`);
      assert.ok(desktop.printBottom <= desktop.innerHeight, `1280x${height}: Print stays inside the viewport`);
      assert.equal(desktop.overflowX, 0, `1280x${height}: no horizontal overflow`);
    }
  });
});

test('unknown sound controls are plain described buttons and known ones are switches', async (t) => {
  const shape = `[...document.querySelectorAll(${SOUNDS_JS})].map((node) => ({
    role: node.getAttribute('role'),
    checked: node.getAttribute('aria-checked'),
    describedBy: node.getAttribute('aria-describedby'),
    disabled: node.disabled,
    label: node.getAttribute('aria-label'),
    visible: node.closest('.switch-row')?.textContent.trim() ?? '',
  }))`;

  await withPage(t, async ({ cdp, port }) => {
    await setViewport(cdp, { width: 1280, height: 900, mobile: false });
    await openApp(cdp, port);
    await cdp.evaluate("document.querySelector('#tab-print').click()");
    await waitFor(cdp, `document.querySelectorAll(${SOUNDS_JS}).length === 2`);
    const unknown = await cdp.evaluate(shape);
    for (const [index, control] of unknown.entries()) {
      assert.equal(control.role, null, `offline ${index}: no role=switch without a state`);
      assert.equal(control.checked, null, `offline ${index}: no invented off state`);
      assert.equal(control.describedBy, 'soundHint', `offline ${index}: the hint explains the unknown state`);
      assert.equal(control.disabled, true, `offline ${index}: the control is honestly disabled`);
      assert.ok(control.label && control.visible.includes(control.label), `offline ${index}: the visible label is exposed`);
    }
  });

  await withPage(t, async ({ cdp, port }) => {
    await setViewport(cdp, { width: 1280, height: 900, mobile: false });
    await inject(cdp, FAKE_PRINTER);
    await openApp(cdp, port);
    await waitFor(cdp, `document.querySelector('#deviceDot').dataset.state === 'online'`);
    await cdp.evaluate("document.querySelector('#tab-print').click()");
    await waitFor(cdp, `document.querySelectorAll(${SOUNDS_JS}).length === 2`);
    await waitFor(cdp, `[...document.querySelectorAll(${SOUNDS_JS})].every((node) => node.closest('.switch-row').dataset.state === 'unknown')`);
    const unknown = await cdp.evaluate(shape);
    for (const [index, control] of unknown.entries()) {
      assert.equal(control.role, null, `connected unread ${index}: no role=switch without a state`);
      assert.equal(control.checked, null, `connected unread ${index}: no invented off state`);
      assert.equal(control.describedBy, 'soundHint', `connected unread ${index}: the hint still describes it`);
    }
  });

  await withPage(t, async ({ cdp, port }) => {
    await setViewport(cdp, { width: 1280, height: 900, mobile: false });
    await inject(cdp, `window.__model = 'D110_M';\nwindow.__soundState = 'on';\n${FAKE_PRINTER}`);
    await openApp(cdp, port);
    await waitFor(cdp, `document.querySelector('#deviceDot').dataset.state === 'online'`);
    await cdp.evaluate("document.querySelector('#tab-print').click()");
    await waitFor(cdp, `[...document.querySelectorAll(${SOUNDS_JS})].every((node) => node.closest('.switch-row').dataset.state === 'known')`);
    const known = await cdp.evaluate(shape);
    for (const [index, control] of known.entries()) {
      assert.equal(control.role, 'switch', `known ${index}: a reported value is a switch`);
      assert.equal(control.checked, 'true', `known ${index}: the printer's on state is exposed`);
      assert.equal(control.describedBy, null, `known ${index}: no unknown hint is needed`);
      assert.equal(control.disabled, false, `known ${index}: a known switch is editable`);
    }
  });
});

test('the quarantine actions meet the coarse-pointer target and still work', async (t) => {
  await withPage(t, async ({ cdp, port }) => {
    await setViewport(cdp, { width: 375, height: 667, mobile: true });
    await inject(cdp, `localStorage.setItem('drypoint.document', '{"version":3,"elements":"nope"}');`);
    await openApp(cdp, port);
    await waitFor(cdp, `!document.querySelector('#storageAlert').hidden`);

    for (const [width, height] of [
      [375, 667],
      [412, 823],
    ]) {
      await setViewport(cdp, { width, height, mobile: true });
      await delay(200);
      assert.equal(
        await cdp.evaluate("matchMedia('(pointer: coarse)').matches"),
        true,
        `${width}: a coarse pointer is emulated`
      );
      for (const selector of ['#storageExportRaw', '#storageReset']) {
        const box = await center(cdp, selector);
        assert.ok(box.height >= 44, `${width}: ${selector} is at least 44 px high (${box.height})`);
      }
      const overflow = await cdp.evaluate('document.documentElement.scrollWidth - document.documentElement.clientWidth');
      assert.equal(overflow, 0, `${width}: the banner fits without horizontal overflow`);

      const reset = await center(cdp, '#storageReset');
      await clickAt(cdp, reset.x, reset.y);
      await delay(250);
      assert.equal(
        await cdp.evaluate(`Boolean([...document.querySelectorAll('[role="dialog"]')].find((node) => node.textContent.includes('Reset the unreadable label?')))`),
        true,
        `${width}: a trusted tap on Reset opens the confirm dialog`
      );
      await cdp.evaluate(`document.querySelector('[role="dialog"] button')?.click()`);
      await delay(150);
    }
  });
});

test('the empty inspector points at the toolbar in both layouts', async (t) => {
  await withPage(t, async ({ cdp, port }) => {
    await setViewport(cdp, { width: 1280, height: 900, mobile: false });
    await openApp(cdp, port);
    for (const [width, height, mobile] of [
      [1280, 900, false],
      [375, 667, true],
    ]) {
      await setViewport(cdp, { width, height, mobile });
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      await delay(200);
      const hint = await cdp.evaluate(`(() => {
        const empty = document.querySelector('#panelBody .empty');
        return empty ? empty.textContent : '';
      })()`);
      assert.match(hint, /Or add one from the toolbar/, `${width}: the neutral hint is present`);
      assert.doesNotMatch(hint, /on the left|on the right|above|below/, `${width}: no layout claim is wrong`);
    }
  });
});
