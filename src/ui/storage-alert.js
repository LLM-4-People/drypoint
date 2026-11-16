/**
 * The one owner of "the stored label could not be read".
 *
 * A corrupt or truncated `localStorage` value used to hydrate to a blank label
 * and be overwritten by the next keystroke, which destroyed the operator's only
 * copy. This owner keeps the raw text, shows a persistent notice and blocks
 * every write until the operator explicitly resets the label. Exporting the raw
 * value is a backup step, not an acknowledgement: it leaves the quarantine and
 * the veto in place, because the stored value is still the only copy of what
 * the operator had. The notice is not a toast: it stays across edits and
 * reloads until the reset is chosen.
 */

import { CONFIG } from '../core/config.js';
import { createLogger } from '../core/log.js';
import { setText } from '../core/dom.js';
import { toast as defaultToast } from './toast.js';

const log = createLogger('ui.storage-alert');

/** One message, shown for the whole quarantine. */
export const STORAGE_ALERT_MESSAGE =
  'The saved label could not be read. It is kept exactly as it is, and nothing is saved, until you reset the label. Export the raw value first if you may need it.';

/**
 * @param {object} options
 * @param {HTMLElement} options.container the persistent banner host
 * @param {HTMLElement} options.textNode the message paragraph
 * @param {HTMLElement} options.exportButton "export the raw value"
 * @param {HTMLElement} options.resetButton "reset the label"
 * @param {(raw: string) => boolean} options.exportRaw writes the raw text
 * @param {() => void} options.onReset called after the quarantine is cleared
 * @param {Function} [options.toast] injected for tests
 * @returns {{active: boolean, raw: string|null, capture: Function, answer: Function,
 *            exportQuarantined: Function}}
 */
export function createStorageAlert({
  container,
  textNode,
  exportButton,
  resetButton,
  exportRaw,
  onReset,
  toast = defaultToast,
}) {
  /** The unreadable value, exactly as storage held it. */
  let raw = null;
  /** True once the operator answered: writes may resume. */
  let answered = false;

  function show() {
    setText(textNode, STORAGE_ALERT_MESSAGE);
    container.hidden = false;
    exportButton.disabled = false;
    resetButton.disabled = false;
  }

  function hide() {
    container.hidden = true;
    exportButton.disabled = true;
    resetButton.disabled = true;
    setText(textNode, '');
  }

  /**
   * Keep one unreadable stored value. Called from the store's load failure,
   * before the app has written anything.
   *
   * @param {string|null} value the raw stored string
   * @param {unknown} [error] the failure, for the log only
   * @returns {boolean} whether a quarantine is now active
   */
  function capture(value, error) {
    // Only a real stored string can be quarantined: a storage read that threw
    // never produced one, and pretending otherwise would block every write.
    if (typeof value !== 'string' || !value) return false;
    raw = value;
    answered = false;
    log.error('stored label could not be read; keeping the raw value', {
      message: error instanceof Error ? error.message : String(error ?? 'unknown'),
      chars: value.length,
    });
    show();
    return true;
  }

  /** Write the quarantined text to a file, unchanged. */
  function exportQuarantined() {
    if (raw === null) return false;
    const filename = `${CONFIG.app.id}-unreadable-label-${Date.now()}.json`;
    try {
      const saved = exportRaw(filename) !== false;
      if (!saved) {
        log.warn('the raw stored label could not be saved');
        toast('Could not save the raw stored label', { tone: 'error' });
        return false;
      }
      toast('Raw stored label exported', { tone: 'ok' });
      return true;
    } catch (error) {
      log.error('raw stored label export failed', { message: error?.message ?? String(error) });
      toast(`Could not save the raw stored label: ${error?.message ?? String(error)}`, { tone: 'error' });
      return false;
    }
  }

  /**
   * The operator accepted the loss. This is the only path that replaces the
   * stored value: the quarantine ends and the current in-memory label is
   * persisted. `exportQuarantined` deliberately does not clear either, so a
   * backup can never destroy the only copy.
   */
  function answer() {
    if (raw === null) return false;
    raw = null;
    answered = true;
    hide();
    log.warn('the unreadable stored label was reset');
    onReset();
    return true;
  }

  exportButton.addEventListener('click', exportQuarantined);
  resetButton.addEventListener('click', answer);
  if (container.hidden === false) hide();

  return {
    /** Whether a write must be refused. */
    get active() {
      return raw !== null;
    },
    get raw() {
      return raw;
    },
    /** True once the operator answered; exposed for the store contract test. */
    get answered() {
      return answered;
    },
    capture,
    answer,
    exportQuarantined,
  };
}
