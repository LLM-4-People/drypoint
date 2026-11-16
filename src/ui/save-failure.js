/**
 * The one owner of "the label is not being saved".
 *
 * A storage failure is often permanent (quota or a blocked origin), so the
 * notice must persist until a write succeeds or the operator dismisses it. The
 * "already shown" guard is cleared by the toast's own dismissal, not only by a
 * later success: a stale remover used to suppress every notice after the first
 * one was clicked away.
 */

import { createLogger } from '../core/log.js';
import { toast as defaultToast } from './toast.js';

const log = createLogger('ui.save-failure');

export const SAVE_FAILURE_MESSAGE = 'Changes are not being saved: storage is full or blocked';

/**
 * @param {{toast?: Function}} [deps] injected for tests
 * @returns {{report: (error: unknown) => void, clear: () => void}}
 */
export function createSaveFailureNotice({ toast = defaultToast } = {}) {
  let remover = null;

  function report(error) {
    log.error('label could not be saved', { message: error instanceof Error ? error.message : String(error) });
    if (remover) return;
    remover = toast(SAVE_FAILURE_MESSAGE, {
      tone: 'error',
      timeout: null,
      key: 'document-save-error',
      onDismiss: () => {
        remover = null;
      },
    });
  }

  function clear() {
    if (!remover) return;
    const dismiss = remover;
    // Clear first: a synchronous onDismiss (or a throwing remover) must never
    // leave a stale guard behind.
    remover = null;
    dismiss();
  }

  return { report, clear };
}
