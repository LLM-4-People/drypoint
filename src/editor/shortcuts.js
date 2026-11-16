/**
 * Keyboard intents for the editor. DOM-free: main.js maps an intent to the
 * controller or the print flow, so the guard rules (text fields, dialogs) are
 * testable without a browser.
 */

const FIELD_TAGS = /^(INPUT|TEXTAREA|SELECT)$/;

/** True when the event's active element owns the keyboard. */
export function isFieldElement(node) {
  return FIELD_TAGS.test(node?.tagName ?? '');
}

/**
 * Map a keydown to one editor action, or null when the event belongs to the
 * focused control or to the browser.
 *
 * Ctrl+D is deliberately below the field guard: inside a text field it is the
 * browser's duplicate/whatever the platform does, never a label element copy.
 *
 * @param {KeyboardEvent|object} event
 * @param {{inField?: boolean, hasSelection?: boolean, hasDialog?: boolean}} [context]
 * @returns {{type: string, key?: string, step?: number}|null}
 */
export function shortcutIntent(event, { inField = false, hasSelection = false, hasDialog = false } = {}) {
  const mod = Boolean(event.ctrlKey || event.metaKey);
  const key = String(event.key ?? '');
  const lower = key.toLowerCase();

  // Native undo/redo must run inside a text field: intercepting it would
  // desync the field from the document history.
  if (mod && lower === 'z') {
    if (inField) return null;
    return { type: event.shiftKey ? 'redo' : 'undo' };
  }
  if (mod && lower === 'y') {
    if (inField) return null;
    return { type: 'redo' };
  }
  if (mod && key === 'Enter') {
    // A dialog owns the keyboard: Ctrl+Enter in the warnings dialog must not
    // start a second print flow behind it.
    return hasDialog ? null : { type: 'print' };
  }

  // Everything below belongs to the editor, never to a focused field.
  if (inField) return null;

  if (mod && lower === 'd') return hasSelection ? { type: 'duplicate' } : null;
  if (key === 'Delete' || key === 'Backspace') return hasSelection ? { type: 'delete' } : null;
  if (key === 'Escape') return { type: 'deselect' };
  if (key.startsWith('Arrow') && hasSelection) return { type: 'nudge', key, step: event.shiftKey ? 8 : 1 };
  return null;
}
