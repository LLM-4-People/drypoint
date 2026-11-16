/**
 * Editor controller: owns the document, selection and undo history, and exposes
 * every mutation the UI can perform. No DOM, no rendering.
 */

import { createHistory, normaliseHistory } from '../label/history.js';
import {
  ELEMENT_TYPES,
  boundElementText,
  clampElement,
  createDocument,
  createElement,
  documentHeightPx,
  documentWidthPx,
  droppedSourceNotice,
  truncatedNotice,
  validateDocument,
} from '../label/schema.js';
import { CONFIG } from '../core/config.js';
import { clamp, createId, deepClone } from '../core/format.js';
import { geometry } from '../core/geometry.js';
import { sourceBudgetProblem } from '../label/images.js';

/**
 * @param {object} options
 * @param {object} [options.document] the starting label
 * @param {string|null} [options.selection] the restored selection; `null` is a
 *        deliberate deselection, `undefined` means no saved value
 * @param {{past?: object[], future?: object[]}|null} [options.history] persisted history
 * @param {(document: object) => void} [options.onChange] document publisher
 * @param {(selection: string|null) => void} [options.onSelection] selection publisher
 * @param {() => void} [options.onHistoryChange] history dirty signal
 * @param {(message: string) => void} [options.onRefusal] one refusal channel: a
 *        refused edit reaches the operator even when the stage summary is
 *        saturated with layout warnings
 */
export function createEditor({
  document: initial,
  selection: initialSelection,
  history: initialHistory = null,
  onChange = () => {},
  onSelection = () => {},
  onHistoryChange = () => {},
  onRefusal = () => {},
} = {}) {
  let document = validateDocument(initial ?? createDocument());

  const history = createHistory({
    initial: document,
    onChange: onHistoryChange,
  });
  // Hydrate silently: loading persisted history is not an edit and must not
  // create an undo step or a write of its own.
  if (initialHistory) history.restore({ present: document, ...normaliseHistory(initialHistory) }, { silent: true });

  const find = (id) => document.elements.find((element) => element.id === id) ?? null;
  const lastId = () => document.elements.at(-1)?.id ?? null;
  let selection;
  if (initialSelection === undefined) selection = lastId();
  else if (initialSelection === null) selection = null;
  else selection = find(initialSelection)?.id ?? lastId();

  /**
   * Notices the operator has answered. They live outside the history snapshot
   * on purpose: rewriting `history.present` would make an undo resurrect text
   * the operator already dismissed, and rewriting a snapshot would rewrite
   * history. Every publish path strips them instead.
   */
  const acknowledged = new Set();

  /** The document handed to the store: history keeps the original notices. */
  function publishable() {
    if (!document.notices?.length || acknowledged.size === 0) return document;
    const remaining = document.notices.filter((notice) => !acknowledged.has(notice));
    if (remaining.length === document.notices.length) return document;
    const next = { ...document };
    if (remaining.length) next.notices = remaining;
    else delete next.notices;
    return next;
  }

  /** Memo for documentForDisplay(): one copy per raw document, not one per render. */
  let displayCache = null;

  /**
   * The document every display path reads: the renderer, the stage footer, the
   * print confirmation and the print flow. History and `controller.document`
   * keep the original notices; an undo may therefore restore a snapshot that
   * still carries an answered notice, and this owner strips it again.
   */
  function documentForDisplay() {
    if (!document.notices?.length || acknowledged.size === 0) return document;
    if (displayCache?.source === document) return displayCache.value;
    const value = publishable();
    displayCache = { source: document, value };
    return value;
  }

  function emit({ commit = true, coalesceKey = null, coalesceMs, keepNotices = false } = {}) {
    // A deliberate edit supersedes the migration notices: they described the
    // document as it arrived, not the label the operator is now building.
    if (commit && !keepNotices && document.notices) {
      document = { ...document };
      delete document.notices;
    }
    if (commit) history.commit(document, { coalesceKey, coalesceMs });
    onChange(deepClone(documentForDisplay()));
  }

  /** Announce a selection change; document mutations never do this on their own. */
  function emitSelection() {
    onSelection(selection);
  }

  /** Append one operator-facing notice, bounded and deduplicated. */
  function addNotice(text) {
    const notices = document.notices ?? [];
    if (notices.includes(text)) return;
    document = { ...document, notices: [...notices, text].slice(0, CONFIG.bounds.maxNotices) };
  }

  /**
   * The collection cap, one owner for both ways an element enters the label.
   * `addElement` and `duplicateElement` must refuse at the same boundary: a
   * duplicate used to grow the label past what validation can keep on reload.
   */
  function refuseElementCap() {
    if (document.elements.length < CONFIG.bounds.maxElements) return false;
    publishRefusal(`A label holds at most ${CONFIG.bounds.maxElements} elements.`);
    return true;
  }

  /**
   * Publish one refusal: the toast-class channel and the document notice, once
   * each, bounded by the one notice list. A refusal is the newest fact, so when
   * the list is full the oldest entry gives way: the operator has already been
   * told it, and the alternative is an invisible refusal.
   *
   * The refusal is a toast-class fact, not a layout hint: with two hundred
   * overlapping elements the stage summary is saturated, so the operator would
   * otherwise see nothing at all when Add is refused.
   */
  function publishRefusal(notice) {
    if (document.notices?.includes(notice)) return false;
    onRefusal(notice);
    const notices = [...(document.notices ?? []), notice].slice(-CONFIG.bounds.maxNotices);
    document = { ...document, notices };
    emit({ commit: false, keepNotices: true });
    return true;
  }

  /**
   * The one source policy for every mutation that can add image text.
   *
   * `replacing` is the element an edit overwrites, so the decision is made on
   * the document the edit *would* produce. `sourceBudgetProblem` owns both
   * budgets: the distinct-source cap (the decode cache) and the image-text
   * budget (the serialised document, which repeats a source once per element and
   * therefore grows even when the source is reused). A source that another
   * element still uses keeps its slot.
   */
  function refuseImageSourceCap(element, replacing = null) {
    if (element?.type !== ELEMENT_TYPES.IMAGE || !element.src) return false;
    // The shared owner decides on the document this change would produce: the
    // replaced element is swapped for its new version, an add appends. Both
    // budgets and both messages live there, never here.
    const elements = replacing
      ? document.elements.map((each) => (each.id === replacing.id ? element : each))
      : [...document.elements, element];
    const problem = sourceBudgetProblem(
      { ...document, elements },
      { action: replacing ? 'replacing this image' : 'adding another image', refusal: true }
    );
    if (!problem) return false;
    publishRefusal(problem);
    return true;
  }

  /**
   * Report the content an edit had to bound: the same wording the load path
   * uses, so a truncation or a dropped source is never a silent rewrite.
   */
  function reportBoundedContent({ droppedSrc, truncated }) {
    const notices = [];
    if (droppedSrc) notices.push(droppedSourceNotice());
    if (truncated) notices.push(truncatedNotice());
    if (!notices.length) return false;
    // An edit answers the notices that described the document as it arrived,
    // but what this edit had to drop is a fact about the new document.
    document = { ...document };
    delete document.notices;
    for (const notice of notices) addNotice(notice);
    return true;
  }

  function updateElement(id, patch, { coalesceKey = null, coalesceMs } = {}) {
    const current = find(id);
    if (!current) return null;
    // A locked element accepts only its own lock/visibility switches. Geometry
    // and content edits (arrow keys, inspector, canvas drags) are rejected here,
    // at the one place every mutation passes through.
    const allowed = Object.keys(patch).every((key) => key === 'locked' || key === 'visible');
    if (current.locked && !allowed) return null;
    // The inspector edits a document that validation already produced, so it
    // bypasses validateDocument entirely; the same input-bound owner must still
    // cap what a paste can put into a field. Bounding runs before the source
    // cap so an over-long source is dropped with its notice, exactly as
    // addElement does, instead of being counted as a seventeenth image.
    const bounded = boundElementText({ ...current, ...patch });
    // A source edit is another way an image enters the document, so it meets
    // the same distinct-source cap addElement applies. Reusing a source that is
    // already on the label never consumes a slot.
    const changesSource = Object.prototype.hasOwnProperty.call(patch, 'src') && patch.src !== current.src;
    if (changesSource && refuseImageSourceCap(bounded.element, current)) return null;
    const elements = document.elements.map((element) =>
      element.id === id ? clampElement(bounded.element, document) : element
    );
    document = { ...document, elements };
    const reported = reportBoundedContent(bounded);
    // One undo step per gesture, per element: two elements dragged inside the
    // same coalesce window must still be two steps. Callers pass the gesture
    // name only; the owner adds the id.
    emit({ coalesceKey: coalesceKey ? `${coalesceKey}:${id}` : null, coalesceMs, keepNotices: reported });
    return find(id);
  }

  function addElement(type, props = {}) {
    // One cap at the collection owner: imported and scripted callers cannot
    // grow a label past what the renderer and the warning pass can handle.
    if (refuseElementCap()) return null;
    const bounded = boundElementText(createElement(type, props));
    if (refuseImageSourceCap(bounded.element)) return null;
    const element = clampElement(bounded.element, document);
    document = { ...document, elements: [...document.elements, element] };
    const reported = reportBoundedContent(bounded);
    selection = element.id;
    emit({ keepNotices: reported });
    emitSelection();
    return element;
  }

  function removeElement(id) {
    // Locking protects the element from every mutation, whatever control asked:
    // the layer trash, Delete/Backspace and the inspector all land here.
    if (find(id)?.locked) return false;
    document = { ...document, elements: document.elements.filter((element) => element.id !== id) };
    const hadSelection = selection === id;
    if (hadSelection) selection = document.elements.at(-1)?.id ?? null;
    emit();
    if (hadSelection) emitSelection();
    return true;
  }

  function duplicateElement(id) {
    const source = find(id);
    if (!source) return null;
    // The same collection cap as addElement: a duplicate is another element.
    if (refuseElementCap()) return null;
    // A copy of a locked element must be usable, so it always starts unlocked.
    const copy = clampElement(
      { ...deepClone(source), id: createId(source.type), x: source.x + 4, y: source.y + 4, locked: false },
      document
    );
    // A copy reuses the same source but adds another occurrence to the
    // serialised document; the shared budget still applies.
    if (refuseImageSourceCap(copy)) return null;
    document = { ...document, elements: [...document.elements, copy] };
    selection = copy.id;
    emit();
    emitSelection();
    return copy;
  }

  function reorder(id, direction) {
    const index = document.elements.findIndex((element) => element.id === id);
    if (index < 0) return;
    // Restacking is a geometry-class mutation: a locked element stays put.
    if (document.elements[index].locked) return;

    const target = clamp(index + direction, 0, document.elements.length - 1);
    if (target === index) return;
    const elements = [...document.elements];
    const [moved] = elements.splice(index, 1);
    elements.splice(target, 0, moved);
    document = { ...document, elements };
    emit();
  }

  function setDocumentLength(lengthMm) {
    const next = clamp(Math.round(lengthMm), CONFIG.geometry.minLengthMm, geometry().maxLengthMm);
    document = validateDocument({ ...document, lengthMm: next });
    // A preset click is a deliberate edit. Coalescing it with the next click
    // collapsed a sequence of presets into one undo step.
    emit();
  }

  /**
   * Re-apply the active geometry limits after the device reports its head and
   * dpi. A truncation changes what prints, so it is reported and committed
   * (undoable) instead of quietly rewriting the operator's label.
   */
  function revalidate() {
    const previous = document;
    const next = validateDocument(previous);
    if (JSON.stringify(next) === JSON.stringify(previous)) return false;
    const moved = next.elements.filter((element) => {
      const before = previous.elements.find((candidate) => candidate.id === element.id);
      return !before || ['x', 'y', 'w', 'h'].some((key) => before[key] !== element[key]);
    }).length;
    document = next;
    if (!find(selection)) selection = document.elements.at(-1)?.id ?? null;

    const parts = [];
    const elementsLabel = `${moved} element${moved === 1 ? '' : 's'}`;
    if (next.lengthMm !== previous.lengthMm) {
      const direction = next.lengthMm < previous.lengthMm ? 'shortened' : 'lengthened';
      parts.push(`Label ${direction} from ${previous.lengthMm} mm to ${next.lengthMm} mm to fit the printer`);
      parts.push(`${elementsLabel} moved or resized`);
    } else if (moved) {
      parts.push(`${elementsLabel} moved or resized to stay inside the label`);
    }
    if (parts.length) {
      document = { ...document, notices: [...(document.notices ?? []), `${parts.join('; ')}.`] };
    }
    emit({ keepNotices: true });
    return true;
  }

  /**
   * The operator accepted the label as it stands, so its migration notices are
   * answered. Metadata, not content: no undo step and no dirtying of the label.
   * The acknowledgement lives in the controller, not in a history snapshot, so
   * a later edit + undo cannot resurrect an answered notice.
   */
  function dismissNotices() {
    if (!document.notices?.length) return false;
    for (const notice of document.notices) acknowledged.add(notice);
    document = { ...document };
    delete document.notices;
    emit({ commit: false, keepNotices: true });
    return true;
  }

  function patchDocument(patch, { coalesceKey = null } = {}) {
    document = validateDocument({ ...document, ...patch });
    emit({ coalesceKey });
  }

  /**
   * Replace the open label from a persisted payload.
   *
   * This is a load, not an edit: the document and both history stacks are
   * replaced without a commit, so switching labels never appears as an undo
   * step. The document and selection are announced for the UI, and the history
   * is marked dirty so the caller's persistence owner can write the loaded
   * (normalised) stacks for the label it now owns.
   */
  function loadDocument(next, { history: nextHistory = null, selection: nextSelection } = {}) {
    acknowledged.clear();
    displayCache = null;
    document = validateDocument(next);
    history.restore({ present: document, ...normaliseHistory(nextHistory) }, { silent: true });
    if (nextSelection === undefined) selection = lastId();
    else if (nextSelection === null) selection = null;
    else selection = find(nextSelection)?.id ?? lastId();
    onChange(deepClone(documentForDisplay()));
    onSelection(selection);
    onHistoryChange();
  }

  function replaceDocument(next) {
    // A different label has its own notices: nothing carries over from the
    // previous label, but the incoming document's own notices are facts about
    // it (a shortened text, a dropped element) and they stay published. The
    // toast is a transient hint, never the record.
    acknowledged.clear();
    displayCache = null;
    document = validateDocument(next);
    selection = document.elements.at(-1)?.id ?? null;
    // Commit instead of reset so applying a template is an undoable edit, and
    // announce the new selection so the inspector rebinds to the new elements.
    emit({ keepNotices: true });
    emitSelection();
  }

  function select(id) {
    if (selection === id) return;
    selection = id;
    emitSelection();
  }

  function undo() {
    const previous = history.undo();
    if (!previous) return false;
    document = previous;
    if (!find(selection)) selection = document.elements.at(-1)?.id ?? null;
    onChange(deepClone(documentForDisplay()));
    onSelection(selection);
    return true;
  }

  function redo() {
    const next = history.redo();
    if (!next) return false;
    document = next;
    if (!find(selection)) selection = document.elements.at(-1)?.id ?? null;
    onChange(deepClone(documentForDisplay()));
    onSelection(selection);
    return true;
  }

  /** Align the selected element inside the label. */
  function alignElement(id, axis) {
    const element = find(id);
    if (!element) return;
    const width = documentWidthPx(document);
    const height = documentHeightPx(document);
    const patch = {};
    if (axis === 'left') patch.x = 0;
    if (axis === 'centerX') patch.x = Math.round((width - element.w) / 2);
    if (axis === 'right') patch.x = width - element.w;
    if (axis === 'top') patch.y = 0;
    if (axis === 'centerY') patch.y = Math.round((height - element.h) / 2);
    if (axis === 'bottom') patch.y = height - element.h;
    updateElement(id, patch);
  }

  function rotateElement(id, delta = 90) {
    const element = find(id);
    if (!element) return;
    updateElement(id, { rotation: (element.rotation + delta + 360) % 360 });
  }

  return {
    get document() {
      return document;
    },
    /** The renderer/print view: the same document without answered notices. */
    documentForDisplay,
    get selection() {
      return selection;
    },
    get selected() {
      return find(selection);
    },
    canUndo: () => history.canUndo(),
    canRedo: () => history.canRedo(),
    /** The persisted half of the undo history, deep-cloned by the owner. */
    historyState: () => history.snapshot(),
    updateElement,
    addElement,
    removeElement,
    duplicateElement,
    reorder,
    setDocumentLength,
    revalidate,
    dismissNotices,
    patchDocument,
    loadDocument,
    replaceDocument,
    select,
    undo,
    redo,
    alignElement,
    rotateElement,
    elementTypes: ELEMENT_TYPES,
  };
}
