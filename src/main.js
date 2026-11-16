/**
 * Composition root: wires the editor, panels, device manager and print flow.
 * No business logic lives here — only orchestration.
 */

import { CONFIG, storageKey } from './core/config.js';
import { geometry } from './core/geometry.js';
import { $, on, el, downloadJson, downloadText, captureFocus, restoreFocus, movePreservingFocus, setText } from './core/dom.js';
import { round1 } from './core/format.js';
import { createLogger, setLogLevel, getLogEntries, exportLogReport } from './core/log.js';
import { bootOfflineShell } from './core/precache-status.js';
import { getSetting, printSettingsSnapshot, setSetting, settingsStore, takeSettingsLoadIssue } from './core/settings.js';
import { createStore } from './core/store.js';
import { icon } from './ui/icons.js';
import { toast } from './ui/toast.js';
import { confirmDialog, openModal } from './ui/modal.js';
import { createEditor } from './editor/controller.js';
import { isFieldElement, shortcutIntent } from './editor/shortcuts.js';
import { createCanvasEditor } from './editor/canvas.js';
import { pickImageFile } from './editor/image-import.js';
import { createLayersPanel } from './ui/layers.js';
import { createInspector } from './ui/inspector.js';
import { clampZoom, fitZoom, placementPlan, shouldClampZoom, stepZoom, wheelZoom } from './ui/stage-layout.js';
import { createPrintPanel } from './ui/print-panel.js';
import { connectionStatus, createPrintFlow, printButtonState } from './ui/print-flow.js';
import { reportDisconnect } from './ui/disconnect-report.js';
import { openSettingsSheet } from './ui/settings-sheet.js';
import { applyTheme as applyThemeSetting } from './ui/theme.js';
import { createSaveFailureNotice } from './ui/save-failure.js';
import { createStorageAlert } from './ui/storage-alert.js';
import { labelCanvasName } from './ui/canvas-name.js';
import { createDeviceManager } from './device/manager.js';
import { applyRollProfile } from './device/roll-profiles.js';
import { describeDeviceStatus, labelTypeName, supportGate } from './device/capabilities.js';
import { resolveRenderOptions } from './device/print-options.js';
import { createDocument, createElement, documentHeightPx, documentWidthPx, exceedsPrinterLimits, hydrateStoredDocument, newElementFrame, ELEMENT_TYPES } from './label/schema.js';
import { summariseWarnings } from './label/render.js';
import { TEMPLATES, testDocument } from './label/templates.js';
import { barcodeFitMessage, barcodeFrame } from './label/barcode.js';
import { createVisibleImageHydrator, hydrateImages, sourceBudgetProblem } from './label/images.js';
import { documentFilename, parseDocument, serializeDocument, transferTooLargeMessage, TRANSFER_MAX_BYTES } from './label/transfer.js';

const log = createLogger('main');

const ui = {
  docName: $('#docName'),
  undo: $('#undoButton'),
  redo: $('#redoButton'),
  deviceButton: $('#deviceButton'),
  deviceDot: $('#deviceDot'),
  deviceLabel: $('#deviceLabel'),
  deviceShortLabel: $('#deviceShortLabel'),
  settingsButton: $('#settingsButton'),
  rail: $('#toolRail'),
  layerList: $('#layerList'),
  layerCount: $('#layerCount'),
  templateList: $('#templateList'),
  exportDocument: $('#exportDocumentButton'),
  importDocument: $('#importDocumentButton'),
  importDocumentInput: $('#importDocumentInput'),
  labelSize: $('#labelSize'),
  labelPx: $('#labelPx'),
  zoomControls: $('#zoomControls'),
  labelCanvas: $('#labelCanvas'),
  overlayCanvas: $('#overlayCanvas'),
  stageScroll: $('#stageScroll'),
  stageNameSlot: $('#stageNameSlot'),
  stageHint: $('#stageHint'),
  tabs: $('#panelTabs'),
  panelBody: $('#panelBody'),
  status: $('#status'),
  progress: $('#progressBar'),
  printButton: $('#printButton'),
  testButton: $('#testButton'),
  printGateReason: $('#printGateReason'),
  modalRoot: $('#modalRoot'),
};

/* ---------------- document ---------------- */

/** One owner of "the label is not being saved", shared by every failure. */
const saveFailure = createSaveFailureNotice();
/**
 * The stored label could not be read: keep the raw text and refuse to write
 * until the operator exports it or resets the label. Created before the store,
 * because the store's load failure is what fills it.
 */
const storageAlert = createStorageAlert({
  container: $('#storageAlert'),
  textNode: $('#storageAlertText'),
  exportButton: $('#storageExportRaw'),
  resetButton: $('#storageReset'),
  // The raw value is written exactly as storage held it: JSON.stringify would
  // refuse to round-trip the truncation that made it unreadable.
  exportRaw: (filename) => downloadText(filename, storageAlert.raw ?? '', 'application/json'),
  onReset: () => {
    // The operator answered: the current label replaces the unreadable value,
    // as one write, now.
    documentStore.replace(controller.documentForDisplay());
    toast('The unreadable label was reset', { tone: 'ok' });
  },
  toast,
});
/**
 * The label is persisted raw (no version envelope) through the shared store:
 * one debounce, one failure channel, and a dirty flag that pagehide can trust.
 */
const documentStore = createStore(createDocument(), {
  key: storageKey('document'),
  envelope: false,
  // Storage is a trust boundary: a value that is not a label is refused, and
  // its raw text is quarantined instead of being replaced by a fresh label.
  hydrate: (data) => hydrateStoredDocument(data),
  persistMs: CONFIG.ui.debounceMs,
  // No write may overwrite a value the operator has not answered yet.
  canPersist: () => !storageAlert.active,
  onError: (error, phase, context) => {
    if (phase === 'persist') saveFailure.report(error);
    else if (!storageAlert.capture(context?.raw ?? null, error)) log.warn('stored label could not be read', { message: error.message });
  },
  onPersist: saveFailure.clear,
});

const device = createDeviceManager();
/** Zoom is a view preference: a storage failure must not stop the app. */
function loadZoom() {
  try {
    return clampZoom(localStorage.getItem(storageKey('zoom')));
  } catch (error) {
    log.warn('stored zoom could not be read', { message: error.message });
    return CONFIG.ui.zoom.default;
  }
}
function saveZoom() {
  try {
    localStorage.setItem(storageKey('zoom'), String(zoom));
  } catch (error) {
    log.warn('could not persist zoom', { message: error.message });
  }
}
let zoom = loadZoom();
/**
 * The last scale an automatic fit chose (boot, Fit, stage clamp, document
 * change). A user zoom is anything else: the stage must not silently replace
 * it on a plain resize.
 */
let autoZoom = null;

const controller = createEditor({
  document: documentStore.get(),
  onChange: (document) => {
    documentStore.replace(document);
    rerender();
  },
  onSelection: () => {
    inspector.render();
    layers.render();
  },
  // One refusal channel: an Add that the element or image budget refused is a
  // fact about the click, not a layout hint, so it must not be buried in a
  // saturated stage summary.
  onRefusal: (message) => {
    log.warn('editor refused a change', { message });
    toast(message, { tone: 'error' });
  },
});

const canvasEditor = createCanvasEditor({
  labelCanvas: ui.labelCanvas,
  overlayCanvas: ui.overlayCanvas,
  controller,
  getZoom: () => zoom,
  getEditorPrefs: () => ({
    snap: getSetting('editor.snap'),
    grid: getSetting('editor.grid'),
    gridMm: Number(getSetting('editor.gridMm')),
    showGuides: getSetting('editor.showGuides'),
  }),
  getRenderOptions: () => resolveRenderOptions(printSettingsSnapshot()),
  scrollContainer: ui.stageScroll,
});

/**
 * The print flow owns the in-flight guard and the job state. It is created
 * before the settings subscription below, whose immediate first call renders
 * the shell and therefore reads `printFlow.printing`.
 */
const printFlow = createPrintFlow({
  device,
  getDocument: () => controller.documentForDisplay(),
  getSettings: printSettingsSnapshot,
  setStatus,
  setProgress,
  onWarnings: setStageWarnings,
  dismissNotices: () => controller.dismissNotices(),
  revalidate: () => controller.revalidate(),
  onPrintingChange: setPrintingView,
  onFinishingChange: setFinishingView,
});

/* ---------------- compact layout ---------------- */

const compactQuery = window.matchMedia(`(max-width: ${CONFIG.ui.compactBreakpointPx}px)`);
/** The layout at the last viewport pass, so a breakpoint change is detectable. */
let lastCompact = compactQuery.matches;
const docNameHome = ui.docName.parentElement;
const workspace = $('.workspace');
const sidebar = workspace.querySelector('.sidebar');
const stage = workspace.querySelector('.stage');
const inspectorPanel = workspace.querySelector('.inspector');
const rail = sidebar.querySelector('.rail');

/**
 * The action bar is the one measured owner of the clearance every fixed and
 * scroll consumer reads.
 *
 * The bar grows when the status text takes its own compact line, and its own
 * padding already contains the safe-area inset. A static token cannot follow
 * either, and adding env() to a measured value would count the inset twice:
 * publish offsetHeight (the full painted height) plus a small gap, and let CSS
 * consume the one value.
 */
const actionbar = $('.actionbar');
const ACTIONBAR_GAP_PX = 8;
function publishActionbarClearance() {
  if (!actionbar) return;
  const clearance = Math.ceil(actionbar.offsetHeight) + ACTIONBAR_GAP_PX;
  document.documentElement.style.setProperty('--actionbar-clearance', `${clearance}px`);
}
// ResizeObserver defaults to the content box; a safe-area inset changes the
// bar's padding and border-box height without changing its content box, which
// is why the inset-only change used to leave the token stale.
if (actionbar && typeof ResizeObserver === 'function') {
  new ResizeObserver(publishActionbarClearance).observe(actionbar, { box: 'border-box' });
}
// A safe-area inset can change without the bar's own box changing first (a
// navigation bar sliding away, a rotation); the viewport events make the
// measured token follow the inset instead of only the action-bar observer.
on(window, 'resize', publishActionbarClearance);
window.visualViewport?.addEventListener('resize', publishActionbarClearance);
publishActionbarClearance();

/**
 * Compact widths keep the label name in the sticky design header instead of
 * hiding it. The same input is moved, never duplicated, so there is still one
 * control and one source of truth.
 */
function placeDocName() {
  const plan = placementPlan({ compact: compactQuery.matches });
  const target = plan.docNameInStage ? ui.stageNameSlot : docNameHome;
  if (ui.docName.parentElement === target) return;
  movePreservingFocus(ui.docName, () => target.append(ui.docName));
}

/**
 * Compact widths show the sticky stage above the sidebar. Move the same node
 * so DOM order follows the visual order: otherwise Tab jumps from the stage
 * footer back up to the stage, because `order` changes paint order only.
 */
function placeStage() {
  const plan = placementPlan({ compact: compactQuery.matches });
  if (plan.stageBeforeSidebar) {
    if (workspace.firstElementChild !== stage) movePreservingFocus(stage, () => workspace.prepend(stage));
  } else if (stage.previousElementSibling !== sidebar) {
    movePreservingFocus(stage, () => sidebar.after(stage));
  }
}

/**
 * Compact widths put the inspector directly under the add-element rail, so the
 * tabs and the selected element's fields are not buried below Layers and
 * Templates. Desktop restores the three-column workspace order.
 */
function placeInspector() {
  const plan = placementPlan({ compact: compactQuery.matches });
  if (plan.inspectorAfterRail) {
    if (inspectorPanel.parentElement !== sidebar || inspectorPanel.previousElementSibling !== rail) {
      movePreservingFocus(inspectorPanel, () => rail.after(inspectorPanel));
    }
  } else if (inspectorPanel.parentElement !== workspace) {
    movePreservingFocus(inspectorPanel, () => workspace.append(inspectorPanel));
  }
}

/** The raw stage viewport the fit math measures. */
function stageViewport() {
  // On compact widths the stage owns a fixed height (40vh), so the fit is not
  // chasing the canvas it is sizing. getComputedStyle resolves that constant to
  // pixels; on desktop it resolves the stage row the grid already sized.
  const height = parseFloat(getComputedStyle(ui.stageScroll).height);
  const available = Number.isFinite(height) && height > 0 ? height : ui.stageScroll.clientHeight;
  return { availableWidth: ui.stageScroll.clientWidth, availableHeight: available };
}

/**
 * Largest scale at which the label fits the stage, for the current layout.
 * Desktop has no compact max-height cap, but a default 200% scale still clips a
 * label between 901 and 1100 px, so the same fit owner serves both layouts.
 */
function stageFitZoom() {
  const document = controller.document;
  return fitZoom({
    docWidth: documentWidthPx(document),
    docHeight: documentHeightPx(document),
    ...stageViewport(),
    compact: compactQuery.matches,
  });
}

function clampZoomToStage() {
  const compact = compactQuery.matches;
  const breakpointChanged = compact !== lastCompact;
  lastCompact = compact;
  // A deliberate user zoom survives a plain resize; the stage only refits its
  // own automatic scale, or when the breakpoint itself changed the stage size.
  if (!shouldClampZoom({ zoom, autoZoom, breakpointChanged })) return;
  const fit = stageFitZoom();
  if (fit === null || (zoom <= fit && !breakpointChanged)) return;
  autoZoom = fit;
  applyZoom(fit, { persist: false });
}

/**
 * The compact fit depends on the label length, so a document-size change
 * re-fits the stage: a longer label must shrink, and a shorter one may grow
 * back. Only a size change triggers it, so a manual zoom is kept through a
 * plain resize; the flag stops setZoom → rerender → refit recursion.
 */
let fitKey = '';
let adjustingZoom = false;
function refitForDocument() {
  const key = `${documentWidthPx(controller.document)}x${documentHeightPx(controller.document)}`;
  if (key === fitKey) return;
  fitKey = key;
  if (adjustingZoom) return;
  // On desktop a document-size change only re-fits while the automatic scale
  // is still on screen; a deliberate user zoom is not replaced.
  if (!compactQuery.matches && zoom !== autoZoom) return;
  const fit = stageFitZoom();
  if (fit === null) return;
  adjustingZoom = true;
  autoZoom = fit;
  try {
    applyZoom(fit, { persist: false });
  } finally {
    adjustingZoom = false;
  }
}

/* ---------------- panels ---------------- */

const designPanel = el('div', {});
const printPanelHost = el('div', { hidden: true });
ui.panelBody.append(designPanel, printPanelHost);

const layers = createLayersPanel({
  container: ui.layerList,
  countNode: ui.layerCount,
  controller,
});

const inspector = createInspector({
  container: designPanel,
  controller,
  onPickImage: () =>
    pickImageFile().catch((error) => {
      log.warn('image pick failed', { message: error.message });
      toast(error.message, { tone: 'error' });
      return null;
    }),
});

const printPanel = createPrintPanel({
  container: printPanelHost,
  device,
  controller,
  onOpenLog: openLogViewer,
  onExport: exportDiagnostics,
});

/* ---------------- rendering ---------------- */

function rerender() {
  const warnings = canvasEditor.render();
  const active = geometry();
  ui.labelSize.textContent = `${round1(active.widthMm)} × ${controller.document.lengthMm} mm`;
  // The canvas is the label: its accessible name carries the size and how much
  // is on it, written only when it changes.
  const canvasName = labelCanvasName({
    widthMm: active.widthMm,
    lengthMm: controller.document.lengthMm,
    count: controller.document.elements.length,
  });
  if (ui.labelCanvas.getAttribute('aria-label') !== canvasName) ui.labelCanvas.setAttribute('aria-label', canvasName);
  ui.labelPx.textContent = `${documentWidthPx(controller.document)} × ${documentHeightPx(controller.document)} px · ${round1(active.dotsPerMm)} dots/mm (${active.dpi ?? 'unknown'} dpi${active.reported ? '' : ' assumed'})`;
  setStageWarnings(warnings);
  layers.render();
  inspector.sync();
  printPanel.sync();
  ui.undo.disabled = !controller.canUndo();
  ui.redo.disabled = !controller.canRedo();
  const name = controller.document.name ?? '';
  // Never rewrite a field the user is editing: the caret would jump.
  if (document.activeElement !== ui.docName && ui.docName.value !== name) ui.docName.value = name;
  updatePrintButton();
  refitForDocument();
  // The hydrator needs the document: `imageSources(undefined)` is empty, so a
  // reveal after boot would never start the decode and stay "still loading".
  hydrateVisibleImages(controller.document);
}

/**
 * Decode any visible image the document reveals without a load. Hidden images
 * are never decoded (they are not painted), so making one visible has to start
 * its decode here; otherwise the canvas shows "still loading" forever. The
 * hydrator attempts each source once per document revision, so an evicted
 * source cannot start a decode/render loop above the cache limit.
 */
const hydrateVisibleImages = createVisibleImageHydrator({
  onSettled: () => {
    canvasEditor.invalidate();
    rerender();
  },
});

/** One owner for the stage footer text, shared by the canvas and print flow. */
function setStageWarnings(report) {
  // The shared setText owner skips identical text, so a rerender with the same
  // warnings produces no DOM mutation for the status role to announce.
  setText(ui.stageHint, summariseWarnings(report));
}

/**
 * Decode every image the document references, then invalidate and repaint.
 * The painter is synchronous, so this is the one owner of "document images are
 * ready"; without it a restored image document paints an empty hole until an
 * unrelated edit happens to re-render it.
 */
async function hydrateAndRepaint(document = controller.document) {
  try {
    await hydrateImages(document);
  } catch (error) {
    log.warn('image hydration failed', { message: error.message });
    toast(error.message, { tone: 'error' });
  } finally {
    canvasEditor.invalidate();
    rerender();
  }
}

/* ---------------- theme ---------------- */

function applyTheme() {
  applyThemeSetting({
    theme: getSetting('appearance.theme'),
    prefersDark: window.matchMedia('(prefers-color-scheme: dark)').matches,
    root: document.documentElement,
    meta: document.querySelector('meta[name="theme-color"]'),
    // The APK shell paints its system bars from the same token; the bridge is
    // absent in a browser.
    bridge: typeof window !== 'undefined' ? window.NiimbotBLE : null,
  });
  document.documentElement.dataset.accent = getSetting('appearance.accent');
}

settingsStore.subscribe(() => {
  // The settings store is the one place a change is applied: the Print panel
  // used to apply the level too, so a change made elsewhere left it stale.
  setLogLevel(getSetting('diagnostics.logLevel'));
  applyTheme();
  rerender();
});

window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);

/* ---------------- toolbar ---------------- */

const RAIL = [
  { type: ELEMENT_TYPES.TEXT, icon: 'text', title: 'Add text' },
  { type: ELEMENT_TYPES.QR, icon: 'qr', title: 'Add QR code' },
  { type: ELEMENT_TYPES.BARCODE, icon: 'barcode', title: 'Add barcode' },
  { type: ELEMENT_TYPES.IMAGE, icon: 'image', title: 'Add image' },
  { type: ELEMENT_TYPES.RECT, icon: 'rect', title: 'Add frame' },
];

for (const item of RAIL) {
  const button = el('button', { type: 'button', title: item.title, 'aria-label': item.title }, icon(item.icon, { size: 17 }));
  on(button, 'click', () => addElement(item.type));
  ui.rail.append(button);
}

async function addElement(type) {
  const width = documentWidthPx(controller.document);
  const height = documentHeightPx(controller.document);
  const pad = CONFIG.geometry.paddingPx;

  if (type === ELEMENT_TYPES.IMAGE) {
    let image;
    try {
      image = await pickImageFile();
    } catch (error) {
      log.warn('image pick failed', { message: error.message });
      toast(error.message, { tone: 'error' });
      return;
    }
    if (!image) return;
    const frame = newElementFrame(type, controller.document);
    const added = controller.addElement(type, { src: image.src, ...frame, x: pad, y: Math.round(height / 2 - frame.h / 2) });
    // A refused add (the element or image-source cap) already reported its
    // reason; claiming "Image added" would contradict it.
    if (!added) return;
    toast('Image added', { tone: 'ok' });
    await hydrateAndRepaint();
    return;
  }

  // Only a barcode needs the fit check; building the other boxes never warns.
  const sizes = type === ELEMENT_TYPES.BARCODE ? barcodeSizes(width, height, pad) : newElementFrame(type, controller.document);
  // The label cannot hold the symbol at all: say why instead of adding an
  // element that would never render.
  if (!sizes) return;

  // addElement announces the new selection; onSelection is the only path that
  // renders the inspector, so there is nothing to call here.
  controller.addElement(type, {
    ...sizes,
    x: Math.round((width - sizes.w) / 2),
    y: Math.round((height - sizes.h) / 2),
  });
}

/** Box for a new barcode, or null after explaining that the label is too short. */
function barcodeSizes(width, height, pad) {
  const prototype = createElement(ELEMENT_TYPES.BARCODE);
  const frame = barcodeFrame({
    labelWidthPx: width,
    labelHeightPx: height,
    paddingPx: pad,
    value: prototype.value,
    symbology: prototype.symbology,
  });
  if (frame.fits) return { w: frame.w, h: frame.h, rotation: 0 };
  const message = barcodeFitMessage({
    minimumWidthPx: frame.minimumWidthPx,
    availableWidthPx: frame.availableWidthPx,
    dotsPerMm: geometry().dotsPerMm,
  });
  log.warn('barcode does not fit the label', {
    minimumWidthPx: frame.minimumWidthPx,
    availableWidthPx: frame.availableWidthPx,
  });
  toast(message, { tone: 'error' });
  return null;
}

for (const template of TEMPLATES) {
  const button = el('button', { type: 'button', onClick: () => applyTemplate(template) }, template.label);
  ui.templateList.append(button);
}

function applyTemplate(template) {
  controller.replaceDocument(template.build());
  toast(`${template.label} template applied`, { tone: 'ok' });
  void hydrateAndRepaint();
}

/* ---------------- document transfer ---------------- */

/**
 * Export the label through the one download owner. The file name carries a
 * timestamp because the Android bridge refuses a display name Downloads
 * already holds.
 */
function exportDocument() {
  // Both source budgets are authoring boundaries, not normalise steps: a
  // document that already exists in memory is exported or refused whole, with
  // the importer's own decision and wording, so an export always re-imports.
  const problem = sourceBudgetProblem(controller.document, { action: 'exporting this label' });
  if (problem) {
    log.warn('label export refused an over-budget document', { message: problem });
    toast(problem, { tone: 'error' });
    return;
  }
  try {
    const saved = downloadJson(documentFilename(controller.document.name), serializeDocument(controller.document));
    if (saved === false) {
      log.warn('label export was refused by the save bridge');
      toast('Could not save the label file', { tone: 'error' });
      return;
    }
    toast('Label exported', { tone: 'ok' });
  } catch (error) {
    log.error('label export failed', { message: error?.message ?? String(error) });
    toast(`Could not export the label: ${error?.message ?? String(error)}`, { tone: 'error' });
  }
}

/**
 * Read one picked file, refusing an over-size file before reading it. Parsing,
 * validation and notices belong to `label/transfer.js`; applying the result
 * goes through `replaceDocument`, which is one undoable step.
 */
async function importDocumentFile(file) {
  const size = Number(file?.size);
  if (!Number.isFinite(size) || size < 0) {
    log.warn('label import could not read the file size');
    toast('That label file could not be read.', { tone: 'error' });
    return;
  }
  if (size > TRANSFER_MAX_BYTES) {
    log.warn('label import refused an over-size file', { bytes: size, limit: TRANSFER_MAX_BYTES });
    toast(transferTooLargeMessage(size), { tone: 'error' });
    return;
  }
  let text;
  try {
    text = await file.text();
  } catch (error) {
    log.warn('label import could not read the file', { message: error?.message ?? String(error) });
    toast('That label file could not be read.', { tone: 'error' });
    return;
  }
  try {
    const { document, notices } = parseDocument(text);
    controller.replaceDocument(document);
    if (notices.length) {
      log.warn('label imported with notices', { notices: notices.length });
      // The same summary owner as the stage footer, so a notice is never
      // rendered as an unbounded toast. The import succeeded; its info tone is
      // deliberate even though it names content that had to be shortened.
      toast(`Label imported. ${summariseWarnings({ warnings: notices, hidden: 0 })}`);
    } else {
      toast('Label imported', { tone: 'ok' });
    }
    await hydrateAndRepaint();
  } catch (error) {
    log.warn('label import failed', { message: error?.message ?? String(error) });
    toast(error?.message ?? 'That label file could not be imported.', { tone: 'error' });
  }
}

ui.exportDocument.addEventListener('click', exportDocument);
ui.importDocument.addEventListener('click', () => ui.importDocumentInput.click());
ui.importDocumentInput.addEventListener('change', () => {
  const file = ui.importDocumentInput.files?.[0];
  // Clearing lets the same file be chosen again after a failed import.
  ui.importDocumentInput.value = '';
  if (file) void importDocumentFile(file);
});

/* ---------------- zoom ---------------- */

function setZoom(delta) {
  // One quantized manual step owns the floor, the cap and the rounding. The
  // floor follows the value on screen, so Zoom out at a 20% Fit never jumps to
  // the 50% manual floor.
  applyZoom(stepZoom(zoom, delta, { compact: compactQuery.matches }), { persist: true });
}

/**
 * Apply a scale a caller has already resolved and bounded. Only a user action
 * persists the shared `drypoint.zoom` key: an automatic fit for this viewport must
 * not overwrite the zoom a desktop session chose.
 */
function applyZoom(value, { persist = false } = {}) {
  zoom = value;
  if (persist) saveZoom();
  updateZoomLabel();
  canvasEditor.invalidate();
  rerender();
}

function applyFitZoom() {
  const scale = stageFitZoom();
  // fitZoom owns the floor and the clamp; setZoom's manual floor would clip
  // the label again.
  if (scale !== null) {
    autoZoom = scale;
    applyZoom(scale, { persist: false });
  }
}

function updateZoomLabel() {
  const value = ui.zoomControls.querySelector('.zoom-value');
  if (value) value.textContent = `${Math.round(zoom * 100)}%`;
}

const zoomWrap = el(
  'div',
  { class: 'zoom' },
  el('button', { type: 'button', title: 'Zoom out', 'aria-label': 'Zoom out', onClick: () => setZoom(-CONFIG.ui.zoom.step) }, icon('zoomOut', { size: 15 })),
  el('span', { class: 'zoom-value' }, `${Math.round(zoom * 100)}%`),
  el('button', { type: 'button', title: 'Zoom in', 'aria-label': 'Zoom in', onClick: () => setZoom(CONFIG.ui.zoom.step) }, icon('zoomIn', { size: 15 })),
  el('button', { type: 'button', title: 'Fit', 'aria-label': 'Fit to screen', onClick: applyFitZoom }, icon('fit', { size: 15 }))
);
ui.zoomControls.append(zoomWrap);

let viewportFrame = 0;

/**
 * The breakpoint CSS hides a region (the stage name slot, the top-bar name)
 * before the media-query listener runs, so the browser has already blurred the
 * control whose focus must survive the move. Remember that blur, including the
 * caret, and hand it back after the regions have moved.
 */
const movableRegions = Object.freeze([ui.docName, stage, inspectorPanel]);
let lostFocus = null;

on(document, 'focusout', (event) => {
  const target = event.target;
  if (!movableRegions.some((region) => region === target || region.contains(target))) return;
  const snapshot = captureFocus(target);
  if (snapshot) lostFocus = { ...snapshot, at: performance.now() };
});
on(document, 'focusin', () => {
  lostFocus = null;
});

function restoreLostFocus() {
  const snapshot = lostFocus;
  lostFocus = null;
  if (!snapshot?.node?.isConnected) return false;
  // Only a recent layout change may reclaim focus; a field blurred much
  // earlier belongs to whatever the user is doing now.
  if (performance.now() - snapshot.at > 500) return false;
  const active = document.activeElement;
  if (active && active !== document.body) return false;
  return restoreFocus(snapshot);
}

function onViewportChange() {
  cancelAnimationFrame(viewportFrame);
  viewportFrame = requestAnimationFrame(() => {
    placeStage();
    placeInspector();
    placeDocName();
    restoreLostFocus();
    clampZoomToStage();
  });
}
compactQuery.addEventListener('change', onViewportChange);
on(window, 'resize', onViewportChange);
on(window, 'orientationchange', onViewportChange);

on(ui.stageScroll, 'wheel', (event) => {
  if (!event.ctrlKey && !event.metaKey) return;
  event.preventDefault();
  // The wheel is its own zoom path: unquantized so small trackpad deltas
  // accumulate, and a user action, so the chosen scale is persisted.
  applyZoom(wheelZoom(zoom, event.deltaY, { compact: compactQuery.matches }), { persist: true });
});

/* ---------------- device wiring ---------------- */

function setDeviceState() {
  const status = describeDeviceStatus(device.state);
  ui.deviceDot.dataset.state = status.dot;
  ui.deviceLabel.textContent = status.label;
  ui.deviceShortLabel.textContent = status.shortLabel;
  ui.deviceButton.title = status.title;
  // The accessible name must contain the visible text (WCAG 2.5.3).
  ui.deviceButton.setAttribute('aria-label', status.ariaLabel);
  printPanel.render();
  updatePrintButton();
}

device.events.on('state', setDeviceState);

device.events.on('discovered', (capabilities) => {
  // The device may report a different head width / dpi and a shorter maximum
  // length than the document was authored for; re-apply the geometry limits.
  const changed = controller.revalidate();
  // A new head or dpi resizes the canvas backing store even when the document
  // in millimetres is untouched. revalidate() emits only on a document change,
  // so force one repaint for the geometry-only case.
  if (!changed) {
    canvasEditor.invalidate();
    rerender();
  }
  printPanel.render();
  // The post-print refresh also publishes this event, while `#status` belongs
  // to the finished job: the connection line must not overwrite the outcome.
  const line = connectionStatus({ jobBusy: printFlow.busy, remaining: capabilities.roll?.remaining });
  if (line) setStatus(line, 'ok');
});

device.events.on('roll-profile', (profile) => {
  const applied = applyRollProfile(profile, {
    capabilities: device.state.capabilities,
    lengthMm: controller.document.lengthMm,
    labelType: getSetting('print.labelType'),
    setLength: (value) => controller.setDocumentLength(value),
    setLabelType: (value) => setSetting('print.labelType', value),
  });
  if (!applied.length) return;
  const summary = applied
    .map(({ field, value }) => (field === 'length' ? `${value} mm` : labelTypeName(value)))
    .join(' and ');
  toast(`Applied saved ${summary} for this roll`, { tone: 'ok' });
});

device.events.on('printer-error', (error) => {
  // One channel per message: errors go to the toast (the single error live
  // region); #status carries job state only, so nothing is announced twice.
  toast(error.message, { tone: 'error' });
});

device.events.on('disconnected', () => {
  setDeviceState();
  // The same owner reports every lost link: an idle disconnect is status only,
  // while a job phase makes it one specific toast. The print flow stays silent
  // for a lost link, so the operator never hears two versions of one event.
  reportDisconnect({ phase: printFlow.phase, setStatus });
});

/**
 * The header pill is a real connection control: offline it starts the browser's
 * printer picker (inside this user gesture), connected it opens the Print tab.
 */
ui.deviceButton.addEventListener('click', async () => {
  if (device.connected || device.state.status === 'connecting') {
    switchTab('print');
    return;
  }
  try {
    await device.connect();
    switchTab('print');
  } catch (error) {
    // Cancelling the browser's port picker is a normal outcome, never an error.
    if (error?.cancelled) {
      log.debug('printer selection cancelled');
      return;
    }
    log.warn('connect from header failed', { message: error.message });
    toast(error.message, { tone: 'error' });
  }
});

/* ---------------- status ---------------- */

let statusTimer = 0;
function setStatus(text, tone = '') {
  ui.status.textContent = text;
  ui.status.dataset.tone = tone;
  clearTimeout(statusTimer);
  if (tone) {
    statusTimer = setTimeout(() => {
      ui.status.textContent = device.connected ? 'Ready' : '';
      ui.status.dataset.tone = '';
    }, CONFIG.ui.statusHoldMs);
  }
}

function setProgress(ratio) {
  ui.progress.style.width = `${Math.round(Math.min(1, Math.max(0, ratio)) * 100)}%`;
}

/* ---------------- printing ---------------- */

/** Print is only available with a live printer, a visible element and an idle link. */
function updatePrintButton() {
  // The one support gate: a model or geometry refusal disables both buttons
  // and is quoted verbatim; a sensor refusal leaves them available so the
  // press can report the sensor reason.
  const state = printButtonState({
    printing: printFlow.printing,
    finishing: printFlow.finishing,
    empty: !controller.document.elements.some((element) => element.visible !== false),
    offline: !device.connected,
    // A device-info read owns the link: starting a job would interleave frames.
    reading: Boolean(device.state.readingInfo),
    // The same print-boundary predicate the flow uses: an undo can restore a
    // label the live printer cannot hold. The flow revalidates it before the
    // raster; the button says so instead of pretending it is print-ready.
    oversized: exceedsPrinterLimits(controller.document),
    gate: supportGate(device.state.capabilities),
  });
  ui.printButton.disabled = state.disabled;
  ui.printButton.title = state.title;
  ui.testButton.disabled = state.testDisabled;
  ui.testButton.title = state.testTitle;
  // The same reason is the accessible description, not only a tooltip, and a
  // visible banner above the action bar so a sighted user does not have to open
  // the Print tab to learn why the buttons are disabled. It is absolutely
  // positioned: showing it never reflows the bar.
  // The banner is a live region: only a changed reason is written, so a
  // rerender while typing the same label never re-announces the refusal.
  setText(ui.printGateReason, state.supportBlocked);
  ui.printGateReason.hidden = !state.supportBlocked;
  for (const button of [ui.printButton, ui.testButton]) {
    if (state.supportBlocked) button.setAttribute('aria-describedby', 'printGateReason');
    else button.removeAttribute('aria-describedby');
  }
}

/** The primary button is also the cancel control while a job is running. */
function setPrintingView(value) {
  ui.printButton.textContent = value ? 'Cancel' : 'Print';
  ui.printButton.classList.toggle('ghost', value);
  ui.printButton.classList.toggle('primary', !value);
  updatePrintButton();
}

/** After the outcome is settled the job cannot be cancelled, only awaited. */
function setFinishingView(value) {
  if (value) {
    ui.printButton.textContent = 'Finishing…';
    ui.printButton.classList.remove('ghost');
    ui.printButton.classList.add('primary');
    updatePrintButton();
    return;
  }
  setPrintingView(printFlow.printing);
}

/**
 * The flow reports its own failures; only an unexpected rejection (a broken
 * notify channel, for example) reaches here, and it must never stay unhandled.
 */
function runPrintFlow(document = undefined) {
  return printFlow.run(document).catch((error) => {
    log.error('print flow failed', { message: error?.message ?? String(error) });
    toast(error?.message ?? 'The print flow failed', { tone: 'error' });
  });
}

ui.printButton.addEventListener('click', () => {
  void runPrintFlow();
});

/**
 * A test label prints paper, so it asks first — exactly like the printer's
 * self-test page in the Print panel.
 */
ui.testButton.addEventListener('click', async () => {
  const proceed = await confirmDialog('Print a test label?', 'A calibration label with the printer model and serial is printed. This uses paper.', {
    confirmLabel: 'Print test',
    tone: 'primary',
  });
  if (!proceed) return;
  void runPrintFlow(testDocument(device.state.capabilities));
});

/* ---------------- tabs ---------------- */

const tabButtons = [...ui.tabs.querySelectorAll('button[data-tab]')];

function switchTab(tab, { focus = false } = {}) {
  for (const button of tabButtons) {
    const active = button.dataset.tab === tab;
    button.setAttribute('aria-selected', String(active));
    // Roving tabindex: the tablist is one tab stop.
    button.tabIndex = active ? 0 : -1;
    if (active && focus) button.focus();
  }
  ui.panelBody.setAttribute('aria-labelledby', `tab-${tab}`);
  designPanel.hidden = tab !== 'design';
  printPanelHost.hidden = tab !== 'print';
  if (tab === 'print') printPanel.render();
  else inspector.render();
}

ui.tabs.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-tab]');
  if (button) switchTab(button.dataset.tab);
});

on(ui.tabs, 'keydown', (event) => {
  const current = event.target.closest('button[data-tab]');
  if (!current) return;
  const index = tabButtons.indexOf(current);
  let next = null;
  if (event.key === 'ArrowRight') next = tabButtons[(index + 1) % tabButtons.length];
  else if (event.key === 'ArrowLeft') next = tabButtons[(index - 1 + tabButtons.length) % tabButtons.length];
  else if (event.key === 'Home') next = tabButtons[0];
  else if (event.key === 'End') next = tabButtons.at(-1);
  if (!next) return;
  event.preventDefault();
  // Keep the document-level arrow-key nudge from also moving the selection.
  event.stopPropagation();
  switchTab(next.dataset.tab, { focus: true });
});

/* ---------------- header actions ---------------- */

ui.undo.addEventListener('click', () => controller.undo());
ui.redo.addEventListener('click', () => controller.redo());
ui.settingsButton.append(icon('settings', { size: 17 }));
ui.settingsButton.addEventListener('click', () => openSettingsSheet());
ui.undo.append(icon('undo', { size: 17 }));
ui.redo.append(icon('redo', { size: 17 }));

on(ui.docName, 'input', () => controller.patchDocument({ name: ui.docName.value }, { coalesceKey: 'name' }));
// The input cap has one owner in CONFIG; the field advertises the same bound.
ui.docName.maxLength = CONFIG.bounds.maxNameChars;

/* ---------------- diagnostics ---------------- */

function openLogViewer() {
  const view = el('div', { class: 'log-view' });
  const render = () => {
    view.textContent = '';
    for (const entry of getLogEntries().slice(-CONFIG.diagnostics.maxEntriesInReport)) {
      view.append(el('div', {}, `${entry.at.slice(11, 19)} [${entry.level}] ${entry.scope}: ${entry.message}${entry.detail ? ` — ${entry.detail}` : ''}`));
    }
  };
  render();
  openModal({
    title: 'Diagnostics log',
    body: view,
    wide: true,
    actions: [
      { label: 'Export', onClick: exportDiagnostics, close: false },
      { label: 'Close', tone: 'primary' },
    ],
  });
}

function exportDiagnostics() {
  const saved = downloadJson(`${CONFIG.app.id}-diagnostics-${Date.now()}.json`, exportLogReport({ capabilities: device.state.capabilities }));
  if (saved === false) toast('Could not save the diagnostics report', { tone: 'error' });
  else toast('Diagnostics exported', { tone: 'ok' });
}

/* ---------------- shortcuts ---------------- */

on(document, 'keydown', (event) => {
  const intent = shortcutIntent(event, {
    inField: isFieldElement(document.activeElement),
    hasSelection: Boolean(controller.selection),
    hasDialog: Boolean(ui.modalRoot?.querySelector('[role="dialog"]')),
  });
  if (!intent) return;

  switch (intent.type) {
    case 'undo':
      event.preventDefault();
      controller.undo();
      break;
    case 'redo':
      event.preventDefault();
      controller.redo();
      break;
    case 'print':
      event.preventDefault();
      void runPrintFlow();
      break;
    case 'duplicate':
      event.preventDefault();
      controller.duplicateElement(controller.selection);
      break;
    case 'delete':
      event.preventDefault();
      // The controller announces the new selection; onSelection is the only
      // path that renders the inspector.
      controller.removeElement(controller.selection);
      break;
    case 'deselect':
      controller.select(null);
      break;
    case 'nudge': {
      event.preventDefault();
      const element = controller.selected;
      const patch = {};
      if (intent.key === 'ArrowLeft') patch.x = element.x - intent.step;
      if (intent.key === 'ArrowRight') patch.x = element.x + intent.step;
      if (intent.key === 'ArrowUp') patch.y = element.y - intent.step;
      if (intent.key === 'ArrowDown') patch.y = element.y + intent.step;
      // The controller scopes the key by element id.
      controller.updateElement(element.id, patch, { coalesceKey: 'nudge' });
      break;
    }
  }
});

/* ---------------- persistence ---------------- */

window.addEventListener('pagehide', () => {
  // Only an owed write is flushed: a tab that never edited the document must
  // not rewrite storage, or the last tab to close would overwrite newer work
  // (two dirty tabs remain last-writer-wins). A failed final write is only
  // logged — the page is gone, and the persistent toast already reported the
  // write that failed first.
  try {
    documentStore.flush();
  } catch (error) {
    log.warn('could not persist label on pagehide', { message: error.message });
  }
});

/* ---------------- boot ---------------- */

applyTheme();
placeStage();
placeInspector();
placeDocName();
// A stored setting that could not be read cost that key only; say so once,
// now that the toast host exists, instead of logging a warning nobody sees.
const settingsIssue = takeSettingsLoadIssue();
if (settingsIssue) toast(settingsIssue.message, { tone: 'error' });
// Choose the first compact zoom before painting: rendering at a desktop zoom
// and then clamping would resize the canvas after the first frame. An
// automatic boot fit is not persisted: the shared zoom key belongs to the
// user's last deliberate choice, not to this viewport.
const initialFit = stageFitZoom();
if (initialFit !== null && zoom > initialFit) {
  zoom = initialFit;
  autoZoom = initialFit;
  updateZoomLabel();
}
rerender();
printPanel.render();
setDeviceState();
void hydrateAndRepaint();

if (getSetting('device.autoConnect')) {
  // Never prompt on boot: only attach to a device the user already granted.
  device.connect({ auto: true }).catch((error) => {
    log.debug('auto-connect skipped', { message: error.message });
    setDeviceState();
  });
}

// One boot owner decides whether this shell has an offline worker at all: a
// failed precache install is otherwise invisible (the worker posts it to every
// window) and the Android WebView has no service worker to register.
bootOfflineShell({
  serviceWorker: 'serviceWorker' in navigator ? navigator.serviceWorker : null,
  isAndroidShell: Boolean(window.NiimbotBLE),
  addWindowListener: (type, handler) => window.addEventListener(type, handler),
  log,
  toast,
});
