/** Layer list: order, visibility, lock and per-element actions. */

import { el, on, setText } from '../core/dom.js';
import { icon } from './icons.js';
import { Z_ORDER_ACTIONS } from './z-order.js';

const ICONS = { text: 'text', qr: 'qr', barcode: 'barcode', image: 'image', rect: 'rect' };

/** Coarse pointers get the disclosure menu instead of the hover strip. */
function coarsePointer() {
  return typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches === true;
}

/**
 * Operator-facing name for one layer row. Every field is untrusted document
 * data, so a non-string value can never throw during a render.
 */
function displayName(element) {
  const name = String(element.name ?? '').trim();
  if (name) return name;
  if (element.type === 'text') return String(element.text ?? '').split('\n')[0].slice(0, 24) || 'Text';
  if (element.type === 'qr') return 'QR code';
  if (element.type === 'barcode') return String(element.value ?? '') || 'Barcode';
  if (element.type === 'image') return 'Image';
  if (element.type === 'rect') return 'Frame';
  return String(element.type ?? '');
}

/**
 * Each row is a plain button carrying aria-current (valid outside a listbox);
 * the actions are sibling buttons, so the row never nests interactive content
 * inside another control. On a coarse pointer the six actions collapse into a
 * single disclosure button.
 */
export function createLayersPanel({ container, countNode, controller }) {
  let lastSignature = '';
  let menu = null;
  /**
   * An action click closes the menu (and that moves focus to the trigger)
   * before the mutation rebuilds the list, so the intent must be captured
   * first or the rebuild only sees the trigger.
   */
  let pendingFocus = null;

  function closeMenu() {
    if (!menu) return;
    const { row, button, offOutside, offEscape, offFocus, offScroll, offResize } = menu;
    menu = null;
    offOutside();
    offEscape();
    offFocus();
    offScroll();
    offResize();
    delete row.dataset.menu;
    button.setAttribute('aria-expanded', 'false');
    // The trigger stays visible at all times; if focus was inside the action
    // grid, hand it back so closing never drops focus to the body. preventScroll
    // keeps a scroll-dismissal from snapping the list back to the trigger.
    if (row.contains(document.activeElement) && document.activeElement !== button) button.focus({ preventScroll: true });
  }

  function openMenu(element, row, button) {
    closeMenu();
    row.dataset.menu = 'open';
    button.setAttribute('aria-expanded', 'true');
    // Capture phase: a tap outside or Escape closes the menu before the row
    // selection / global shortcut handlers see the event.
    const offOutside = on(
      document,
      'pointerdown',
      (event) => {
        if (!row.contains(event.target)) closeMenu();
      },
      true
    );
    const offEscape = on(
      document,
      'keydown',
      (event) => {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        event.stopPropagation();
        closeMenu();
        button.focus({ preventScroll: true });
      },
      true
    );
    // Tabbing (or any other focus move) out of the row dismisses the menu; it
    // used to stay open and keep blocking the rows below while aria-expanded
    // claimed it was still open.
    const offFocus = on(
      document,
      'focusin',
      (event) => {
        if (!row.contains(event.target)) closeMenu();
      },
      true
    );
    // The actions are in the row's flow, so a scroll or resize cannot detach
    // them; closing keeps a long list from parking an open menu off-screen.
    const offScroll = on(
      window,
      'scroll',
      (event) => {
        if (!menu) return;
        // Opening scrolls the grid into view; the scroll events that report
        // the position it left behind are not a dismissal. A later scroll
        // lands somewhere else and closes.
        const { list, listTop, pageY } = menu.settled ?? {};
        if (list && event.target === list && list.scrollTop === listTop) return;
        if (pageY !== null && (event.target === document || event.target === window) && window.scrollY === pageY) return;
        closeMenu();
      },
      { capture: true, passive: true }
    );
    const offResize = on(window, 'resize', () => closeMenu());
    menu = { id: element.id, row, button, offOutside, offEscape, offFocus, offScroll, offResize, settled: null };
    // Bring the expanded grid clear of the list's own overflow, then move focus
    // into it so the next Tab walks the actions. The trigger precedes the grid
    // in the DOM (see the row build below), so this is also the reading order.
    const actions = row.querySelector('.layer-actions');
    actions?.scrollIntoView?.({ block: 'nearest' });
    const list = row.closest('.layer-list');
    menu.settled = {
      list,
      listTop: typeof list?.scrollTop === 'number' ? list.scrollTop : null,
      pageY: Number.isFinite(window.scrollY) ? window.scrollY : null,
    };
    row.querySelector('button[data-action]')?.focus();
  }

  /** Remember which row and action had focus so a rebuild can put it back. */
  function focusedState() {
    const active = document.activeElement;
    if (!active || !container.contains(active)) return null;
    const row = active.closest('.layer-row');
    if (!row) return null;
    return {
      id: row.dataset.id,
      index: [...container.children].indexOf(row),
      action: active.closest('button[data-action]')?.dataset.action ?? null,
    };
  }

  function restoreFocus(state) {
    if (!state) return;
    const rows = [...container.querySelectorAll('.layer-row')];
    const sameRow = rows.find((item) => item.dataset.id === state.id) ?? null;
    // A deleted row is gone: fall back to the row that took its place.
    const row = sameRow ?? rows[Math.min(state.index ?? 0, rows.length - 1)];
    // Deleting the last layer leaves nothing to focus; the list itself is the
    // stable target so focus never falls to the body.
    if (!row) {
      container.focus?.();
      return;
    }
    // Focus the row control first: the action strip is display:none until the
    // row is focused (or hovered), so focusing an action directly is a no-op
    // and focus falls to the body.
    row.querySelector('.layer-select')?.focus();
    // Coarse pointers keep focus on the visible row control; the action grid
    // would otherwise steal it from the row the user is working with.
    if (coarsePointer() || !sameRow || !state.action) return;
    // Keep keyboard focus on the action that ran; a vanished row falls back to
    // the replacement row's select button rather than running the same action
    // against a different element.
    row.querySelector(`button[data-action="${state.action}"]`)?.focus();
  }

  function actionButtons(element) {
    const specs = [
      ['visibility', element.visible ? 'eye' : 'eyeOff', 'Toggle visibility', () => controller.updateElement(element.id, { visible: !element.visible })],
      ['lock', element.locked ? 'lock' : 'unlock', 'Toggle lock', () => controller.updateElement(element.id, { locked: !element.locked })],
      // A locked element may be duplicated, hidden or unlocked, but its place in
      // the stack is fixed; the owner refuses these too, so the disabled state
      // and the behaviour cannot disagree.
      ...Z_ORDER_ACTIONS.map((action) => [action.name, action.icon, action.title, () => controller.reorder(element.id, action.delta), true]),
      ['duplicate', 'copy', 'Duplicate', () => controller.duplicateElement(element.id)],
      ['delete', 'trash', 'Delete', () => controller.removeElement(element.id), true],
    ];
    return specs.map(([name, iconName, title, run, lockedDisabled = false]) => {
      const button = el(
        'button',
        {
          type: 'button',
          dataset: { action: name },
          title,
          'aria-label': title,
          disabled: lockedDisabled && Boolean(element.locked),
        },
        icon(iconName, { size: 14 })
      );
      on(button, 'click', (event) => {
        event.stopPropagation();
        const row = button.closest('.layer-row');
        pendingFocus = {
          id: element.id,
          action: name,
          index: row ? [...container.children].indexOf(row) : 0,
        };
        closeMenu();
        run();
        // A synchronous rebuild already consumed the intent. When the action
        // was a no-op (nothing to reorder) it must not be replayed later on an
        // unrelated rebuild.
        pendingFocus = null;
      });
      return button;
    });
  }

  function buildRow(element) {
    const selected = element.id === controller.selection;
    const name = displayName(element);
    const row = el('li', { class: 'layer-row', dataset: { id: element.id, selected: String(selected) } });

    const select = el(
      'button',
      {
        class: 'layer-select',
        type: 'button',
        'aria-current': selected ? 'true' : null,
        title: name,
        onClick: () => {
          closeMenu();
          controller.select(element.id);
        },
      },
      el('span', { class: 'layer-icon' }, icon(ICONS[element.type] ?? 'rect', { size: 15 })),
      el('span', { class: 'layer-name' }, name)
    );

    const actions = el('span', { class: 'layer-actions', id: `layer-actions-${element.id}` }, ...actionButtons(element));
    const menuButton = el(
      'button',
      {
        class: 'layer-menu',
        type: 'button',
        'aria-expanded': 'false',
        'aria-controls': actions.id,
        'aria-label': `Actions for ${name}`,
        title: 'Layer actions',
      },
      icon('more', { size: 16 })
    );
    on(menuButton, 'click', (event) => {
      event.stopPropagation();
      if (menu?.id === element.id) closeMenu();
      else openMenu(element, row, menuButton);
    });

    // The trigger precedes the actions it controls in the DOM, so Tab walks
    // the row, then the trigger, then the action grid. It is absolutely
    // positioned above the grid, so the visual order is unchanged.
    row.append(select, menuButton, actions);
    return row;
  }

  function render() {
    const document = controller.document;
    const signature = document.elements.map((e) => `${e.id}:${e.visible}:${e.locked}:${displayName(e)}`).join('|') + `#${controller.selection}`;
    const focusState = pendingFocus ?? focusedState();
    pendingFocus = null;
    if (signature === lastSignature) return;
    closeMenu();
    lastSignature = signature;
    container.textContent = '';
    setText(countNode, `${document.elements.length}`);

    for (const element of [...document.elements].reverse()) container.append(buildRow(element));
    restoreFocus(focusState);
  }

  return { render };
}
