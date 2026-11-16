/** Modal dialog: one implementation for settings, device and diagnostics. */

import { el, $, on } from '../core/dom.js';
import { createLogger } from '../core/log.js';
import { icon } from './icons.js';
import { toast } from './toast.js';

const log = createLogger('ui.modal');

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Topmost dialog owns the keyboard; nested dialogs keep the shell inert. */
const stack = [];

function focusableWithin(dialog) {
  return [...dialog.querySelectorAll(FOCUSABLE)].filter((node) => node.getClientRects().length > 0);
}

/**
 * @param {{title:string, body:Node, actions?:Array<{label:string, tone?:string, onClick?:Function, close?:boolean}>,
 *          onClose?:Function, wide?:boolean}} options
 */
export function openModal({ title, body, actions = [], onClose, wide = false }) {
  const root = $('#modalRoot');
  const app = $('#app');
  const backdrop = el('div', { class: 'modal-backdrop' });
  const closeButton = el('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Close' }, icon('x'));

  const footer = actions.length
    ? el(
        'div',
        { class: 'modal-foot' },
        ...actions.map((action) =>
          el(
            'button',
            {
              class: action.tone === 'primary' ? 'btn primary' : action.tone === 'danger' ? 'btn danger' : 'btn',
              type: 'button',
              onClick: async () => {
                try {
                  const keepOpen = await action.onClick?.();
                  if (action.close !== false && keepOpen !== true) close();
                } catch (error) {
                  // A rejected action must never become an unhandled rejection.
                  // Report it and keep the dialog open so it can be retried.
                  log.error('dialog action failed', { action: action.label, message: error?.message ?? String(error) });
                  toast(error?.message ?? `${action.label} failed`, { tone: 'error' });
                }
              },
            },
            action.label
          )
        )
      )
    : null;

  const dialog = el(
    'div',
    {
      class: 'modal',
      role: 'dialog',
      'aria-modal': 'true',
      'aria-label': title,
      tabIndex: -1,
      style: wide ? { width: 'min(760px, 100%)' } : {},
    },
    el('div', { class: 'modal-head' }, el('h2', {}, title), closeButton),
    el('div', { class: 'modal-body' }, body),
    footer
  );

  backdrop.append(dialog);
  root.append(backdrop);

  const previousFocus = document.activeElement;
  let closed = false;

  const close = () => {
    if (closed) return;
    closed = true;
    const index = stack.indexOf(close);
    if (index >= 0) stack.splice(index, 1);
    backdrop.remove();
    offKeydown();
    // Only the last dialog to close releases the shell.
    if (app) app.inert = stack.length > 0;
    onClose?.();
    previousFocus?.focus?.();
  };

  stack.push(close);
  // The app shell (and everything behind the dialog) leaves the tab order and
  // the accessibility tree while any dialog is open.
  if (app) app.inert = true;

  const onKeydown = (event) => {
    if (stack.at(-1) !== close) return;
    if (event.key === 'Escape') {
      // Capture phase on window: stop the document-level shortcut handler from
      // also treating Escape as "deselect the element behind the dialog".
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    if (event.key !== 'Tab') return;
    const items = focusableWithin(dialog);
    if (!items.length) {
      event.preventDefault();
      dialog.focus();
      return;
    }
    const first = items[0];
    const last = items.at(-1);
    const active = document.activeElement;
    const inside = dialog.contains(active);
    if (event.shiftKey) {
      if (!inside || active === first) {
        event.preventDefault();
        last.focus();
      }
    } else if (!inside || active === last) {
      event.preventDefault();
      first.focus();
    }
  };
  const offKeydown = on(window, 'keydown', onKeydown, true);

  on(backdrop, 'pointerdown', (event) => {
    if (event.target === backdrop) close();
  });
  on(closeButton, 'click', close);

  closeButton.focus();
  return { close, dialog };
}

/**
 * Ask for confirmation. Resolves true only when the confirm action is chosen;
 * cancel, Escape and backdrop dismissal resolve false.
 */
export function confirmDialog(title, message, { confirmLabel = 'Confirm', tone = 'danger', body = null } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const modal = openModal({
      title,
      body: body ?? el('div', { class: 'hint' }, message),
      onClose: () => settle(false),
      actions: [
        { label: 'Cancel', close: true, onClick: () => settle(false) },
        {
          label: confirmLabel,
          tone,
          onClick: () => {
            settle(true);
            modal.close();
            return true;
          },
        },
      ],
    });
  });
}
