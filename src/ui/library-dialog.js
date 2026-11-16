/**
 * The visible label library: the Labels modal and its rows.
 *
 * Persistence and switching belong to `core/label-session.js`; this module only
 * renders the cached list for one opening and hands the chosen action back to
 * the composition root. The dialog itself is the shared `openModal` owner, so
 * focus trapping, Escape and focus return have one implementation.
 */

import { createLogger } from '../core/log.js';
import { el } from '../core/dom.js';
import { DEFAULT_LABEL_NAME } from '../label/schema.js';
import { icon } from './icons.js';
import { elementCountLabel, relativeLabelTime } from './library-format.js';
import { confirmDialog, openModal } from './modal.js';
import { toast } from './toast.js';

const log = createLogger('ui.library');

function displayName(label) {
  const name = typeof label?.name === 'string' ? label.name.trim() : '';
  return name || DEFAULT_LABEL_NAME;
}

function actionButton(label, action, onClick, { tone = '' } = {}) {
  return el(
    'button',
    {
      class: 'label-action',
      type: 'button',
      dataset: tone ? { tone } : {},
      'aria-label': `${action} ${label}`,
      onClick,
    },
    action
  );
}

/**
 * Build one saved-label row.
 *
 * @param {object} label label metadata
 * @param {{current: boolean, onOpen: Function, onDuplicate: Function, onExport: Function, onDelete: Function}} handlers
 */
function labelRow(label, { current, onOpen, onDuplicate, onExport, onDelete }) {
  const name = displayName(label);
  return el(
    'li',
    { class: 'label-row', 'aria-current': current ? 'true' : null },
    el(
      'div',
      { class: 'label-name' },
      el('button', { class: 'label-open', type: 'button', 'aria-label': `Open ${name}`, onClick: onOpen }, name),
      el(
        'div',
        { class: 'label-meta' },
        current ? el('span', { class: 'label-current' }, 'Current') : null,
        el('span', {}, `${elementCountLabel(label.elementCount)} · ${relativeLabelTime(label.updatedAt)}`)
      )
    ),
    el(
      'div',
      { class: 'label-actions' },
      actionButton(name, 'Duplicate', onDuplicate),
      actionButton(name, 'Export', onExport),
      actionButton(name, 'Delete', onDelete, { tone: 'danger' })
    )
  );
}

/**
 * @param {object} options
 * @param {() => Promise<object[]>} options.list the saved labels for this opening
 * @param {() => string|null} options.currentId the open label
 * @param {(label: object) => Promise<void>} options.onOpen
 * @param {() => Promise<void>} options.onNew
 * @param {(label: object) => Promise<void>} options.onDuplicate
 * @param {(label: object) => Promise<void>} options.onExport
 * @param {(label: object) => Promise<void>} options.onDelete
 * @param {() => void} options.onImport
 * @param {Function} [options.notify]
 * @param {Function} [options.confirm]
 */
export function createLibraryDialog({
  list,
  currentId,
  onOpen,
  onNew,
  onDuplicate,
  onExport,
  onDelete,
  onImport,
  notify = toast,
  confirm = confirmDialog,
}) {
  let opening = false;
  let active = false;
  /** One action at a time: a double click must not create or delete twice. */
  let busy = false;

  async function open() {
    if (opening || active) return;
    opening = true;
    let labels;
    try {
      labels = await list();
    } catch (error) {
      log.warn('the saved labels could not be listed', { message: error?.message ?? String(error) });
      notify(error?.message ?? 'The saved labels could not be read.', { tone: 'error' });
      return;
    } finally {
      opening = false;
    }

    const current = currentId();
    let dialog = null;

    const runAndClose = async (action, failure) => {
      if (busy) return;
      busy = true;
      try {
        await action();
        dialog?.close();
      } catch (error) {
        log.warn('a library action failed', { message: error?.message ?? String(error) });
        notify(error?.message ?? failure, { tone: 'error' });
      } finally {
        busy = false;
      }
    };

    const keepOpen = async (action, failure) => {
      if (busy) return;
      busy = true;
      try {
        await action();
      } catch (error) {
        log.warn('a library action failed', { message: error?.message ?? String(error) });
        notify(error?.message ?? failure, { tone: 'error' });
      } finally {
        busy = false;
      }
    };

    const rows = labels.map((label) =>
      labelRow(label, {
        current: label.id === current,
        onOpen: () => {
          if (label.id === current) {
            dialog?.close();
            return;
          }
          void runAndClose(() => onOpen(label), 'That label could not be opened.');
        },
        onDuplicate: () => void runAndClose(() => onDuplicate(label), 'That label could not be duplicated.'),
        onExport: () => void keepOpen(() => onExport(label), 'That label could not be exported.'),
        onDelete: async () => {
          const confirmed = await confirm(
            `Delete "${displayName(label)}"?`,
            'This deletes the label, its undo history and its saved view. It cannot be undone.',
            { confirmLabel: 'Delete', tone: 'danger' }
          );
          if (!confirmed) return;
          await runAndClose(() => onDelete(label), 'That label could not be deleted.');
        },
      })
    );

    const body = el(
      'div',
      { class: 'library' },
      el(
        'p',
        { class: 'hint' },
        'Open a saved label, or start a new one. Each label keeps its own design, undo history and last view.'
      ),
      rows.length
        ? el('ul', { class: 'label-list', 'aria-label': 'Saved labels' }, ...rows)
        : el(
            'div',
            { class: 'empty' },
            el('span', { class: 'icon' }, icon('layers', { size: 20 })),
            el('span', {}, 'No saved labels yet'),
            el('span', { class: 'hint' }, 'Use New label to start one')
          )
    );

    active = true;
    dialog = openModal({
      title: 'Labels',
      wide: true,
      body,
      onClose: () => {
        active = false;
      },
      actions: [
        // The shared dialog closes after an action resolves; a failed create
        // stays open so the operator can retry.
        {
          label: 'New label',
          tone: 'primary',
          onClick: async () => {
            if (busy) return true;
            busy = true;
            try {
              await onNew();
            } finally {
              busy = false;
            }
          },
        },
        {
          label: 'Import label',
          onClick: () => {
            // Close first, then open the existing hidden file input. Returning
            // true tells the shared dialog that this action already closed.
            if (busy) return true;
            dialog?.close();
            onImport();
            return true;
          },
        },
      ],
    });
  }

  return { open };
}
