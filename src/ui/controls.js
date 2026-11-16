/**
 * Reusable form controls. Every panel builds its UI from these so styling,
 * labels, accessibility and change handling stay consistent.
 */

import { el, on } from '../core/dom.js';

export function group(title, children, { extra = null } = {}) {
  return el(
    'section',
    { class: 'group' },
    el('div', { class: 'group-title' }, el('span', {}, title), extra),
    ...[children].flat().filter(Boolean)
  );
}

function head(label, valueText) {
  return el('div', { class: 'control-head' }, el('span', {}, label), valueText ? el('span', { class: 'value' }, valueText) : null);
}

export function control(label, node, { value = null } = {}) {
  const valueNode = value === null ? null : el('span', { class: 'value' }, value);
  return el('div', { class: 'control' }, el('div', { class: 'control-head' }, el('span', {}, label), valueNode), node);
}

/**
 * True for controls that own a caret and the user's typing. A sync must not
 * rewrite those, but a switch, segmented group, range or number field has no
 * usable caret: each must follow the model even while focused, or an undo (or
 * a rejected value) leaves it showing something the document never accepted.
 */
export function isTextEntry(node) {
  if (!node) return false;
  if (node.tagName === 'TEXTAREA') return true;
  if (node.tagName !== 'INPUT') return false;
  return !['range', 'number', 'checkbox', 'radio', 'button', 'submit', 'reset'].includes(String(node.type ?? '').toLowerCase());
}

export function slider({ label, min, max, step = 1, value, unit = '', format = null, onInput }) {
  const display = (next) => (format ? format(next) : `${next}${unit}`);
  const valueNode = el('span', { class: 'value' }, display(value));
  const input = el('input', {
    type: 'range',
    min,
    max,
    step,
    value,
    'aria-label': label,
    'aria-valuetext': display(value),
  });
  /** The touch gesture that owns the value, if any. */
  let touch = null;
  /**
   * The pointer gesture that owns the value. A new press is a new undo step
   * even inside the 600 ms coalesce window; keyboard edits carry no gesture
   * and keep their constant key.
   */
  let gesture = null;
  let gestureId = 0;
  const commit = (next) => onInput?.(next, gesture ? { gesture } : undefined);

  const show = (next) => {
    valueNode.textContent = display(next);
    input.setAttribute('aria-valuetext', display(next));
  };

  on(input, 'input', () => {
    // A touch seeks on pointerdown and streams while dragging. Committing each
    // step would make a vertical scroll rewrite the value before the browser
    // cancels the gesture; only the label follows until pointerup.
    show(Number(input.value));
    if (touch) return;
    commit(Number(input.value));
  });
  on(input, 'pointerdown', (event) => {
    gesture = `g${++gestureId}`;
    if (event.pointerType !== 'touch') return;
    touch = { pointerId: event.pointerId, committed: Number(input.value) };
  });
  on(input, 'pointerup', (event) => {
    if (!touch || event.pointerId !== touch.pointerId) {
      gesture = null;
      return;
    }
    const next = Number(input.value);
    const committed = touch.committed;
    touch = null;
    show(next);
    // A tap on the current thumb is not an edit; skip the rerender.
    if (next !== committed) commit(next);
    gesture = null;
  });
  const restoreTouch = (event) => {
    if (!touch || event.pointerId !== touch.pointerId) return;
    const committed = touch.committed;
    touch = null;
    gesture = null;
    input.value = String(committed);
    show(committed);
  };
  on(input, 'pointercancel', restoreTouch);
  on(input, 'lostpointercapture', restoreTouch);
  return {
    node: el('div', { class: 'control' }, el('div', { class: 'control-head' }, el('span', {}, label), valueNode), input),
    set(next) {
      // A model update outside the gesture wins: the finger is no longer the
      // owner of the value, so a later cancel must not restore the old one.
      touch = null;
      input.value = String(next);
      show(next);
    },
    setDisabled(next) {
      input.disabled = Boolean(next);
    },
  };
}

/**
 * A three-state switch: true, false, or unknown (null).
 *
 * Unknown is not "off". A value the printer never reported must not be
 * announced as checked=false, and a `switch` role without `aria-checked` is an
 * invalid control. So an unknown value renders as a plain disabled button
 * described by the hint that explains why; only a known value is a switch.
 */
export function toggle({ label, checked = false, onChange, description = null, hintId = null }) {
  const button = el('button', { class: 'switch', type: 'button', 'aria-label': label }, el('i', { 'aria-hidden': 'true' }));
  let known = false;
  const set = (next) => {
    known = next === true || next === false;
    if (known) {
      button.setAttribute('role', 'switch');
      button.setAttribute('aria-checked', String(next));
    } else {
      button.removeAttribute('role');
      button.removeAttribute('aria-checked');
    }
    if (!known && hintId) button.setAttribute('aria-describedby', hintId);
    else button.removeAttribute('aria-describedby');
  };
  set(checked);
  on(button, 'click', () => {
    // An unknown value has nothing to invert; the control is disabled in that
    // state, so this only guards a synthetic click.
    if (!known) return;
    const next = button.getAttribute('aria-checked') !== 'true';
    set(next);
    onChange?.(next);
  });
  const node = el(
    'div',
    { class: 'switch-row' },
    el('span', {}, label),
    description ? el('span', { class: 'hint' }, description) : null,
    button
  );
  return {
    node,
    set,
    setDisabled(next) {
      button.disabled = Boolean(next);
    },
  };
}

export function select({ label, options, value, onChange }) {
  const node = el('select', { class: 'select', 'aria-label': label });
  /** The options currently in the DOM, normalized to [stringId, text]. */
  let current = [];
  const renderOptions = (nextOptions, nextValue) => {
    const normalized = nextOptions.map(([id, text]) => [String(id), text]);
    const same =
      normalized.length === current.length && normalized.every(([id, text], index) => id === current[index][0] && text === current[index][1]);
    if (!same) {
      current = normalized;
      node.textContent = '';
      for (const [id, text] of normalized) node.append(el('option', { value: id }, text));
    }
    if (nextValue !== undefined) node.value = String(nextValue);
  };
  renderOptions(options, value);
  on(node, 'change', () => onChange?.(node.value));
  return {
    node: el('div', { class: 'control' }, head(label), node),
    set(next) {
      node.value = String(next);
    },
    /**
     * Replace the option list and the selection together. A value the new
     * list does not contain would otherwise leave the browser showing the
     * first option while the model holds another value.
     */
    setOptions(nextOptions, nextValue) {
      renderOptions(nextOptions, nextValue);
    },
    /** Whether the current list can display this value at all. */
    hasOption(next) {
      return current.some(([id]) => id === String(next));
    },
    setDisabled(next) {
      node.disabled = Boolean(next);
    },
    element: node,
  };
}

export function segmented({ label, options, value, onChange }) {
  const buttons = options.map(([id, text]) =>
    el('button', { type: 'button', dataset: { value: String(id) }, 'aria-pressed': String(String(id) === String(value)) }, text)
  );
  const wrap = el('div', { class: 'segmented', role: 'group', 'aria-label': label }, ...buttons);
  on(wrap, 'click', (event) => {
    const button = event.target.closest('button[data-value]');
    if (!button) return;
    for (const other of buttons) other.setAttribute('aria-pressed', String(other === button));
    onChange?.(button.dataset.value);
  });
  return {
    node: el('div', { class: 'control' }, head(label), wrap),
    set(next) {
      for (const button of buttons) button.setAttribute('aria-pressed', String(button.dataset.value === String(next)));
    },
    setDisabled(next) {
      for (const button of buttons) button.disabled = Boolean(next);
    },
  };
}

export function textArea({ label, value = '', placeholder = '', rows = 3, maxLength, onInput }) {
  const node = el('textarea', { class: 'textarea', rows, placeholder, 'aria-label': label, maxlength: maxLength, spellcheck: 'false' });
  node.value = value;
  on(node, 'input', () => onInput?.(node.value));
  return {
    node: el('div', { class: 'control' }, head(label), node),
    set(next) {
      if (node.value !== next) node.value = next;
    },
    setDisabled(next) {
      node.disabled = Boolean(next);
    },
    element: node,
  };
}

export function textField({ label, value = '', placeholder = '', maxLength, onInput, inputMode }) {
  const node = el('input', { class: 'input', type: 'text', placeholder, 'aria-label': label, maxlength: maxLength, inputMode, spellcheck: 'false' });
  node.value = value;
  on(node, 'input', () => onInput?.(node.value));
  return {
    node: el('div', { class: 'control' }, head(label), node),
    set(next) {
      if (node.value !== next) node.value = next;
    },
    setDisabled(next) {
      node.disabled = Boolean(next);
    },
    element: node,
  };
}

export function numberField({ label, value, min, max, step = 1, unit = '', onChange }) {
  // The unit is part of the accessible name: a spinbutton announced as "X"
  // gives no clue whether the number is millimetres or dots.
  const accessibleName = unit ? `${label} (${unit})` : label;
  const node = el('input', { class: 'input', type: 'number', min, max, step, value, 'aria-label': accessibleName, inputMode: 'numeric' });
  // Remember the last accepted value so clearing the field can be undone
  // instead of committing 0 (which collapsed elements or moved them to the
  // origin). An empty or unreadable value never reaches the controller.
  let current = Number(value);
  on(node, 'change', () => {
    const raw = String(node.value).trim();
    const next = Number(raw);
    if (raw === '' || !Number.isFinite(next)) {
      node.value = String(current);
      return;
    }
    current = next;
    onChange?.(next);
  });
  return {
    node: el('div', { class: 'control' }, head(label, unit || null), node),
    set(next) {
      current = Number(next);
      node.value = String(next);
    },
    /** A device-reported limit can change without rebuilding the panel. */
    setMax(next) {
      const limit = Number(next);
      if (!Number.isFinite(limit)) return;
      node.max = String(limit);
    },
    setDisabled(next) {
      node.disabled = Boolean(next);
    },
    element: node,
  };
}

export function row(...children) {
  return el('div', { class: 'control-row' }, ...children);
}

export function buttonRow(buttons) {
  return el('div', { class: 'btn-row' }, ...buttons.map((b) => b.node ?? b));
}

export function actionButton(label, { onClick, icon = null, tone = '', disabled = false, small = false } = {}) {
  const node = el(
    'button',
    { class: `btn ${tone} ${small ? 'small' : ''}`.trim(), type: 'button', disabled },
    icon,
    el('span', {}, label)
  );
  on(node, 'click', onClick);
  return {
    node,
    setDisabled(next) {
      node.disabled = Boolean(next);
    },
    setLabel(next) {
      node.lastChild.textContent = next;
    },
  };
}

/**
 * A read-only label/value row. Returns a control so panels can register it and
 * let sync() update the value in place instead of rebuilding the whole panel.
 */
export function statRow(label, value = '—') {
  const valueNode = el('span', { class: 'value' }, value);
  const node = el('div', { class: 'stat-row' }, el('span', { class: 'label' }, label), valueNode);
  return {
    node,
    set(next) {
      const text = next === null || next === undefined || next === '' ? '—' : String(next);
      if (valueNode.textContent !== text) valueNode.textContent = text;
    },
  };
}
