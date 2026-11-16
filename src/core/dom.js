/** Shared DOM helpers. Every module uses these instead of raw boilerplate. */

export const $ = (selector, root = document) => root.querySelector(selector);

/**
 * Create an element.
 * @param {string} tag
 * @param {Record<string, unknown>} [props]
 * @param {...(Node|string|null)} children
 */
export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key === 'style') Object.assign(node.style, value);
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key in node) node[key] = value;
    else node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

/** Add a listener and return its disposer. */
export function on(target, type, handler, options) {
  target.addEventListener(type, handler, options);
  return () => target.removeEventListener(type, handler, options);
}

export function setText(node, text) {
  if (node && node.textContent !== text) node.textContent = text;
}

/**
 * Snapshot what focus restoration needs for one node: the node itself and, for
 * a text control, the caret selection (reparenting resets it to the end).
 */
export function captureFocus(node) {
  if (!node || typeof node.focus !== 'function') return null;
  const selection =
    typeof node.selectionStart === 'number'
      ? { start: node.selectionStart, end: node.selectionEnd, direction: node.selectionDirection ?? 'none' }
      : null;
  return { node, selection };
}

/**
 * The last focused control, kept live while the user works.
 *
 * A breakpoint change can hide the focused control's ancestor. Chromium then
 * moves focus to the body one frame later *without* dispatching focusout/blur,
 * so at move time `document.activeElement` may already be the body and a
 * capture taken then would be empty.
 */
let lastFocused = null;
let trackingFocus = false;

function ensureFocusTracking() {
  if (trackingFocus || typeof document === 'undefined' || typeof document.addEventListener !== 'function') return;
  trackingFocus = true;
  document.addEventListener('focusin', (event) => {
    const target = event?.target;
    if (target && target !== document.body) lastFocused = captureFocus(target);
  });
  // A caret move is part of the state to restore: the selection captured at
  // focus time would otherwise put the caret back where it was minutes ago.
  document.addEventListener('selectionchange', () => {
    const active = document.activeElement;
    if (active && active === lastFocused?.node) lastFocused = captureFocus(active);
  });
}

/** Put focus and the caret back from a captureFocus() snapshot. */
export function restoreFocus(snapshot) {
  if (!snapshot?.node) return false;
  const { node, selection } = snapshot;
  node.focus?.({ preventScroll: true });
  if (selection && typeof node.setSelectionRange === 'function') {
    try {
      node.setSelectionRange(selection.start, selection.end, selection.direction);
    } catch {
      // Some input types (number, email) reject a selection range; focus is
      // still restored, which is the part that matters.
    }
  }
  return true;
}

/**
 * Move a node with the callback, then put keyboard focus and the text
 * selection back. Reparenting a focused input (breakpoint changes move the
 * label name, stage and inspector) drops focus to the body in every browser;
 * one helper owns the restore so each caller cannot forget it.
 *
 * The restore is re-asserted once on the next frame: Chromium's own fixup for
 * a control hidden by the move lands after this call, and would otherwise win.
 *
 * @param {Node} node the subtree being moved
 * @param {() => void} move performs the actual DOM move
 * @returns {boolean} true when focus was restored
 */
export function movePreservingFocus(node, move) {
  ensureFocusTracking();
  const active = document.activeElement;
  const snapshot =
    active && active !== document.body && node.contains(active)
      ? captureFocus(active)
      : lastFocused && node.contains(lastFocused.node)
        ? lastFocused
        : null;
  move();
  const restored = snapshot ? restoreFocus(snapshot) : false;
  if (snapshot && typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(() => {
      if (document.activeElement !== document.body) return;
      // Only a node that is still in the document can take focus back.
      if (snapshot.node.isConnected === false) return;
      restoreFocus(snapshot);
    });
  }
  return restored;
}

/**
 * Save one text file through the one download owner.
 *
 * In the Android shell a Blob download has no destination; the native bridge
 * writes the file into Downloads and returns whether it succeeded. `type` is
 * only meaningful for the browser Blob.
 */
export function downloadText(filename, text, type = 'text/plain') {
  const bridge = typeof window !== 'undefined' ? window.NiimbotBLE : null;
  if (bridge?.saveFile) return bridge.saveFile(filename, text);

  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const link = el('a', { href: url, download: filename });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return true;
}

export function downloadJson(filename, data) {
  return downloadText(filename, JSON.stringify(data, null, 2), 'application/json');
}

