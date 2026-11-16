import test from 'node:test';
import assert from 'node:assert/strict';

import { createPrintFlow, printButtonState } from '../src/ui/print-flow.js';
import { PrinterError } from '../src/protocol/errors.js';
import { resetGeometry, setGeometry } from '../src/core/geometry.js';
import { createEmitter } from '../src/core/events.js';
import { clearLog, subscribeLog } from '../src/core/log.js';
import { renderDocument } from '../src/label/render.js';
import { ELEMENT_TYPES, createDocument, createElement, validateDocument } from '../src/label/schema.js';
import { createEditor } from '../src/editor/controller.js';
import { installDom } from './helpers/fake-dom.mjs';

// The real renderer needs a canvas; the confirmation wiring below runs it.
installDom();

const tick = () => new Promise((resolve) => setImmediate(resolve));

function harness({
  warnings = [],
  print = null,
  confirm = null,
  hydrate = null,
  cancelResult = true,
  start = true,
  capabilities = null,
} = {}) {
  const calls = { print: 0, cancel: 0, confirm: 0, confirmation: null, toasts: [], statuses: [], printing: [], finishing: [], warnings: [], dismissals: 0 };
  const events = createEmitter();
  const device = {
    events,
    connected: true,
    state: { capabilities },
    async print(raster, options = {}) {
      calls.print++;
      // The manager calls onStart immediately before PrintStart; `start: false`
      // simulates a job the gate refused before any paper moved.
      if (start) options.onStart?.();
      return print ? print(options) : { copies: 1 };
    },
    async cancel() {
      calls.cancel++;
      return cancelResult;
    },
  };
  const document = { elements: [{ id: 'text_1', type: 'text' }], copies: 1, lengthMm: 40 };
  const flow = createPrintFlow({
    device,
    getDocument: () => document,
    getSettings: () => ({}),
    notify: (message) => calls.toasts.push(message),
    confirm: async (title, message, options) => {
      calls.confirm++;
      calls.confirmation = { title, message, options };
      return confirm ? confirm(title, message, options) : true;
    },
    hydrate: async () => {
      if (hydrate) await hydrate();
    },
    render: () => ({ canvas: {}, warnings }),
    rasterize: () => ({ width: 96, height: 320, rows: [] }),
    setStatus: (text) => calls.statuses.push(text),
    setProgress: () => {},
    onWarnings: (list) => calls.warnings.push(list),
    dismissNotices: () => {
      calls.dismissals++;
    },
    onPrintingChange: (value) => calls.printing.push(value),
    onFinishingChange: (value) => calls.finishing.push(value),
  });
  return { flow, device, document, calls, events };
}

test('a second trigger while the job is preparing never starts a parallel print', async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const { flow, calls } = harness({ hydrate: () => gate });

  const first = flow.run();
  await tick();
  assert.equal(flow.printing, false, 'the job has not been sent yet');
  assert.equal(flow.busy, true, 'the flow owns the print path');

  // This is the double-click / Ctrl+Enter case: the failure of a second flow
  // used to clear the flag of the job that was still preparing.
  const second = flow.run();
  await tick();
  assert.equal(calls.print, 0, 'the second trigger did not reach the printer');
  assert.equal(calls.cancel, 0, 'and it did not cancel anything');

  release();
  await Promise.all([first, second]);
  assert.equal(calls.print, 1, 'the first job printed exactly once');
  assert.deepEqual(calls.printing, [true, false], 'the primary button flips exactly once');
});

test('a second trigger while the warnings dialog is open is ignored', async () => {
  let answer;
  const dialog = new Promise((resolve) => {
    answer = resolve;
  });
  const { flow, calls } = harness({ warnings: ['Text overflows'], confirm: () => dialog });

  const first = flow.run();
  await tick();
  assert.equal(calls.confirm, 1);
  const second = flow.run();
  await tick();
  assert.equal(calls.confirm, 1, 'the dialog is not opened twice');
  assert.equal(calls.print, 0, 'nothing is printed until the dialog answers');

  answer(true);
  await Promise.all([first, second]);
  assert.equal(calls.print, 1, 'only the first flow printed');
});

test('the guard clears after a failure, so a later print still runs', async (t) => {
  t.mock.method(console, 'warn', () => {});
  let attempts = 0;
  const { flow, calls } = harness({
    print: () => {
      attempts++;
      if (attempts === 1) throw new Error('Printer jam');
      return { copies: 1 };
    },
  });

  await flow.run();
  assert.deepEqual(calls.toasts, ['Printer jam'], 'the failure is reported once');
  assert.equal(flow.busy, false);
  assert.equal(flow.printing, false);

  await flow.run();
  assert.equal(calls.print, 2, 'the next job is not blocked by the failed one');
  assert.deepEqual(calls.printing, [true, false, true, false]);
});
test('a layout warning from the real renderer reaches the print confirmation', async () => {
  const document = validateDocument({
    lengthMm: 40,
    elements: [
      createElement(ELEMENT_TYPES.TEXT, { name: 'Front', text: 'Hi', x: 4, y: 4, w: 200, h: 60 }),
      createElement(ELEMENT_TYPES.TEXT, { name: 'Back', text: 'Hi', x: 150, y: 40, w: 200, h: 60 }),
    ],
  });
  const calls = { confirm: [], print: 0 };
  const flow = createPrintFlow({
    device: {
      connected: true,
      async print() {
        calls.print++;
        return { copies: 1 };
      },
      async cancel() {},
    },
    getDocument: () => document,
    getSettings: () => ({}),
    notify: () => {},
    confirm: async (title, message) => {
      calls.confirm.push({ title, message });
      return true;
    },
    hydrate: async () => {},
    render: renderDocument,
    rasterize: () => ({ width: 96, height: 320, rows: [] }),
    setStatus: () => {},
    setProgress: () => {},
    onWarnings: () => {},
    onPrintingChange: () => {},
  });

  await flow.run();
  assert.equal(calls.confirm.length, 1, 'the overlap asks before printing');
  assert.equal(calls.confirm[0].title, 'Print with warnings?');
  assert.match(calls.confirm[0].message, /Text "Front" and Text "Back" overlap/);
  assert.equal(calls.print, 1, 'the operator can still print over the warning');
});

test('the primary button cancels instead of starting a second job while printing', async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const { flow, calls } = harness({ print: () => gate.then(() => ({ copies: 1 })) });

  const job = flow.run();
  await tick();
  assert.equal(flow.printing, true);

  await flow.run();
  assert.equal(calls.cancel, 1);
  assert.equal(calls.print, 1);

  release();
  await job;
});

test('after the printer settles, the flow reports Finishing… and cancelling is a no-op', async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const { flow, device, calls } = harness({
    print: async () => {
      // The manager emits `finishing` once the outcome is settled and only its
      // post-print device refresh is left.
      device.events.emit('finishing', { started: true });
      await gate;
      return { copies: 1 };
    },
    cancelResult: false,
  });

  const job = flow.run();
  await tick();
  assert.equal(flow.printing, true);
  assert.equal(flow.finishing, true, 'the flow knows the outcome is settled');
  assert.ok(calls.statuses.includes('Finishing…'), 'the status line says what is happening');

  await flow.run();
  assert.equal(calls.cancel, 1, 'the primary button still routes to cancel');
  assert.equal(calls.print, 1, 'but it never starts a second job');
  assert.deepEqual(calls.toasts, [], 'nothing left to cancel is not an error');

  release();
  await job;
  assert.equal(flow.finishing, false, 'the next job starts from a clean state');
  assert.deepEqual(calls.finishing, [true, false]);
});

test('a failed job also reports Finishing… instead of offering a dead Cancel', async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const { flow, device, calls } = harness({
    print: async () => {
      // The manager publishes `finishing` for a failed job too: only the device
      // refresh is left, so the primary button must not still offer Cancel.
      device.events.emit('finishing', { started: true });
      await gate;
      throw new Error('Printer jam');
    },
    cancelResult: false,
  });

  const job = flow.run();
  await tick();
  assert.equal(flow.finishing, true, 'the failure is settled and only the refresh remains');
  assert.equal(flow.printing, true);

  await flow.run();
  assert.equal(calls.cancel, 1, 'the button still routes through cancel');
  assert.deepEqual(calls.toasts, [], 'a cancelled no-op is not reported as a failure');

  release();
  await job;
  assert.equal(flow.finishing, false, 'the next job starts clean');
  assert.deepEqual(calls.toasts, ['Printer jam']);
});

test('an offline printer or an empty label is refused without a job', async () => {
  const { flow, device, calls } = harness();
  device.connected = false;
  await flow.run();
  assert.equal(calls.print, 0);
  assert.deepEqual(calls.toasts, ['Connect the printer before printing']);

  device.connected = true;
  await flow.run({ elements: [], copies: 1, lengthMm: 40 });
  assert.equal(calls.print, 0);
  assert.deepEqual(calls.toasts, ['Connect the printer before printing', 'Add an element before printing']);
});

test('a failed cancel is reported and never rejects the flow', async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const { flow, device, calls } = harness({ print: () => gate.then(() => ({ copies: 1 })) });
  device.cancel = async () => {
    throw new Error('Cancel frame rejected');
  };

  const job = flow.run();
  await tick();
  assert.equal(flow.printing, true);

  await assert.doesNotReject(flow.run());
  assert.deepEqual(calls.toasts, ['Could not cancel the print: Cancel frame rejected']);

  release();
  await job;
  assert.equal(flow.printing, false, 'the running job still settles on its own');
});

test('a failed print is logged at error, not warn', async (t) => {
  t.mock.method(console, 'warn', () => {});
  t.mock.method(console, 'error', () => {});
  clearLog();
  const entries = [];
  const off = subscribeLog((entry) => entries.push(entry));
  try {
    const { flow, calls } = harness({
      print: () => {
        throw new Error('Printer jam');
      },
    });
    await flow.run();
    assert.deepEqual(calls.toasts, ['Printer jam']);
  } finally {
    off();
  }
  const failure = entries.find((entry) => entry.message === 'print failed');
  assert.ok(failure, 'the failure reached the diagnostics log');
  assert.equal(failure.level, 'error');
  assert.equal(entries.filter((entry) => entry.level === 'warn').length, 0);
});

/* ---------------- warnings ownership and notices (R2-2/R2-9) ---------------- */

test('a test print never overwrites the current label’s stage warning', async () => {
  const { flow, calls } = harness({ warnings: ['Test document warning'] });
  await flow.run({ elements: [{ id: 'test_1', type: 'text', visible: true }], copies: 1, lengthMm: 40 });
  assert.deepEqual(calls.warnings, [], 'the shared hint keeps the current label');
  await flow.run();
  assert.deepEqual(calls.warnings, [['Test document warning']], 'the current label still updates it');
});

test('“Print anyway” dismisses the notices; a cancelled dialog keeps them', async () => {
  const kept = harness({ warnings: ['A legacy element was dropped.'], confirm: () => false });
  await kept.flow.run();
  assert.equal(kept.calls.dismissals, 0, 'a cancelled dialog leaves the notice for the next trigger');

  const dismissed = harness({ warnings: ['A legacy element was dropped.'], confirm: () => true });
  await dismissed.flow.run();
  assert.equal(dismissed.calls.dismissals, 1);
});

test('an all-hidden label is refused before any paper moves', async () => {
  const { flow, calls } = harness();
  await flow.run({ elements: [{ id: 'text_1', type: 'text', visible: false }], copies: 1, lengthMm: 40 });
  assert.equal(calls.print, 0);
  assert.deepEqual(calls.toasts, ['Show at least one element before printing']);
});

/* ---------------- job start honesty (R5F-9) ---------------- */

test('a job refused before its first frame keeps Preparing… and never offers Cancel', async () => {
  let callsDuringPrint = [];
  const { flow, calls } = harness({
    start: false,
    print: () => {
      callsDuringPrint = [...calls.printing];
      throw new Error('Cover open');
    },
  });
  await flow.run();
  assert.deepEqual(callsDuringPrint, [], 'the primary button never flipped to Cancel');
  assert.deepEqual(calls.printing, [], 'no printing change for a job that never started');
  assert.deepEqual(calls.finishing, [], 'and no Finishing either');
  assert.deepEqual(calls.statuses, ['Preparing…', ''], 'the error toast replaces the Preparing line');
  assert.deepEqual(calls.toasts, ['Cover open']);
});

test('Printing and Cancel belong to the job’s own start callback', async () => {
  let seenPrinting = [];
  const recorded = harness({
    print: () => {
      seenPrinting = [...recorded.calls.printing];
      return { copies: 1 };
    },
  });
  await recorded.flow.run();
  // The harness calls onStart before the body, exactly like the manager.
  assert.deepEqual(seenPrinting, [true], 'the UI is in Printing state before the job body runs');
  assert.deepEqual(recorded.calls.statuses, ['Preparing…', 'Printing…', 'Printed 1 label']);
});

/* ---------------- print-boundary geometry (R5B-3) ---------------- */

function limitHarness(initial) {
  const calls = { revalidate: 0, render: [], print: [] };
  let current = initial;
  const flow = createPrintFlow({
    device: {
      connected: true,
      async print(raster, options) {
        calls.print.push(options);
        options.onStart?.();
        return { copies: 1 };
      },
      async cancel() {},
    },
    getDocument: () => current,
    getSettings: () => ({}),
    notify: (message) => calls.print.push({ toast: message }),
    confirm: async () => true,
    hydrate: async () => {},
    render: (document) => {
      calls.render.push(document);
      return { canvas: {}, warnings: [] };
    },
    rasterize: () => ({ width: 96, height: 320, rows: [] }),
    setStatus: () => {},
    setProgress: () => {},
    revalidate: () => {
      calls.revalidate++;
      current = { ...current, elements: current.elements.map((element) => ({ ...element, x: 4 })) };
      return true;
    },
  });
  return { flow, calls, setDocument: (next) => (current = next) };
}

test('a document beyond the live printer is revalidated before it is rendered', async () => {
  const { flow, calls } = limitHarness({
    elements: [{ id: 'text_1', type: 'text', visible: true, x: 400, y: 4, w: 40, h: 20 }],
    copies: 1,
    lengthMm: 40,
  });
  await flow.run();
  assert.equal(calls.revalidate, 1, 'the flow asked for the live limits');
  assert.equal(calls.render[0].elements[0].x, 4, 'the revalidated document is what gets rendered and printed');
  assert.equal(calls.print.length, 1);
});

test('a document inside the printer limits is not revalidated', async () => {
  const { flow, calls } = limitHarness({
    elements: [{ id: 'text_1', type: 'text', visible: true, x: 4, y: 4, w: 40, h: 20 }],
    copies: 1,
    lengthMm: 40,
  });
  await flow.run();
  assert.equal(calls.revalidate, 0);
  assert.equal(calls.render.length, 1);
});

/* ---------------- the print button matrix (R5G-4) ---------------- */

test('one pure function owns the Print and Test button state', () => {
  const base = { printing: false, finishing: false, empty: false, offline: false, reading: false };
  assert.deepEqual(printButtonState(base), { disabled: false, title: '', testDisabled: false, testTitle: '', supportBlocked: '' });
  assert.deepEqual(printButtonState({ ...base, offline: true }), {
    disabled: true,
    title: 'Connect the printer to print',
    testDisabled: true,
    testTitle: 'Connect the printer first',
    supportBlocked: '',
  });
  assert.deepEqual(printButtonState({ ...base, empty: true }), {
    disabled: true,
    title: 'Show at least one element before printing',
    testDisabled: false,
    testTitle: '',
    supportBlocked: '',
  });
  assert.deepEqual(printButtonState({ ...base, reading: true }), {
    disabled: true,
    title: 'Wait for the device info read to finish',
    testDisabled: true,
    testTitle: 'Wait for the device info read to finish',
    supportBlocked: '',
  });
  assert.deepEqual(printButtonState({ ...base, oversized: true }), {
    disabled: false,
    title: 'The label is larger than the printer; it will be shortened to fit',
    testDisabled: false,
    testTitle: '',
    supportBlocked: '',
  });
  // A running job is the cancel control, whatever the document looks like.
  assert.deepEqual(printButtonState({ ...base, printing: true, empty: true, offline: true }), {
    disabled: false,
    title: 'Cancel the running print',
    testDisabled: true,
    testTitle: '',
    supportBlocked: '',
  });
  // Once the outcome is settled, even Cancel is gone.
  assert.deepEqual(printButtonState({ ...base, printing: true, finishing: true }), {
    disabled: true,
    title: 'The printer is finishing; nothing can be cancelled',
    testDisabled: true,
    testTitle: '',
    supportBlocked: '',
  });
});

test('the support gate disables both buttons only for model and geometry refusals', () => {
  const base = { printing: false, finishing: false, empty: false, offline: false, reading: false };
  const reason = 'B1 is not supported. This app prints 12 mm labels on the NIIMBOT D110 family; no frame was sent.';
  for (const kind of ['model', 'geometry']) {
    const state = printButtonState({ ...base, gate: { allowed: false, reason, kind } });
    assert.deepEqual(state, { disabled: true, title: reason, testDisabled: true, testTitle: reason, supportBlocked: reason });
  }
  // A sensor refusal is a press-time message: the controls stay available.
  const sensor = printButtonState({ ...base, gate: { allowed: false, reason: 'Close the printer lid before printing; nothing was printed.', kind: 'sensor' } });
  assert.deepEqual(sensor, { disabled: false, title: '', testDisabled: false, testTitle: '', supportBlocked: '' });
  // An allowed gate never adds a support claim.
  assert.equal(printButtonState({ ...base, gate: { allowed: true, reason: null, kind: null } }).supportBlocked, '');
});

/* ---------------- a cancelled print (R5G-7) ---------------- */

test('a user-cancelled print reports Print cancelled with no error toast', async () => {
  const { flow, calls } = harness({
    print: () => {
      throw new PrinterError('Print cancelled', { cancelled: true });
    },
  });
  await flow.run();
  assert.deepEqual(calls.statuses, ['Preparing…', 'Printing…', 'Print cancelled']);
  assert.deepEqual(calls.toasts, [], 'a user cancel is a normal outcome');
  assert.deepEqual(calls.printing, [true, false], 'the Cancel button returns to Print');
});

/* ---------------- the display document reaches the flow (R1) ---------------- */

test('a dismissed notice never reaches the print confirmation again', async () => {
  const notice = 'One legacy element was dropped because it was not a valid element.';
  const editor = createEditor({ document: createDocument({ lengthMm: 40, notices: [notice] }) });
  editor.dismissNotices();
  editor.updateElement(editor.selection, { text: 'Changed' });
  assert.ok(editor.undo());
  assert.ok(editor.document.notices?.includes(notice), 'the history snapshot still carries the answered notice');

  const confirmations = [];
  let printed = null;
  const flow = createPrintFlow({
    device: {
      connected: true,
      async print() {
        printed = flowDocument();
        return { copies: 1 };
      },
      async cancel() {},
    },
    getDocument: () => editor.documentForDisplay(),
    getSettings: () => ({}),
    notify: () => {},
    confirm: async (title, message) => {
      confirmations.push({ title, message });
      return true;
    },
    hydrate: async () => {},
    render: renderDocument,
    rasterize: () => ({ width: 96, height: 320, rows: [] }),
    setStatus: () => {},
    setProgress: () => {},
  });
  const flowDocument = () => editor.documentForDisplay();

  await flow.run();
  assert.deepEqual(confirmations, [], 'an answered notice must not be asked about again');
  assert.ok(printed, 'the label still printed');
  assert.equal(printed.notices, undefined, 'the printed document is the display document');
});

/* ---------------- a test print is not the live label (O2) ---------------- */

test('an over-long test document is clamped, never replaced by the live label', async () => {
  // Authored while the default 200 mm tape was assumed.
  const testDocument = createDocument({ lengthMm: 200, elements: [{ type: 'text', text: 'TEST' }] });
  const current = createDocument({ lengthMm: 30, elements: [{ type: 'text', text: 'CURRENT' }] });
  setGeometry({ discovered: true, headWidthPx: 96, dpi: 203, maxLengthMm: 30 });
  try {
    for (const revalidates of [false, true]) {
      const rendered = [];
      let revalidateCalls = 0;
      let live = current;
      const flow = createPrintFlow({
        device: {
          connected: true,
          async print() {
            return { copies: 1 };
          },
          async cancel() {},
        },
        getDocument: () => live,
        getSettings: () => ({}),
        notify: () => {},
        confirm: async () => true,
        hydrate: async () => {},
        render: (document) => {
          rendered.push(document);
          return { canvas: {}, warnings: [] };
        },
        rasterize: () => ({ width: 96, height: 320, rows: [] }),
        setStatus: () => {},
        setProgress: () => {},
        revalidate: () => {
          revalidateCalls++;
          // The dirty-current branch the verifier reproduced: the old code
          // substituted the live label after this returned true.
          live = createDocument({ lengthMm: 30, elements: [{ type: 'text', text: 'CURRENT' }] });
          return revalidates;
        },
      });

      await flow.run(testDocument);
      assert.equal(revalidateCalls, 0, `revalidate ${revalidates}: a test document never revalidates the live label`);
      assert.equal(rendered.length, 1);
      assert.equal(rendered[0].lengthMm, 30, 'the schema clamped the test page to the live tape');
      assert.equal(rendered[0].elements[0].text, 'TEST', 'the test document is what prints');
      assert.equal(live.elements[0].text, 'CURRENT', 'the live label is untouched');
    }
  } finally {
    resetGeometry();
  }
});

/* ---------------- experimental models (A4) ---------------- */

test('an experimental model is allowed but the confirmation says so first', async () => {
  const { flow, calls } = harness({
    capabilities: { model: 'D11_H', modelSupport: 'experimental', task: 'd110mv4' },
  });
  await flow.run();
  assert.equal(calls.print, 1, 'experimental is allowed, not blocked');
  assert.equal(calls.confirm, 1, 'it is never silent');
  assert.equal(calls.confirmation.title, 'Print on an experimental model?');
  assert.match(calls.confirmation.message, /D11_H/);
  assert.ok(calls.confirmation.message.includes('This model is experimental'));
});

test('a confirmed model prints without an extra confirmation', async () => {
  const { flow, calls } = harness({
    capabilities: { model: 'D110_M', modelSupport: 'confirmed', task: 'd110mv4' },
  });
  await flow.run();
  assert.equal(calls.print, 1);
  assert.equal(calls.confirm, 0, 'the reference model needs no support prompt');
});

test('warnings carry the experimental sentence when both apply', async () => {
  const { flow, calls } = harness({
    warnings: ['The label is wider than the head.'],
    capabilities: { model: 'D11_H', modelSupport: 'experimental' },
  });
  await flow.run();
  assert.equal(calls.confirm, 1);
  assert.equal(calls.confirmation.title, 'Print with warnings?');
  assert.match(calls.confirmation.message, /D11_H/);
  assert.match(calls.confirmation.message, /wider than the head/);
});
