/**
 * Mounted Print-panel tests. The panel used to be covered only by source-text
 * greps, so a wrong three-state capability, a dead control or a switch that
 * claimed ON while unread all passed. These tests build the real panel against
 * a fake device across connected/disconnected × true/false/null and inspect
 * what the operator actually gets.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { installDom } from './helpers/fake-dom.mjs';
import { clearLog, setLogLevel, subscribeLog } from '../src/core/log.js';
import { CONFIG } from '../src/core/config.js';
import { resolvePrintOptions } from '../src/device/print-options.js';
import { FIXTURE_SERIAL } from './fixtures/captured-unit.mjs';

// The settings store reads localStorage at import time.
const values = new Map();
const dom = installDom();
globalThis.localStorage = {
  getItem: (key) => values.get(key) ?? null,
  setItem: (key, value) => values.set(key, value),
  removeItem: (key) => values.delete(key),
};

const { el } = await import('../src/core/dom.js');
for (const id of ['app', 'toasts', 'modalRoot']) dom.body.append(el('div', { id }));

const { createPrintPanel } = await import('../src/ui/print-panel.js');
const { emptyCapabilities, describeDeviceStatus } = await import('../src/device/capabilities.js');
const { SETTINGS_SCHEMA, getSetting, setSetting, settingsForSurface } = await import('../src/core/settings.js');

const tick = () => new Promise((resolve) => setImmediate(resolve));

function buildCaps(overrides = {}) {
  const base = emptyCapabilities();
  const { source = {}, ...rest } = overrides;
  return {
    ...base,
    // The ordinary fixture is the reference printer: tests that exercise an
    // unsupported or unknown model say so explicitly.
    model: 'D110_M',
    modelSupport: 'confirmed',
    task: 'd110mv4',
    deviceType: 0x0910,
    discovered: true,
    headWidthPx: 96,
    dpi: 200,
    maxLengthMm: 200,
    densityRange: { min: 1, max: 5 },
    labelTypes: [1, 2, 3, 5],
    autoShutdownRange: { min: 1, max: 4 },
    ...rest,
    source: { ...base.source, geometry: 'reported', model: 'reported', ...source },
  };
}

function fakeDevice({
  status = 'idle',
  caps = buildCaps(),
  printing = false,
  readingInfo = false,
  sound = true,
  soundWrite = undefined,
  rejectSoundRead = false,
  rejectSoundWrite = false,
  rejectAutoOff = false,
} = {}) {
  const calls = [];
  const device = {
    state: { status, capabilities: caps, transportLabel: null, printing, readingInfo, error: null },
    get connected() {
      return this.state.status === 'connected';
    },
    get printing() {
      return this.state.printing;
    },
    async connect() {
      calls.push(['connect']);
      this.state = { ...this.state, status: 'connected' };
    },
    async disconnect() {
      calls.push(['disconnect']);
      this.state = { ...this.state, status: 'idle' };
    },
    async choosePrinter() {
      calls.push(['choose']);
    },
    async forgetPrinter() {
      calls.push(['forget']);
      return [{ transport: 'AndroidTransport', forgotten: true }];
    },
    async refresh() {
      calls.push(['refresh']);
    },
    async pushSetting(key, value) {
      calls.push(['push', key, value]);
    },
    async soundSettings(item, value) {
      if (value === undefined) {
        calls.push(['sound-read', item]);
        if (rejectSoundRead) throw new Error('sound read refused');
        return sound;
      }
      calls.push(['sound-write', item, value]);
      if (rejectSoundWrite) throw new Error('sound write refused');
      return soundWrite === undefined ? value === 1 : soundWrite;
    },
    async setAutoShutdown(value) {
      calls.push(['auto-off', value]);
      if (rejectAutoOff) throw new Error('auto-off refused');
      this.state = { ...this.state, capabilities: { ...this.state.capabilities, autoShutdown: value } };
    },
    async calibrate() {
      calls.push(['calibrate']);
      return true;
    },
    async testPage() {
      calls.push(['test-page']);
    },
    async syncClock() {
      calls.push(['sync-clock']);
    },
    async resetPrinter() {
      calls.push(['reset']);
    },
    async diagnostic(name) {
      calls.push(['diagnostic', name]);
      return { raw: {} };
    },
    async readInfoDiagnostics() {
      calls.push(['read-info']);
      return [];
    },
    async cancel() {
      calls.push(['cancel']);
    },
  };
  return { device, calls };
}

function mount(device, { confirm = true } = {}) {
  const container = el('div');
  const toasts = [];
  const dialogs = [];
  const panel = createPrintPanel({
    container,
    device,
    controller: {
      document: { copies: 1 },
      patchDocument(patch) {
        this.document = { ...this.document, ...patch };
      },
    },
    onOpenLog: () => {},
    onExport: () => {},
    notify: (message, options) => toasts.push({ message, tone: options?.tone }),
    confirm: async (title, message) => {
      dialogs.push({ title, message });
      return confirm;
    },
  });
  panel.render();
  return { panel, container, toasts, dialogs };
}

function rowsOf(container) {
  return new Map([...container.querySelectorAll('.stat-row')].map((node) => [node.children[0]?.textContent, node.children[1]?.textContent ?? '']));
}

function buttonByText(container, text) {
  return [...container.querySelectorAll('button')].find((node) => node.textContent.trim() === text);
}

const switchRows = (container) => [...container.querySelectorAll('.switch-row')];

test('the main panel reports one honest output and keeps colour out of the rows', () => {
  const { device } = fakeDevice({ status: 'idle', caps: buildCaps({ supportsColor: false, supportsGray: true }) });
  const { container } = mount(device);
  const rows = rowsOf(container);
  assert.equal(rows.get('Output'), '1-bit monochrome');
  assert.equal(rows.has('Colour'), false);
  assert.equal(rows.has('Gray'), false);
  assert.doesNotMatch(container.textContent, /Colour|Gray/, 'not even the assumed-groups row names them');
});

test('the Status row reads the same description as the header', () => {
  for (const status of ['idle', 'connecting', 'error', 'connected']) {
    const { device } = fakeDevice({ status, caps: buildCaps({ model: 'D110_M', serial: FIXTURE_SERIAL }) });
    const { container } = mount(device);
    assert.equal(rowsOf(container).get('Status'), describeDeviceStatus(device.state).panelLabel, status);
  }
});

test('cancelling the connect dialog is silent, not an error', async (t) => {
  for (const level of ['log', 'info', 'warn', 'error']) t.mock.method(console, level, () => {});
  const { device } = fakeDevice({ status: 'idle' });
  device.connect = async () => {
    // The manager rejects a superseded or user-cancelled picker this way.
    throw Object.assign(new Error('Connection attempt was cancelled'), { cancelled: true });
  };
  clearLog();
  const entries = [];
  const off = subscribeLog((entry) => entries.push(entry));
  let toasts = [];
  try {
    const mounted = mount(device);
    toasts = mounted.toasts;
    buttonByText(mounted.container, 'Connect printer').dispatch('click');
    await tick();
  } finally {
    off();
  }

  assert.deepEqual(toasts, [], 'no toast claims a failure');
  assert.equal(device.state.status, 'idle', 'the link stays idle');
  assert.deepEqual(entries.filter((entry) => entry.level === 'error'), [], 'a cancel is not a fault');
  assert.deepEqual(entries.filter((entry) => entry.level === 'warn'), [], 'and it is not a warning either');
});

test('a failed connect shows its cause, and a new status clears it', () => {
  const { device } = fakeDevice({ status: 'error' });
  device.state = { ...device.state, error: 'No printer selected' };
  const { panel, container } = mount(device);
  assert.equal(rowsOf(container).get('Last error'), 'No printer selected', 'the panel names what went wrong');

  device.state = { ...device.state, status: 'connected', error: null };
  panel.render();
  assert.equal(rowsOf(container).has('Last error'), false, 'a recovered link drops the stale cause');
});

test('sound controls follow the capability across connected and disconnected', async () => {
  for (const status of ['connected', 'idle']) {
    for (const hasVolume of [true, false, null]) {
      const { device } = fakeDevice({
        status,
        caps: buildCaps({ hasVolume, source: { volume: hasVolume == null ? 'default' : 'reported' } }),
      });
      const { container } = mount(device);
      await tick();
      const label = `${status}/${String(hasVolume)}`;
      const switches = switchRows(container);

      if (hasVolume === false) {
        assert.equal(switches.length, 0, `${label}: no switch claims a state the printer rejected`);
        assert.match(container.textContent, /Sound settings are not supported by this printer/);
        continue;
      }

      assert.equal(switches.length, 2, `${label}: both switches exist`);
      const buttons = switches.map((row) => row.querySelector('button'));
      for (const button of buttons) {
        assert.equal(button.disabled, status !== 'connected', `${label}: only a live link enables editing`);
      }
      if (status === 'connected') {
        assert.deepEqual(switches.map((row) => row.getAttribute('data-state')), ['known', 'known'], `${label}: the read resolved`);
        assert.deepEqual(buttons.map((button) => button.getAttribute('aria-checked')), ['true', 'true'], `${label}: the printer's value is applied`);
      } else {
        assert.deepEqual(switches.map((row) => row.getAttribute('data-state')), ['unknown', 'unknown'], `${label}: offline is unknown`);
        assert.deepEqual(
          buttons.map((button) => button.getAttribute('aria-checked')),
          [null, null],
          `${label}: an unread value is never announced as off`
        );
      }
    }
  }
});

test('a sound switch reads "Reading…" and is disabled until the read resolves', async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const { device } = fakeDevice({ status: 'connected', caps: buildCaps({ hasVolume: true, source: { volume: 'reported' } }) });
  const original = device.soundSettings.bind(device);
  device.soundSettings = async (item, value) => {
    if (value === undefined) {
      await gate;
      return false;
    }
    return original(item, value);
  };

  const { container } = mount(device);
  const switches = switchRows(container);
  assert.match(container.textContent, /Reading…/);
  assert.ok(switches.every((row) => row.querySelector('button').disabled));
  const buttons = switches.map((row) => row.querySelector('button'));
  assert.deepEqual(buttons.map((button) => button.getAttribute('aria-checked')), [null, null], 'still unknown while reading');
  assert.deepEqual(buttons.map((button) => button.getAttribute('aria-describedby')), ['soundHint', 'soundHint']);

  release();
  await tick();
  assert.doesNotMatch(container.textContent, /Reading…/);
  assert.ok(switches.every((row) => !row.querySelector('button').disabled));
  assert.deepEqual(switches.map((row) => row.getAttribute('data-state')), ['known', 'known']);
  assert.deepEqual(buttons.map((button) => button.getAttribute('aria-checked')), ['false', 'false'], 'the read value is announced');
  assert.deepEqual(buttons.map((button) => button.getAttribute('aria-describedby')), [null, null], 'the description is gone');
});

test('a failed sound read stays unknown, disabled and reported', async () => {
  const { device } = fakeDevice({
    status: 'connected',
    caps: buildCaps({ hasVolume: true, source: { volume: 'reported' } }),
    rejectSoundRead: true,
  });
  const { container, toasts } = mount(device);
  await tick();

  const switches = switchRows(container);
  assert.deepEqual(switches.map((row) => row.getAttribute('data-state')), ['unknown', 'unknown']);
  assert.ok(switches.every((row) => row.querySelector('button').disabled));
  assert.match(container.textContent, /Sound state unknown/);
  assert.equal(toasts.at(-1)?.tone, 'error');
  assert.match(toasts.at(-1)?.message, /Sound state unknown/);
});

test('a failed sound write flips the switch back and reports', async () => {
  const { device, calls } = fakeDevice({
    status: 'connected',
    caps: buildCaps({ hasVolume: true, source: { volume: 'reported' } }),
    sound: false,
    rejectSoundWrite: true,
  });
  const { container, toasts } = mount(device);
  await tick();

  const button = switchRows(container)[0].querySelector('button');
  assert.equal(button.getAttribute('aria-checked'), 'false');
  button.dispatch('click');
  assert.equal(button.getAttribute('aria-checked'), 'true', 'the tap flips immediately');
  await tick();
  assert.equal(button.getAttribute('aria-checked'), 'false', 'the rejection restores the printer state');
  assert.equal(toasts.at(-1)?.tone, 'error');
  assert.match(toasts.at(-1)?.message, /sound write refused/);
  assert.ok(calls.some(([kind]) => kind === 'sound-write'));
});

test('auto power-off shows Not reported until the printer answers', () => {
  const unknown = mount(fakeDevice({ status: 'connected', caps: buildCaps({ autoShutdown: null }) }).device);
  assert.equal(rowsOf(unknown.container).get('Auto power-off'), 'Not reported');
  assert.equal(unknown.container.querySelector('select[aria-label="Auto power-off"]'), null);

  const known = mount(fakeDevice({ status: 'connected', caps: buildCaps({ autoShutdown: 2 }) }).device);
  const select = known.container.querySelector('select[aria-label="Auto power-off"]');
  assert.ok(select, 'the control exists once the printer reports a value');
  assert.equal(select.value, '2');
});

test('a failed auto power-off write restores the printer value', async () => {
  const { device } = fakeDevice({ status: 'connected', caps: buildCaps({ autoShutdown: 2 }), rejectAutoOff: true });
  const { container, toasts } = mount(device);
  const select = container.querySelector('select[aria-label="Auto power-off"]');
  select.value = '4';
  select.dispatch('change');
  await tick();
  assert.equal(select.value, '2', 'the control never keeps a value the printer refused');
  assert.equal(toasts.at(-1)?.tone, 'error');
});

test('the Print job controls come from the schema with capability overrides', () => {
  setSetting('print.density', 5);
  try {
    const caps = buildCaps({ densityRange: { min: 2, max: 4 }, labelTypes: [1, 3] });
    const { container } = mount(fakeDevice({ status: 'connected', caps }).device);

    const density = container.querySelector('input[aria-label="Density"]');
    assert.equal(Number(density.min), 2);
    assert.equal(Number(density.max), 4);
    assert.equal(Number(density.value), 4, 'a stored value above the reported range is shown clamped');

    const tape = container.querySelector('select[aria-label="Tape type"]');
    const expectedTape = SETTINGS_SCHEMA.find((definition) => definition.key === 'print.labelType').options.filter(([id]) => ['1', '3'].includes(id));
    assert.deepEqual([...tape.querySelectorAll('option')].map((option) => [option.value, option.textContent]), expectedTape);

    const quality = container.querySelector('select[aria-label="Print quality"]');
    const schemaQuality = SETTINGS_SCHEMA.find((definition) => definition.key === 'print.speed').options;
    assert.deepEqual([...quality.querySelectorAll('option')].map((option) => [option.value, option.textContent]), schemaQuality);

    // The controls and their order are exactly the schema's Printing group,
    // followed by the document's copy count.
    const jobGroup = [...container.querySelectorAll('section')].find(
      (section) => section.querySelector('.group-title')?.textContent === 'Print job'
    );
    const labels = [...jobGroup.querySelectorAll('[aria-label]')].map((node) => node.getAttribute('aria-label'));
    const expected = settingsForSurface('print').filter((definition) => definition.group === 'Printing').map((definition) => definition.label);
    assert.deepEqual(labels, [...expected, 'Copies']);
    assert.equal(getSetting('print.density'), 5, 'showing a clamped value does not rewrite the setting');
  } finally {
    setSetting('print.density', 3);
  }
});

test('a running job disables device commands but not job settings', () => {
  const { device } = fakeDevice({ status: 'connected', printing: true });
  const { container } = mount(device);

  const disabled = [
    'Disconnect',
    'Choose printer',
    'Forget printer',
    'Refresh',
    'Feed / align paper',
    'Self-test page',
    'Sync clock',
    'Read paper info',
    'Read history',
    'Read capabilities',
    'Read device info',
    'Reset settings',
  ];
  for (const label of disabled) {
    assert.equal(buttonByText(container, label)?.disabled, true, `${label} is disabled during a job`);
  }
  assert.equal(container.querySelector('input[aria-label="Density"]').disabled, true);
  assert.equal(container.querySelector('select[aria-label="Tape type"]').disabled, true);
  assert.equal(container.querySelector('input[aria-label="Copies"]').disabled, false, 'a job setting is still editable');
  assert.equal(container.querySelector('select[aria-label="Print quality"]').disabled, false, 'job quality is still editable');
});

test('an unsupported capability stays visible offline', () => {
  const { container } = mount(fakeDevice({ status: 'idle', caps: buildCaps({ hasRtc: false, hasVolume: false }) }).device);
  assert.match(container.textContent, /Not supported by this printer/);
  assert.match(container.textContent, /Sound settings are not supported by this printer/);
  assert.equal(buttonByText(container, 'Sync clock'), undefined, 'a command that can only fail is never a button');
});

test('every control is present, labelled and wired', () => {
  const { container } = mount(fakeDevice({ status: 'idle', caps: buildCaps({ hasVolume: true, hasRtc: null }) }).device);

  const buttons = [...container.querySelectorAll('button')].map((node) => node.getAttribute('aria-label') ?? node.textContent.trim());
  assert.deepEqual(
    [...buttons].sort(),
    [
      'Connect printer',
      'Choose printer',
      'Forget printer',
      'Refresh',
      'Feed / align paper',
      'Self-test page',
      'Sync clock',
      'Bluetooth sound',
      'Power sound',
      'Read paper info',
      'Read history',
      'Read capabilities',
      'Read device info',
      'Reset settings',
      'Open log',
      'Export report',
    ].sort()
  );

  const interactive = [
    ...container.querySelectorAll('button'),
    ...container.querySelectorAll('select'),
    ...container.querySelectorAll('input'),
  ];
  for (const node of interactive) {
    const name = node.getAttribute('aria-label') ?? node.textContent.trim();
    assert.ok(node.listeners.size > 0, `${name} is not a dead control`);
  }
});

test('a rejected printer setting write is reported, not only logged', async () => {
  const { device, calls } = fakeDevice({ status: 'connected' });
  device.pushSetting = async (key) => {
    calls.push(['push', key]);
    throw new Error(`${key} refused`);
  };
  const { container, toasts } = mount(device);

  const density = container.querySelector('input[aria-label="Density"]');
  density.value = '4';
  density.dispatch('input');
  await tick();
  assert.equal(toasts.at(-1)?.tone, 'error');
  assert.match(toasts.at(-1)?.message, /print\.density refused/, 'the manager’s specific refusal is shown, not a generic retry claim');

  const tape = container.querySelector('select[aria-label="Tape type"]');
  tape.value = '3';
  tape.dispatch('change');
  await tick();
  assert.match(toasts.at(-1)?.message, /print\.labelType refused/);
  assert.ok(calls.some(([kind, key]) => kind === 'push' && key === 'print.labelType'), 'the change still reached the push path');

  setSetting('print.density', 3);
  setSetting('print.labelType', '1');
});

test('Choose printer and Forget printer are explicit actions', async () => {
  const { device, calls } = fakeDevice({ status: 'idle' });
  const { container, dialogs, toasts } = mount(device);

  buttonByText(container, 'Choose printer').dispatch('click');
  await tick();
  assert.ok(calls.some(([kind]) => kind === 'choose'), 'Choose printer opens the picker');

  buttonByText(container, 'Forget printer').dispatch('click');
  await tick();
  assert.equal(dialogs.at(-1)?.title, 'Forget the saved printer?');
  assert.match(dialogs.at(-1)?.message, /site settings/, 'the browser grant is described honestly');
  assert.ok(calls.some(([kind]) => kind === 'forget'));
  assert.equal(toasts.at(-1)?.message, 'Saved printer forgotten');
});

test('Reset states that the printer-side change cannot be undone', async () => {
  const { container, dialogs } = mount(fakeDevice({ status: 'connected' }).device);
  buttonByText(container, 'Reset settings').dispatch('click');
  await tick();
  assert.match(dialogs.at(-1)?.message, /cannot be undone on the printer/);
});

test('connect and refresh failures go through the error path', async () => {
  const idle = fakeDevice({ status: 'idle' });
  idle.device.connect = async () => {
    throw new Error('connect refused');
  };
  const first = mount(idle.device);
  buttonByText(first.container, 'Connect printer').dispatch('click');
  await tick();
  assert.equal(first.toasts.at(-1)?.message, 'connect refused');
  assert.equal(first.toasts.at(-1)?.tone, 'error');

  const live = fakeDevice({ status: 'connected' });
  live.device.refresh = async () => {
    throw new Error('refresh refused');
  };
  const second = mount(live.device);
  buttonByText(second.container, 'Refresh').dispatch('click');
  await tick();
  assert.equal(second.toasts.at(-1)?.message, 'refresh refused');
  assert.equal(second.toasts.at(-1)?.tone, 'error');
});

test('Read capabilities keeps the raw TLV, including colour and gray, in diagnostics', async () => {
  const { device } = fakeDevice({ status: 'connected' });
  device.diagnostic = async () => ({
    raw: { printColor: [], grayBuffer: [1], speedRange: [5, 1] },
    supportsColor: null,
    supportsGray: true,
    hasCutter: false,
    labelTypes: [1],
    densityRange: { min: 1, max: 5 },
    speedRange: { min: 1, max: 5 },
  });
  const { container } = mount(device);

  buttonByText(container, 'Read capabilities').dispatch('click');
  await tick();
  const dialog = dom.body.querySelector('[role="dialog"]');
  assert.ok(dialog, 'the diagnostic opened');
  assert.match(dialog.textContent, /Raw TLV values/);
  assert.match(dialog.textContent, /grayBuffer: 01/, 'the raw gray byte is inspectable');
  assert.match(dialog.textContent, /Colour reported: Not reported/);
  assert.match(dialog.textContent, /Speed range: 1–5/);

  const close = [...dialog.querySelectorAll('button')].find((node) => node.textContent.trim() === 'Close');
  close.dispatch('click');
});

test('a double click on Read device info joins one read and opens one modal', async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const { device, calls } = fakeDevice({ status: 'connected' });
  device.readInfoDiagnostics = async () => {
    calls.push(['read-info']);
    return gate;
  };
  const { container } = mount(device);
  const modalRoot = document.querySelector('#modalRoot');
  modalRoot.textContent = '';

  const button = buttonByText(container, 'Read device info');
  button.dispatch('click');
  button.dispatch('click');
  await tick();
  assert.equal(calls.filter(([name]) => name === 'read-info').length, 1, 'the manager joins the two reads');

  release([]);
  await tick();
  await tick();
  assert.equal(modalRoot.querySelectorAll('.modal-backdrop').length, 1, 'and only one modal opens');
});

/* ---------------- sound state honesty (R5F-3/R5F-4) ---------------- */

test('a sound read the printer does not answer stays unknown without an error', async () => {
  const { device } = fakeDevice({
    status: 'connected',
    caps: buildCaps({ hasVolume: true, source: { volume: 'reported' } }),
    sound: null,
  });
  clearLog();
  setLogLevel('debug');
  const entries = [];
  const off = subscribeLog((entry) => entries.push(entry));
  let mounted;
  try {
    mounted = mount(device);
    await tick();
  } finally {
    off();
    setLogLevel(CONFIG.log.level);
  }

  const switches = switchRows(mounted.container);
  const buttons = switches.map((row) => row.querySelector('button'));
  assert.deepEqual(switches.map((row) => row.getAttribute('data-state')), ['unknown', 'unknown']);
  assert.ok(buttons.every((button) => button.disabled), 'an unreported state is not editable');
  assert.deepEqual(buttons.map((button) => button.getAttribute('aria-checked')), [null, null], 'never announced as off');
  assert.match(mounted.container.textContent, /Sound state not reported/);
  assert.deepEqual(mounted.toasts, [], 'a completed read with no state is not a link failure');
  assert.deepEqual(entries.filter((entry) => entry.level === 'error'), [], 'and it is not an error in the log');
  assert.ok(
    entries.some((entry) => entry.level === 'debug' && /sound switch state not reported/.test(entry.message)),
    'the diagnostics log still records it'
  );
});

test('one unread switch does not disable the switch the printer did report', async () => {
  const { device } = fakeDevice({ status: 'connected', caps: buildCaps({ hasVolume: true, source: { volume: 'reported' } }) });
  device.soundSettings = async (item, value) => {
    if (value !== undefined) return value === 1;
    return item === 1 ? true : null;
  };
  const { container } = mount(device);
  await tick();

  const rows = switchRows(container);
  assert.equal(rows[0].getAttribute('data-state'), 'known');
  assert.equal(rows[0].querySelector('button').disabled, false, 'the reported switch stays editable');
  assert.equal(rows[0].querySelector('button').getAttribute('aria-checked'), 'true');
  assert.equal(rows[1].getAttribute('data-state'), 'unknown');
  assert.equal(rows[1].querySelector('button').disabled, true, 'the unread switch stays unknown');
  assert.equal(rows[1].querySelector('button').getAttribute('aria-checked'), null);
  assert.match(container.textContent, /Sound state not reported/);
});

test('an explicit Refresh retries a sound read the printer did not answer', async () => {
  let answer = null;
  const { device, calls } = fakeDevice({ status: 'connected', caps: buildCaps({ hasVolume: true, source: { volume: 'reported' } }) });
  device.soundSettings = async (item, value) => {
    if (value === undefined) {
      calls.push(['sound-read', item]);
      return answer;
    }
    calls.push(['sound-write', item, value]);
    return value === 1;
  };
  const { container } = mount(device);
  await tick();
  assert.equal(calls.filter(([kind]) => kind === 'sound-read').length, 2);
  assert.match(container.textContent, /Sound state not reported/);

  answer = true;
  buttonByText(container, 'Refresh').dispatch('click');
  await tick();
  await tick();
  assert.equal(calls.filter(([kind]) => kind === 'sound-read').length, 4, 'the explicit refresh read both switches again');
  assert.deepEqual(switchRows(container).map((row) => row.getAttribute('data-state')), ['known', 'known']);
  assert.doesNotMatch(container.textContent, /Sound state not reported/);
});

test('a sound write without a state reverts and says the printer did not confirm it', async () => {
  const { device } = fakeDevice({
    status: 'connected',
    caps: buildCaps({ hasVolume: true, source: { volume: 'reported' } }),
    sound: false,
    soundWrite: null,
  });
  clearLog();
  const entries = [];
  const off = subscribeLog((entry) => entries.push(entry));
  let mounted;
  try {
    mounted = mount(device);
    await tick();
    const button = switchRows(mounted.container)[0].querySelector('button');
    assert.equal(button.getAttribute('aria-checked'), 'false');
    button.dispatch('click');
    assert.equal(button.getAttribute('aria-checked'), 'true', 'the tap flips immediately');
    await tick();
    assert.equal(button.getAttribute('aria-checked'), 'false', 'an unconfirmed write restores the last confirmed value');
  } finally {
    off();
  }

  assert.equal(mounted.toasts.at(-1)?.message, 'The printer did not confirm the sound setting');
  assert.deepEqual(entries.filter((entry) => entry.level === 'error'), [], 'a completed exchange is not a link failure');
});

test('a sound write applies the state the printer replied with, not the tap', async () => {
  const { device } = fakeDevice({
    status: 'connected',
    caps: buildCaps({ hasVolume: true, source: { volume: 'reported' } }),
    sound: false,
    soundWrite: false,
  });
  const { container } = mount(device);
  await tick();

  const button = switchRows(container)[0].querySelector('button');
  button.dispatch('click');
  assert.equal(button.getAttribute('aria-checked'), 'true');
  await tick();
  assert.equal(button.getAttribute('aria-checked'), 'false', 'the printer said it is still off');
});

/* ---------------- one idle-link gate (R5F-5) ---------------- */

test('a device-info read disables every command that would use the link', () => {
  const { device } = fakeDevice({
    status: 'connected',
    caps: buildCaps({ hasVolume: true, autoShutdown: 2 }),
    readingInfo: true,
  });
  const { container } = mount(device);

  const disabled = [
    'Disconnect',
    'Choose printer',
    'Forget printer',
    'Refresh',
    'Feed / align paper',
    'Self-test page',
    'Sync clock',
    'Read paper info',
    'Read history',
    'Read capabilities',
    'Read device info',
    'Reset settings',
  ];
  for (const label of disabled) {
    assert.equal(buttonByText(container, label)?.disabled, true, `${label} waits for the info read`);
  }
  assert.equal(container.querySelector('input[aria-label="Density"]').disabled, true);
  assert.equal(container.querySelector('select[aria-label="Tape type"]').disabled, true);
  assert.equal(container.querySelector('select[aria-label="Auto power-off"]').disabled, true);
  for (const row of switchRows(container)) assert.equal(row.querySelector('button').disabled, true);
  assert.equal(container.querySelector('input[aria-label="Copies"]').disabled, false, 'a document field is not link-bound');
});

test('a device-info read that loses the link logs debug instead of toasting an error', async () => {
  const { device } = fakeDevice({ status: 'connected' });
  device.readInfoDiagnostics = async () => {
    device.state = { ...device.state, status: 'idle' };
    throw new Error('Printer is not connected');
  };
  clearLog();
  setLogLevel('debug');
  const entries = [];
  const off = subscribeLog((entry) => entries.push(entry));
  let mounted;
  try {
    mounted = mount(device);
    buttonByText(mounted.container, 'Read device info').dispatch('click');
    await tick();
    await tick();
  } finally {
    off();
    setLogLevel(CONFIG.log.level);
  }

  assert.deepEqual(mounted.toasts, [], 'a link that went away is not an error toast');
  assert.deepEqual(entries.filter((entry) => entry.level === 'error'), []);
  assert.ok(entries.some((entry) => entry.level === 'debug' && /device info read stopped: printer disconnected/.test(entry.message)));
});

/* ---------------- density intersection (R5F-7) ---------------- */

test('the density control offers only the intersection of printer and schema', () => {
  setSetting('print.density', 5);
  try {
    const caps = buildCaps({ densityRange: { min: 3, max: 9 } });
    const { container } = mount(fakeDevice({ status: 'connected', caps }).device);
    const density = container.querySelector('input[aria-label="Density"]');
    assert.equal(Number(density.min), 3, 'the printer raises the floor');
    assert.equal(Number(density.max), 5, "the schema caps the printer's upper bound");
    assert.equal(Number(density.value), 5);
    assert.doesNotMatch(container.textContent, /outside this app's/, 'a usable intersection needs no hint');
  } finally {
    setSetting('print.density', 3);
  }
});

test('an empty density intersection disables the control and states the wire value (O4)', () => {
  const caps = buildCaps({ densityRange: { min: 6, max: 8 }, hasVolume: false });
  const { container } = mount(fakeDevice({ status: 'connected', caps }).device);
  const density = container.querySelector('input[aria-label="Density"]');
  assert.equal(Number(density.min), 1, 'the schema range is the only renderable fallback');
  assert.equal(Number(density.max), 5);
  assert.equal(density.disabled, true, 'the operator cannot pick a value the job will not send');
  const wire = resolvePrintOptions({
    settings: { 'print.density': 3, 'print.labelType': '1', 'print.speed': 'normal' },
    capabilities: caps,
    copies: 1,
  });
  assert.equal(wire.density, 6, 'the job sends the printer floor');
  assert.match(
    container.textContent,
    /The printer accepts density 6–8, outside this app's 1–5; the density control is disabled and the next print sends 6\./
  );
});

/* ---------------- auto-off options (R5F-8) ---------------- */

test('an auto-off level reported after the panel was built is added before it is selected', () => {
  const { device } = fakeDevice({ status: 'connected', caps: buildCaps({ autoShutdown: 2, autoShutdownRange: { min: 1, max: 4 } }) });
  const { panel, container } = mount(device);
  const selectNode = container.querySelector('select[aria-label="Auto power-off"]');
  assert.equal(selectNode.value, '2');

  // A later discovery reports a level the first option list did not contain.
  device.state = { ...device.state, capabilities: { ...device.state.capabilities, autoShutdown: 5 } };
  panel.render();
  const values = [...selectNode.querySelectorAll('option')].map((option) => option.value);
  assert.ok(values.includes('5'), 'the option list follows the printer');
  assert.equal(selectNode.value, '5', 'and the reported level is actually selected');
});

test('a partial sound read failure keeps the reported switch usable and says so', async () => {
  const { device } = fakeDevice({ status: 'connected', caps: buildCaps({ hasVolume: true, source: { volume: 'reported' } }) });
  device.soundSettings = async (item, value) => {
    if (value !== undefined) return value === 1;
    if (item === 1) throw new Error('bluetooth sound read refused');
    return true;
  };
  const { container, toasts } = mount(device);
  await tick();

  const rows = switchRows(container);
  assert.equal(rows[0].getAttribute('data-state'), 'unknown', 'the failed switch stays unknown');
  assert.equal(rows[0].querySelector('button').disabled, true);
  assert.equal(rows[1].getAttribute('data-state'), 'known', 'the reported switch is still usable');
  assert.equal(rows[1].querySelector('button').disabled, false);
  assert.equal(rows[1].querySelector('button').getAttribute('aria-checked'), 'true');
  assert.match(container.textContent, /Some sound settings could not be read/, 'the hint does not overstate the failure');
  assert.equal(toasts.at(-1)?.tone, 'error');
  assert.match(toasts.at(-1)?.message, /Some sound settings could not be read/);
});

/* ---------------- the sound read owns the link (R2) ---------------- */

test('a pending sound read disables every command that would settle it', () => {
  const gate = new Promise(() => {});
  const { device } = fakeDevice({
    status: 'connected',
    caps: buildCaps({ hasVolume: true, autoShutdown: 2, source: { volume: 'reported' } }),
  });
  device.soundSettings = (item, value) => (value === undefined ? gate : Promise.resolve(true));
  const { container } = mount(device);

  for (const label of [
    'Disconnect',
    'Choose printer',
    'Forget printer',
    'Refresh',
    'Feed / align paper',
    'Self-test page',
    'Sync clock',
    'Read paper info',
    'Read history',
    'Read capabilities',
    'Read device info',
    'Reset settings',
  ]) {
    assert.equal(buttonByText(container, label)?.disabled, true, `${label} waits for the sound read`);
  }
  assert.equal(container.querySelector('input[aria-label="Density"]').disabled, true);
  assert.equal(container.querySelector('select[aria-label="Tape type"]').disabled, true);
  assert.equal(container.querySelector('select[aria-label="Auto power-off"]').disabled, true);
  for (const row of switchRows(container)) assert.equal(row.querySelector('button').disabled, true);
  assert.equal(container.querySelector('input[aria-label="Copies"]').disabled, false, 'the document stays editable');
});

test('a deliberate disconnect during a sound read is quiet', async () => {
  const rejecters = [];
  const { device } = fakeDevice({
    status: 'connected',
    caps: buildCaps({ hasVolume: true, source: { volume: 'reported' } }),
  });
  device.soundSettings = (item, value) => {
    if (value !== undefined) return Promise.resolve(true);
    return new Promise((_, reject) => rejecters.push(reject));
  };
  clearLog();
  setLogLevel('debug');
  const entries = [];
  const off = subscribeLog((entry) => entries.push(entry));
  let mounted;
  try {
    mounted = mount(device);
    assert.match(mounted.container.textContent, /Reading…/);
    // The operator asks for idle before the pending read answers.
    device.state = { ...device.state, status: 'idle' };
    for (const reject of rejecters) reject(new Error('Printer is not connected'));
    await tick();
    await tick();
  } finally {
    off();
    setLogLevel(CONFIG.log.level);
  }

  assert.deepEqual(mounted.toasts, [], 'the operator’s disconnect is not an error toast');
  assert.deepEqual(entries.filter((entry) => entry.level === 'error'), []);
  assert.ok(entries.some((entry) => entry.level === 'debug' && /sound state read stopped: printer disconnected/.test(entry.message)));
  assert.match(mounted.container.textContent, /Connect the printer to read the sound state/);
});

/* ---------------- model truth (A4) ---------------- */

test('the panel names the model, its support state and the behaviour task', () => {
  const caps = buildCaps({
    model: 'D110_M',
    modelSupport: 'confirmed',
    task: 'd110mv4',
    deviceType: 0x0910,
    protocolVersion: 301,
  });
  const { container } = mount(fakeDevice({ status: 'connected', caps }).device);
  assert.match(container.textContent, /D110_M — tested · 0x0910/);
  assert.match(container.textContent, /D110M V4 · build 301/);
  assert.doesNotMatch(container.textContent, /\bV5\b/);
});

test('an experimental model and an unsupported model read differently', () => {
  const experimental = mount(
    fakeDevice({
      status: 'connected',
      caps: buildCaps({ model: 'D11_H', modelSupport: 'experimental', task: 'd110mv4', deviceType: 0x0210 }),
    }).device
  );
  assert.match(experimental.container.textContent, /D11_H — experimental · 0x0210/);

  const unsupported = mount(
    fakeDevice({
      status: 'connected',
      caps: buildCaps({ model: 'B1', modelSupport: 'unsupported', task: 'd110mv4', deviceType: 0x1000 }),
    }).device
  );
  assert.match(unsupported.container.textContent, /B1 — not supported · 0x1000/);
});

/* ---------------- support gate (P1) ---------------- */

test('an unsupported or unknown model disables every mutating control with the reason', async () => {
  const cases = [
    {
      label: 'B1',
      caps: buildCaps({ model: 'B1', modelSupport: 'unsupported', task: 'd110mv4', deviceType: 0x1000, autoShutdown: 2 }),
      reason: /B1 is not supported[\s\S]*no frame was sent/,
    },
    {
      label: 'unknown',
      caps: buildCaps({ model: 'Unknown', modelSupport: 'unknown', task: null, deviceType: 0x1234, autoShutdown: 2 }),
      reason: /did not report a model[\s\S]*no frame was sent/i,
    },
  ];
  for (const { label, caps, reason } of cases) {
    const { device } = fakeDevice({ status: 'connected', caps });
    const { container } = mount(device);
    await tick();

    const commands = ['Feed / align paper', 'Self-test page', 'Sync clock', 'Reset settings'];
    for (const name of commands) {
      const button = buttonByText(container, name);
      assert.equal(button?.disabled, true, `${label}: ${name} is disabled`);
      assert.match(button?.title ?? '', reason, `${label}: ${name} carries the gate reason`);
    }
    for (const selector of ['input[aria-label="Density"]', 'select[aria-label="Tape type"]', 'select[aria-label="Auto power-off"]']) {
      const control = container.querySelector(selector);
      assert.equal(control?.disabled, true, `${label}: ${selector} is a printer write and is disabled`);
      assert.match(control?.title ?? '', reason, `${label}: ${selector} carries the gate reason`);
    }
    for (const row of switchRows(container)) {
      assert.equal(row.querySelector('button').disabled, true, `${label}: sound writes are disabled`);
      assert.match(row.querySelector('button').title ?? '', reason, `${label}: sound write carries the gate reason`);
    }
    // Reads are not mutating commands and stay available for diagnosis.
    for (const name of ['Read paper info', 'Read history', 'Read capabilities', 'Read device info']) {
      assert.equal(buttonByText(container, name)?.disabled, false, `${label}: ${name} stays a read`);
    }
  }
});

test('a sensor refusal disables paper commands but not configuration writes', async () => {
  const caps = buildCaps({
    model: 'D110_M',
    modelSupport: 'confirmed',
    task: 'd110mv4',
    deviceType: 0x0910,
    autoShutdown: 2,
    sensors: { lidClosed: false, paperPresent: true },
  });
  const { device } = fakeDevice({ status: 'connected', caps });
  const { container } = mount(device);
  await tick();

  for (const name of ['Feed / align paper', 'Self-test page']) {
    const button = buttonByText(container, name);
    assert.equal(button?.disabled, true, `${name} moves paper and is refused`);
    assert.match(button?.title ?? '', /lid[\s\S]*nothing was printed/i);
  }
  // Resetting settings or syncing the clock does not move paper.
  assert.equal(buttonByText(container, 'Reset settings')?.disabled, false);
  assert.equal(buttonByText(container, 'Sync clock')?.disabled, false);
  assert.equal(container.querySelector('select[aria-label="Auto power-off"]')?.disabled, false);
});

test('an unknown model is named Unknown model and exposes no print task', () => {
  const { device } = fakeDevice({
    status: 'connected',
    caps: buildCaps({ model: 'Unknown', modelSupport: 'unknown', task: null, deviceType: 0x1234 }),
  });
  const { container } = mount(device);
  const rows = rowsOf(container);
  assert.equal(rows.get('Model'), 'Unknown model · 0x1234');
  assert.doesNotMatch(container.textContent, /Unknown — unknown/);
  assert.equal(rows.get('Protocol'), 'Print task not available for this model');
  assert.doesNotMatch(container.textContent, /D110M V4/);
});

test('an unsupported known model exposes no print task', () => {
  const { device } = fakeDevice({
    status: 'connected',
    caps: buildCaps({ model: 'B1', modelSupport: 'unsupported', task: 'd110mv4', deviceType: 0x1000, protocolVersion: 145 }),
  });
  const { container } = mount(device);
  const rows = rowsOf(container);
  assert.equal(rows.get('Model'), 'B1 — not supported · 0x1000');
  assert.equal(rows.get('Protocol'), 'Print task not available for this model');
  assert.doesNotMatch(container.textContent, /D110M V4/);
});

test('an experimental model still names the print task it may run', () => {
  const { device } = fakeDevice({
    status: 'connected',
    caps: buildCaps({ model: 'D11_H', modelSupport: 'experimental', task: 'd110mv4', deviceType: 0x0210, protocolVersion: 301 }),
  });
  const { container } = mount(device);
  assert.equal(rowsOf(container).get('Protocol'), 'D110M V4 · build 301');
});

test('the self-test uses the experimental confirmation on D11_H', async () => {
  const { device, calls } = fakeDevice({
    status: 'connected',
    caps: buildCaps({ model: 'D11_H', modelSupport: 'experimental', task: 'd110mv4', deviceType: 0x0210 }),
  });
  const { container, dialogs } = mount(device);
  await tick();

  buttonByText(container, 'Self-test page').dispatch('click');
  await tick();
  assert.ok(calls.some(([kind]) => kind === 'test-page'), 'the self-test runs after confirmation');
  assert.equal(dialogs.length, 1);
  assert.match(dialogs[0].title, /experimental/i);
  assert.match(dialogs[0].message, /D11_H/);
  assert.match(dialogs[0].message, /This model is experimental/);
});
