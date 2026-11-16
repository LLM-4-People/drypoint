/**
 * The one print flow: prepare the label, confirm warnings, run the job and
 * report progress.
 *
 * It owns the single in-flight guard. A second trigger (a double click, or
 * Ctrl+Enter while the warnings dialog is open) must not start a parallel flow:
 * that flow's failure would clear the first job's state while it is still
 * running.
 */

import { CONFIG } from '../core/config.js';
import { createLogger } from '../core/log.js';
import { hydrateImages } from '../label/images.js';
import { canvasToRaster } from '../label/raster.js';
import { renderDocument, summariseWarnings } from '../label/render.js';
import { exceedsPrinterLimits, validateDocument } from '../label/schema.js';
import { resolveRenderOptions } from '../device/print-options.js';
import { confirmDialog } from './modal.js';
import { toast } from './toast.js';

const log = createLogger('ui.print-flow');

/**
 * The primary Print/Test button state.
 *
 * One owner for the copy and the enablement: a running job, a finishing
 * refresh, an empty label, an offline printer and a device-info read cannot
 * disagree between the two buttons. `oversized` only changes the title the
 * operator sees; the flow revalidates the label before it renders, so a print
 * that will be shortened is still allowed. `gate` is the one support gate's
 * answer: a model/geometry refusal blocks both buttons with its reason, while
 * a sensor refusal leaves them available so the press reports that reason.
 *
 * @param {{printing?:boolean, finishing?:boolean, empty?:boolean, offline?:boolean,
 *          reading?:boolean, oversized?:boolean, gate?:{allowed:boolean,reason:string|null,kind:string|null}|null}} state
 */
export function printButtonState({ printing = false, finishing = false, empty = false, offline = false, reading = false, oversized = false, gate = null } = {}) {
  if (finishing) {
    // The outcome is settled; only the device refresh is left. Nothing on the
    // wire can be cancelled, so the control must not offer Cancel.
    return {
      disabled: true,
      title: 'The printer is finishing; nothing can be cancelled',
      testDisabled: true,
      testTitle: '',
      supportBlocked: '',
    };
  }
  if (printing) {
    return {
      disabled: false,
      title: 'Cancel the running print',
      testDisabled: true,
      testTitle: '',
      supportBlocked: '',
    };
  }
  // Offline is the app's normal start state, not a model refusal: the operator
  // has to connect first, so that is the one answer the buttons quote.
  if (offline) {
    return {
      disabled: true,
      title: 'Connect the printer to print',
      testDisabled: true,
      testTitle: 'Connect the printer first',
      supportBlocked: '',
    };
  }
  // A sensor refusal is a paper prerequisite, not a model/geometry refusal:
  // the buttons stay enabled so the press can show the sensor reason.
  const blocked = gate && !gate.allowed && gate.kind !== 'sensor' ? String(gate.reason ?? '') : '';
  const title = blocked
    ? blocked
    : empty
      ? 'Show at least one element before printing'
      : reading
        ? 'Wait for the device info read to finish'
        : oversized
          ? 'The label is larger than the printer; it will be shortened to fit'
          : '';
  return {
    disabled: Boolean(blocked) || empty || reading,
    title,
    testDisabled: Boolean(blocked) || reading,
    testTitle: blocked || (reading ? 'Wait for the device info read to finish' : ''),
    supportBlocked: blocked,
  };
}

/**
 * @param {object} options
 * @param {object} options.device device manager (connected / print / cancel)
 * @param {() => object} options.getDocument current document
 * @param {() => object} options.getSettings settings snapshot for render options
 * @param {Function} [options.notify] error channel (toast)
 * @param {Function} [options.confirm] confirmation dialog
 * @param {Function} [options.hydrate] image hydration
 * @param {Function} [options.render] document renderer
 * @param {Function} [options.rasterize] canvas → 1-bit rows
 * @param {Function} [options.setStatus] job-state channel (#status)
 * @param {Function} [options.setProgress] progress bar writer
 * @param {Function} [options.onWarnings] stage-hint writer
 * @param {Function} [options.dismissNotices] clears the current label's notices
 * @param {Function} [options.revalidate] re-applies live device geometry limits
 * @param {Function} [options.onPrintingChange] primary-button state writer
 * @param {Function} [options.onFinishingChange] "Finishing…" state writer
 */
export function createPrintFlow({
  device,
  getDocument,
  getSettings,
  notify = toast,
  confirm = confirmDialog,
  hydrate = hydrateImages,
  render = renderDocument,
  rasterize = canvasToRaster,
  setStatus = () => {},
  setProgress = () => {},
  onWarnings = () => {},
  dismissNotices = () => {},
  revalidate = () => false,
  onPrintingChange = () => {},
  onFinishingChange = () => {},
}) {
  /** True once the job has been sent; the primary button becomes Cancel. */
  let printing = false;
  /** True once the job outcome is settled and its refresh is still running. */
  let finishing = false;
  /** True from the first trigger until the flow settles, dialog included. */
  let busy = false;

  function setPrinting(value) {
    if (printing === value) return;
    printing = value;
    onPrintingChange(value);
  }

  function setFinishing(value) {
    if (finishing === value) return;
    finishing = value;
    onFinishingChange(value);
  }

  // The job's outcome is settled; only the post-print device refresh is left.
  // Every terminal outcome (printed, failed, cancelled) publishes this, so the
  // primary button stops offering a Cancel that has nothing left to abort.
  // `started` is false when the job was refused before paper moved: the flow
  // keeps "Preparing…" and only the error remains.
  device.events?.on?.('finishing', (info) => {
    if (!printing || !info?.started) return;
    setFinishing(true);
    setStatus('Finishing…');
  });

  async function run(document = getDocument()) {
    // While a job is running the same button is its cancel control.
    if (printing) {
      try {
        const cancelled = await device.cancel();
        // The outcome is settled and the device refresh is running: there is
        // nothing to stop, and saying so would be a false failure.
        if (!cancelled) log.debug('cancel ignored: the job outcome is already settled');
      } catch (error) {
        // A failed cancel must not leave the promise unhandled or the button
        // claiming nothing happened.
        log.error('print cancel failed', { message: error?.message ?? String(error) });
        notify(`Could not cancel the print: ${error?.message ?? String(error)}`, { tone: 'error' });
      }
      return;
    }
    if (busy) {
      log.debug('print flow already in progress; ignoring the second trigger');
      return;
    }
    if (!device.connected) {
      notify('Connect the printer before printing', { tone: 'error' });
      return;
    }
    // Print-boundary geometry: an undo can restore a label authored against a
    // longer tape (or an element outside the head), and nothing re-checked it
    // before the raster was built. Revalidate against the live printer and use
    // the resulting document; its notice reaches the confirmation below.
    let target = document;
    if (exceedsPrinterLimits(target)) {
      // Revalidating the live label is the right fix only when the job is for
      // the live label. A test print is a different document: substituting the
      // current one printed the wrong label, and skipping validation printed a
      // 200 mm test page on a 30 mm printer. The schema owner clamps it.
      if (target === getDocument()) {
        if (revalidate()) target = getDocument();
      } else {
        target = validateDocument(target);
      }
    }
    // Only elements the painter actually draws count: an all-hidden label
    // prints a blank label, which is never what the operator meant.
    const visible = target.elements.some((element) => element.visible !== false);
    if (!target.elements.length) {
      notify('Add an element before printing', { tone: 'error' });
      return;
    }
    if (!visible) {
      notify('Show at least one element before printing', { tone: 'error' });
      return;
    }

    busy = true;
    const current = target === getDocument();
    const options = resolveRenderOptions(getSettings());
    setProgress(0.05);
    setStatus('Preparing…');
    try {
      // A missing decode must fail the job instead of printing a blank hole.
      await hydrate(target);
      const { canvas, warnings, hidden = 0 } = render(target, options);
      const warningReport = { warnings, hidden };
      // Keep the warnings in the stage hint, even when the user cancels here —
      // but only for the label on screen: a test print must not overwrite the
      // current label's warning with the test document's.
      if (current) onWarnings(warningReport);
      // An experimental model is allowed, but never silently. The one
      // pre-print confirmation names the support state; with no warnings it is
      // still shown, so the operator is told before paper moves.
      const capabilities = device.state?.capabilities ?? null;
      const experimental = capabilities?.modelSupport === 'experimental';
      const experimentalText = experimental
        ? `${capabilities.model ?? 'This printer'} — ${CONFIG.device.printGate.experimental}`
        : null;
      if (warnings.length) {
        const proceed = await confirm(
          'Print with warnings?',
          [experimentalText, summariseWarnings(warningReport, { limit: 20 })].filter(Boolean).join('\n\n'),
          {
            confirmLabel: 'Print anyway',
            tone: 'primary',
          }
        );
        if (!proceed) {
          setProgress(0);
          setStatus('Print cancelled');
          return;
        }
        // The operator accepted this label as it is: its migration notices are
        // answered. A cancelled dialog leaves them for the next trigger.
        if (current) dismissNotices();
      } else if (experimental) {
        const proceed = await confirm('Print on an experimental model?', experimentalText, {
          confirmLabel: 'Print anyway',
          tone: 'primary',
        });
        if (!proceed) {
          setProgress(0);
          setStatus('Print cancelled');
          return;
        }
      }

      const raster = rasterize(canvas);
      const result = await device.print(raster, {
        copies: target.copies,
        lengthMm: target.lengthMm,
        onProgress: (done, total) => setProgress(0.1 + (done / total) * 0.8),
        // Printing/Cancel belong to the moment the job really starts. The
        // manager calls this immediately before PrintStart, so a gate refusal
        // (lid open, low battery) never leaves the UI claiming paper is moving.
        onStart: () => {
          setPrinting(true);
          setStatus('Printing…');
        },
      });
      setProgress(1);
      setStatus(`Printed ${result.copies} label${result.copies > 1 ? 's' : ''}`, 'ok');
    } catch (error) {
      setProgress(0);
      // A user cancel is a normal outcome, never an error toast.
      if (error.cancelled) {
        setStatus('Print cancelled');
        return;
      }
      // Errors go to the toast (the one error channel); #status stays the job
      // state channel, so the same text is never announced twice. A failed job
      // is an error, exactly like a failed connect.
      log.error('print failed', { message: error.message });
      if (!device.connected) {
        // The connection owner reports a lost link (and owns #status): a second
        // toast here used to repeat the same event as a generic failure. Other
        // print failures still take the toast below.
        log.debug('print failure belongs to the disconnected link');
        return;
      }
      setStatus('');
      notify(error.message, { tone: 'error' });
    } finally {
      // The finishing badge describes one job: clear it before the button
      // returns to "Print", whatever the outcome.
      setFinishing(false);
      setPrinting(false);
      busy = false;
      // Never hold the process open just for a cosmetic progress reset.
      setTimeout(() => setProgress(0), 1200)?.unref?.();
    }
  }

  return {
    run,
    get printing() {
      return printing;
    },
    get finishing() {
      return finishing;
    },
    get busy() {
      return busy;
    },
    /**
     * The job phase a disconnect has to describe: nothing is on the wire while
     * preparing, only the finished-job refresh while finishing, and paper may
     * have moved as soon as the job started.
     */
    get phase() {
      return printing ? 'printing' : busy ? 'preparing' : 'idle';
    },
  };
}
