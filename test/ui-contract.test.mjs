import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { CONFIG } from '../src/core/config.js';
import { STAGE_MARGINS } from '../src/ui/stage-layout.js';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const html = read('index.html');
const css = read('assets/app.css');
const toast = read('src/ui/toast.js');
const printPanel = read('src/ui/print-panel.js');
const main = read('src/main.js');
const layers = read('src/ui/layers.js');

/** Body of the first rule whose selector is exactly `selector`. */
function rule(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
  assert.ok(match, `missing rule block: ${selector}`);
  return match[1];
}

/** Every `@media (max-width: Npx)` block, with its balanced body. */
function mediaBlocks() {
  const blocks = [];
  const pattern = /@media \(max-width: (\d+)px\)\s*\{/g;
  let match;
  while ((match = pattern.exec(css))) {
    let depth = 1;
    let index = pattern.lastIndex;
    while (index < css.length && depth > 0) {
      if (css[index] === '{') depth++;
      else if (css[index] === '}') depth--;
      index++;
    }
    blocks.push({ width: Number(match[1]), body: css.slice(pattern.lastIndex, index - 1) });
    pattern.lastIndex = index;
  }
  return blocks;
}

test('the tablist controls one labelled tabpanel with a roving tab stop', () => {
  assert.match(html, /id="panelBody"[^>]*role="tabpanel"[^>]*aria-labelledby="tab-design"/);
  assert.match(html, /id="tab-design"[^>]*aria-controls="panelBody"[^>]*tabindex="0"/);
  assert.match(html, /id="tab-print"[^>]*aria-controls="panelBody"[^>]*tabindex="-1"/);
});

test('toasts have exactly one non-atomic live region', () => {
  // aria-atomic re-announced every visible toast whenever one was added.
  assert.match(html, /id="toasts"[^>]*aria-live="polite"/);
  assert.doesNotMatch(html, /id="toasts"[^>]*aria-atomic/);
  assert.doesNotMatch(toast, /role:\s*['"](?:status|alert)['"]/);
});

test('composite roles match their children', () => {
  // A radiogroup needs radio children; the segmented control is pressed
  // buttons, so it is a plain group. The rail has no arrow-key contract.
  assert.doesNotMatch(read('src/ui/controls.js'), /role:\s*'radiogroup'/);
  assert.match(read('src/ui/controls.js'), /class: 'segmented', role: 'group'/);
  assert.match(html, /id="toolRail" role="group"/);
  assert.doesNotMatch(html, /role="toolbar"/);
});

test('compact layout pins the action bar and keeps the status live region', () => {
  assert.match(css, /\.actionbar\s*\{[^}]*position:\s*sticky/);
  assert.doesNotMatch(css, /\.status\s*\{\s*display:\s*none/);
  assert.match(css, /@media \(pointer: coarse\)[\s\S]*?44px/);
});

test('a cancelled port picker is one contract, keyed off error.cancelled', () => {
  assert.match(printPanel, /if \(error\?\.cancelled\)/);
  assert.match(main, /if \(error\?\.cancelled\)/);
  assert.doesNotMatch(printPanel, /NotFoundError/);
  assert.doesNotMatch(main, /NotFoundError/);
});

test('capability rows render three states and never print internal keys', () => {
  assert.match(printPanel, /capabilityState/);
  assert.match(printPanel, /'Not reported'/);
  assert.match(printPanel, /CAPABILITY_GROUP_LABELS\[groupName\]/);
  // The clock and sound controls are hidden only on a reported "no".
  assert.match(printPanel, /clockState === 'reported-no'/);
  assert.match(printPanel, /volumeState === 'reported-no'/);
  assert.doesNotMatch(printPanel, /caps\.hasRtc === false/);
});

test('the printer panel owns no second copy of the printer setting labels', () => {
  // The schema owns the label, order and option text; the panel only adapts
  // the range/options to what the printer reported.
  assert.doesNotMatch(printPanel, /label: 'Print mode'/);
  assert.doesNotMatch(printPanel, /label: 'Density'/);
  assert.doesNotMatch(printPanel, /label: 'Tape type'/);
  assert.match(printPanel, /buildSettingControl/);
  assert.match(printPanel, /settingsForSurface\('print'\)/);
  assert.doesNotMatch(read('src/ui/settings-sheet.js'), /scope === 'printer'/);
  assert.match(read('src/core/settings.js'), /label: 'Print quality'/);
});

test('colour and gray stay diagnostics, not rows in the print panel', () => {
  // The panel has one honest output row; colour/gray are protocol features
  // with no control, so their raw TLVs live in the capability diagnostic.
  assert.doesNotMatch(printPanel, /statRow\('Colour'/);
  assert.doesNotMatch(printPanel, /statRow\('Gray'/);
  assert.match(printPanel, /statRow\('Output', OUTPUT_DESCRIPTION\)/);
  assert.match(printPanel, /supportsColor/);
  assert.match(printPanel, /supportsGray/);
});

test('one error path covers every panel failure', () => {
  assert.match(printPanel, /function reportError\(action, error, message = null\)/);
  assert.match(printPanel, /log\.error\(action/);
  // The paths that used to log without telling the operator.
  for (const action of ['connection action failed', 'refresh failed', 'push failed', 'sound state read failed', 'auto power-off update failed', 'printer reset failed']) {
    assert.match(printPanel, new RegExp(action.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.doesNotMatch(printPanel, /\.catch\(\(error\) => log\.warn/);
});

test('the unknown sound state has a visible non-colour cue', () => {
  // The dashed --field-border track is 3.22:1 light / 3.47:1 dark. Dimming the
  // whole switch composited that to ~1.15:1, so only the knob is muted.
  assert.match(css, /\.switch-row\[data-state="unknown"\] \.switch\s*\{[^}]*border:\s*1px dashed var\(--field-border\)/);
  assert.match(css, /\.switch-row\[data-state="unknown"\] \.switch\s*\{[^}]*opacity:\s*1/);
  assert.match(css, /\.switch-row\[data-state="unknown"\] \.switch i\s*\{[^}]*background:\s*var\(--muted-2\)/);
});

test('the header and the panel share one status description', () => {
  assert.match(main, /describeDeviceStatus\(device\.state\)/);
  assert.match(printPanel, /describeDeviceStatus\(device\.state\)/);
  assert.doesNotMatch(main, /status === 'connecting' \? 'connecting'/);
});

test('the page subscribes through the one precache boot owner', () => {
  assert.match(main, /bootOfflineShell\(\{/);
  assert.match(main, /serviceWorker: 'serviceWorker' in navigator \? navigator\.serviceWorker : null/);
  const status = read('src/core/precache-status.js');
  assert.match(status, /registerPrecacheErrors\(serviceWorker, \{ log, toast \}\)/);
  assert.match(status, /log\.error\('precache install failed'/);
  assert.match(status, /toast\(message, \{ tone: 'error' \}\)/);
});

test('phones keep properties under the add rail and let the stage scroll away', () => {
  // The inspector used to sit below Layers and Templates, and a 281px sticky
  // stage covered whatever scrolled under it. The compact stage has no
  // position override at all: static is the default and the old explicit
  // position:static/z-index pair was inert.
  assert.match(main, /function placeInspector\(\)/);
  assert.match(main, /rail\.after\(inspectorPanel\)/);
  assert.match(main, /placeInspector\(\);/);
  assert.doesNotMatch(css, /\.stage\s*\{[^}]*position:/);
  assert.doesNotMatch(css, /\.stage\s*\{[^}]*z-index:/);
  assert.match(css, /#labelPx\s*\{\s*display:\s*none/);
});

test('the empty stage footer collapses but stays a live region', () => {
  // .stage-foot:empty never matched: the #stageHint span always exists, so a
  // phone reserved 22px for an empty row. Zero height keeps the role=status
  // live region in the accessibility tree, which display:none removed.
  assert.match(css, /\.stage-foot:has\(#stageHint:empty\)\s*\{[^}]*height:\s*0/);
  assert.match(css, /\.stage-foot:has\(#stageHint:empty\)\s*\{[^}]*overflow:\s*hidden/);
  assert.doesNotMatch(css, /\.stage-foot:has\(#stageHint:empty\)\s*\{[^}]*display:\s*none/);
  assert.doesNotMatch(css, /\.stage-foot:empty/);
  assert.match(html, /id="stageHint"[^>]*role="status"/);
  assert.match(main, /setText\(ui\.stageHint, summariseWarnings\(warnings\)\)/);
});

test('safe-area insets cannot widen the app or squeeze the workspace', () => {
  // The implicit grid column was floored by the top bar's min-content width:
  // 431px on a 390px viewport with 44px insets, clipping the right edge.
  assert.match(rule('.app'), /grid-template-columns:\s*minmax\(0,\s*1fr\)/);
  for (const selector of ['.topbar', '.topbar-actions', '.device-pill']) {
    assert.match(rule(selector), /min-width:\s*0/, `${selector} must be able to shrink`);
  }
  // Brand, a zero-minimum middle and actions: the brand keeps a real column
  // instead of collapsing to 0 while the actions take its space.
  const compact = mediaBlocks().find((block) => /#labelPx/.test(block.body));
  assert.ok(compact, 'compact media query');
  assert.match(compact.body, /\.topbar\s*\{[^}]*grid-template-columns:\s*auto\s+minmax\(0,\s*1fr\)\s+auto/);
  assert.match(compact.body, /\.workspace\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/);
  // Rail, tabs, fields and templates all live inside the workspace.
  assert.match(rule('.workspace'), /padding-inline:\s*env\(safe-area-inset-left\)\s+env\(safe-area-inset-right\)/);
});

test('the coarse layer menu opens inside the row, never over the list clip', () => {
  // .layer-list keeps overflow-y:auto, so an absolutely positioned popup was
  // clipped at the list edges (26px above the first row, 16px below the last).
  const openState = rule('.layer-row[data-menu="open"] .layer-actions');
  assert.match(openState, /display:\s*grid/);
  assert.match(openState, /grid-template-columns:\s*repeat\(auto-fit,\s*44px\)/);
  assert.doesNotMatch(openState, /position:\s*absolute/);
  assert.doesNotMatch(openState, /transform:/);
  assert.doesNotMatch(css, /\.layer-list\s*\{[^}]*overflow(?:-y)?:\s*visible/);
  assert.match(rule('.layer-list'), /overflow-y:\s*auto/);
  // The open grid is scrolled clear of the list's own overflow.
  assert.match(layers, /scrollIntoView\?\.\(\{ block: 'nearest' \}\)/);
});

test('the coarse menu closes when focus leaves the row, on scroll and on resize', () => {
  assert.match(layers, /on\(\s*document,\s*'focusin'/);
  assert.match(layers, /on\(\s*window,\s*'scroll'/);
  assert.match(layers, /on\(\s*window,\s*'resize'/);
  // Escape and pointer-outside stay the other two exits.
  assert.match(layers, /'pointerdown'/);
  assert.match(layers, /'keydown'/);
});

test('one rule owns the disabled cursor, after the range rule, for every control', () => {
  assert.match(css, /:is\(button, input, select, textarea\):disabled\s*\{\s*cursor:\s*not-allowed/);
  // A disabled slider must not keep the pointer: the range rule sets
  // cursor:pointer, so the owner has to come after it in source order.
  assert.ok(css.indexOf(':is(button, input, select, textarea):disabled') > css.indexOf('input[type="range"] {'), 'the owner wins over the range rule');
  const disabled = [...css.matchAll(/[^{}]*:disabled[^{}]*\{([^}]*)\}/g)].map((match) => match[1]);
  const withCursor = disabled.filter((body) => /cursor:/.test(body));
  assert.equal(withCursor.length, 1, 'only one block may set a disabled cursor');

  // And one visual rule covers the controls that cannot inherit a button style,
  // including the custom-styled layer actions: a locked element's restack and
  // delete buttons used to look enabled while being a silent no-op.
  const visual = rule(
    ':is(input, select, textarea):disabled,\n.segmented button:disabled,\n.icon-grid button:disabled,\n.layer-actions button:disabled,\n.switch:disabled'
  );
  assert.match(visual, /opacity:/);
});

test('the selected segment carries a non-colour cue and a 3:1 ring token', () => {
  assert.match(rule('.segmented'), /border:\s*1px solid var\(--field-border\)/);
  assert.match(rule('.segmented button'), /border:\s*1px solid transparent/, 'the ring border is reserved');
  const pressed = rule('.segmented button[aria-pressed="true"]');
  assert.match(pressed, /border-color:\s*var\(--field-border\)/);
  assert.match(pressed, /font-weight:\s*650/, 'weight is a non-colour cue');
  assert.match(pressed, /box-shadow:\s*inset 0 -3px 0 var\(--accent\)/, 'an edge bar is a non-colour cue');
});

test('the stage bar stays one line: badge fixed, pixel hint flexible', () => {
  // At 1024 the badge and the pixel hint both wrapped to a second line.
  assert.match(rule('.badge'), /flex:\s*none/);
  assert.match(rule('.badge'), /white-space:\s*nowrap/);
  const px = rule('#labelPx');
  assert.match(px, /flex:\s*0 1 auto/);
  assert.match(px, /min-width:\s*0/);
  assert.match(px, /text-overflow:\s*ellipsis/);
  // Only the hint gives way; the zoom cluster keeps its 44px coarse targets.
  assert.match(rule('#zoomControls'), /flex:\s*none/);
  // The bar's own grid column is explicit, or its max-content width would be
  // painted over the inspector between 901 and 1100px.
  assert.match(rule('.stage'), /grid-template-columns:\s*minmax\(0,\s*1fr\)/);
});

test('an empty status takes no space in the action row', () => {
  assert.match(rule('.status:empty'), /flex:\s*0 1 auto/);
  assert.match(rule('.status'), /white-space:\s*nowrap/);
  // Even with the empty region gone, the two labels must stay on one line.
  assert.match(css, /\.primary,\s*\.ghost\s*\{[^}]*white-space:\s*nowrap/);
});

test('the compact breakpoint has one numeric owner', () => {
  // CONFIG.ui.compactBreakpointPx drives the JS media query; the stylesheet
  // literal must equal it or the two layouts disagree by 1px.
  const blocks = mediaBlocks();
  const compact = blocks.filter((block) => /#labelPx|\.stage-name/.test(block.body));
  assert.equal(compact.length, 1, 'exactly one compact media query');
  assert.equal(compact[0].width, CONFIG.ui.compactBreakpointPx);
  assert.equal(
    blocks.filter((block) => block.width === CONFIG.ui.compactBreakpointPx).length,
    1,
    'no second media query may reuse the compact width'
  );
  assert.match(main, /matchMedia\(`\(max-width: \$\{CONFIG\.ui\.compactBreakpointPx\}px\)`\)/);
});

test('a touch scroll cannot change a slider or drag a label element', () => {
  // A vertical pan that starts on a range must scroll the page; only a
  // horizontal drag changes the value, and the commit waits for pointerup.
  assert.match(css, /input\[type="range"\]\s*\{[^}]*touch-action:\s*pan-y/);
  // The canvas surface must not swallow the page scroll either.
  assert.match(css, /\.canvas-stack\s*\{[^}]*touch-action:\s*pan-y/);
  // An oversized zoomed label stays reachable from its leading edge.
  assert.match(css, /\.stage-scroll\s*\{[^}]*place-items:\s*safe center/);
  // First touch selects; a drag needs a touch that starts on the selection.
  assert.match(read('src/editor/canvas.js'), /event\.pointerType === 'touch'\) return/);
  assert.match(read('src/editor/canvas.js'), /scrolling cannot drag a label element by accident/);
});

test('selection has exactly one render path', () => {
  // The canvas and the layer list used to call inspector.render() through an
  // onSelect callback on top of controller.onSelection, so every select and
  // every add rendered the panel twice.
  assert.doesNotMatch(main, /onSelect:/);
  assert.doesNotMatch(read('src/ui/layers.js'), /onSelect/);
  assert.doesNotMatch(read('src/editor/canvas.js'), /onSelect/);
  const addElement = main.slice(main.indexOf('async function addElement'), main.indexOf('/** Box for a new barcode'));
  assert.doesNotMatch(addElement, /inspector\.render\(\)/, 'addElement relies on onSelection');
  assert.doesNotMatch(addElement, /controller\.select\(/, 'addElement already leaves the new element selected');
});

test('breakpoint moves restore focus through one helper', () => {
  assert.match(main, /import \{[^}]*movePreservingFocus[^}]*\} from '\.\/core\/dom\.js'/);
  assert.match(main, /movePreservingFocus\(ui\.docName/);
  assert.match(main, /movePreservingFocus\(stage/);
  assert.match(main, /movePreservingFocus\(inspectorPanel/);
  assert.doesNotMatch(main, /hadFocus/, 'the name-only focus restore is gone');
});

test('stage placement and fit decisions come from one module', () => {
  assert.match(main, /placementPlan\(\{ compact: compactQuery\.matches \}\)/);
  assert.match(main, /from '\.\/ui\/stage-layout\.js'/);
  assert.doesNotMatch(main, /clientWidth - 40/, 'the desktop gutter is not duplicated in main');
  assert.doesNotMatch(main, /clientWidth - 24/, 'the compact gutter is not duplicated in main');
});


test('the page never scrolls sideways and fields clear the action bar', () => {
  assert.match(css, /#app\s*\{[^}]*overflow-x:\s*clip/);
  assert.match(css, /overscroll-behavior-x:\s*contain/);
  // One measured clearance drives the field margin, the scroll padding and the
  // toasts. The value already contains the safe-area padding (main.js measures
  // the bar), so no consumer adds env() a second time.
  assert.match(css, /scroll-margin-block:\s*var\(--actionbar-clearance\)/);
  assert.match(css, /scroll-padding-bottom:\s*var\(--actionbar-clearance\)/);
  assert.match(css, /\.toasts\s*\{[^}]*bottom:\s*var\(--actionbar-clearance\)/);
  assert.doesNotMatch(css, /--actionbar-clearance\)\s*\+\s*env/, 'the inset is inside the measured height');
  assert.match(main, /new ResizeObserver\(publishActionbarClearance\)\.observe\(actionbar\)/, 'the bar is measured, not guessed');
  assert.match(main, /Math\.ceil\(actionbar\.offsetHeight\) \+ ACTIONBAR_GAP_PX/, 'the full painted height plus one gap');
});

test('Print and Test are disabled while a device info read owns the link', () => {
  const update = main.match(/function updatePrintButton\(\) \{([\s\S]*?)\n\}/)?.[1];
  assert.ok(update, 'updatePrintButton exists');
  assert.match(update, /reading: Boolean\(device\.state\.readingInfo\)/, 'the read is part of the button state');
  assert.match(update, /printButtonState\(\{/, 'the matrix lives in the flow, not in main');
  assert.match(update, /ui\.printButton\.disabled = state\.disabled/);
  assert.match(update, /ui\.testButton\.disabled = state\.testDisabled/);
});

test('the finishing view never claims the labels were printed', () => {
  const flow = read('src/ui/print-flow.js');
  const manager = read('src/device/manager.js');
  const finishing = flow.match(/if \(finishing\) \{([\s\S]*?)\n  \}/)?.[1];
  assert.ok(finishing, 'the finishing branch exists');
  assert.match(finishing, /title: 'The printer is finishing; nothing can be cancelled'/);
  // Failure and user cancel reach the same view, so its copy must describe the
  // settled outcome, never a successful print.
  assert.doesNotMatch(finishing, /labels? (?:are|were) printed|already printed/i);
  assert.doesNotMatch(flow, /labels? (?:are|were) (?:already )?printed|job already printed|confirmed the job/i);
  assert.doesNotMatch(manager, /job has already printed|already printed/i);
});

test('the finishing callback is wired to the view and refreshes the button', () => {
  assert.match(main, /onFinishingChange: setFinishingView/, 'the flow finishing signal reaches the view');
  const view = main.match(/function setFinishingView\(value\) \{([\s\S]*?)\n\}/)?.[1];
  assert.ok(view, 'setFinishingView exists');
  const finishingBranch = view.match(/if \(value\) \{([\s\S]*?)\n    return;/)?.[1];
  assert.ok(finishingBranch, 'the finishing branch exists');
  // Without this the button keeps the printing state: enabled, titled "Cancel
  // the running print", and a silent no-op when clicked.
  assert.match(finishingBranch, /updatePrintButton\(\);/, 'the finishing branch recomputes disabled/title, not just the label');
});

test('the label is persisted through the shared store, raw, with one failure channel', () => {
  const saveFailure = read('src/ui/save-failure.js');
  assert.match(main, /createStore\(createDocument\(\), \{/, 'the document store is the shared persistence owner');
  assert.match(main, /envelope: false/, 'the stored format stays the raw document');
  assert.match(main, /createSaveFailureNotice\(\)/, 'the save-failure notice has one owner');
  assert.match(saveFailure, /timeout: null/, 'a save failure is a persistent toast');
  assert.match(saveFailure, /key: 'document-save-error'/, 'one deduplicated toast per failure');
  assert.match(saveFailure, /onDismiss:/, 'dismissal clears the “already shown” guard');
  assert.doesNotMatch(main, /localStorage\.setItem\(storageKey\('document'\)/, 'no second writer for the label');
  assert.match(main, /window\.addEventListener\('pagehide'[\s\S]{0,500}documentStore\.flush\(\)/, 'pagehide flushes the owed write');
});

test('the stage gutter constants match the stylesheet padding', () => {
  const paddings = (text) => {
    const value = text.match(/padding:\s*([^;]+);/)[1].trim().split(/\s+/).map(parseFloat);
    // 8px 24px 20px -> top, right, bottom; a two-value form is [vertical, horizontal].
    return value.length === 2 ? [value[0], value[1], value[0]] : value;
  };

  const desktop = css.match(/^\.stage-scroll \{([\s\S]*?)^\}/m)[1];
  const [top, right, bottom] = paddings(desktop);
  assert.equal(STAGE_MARGINS.desktop.width, right * 2, 'the horizontal gutter is both side paddings');
  assert.equal(STAGE_MARGINS.desktop.height, top + bottom, 'the vertical gutter is top plus bottom');

  const compact = mediaBlocks().find((block) => block.width === CONFIG.ui.compactBreakpointPx);
  const compactRule = compact.body.match(/\.stage-scroll \{\s*padding:\s*([^;]+);/)[1].trim().split(/\s+/).map(parseFloat);
  assert.equal(STAGE_MARGINS.compact.width, compactRule[1] * 2);
  assert.equal(STAGE_MARGINS.compact.height, compactRule[0] + compactRule[2]);
});

/* ---------------- shell clearance and safe areas (R4-1/R4-2/R4-3) ---------------- */

test('one clearance token drives the toasts, scroll padding and field margins', () => {
  assert.match(css, /--actionbar-clearance:\s*84px/, 'the base bar height is one token');
  const compact = mediaBlocks().find((block) => /--actionbar-clearance/.test(block.body));
  assert.ok(compact, 'the compact bar redefines the token, not its three consumers');
  assert.match(compact.body, /--actionbar-clearance:\s*76px/);
  // No consumer keeps a second, hard-coded bar height.
  assert.doesNotMatch(css, /bottom:\s*84px/);
  assert.doesNotMatch(css, /bottom:\s*calc\(76px/);
  assert.doesNotMatch(css, /scroll-margin-block:\s*84px/);
});

test('a non-empty status owns its own line in the compact action row', () => {
  const compact = mediaBlocks().find((block) => /#labelPx/.test(block.body));
  assert.match(compact.body, /\.action-row\s*\{[^}]*flex-wrap:\s*wrap/);
  assert.match(compact.body, /\.status:not\(:empty\)\s*\{[^}]*flex:\s*1 0 100%/);
  // The empty live region stays in the row (and keeps its 10px gap).
  assert.match(rule('.status:empty'), /flex:\s*0 1 auto/);
  assert.match(rule('.action-row'), /gap:\s*10px/);
});

test('fixed overlays respect the safe-area insets', () => {
  const backdrop = rule('.modal-backdrop');
  for (const side of ['top', 'right', 'bottom', 'left']) {
    assert.match(backdrop, new RegExp(`max\\(20px,\\s*env\\(safe-area-inset-${side}\\)\\)`), `modal padding clears ${side}`);
  }
  const toasts = rule('.toasts');
  assert.match(toasts, /inset-inline:\s*max\(12px,\s*env\(safe-area-inset-left\)\)\s+max\(12px,\s*env\(safe-area-inset-right\)\)/);
  assert.match(toasts, /left:\s*0/);
  assert.match(toasts, /right:\s*0/);
  assert.match(toasts, /width:\s*auto/);
  assert.match(toasts, /max-width:\s*460px/);
  assert.match(toasts, /margin-inline:\s*auto/);
  assert.match(toasts, /transform:\s*none/);
});

test('the compact header keeps every icon target and a 22px brand mark', () => {
  assert.match(css, /\.topbar-actions \.icon-btn,\s*\n\.topbar-actions \.divider\s*\{[^}]*flex:\s*none/);
  assert.match(rule('.device-pill'), /flex:\s*0 1 auto/);
  assert.match(rule('.brand-mark'), /width:\s*22px/);
  const compact = mediaBlocks().find((block) => /#labelPx/.test(block.body));
  assert.doesNotMatch(compact.body, /\.brand-mark\s*\{[^}]*display:\s*none/, 'the mark survives a narrow header');
});

test('a warning hint can shrink and wrap instead of widening the page', () => {
  assert.match(rule('.hint'), /min-width:\s*0/);
  assert.match(rule('.hint'), /overflow-wrap:\s*anywhere/);
  assert.match(rule('.stage-foot'), /min-width:\s*0/);
});

test('zoom paths: quantized buttons, an unquantized wheel, and no persisted boot fit', () => {
  assert.match(main, /applyZoom\(wheelZoom\(zoom, event\.deltaY/);
  assert.doesNotMatch(main, /setZoom\(zoom - event\.deltaY/);
  assert.match(main, /autoZoom = initialFit/);
  assert.doesNotMatch(main, /zoom = initialFit;\s*\n\s*saveZoom\(\)/, 'the boot fit must not overwrite the shared zoom key');
  assert.match(main, /shouldClampZoom\(\{ zoom, autoZoom, breakpointChanged \}\)/);
  assert.match(main, /min = Math\.min\(zoom, limits\.min\)/);
});

test('the layer row and the Arrange group share one restack spec', () => {
  const spec = read('src/ui/z-order.js');
  assert.match(spec, /forward[^\n]*delta: 1/);
  assert.match(spec, /backward[^\n]*delta: -1/);
  for (const file of ['src/ui/layers.js', 'src/ui/inspector.js']) {
    const source = read(file);
    assert.match(source, /Z_ORDER_ACTIONS/, `${file} uses the shared spec`);
    assert.doesNotMatch(source, /reorder\([^)]*,\s*[+-]?1\s*\)/, `${file} keeps no second direction literal`);
  }
});

test('the theme owner suppresses transitions while the theme flips', () => {
  // The class is on the root before data-theme changes, so the rule must cover
  // the root and every descendant that owns a colour transition.
  assert.match(css, /\.theme-switching,\s*\n\.theme-switching \*\s*\{[^}]*transition:\s*none\s*!important/);
  const theme = read('src/ui/theme.js');
  assert.match(theme, /root\.classList\?\.add\?\.\('theme-switching'\)/);
  assert.match(theme, /requestFrame\(\(\) => requestFrame\(done\)\)/);
});

test('the display document is the one the print flow and the renderer read', () => {
  assert.match(main, /getDocument: \(\) => controller\.documentForDisplay\(\)/);
  const canvas = read('src/editor/canvas.js');
  assert.match(canvas, /const document = controller\.documentForDisplay\(\)/);
});

test('the Print and Test buttons quote the support gate in title and description', () => {
  const update = main.match(/function updatePrintButton\(\) \{([\s\S]*?)\n\}/)?.[1];
  assert.ok(update, 'updatePrintButton exists');
  assert.match(update, /gate: supportGate\(device\.state\.capabilities\)/, 'the one gate owns the button answer');
  assert.match(update, /ui\.printButton\.title = state\.title/);
  assert.match(update, /ui\.testButton\.title = state\.testTitle/);
  assert.match(update, /state\.supportBlocked/, 'the gate reason reaches the description');
  assert.match(update, /setAttribute\('aria-describedby', 'printGateReason'\)/);
  assert.match(html, /id="printGateReason"/, 'the description target exists in the page');
});
