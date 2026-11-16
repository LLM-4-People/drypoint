/** Toasts: the single way to surface transient feedback. */

import { CONFIG } from '../core/config.js';
import { el, $ } from '../core/dom.js';
import { icon } from './icons.js';

/**
 * `timeout: null` keeps a toast until it is dismissed (a failure that must not
 * disappear on its own). `key` dedupes: the owner of a recurrent condition gets
 * back the same remover instead of stacking identical toasts. `onDismiss` runs
 * once when the toast goes away, whether the timer, a click or the owner's
 * remover did it, so a caller's "already shown" guard can never go stale.
 */
const live = new Map();

export function toast(message, { tone = '', timeout = CONFIG.ui.toastMs, key = null, onDismiss = null } = {}) {
  const host = $('#toasts');
  if (!host) return () => {};
  if (key && live.has(key)) return live.get(key);
  const name = tone === 'error' ? 'alert' : tone === 'ok' ? 'check' : 'info';
  // #toasts is the one live region (aria-live, no aria-atomic, so only the new
  // toast is announced); a role on each toast would announce the message twice.
  const persistent = timeout == null;
  const node = el(
    'div',
    { class: 'toast', dataset: { tone } },
    el('span', { class: 'icon' }, icon(name, { size: 16 })),
    el('span', {}, message),
    // A toast that never times out must be clearable from the keyboard. The
    // close button is the focusable control; a click anywhere still dismisses.
    persistent ? el('button', { class: 'toast-close', type: 'button', 'aria-label': 'Dismiss' }, icon('x', { size: 14 })) : null
  );
  host.append(node);
  // One remover, one outcome: a click on the close button bubbles to the toast
  // click handler, and the owner may call its remover at the same time. The
  // guard keeps onDismiss and the key cleanup exactly once.
  let removed = false;
  const remove = () => {
    if (removed) return;
    removed = true;
    if (key) live.delete(key);
    onDismiss?.();
    node.style.opacity = '0';
    node.style.transform = 'translateY(4px)';
    setTimeout(() => node.remove(), 160);
  };
  const timer = timeout == null ? null : setTimeout(remove, timeout);
  node.addEventListener('click', () => {
    if (timer) clearTimeout(timer);
    remove();
  });
  if (key) live.set(key, remove);
  return remove;
}
