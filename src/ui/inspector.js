/**
 * Inspector: document controls plus the properties of the selected element.
 * Controls are rebuilt on selection change and synced in place afterwards so
 * typing never loses focus.
 */

import { CONFIG } from '../core/config.js';
import { el, on } from '../core/dom.js';
import { round1 } from '../core/format.js';
import { geometry, mmToPx, pxToMm } from '../core/geometry.js';
import { icon } from './icons.js';
import {
  actionButton,
  buttonRow,
  group,
  isTextEntry,
  numberField,
  row,
  segmented,
  select,
  slider,
  textArea,
  textField,
  toggle,
} from './controls.js';
import { Z_ORDER_ACTIONS } from './z-order.js';
import { ELEMENT_TYPES, documentHeightPx, documentWidthPx } from '../label/schema.js';

const ROTATION_OPTIONS = [
  ['0', '0°'],
  ['90', '90°'],
  ['180', '180°'],
  ['270', '270°'],
];

/**
 * The undo coalesce key for a slider edit. A pointer gesture gets its own key,
 * so two deliberate drags are two undo steps; a keyboard change keeps the
 * constant key and still merges with its neighbours.
 */
function gestureKey(name, info) {
  return info?.gesture ? `${name}:${info.gesture}` : name;
}

export function createInspector({ container, controller, onPickImage }) {
  let builtFor = '__none__';
  let fields = [];
  let lengthField = null;
  let lengthPresets = [];
  /** The four geometry fields, so sync() can follow a label-length change. */
  let geometryFields = null;

  /**
   * @param {object} controlApi control returned by ui/controls
   * @param {(element: object|null) => unknown} getValue current value reader
   * @param {{elementScoped?: boolean}} [options] elementScoped controls are
   *        disabled while the selected element is locked
   */
  function register(controlApi, getValue, { elementScoped = true } = {}) {
    fields.push({ control: controlApi, getValue, node: controlApi.node, elementScoped });
  }

  /** The device reports a maximum length after discovery; follow it live. */
  function syncLengthLimit() {
    const maxLengthMm = geometry().maxLengthMm;
    lengthField?.setMax(maxLengthMm);
    for (const preset of lengthPresets) preset.node.disabled = preset.mm > maxLengthMm;
  }

  function sync() {
    const element = controller.selected;
    // The selection changed under us (delete-last, template replace, undo):
    // rebuild before touching any field that belongs to the previous element.
    if ((element?.id ?? '__doc__') !== builtFor) {
      build();
      return;
    }
    syncLengthLimit();
    // A length change re-clamps the label, so the X/W and Y/H bounds must
    // follow it too: a stale max="40" rejected a legal X=150 with
    // rangeOverflow and left the spinner dead until the element was reselected.
    if (geometryFields) {
      const maxX = round1(pxToMm(documentWidthPx(controller.document)));
      const maxY = round1(pxToMm(documentHeightPx(controller.document)));
      geometryFields.x.setMax(maxX);
      geometryFields.w.setMax(maxX);
      geometryFields.y.setMax(maxY);
      geometryFields.h.setMax(maxY);
    }
    const locked = Boolean(element?.locked);
    for (const field of fields) {
      if (field.elementScoped && field.control.setDisabled) field.control.setDisabled(locked);
      // Only text-entry controls own the caret. A switch/segmented/range must
      // follow an undo even while it holds focus.
      if (isTextEntry(document.activeElement) && field.node.contains(document.activeElement)) continue;
      field.control.set?.(field.getValue(element));
    }
  }

  function buildDocumentGroup() {
    const document = controller.document;
    const length = numberField({
      label: 'Length',
      value: document.lengthMm,
      min: CONFIG.geometry.minLengthMm,
      max: geometry().maxLengthMm,
      step: 1,
      unit: 'mm',
      onChange: (value) => controller.setDocumentLength(value),
    });
    lengthField = length;
    register(length, () => controller.document.lengthMm, { elementScoped: false });

    lengthPresets = [25, 30, 40, 50, 70].map((mm) => ({
      mm,
      node: el('button', { class: 'btn small', type: 'button', onClick: () => controller.setDocumentLength(mm) }, `${mm} mm`),
    }));
    const presets = el('div', { class: 'btn-row' }, ...lengthPresets.map((preset) => preset.node));

    return group('Label', [length.node, presets]);
  }

  /**
   * One builder per element type, plus the two groups every element shares.
   * Adding a type means adding one builder and one entry below.
   */
  function buildElementGroups(element) {
    const builders = {
      [ELEMENT_TYPES.TEXT]: buildTextGroup,
      [ELEMENT_TYPES.QR]: buildQrGroup,
      [ELEMENT_TYPES.BARCODE]: buildBarcodeGroup,
      [ELEMENT_TYPES.IMAGE]: buildImageGroup,
      [ELEMENT_TYPES.RECT]: buildRectGroup,
    };
    return [builders[element.type]?.(element), buildGeometryGroup(element), buildArrangeGroup(element)].filter(Boolean);
  }

  function buildTextGroup(element) {
    const id = element.id;
    const text = textArea({
      label: 'Text',
      value: element.text,
      rows: 3,
      maxLength: CONFIG.bounds.maxTextChars,
      onInput: (value) => controller.updateElement(id, { text: value }, { coalesceKey: 'text' }),
    });
    register(text, (current) => current.text);

    const size = slider({
      label: 'Size',
      min: 0,
      max: CONFIG.geometry.maxFontPx,
      step: 1,
      value: element.fontPx,
      format: (value) => (value === 0 ? 'Auto' : `${value} px`),
      onInput: (value, info) =>
        controller.updateElement(id, { fontPx: value === 0 ? 0 : Math.max(CONFIG.geometry.minFontPx, value) }, { coalesceKey: gestureKey('size', info) }),
    });
    register(size, (current) => current.fontPx);

    const bold = toggle({ label: 'Bold', checked: element.bold, onChange: (value) => controller.updateElement(id, { bold: value }) });
    register(bold, (current) => current.bold);

    const align = segmented({
      label: 'Align',
      options: [
        ['left', 'Left'],
        ['center', 'Center'],
        ['right', 'Right'],
      ],
      value: element.align,
      onChange: (value) => controller.updateElement(id, { align: value }),
    });
    register(align, (current) => current.align);

    const valign = segmented({
      label: 'Vertical',
      options: [
        ['top', 'Top'],
        ['middle', 'Middle'],
        ['bottom', 'Bottom'],
      ],
      value: element.valign,
      onChange: (value) => controller.updateElement(id, { valign: value }),
    });
    register(valign, (current) => current.valign);

    return group('Text', [text.node, size.node, bold.node, align.node, valign.node]);
  }

  function buildQrGroup(element) {
    const id = element.id;
    const value = textField({
      label: 'Content',
      value: element.value,
      placeholder: 'https://…',
      maxLength: CONFIG.bounds.maxValueChars,
      onInput: (next) => controller.updateElement(id, { value: next }, { coalesceKey: 'qr' }),
    });
    register(value, (current) => current.value);

    const ec = select({
      label: 'Correction',
      options: [
        ['L', 'Low (7%)'],
        ['M', 'Medium (15%)'],
        ['Q', 'Quartile (25%)'],
        ['H', 'High (30%)'],
      ],
      value: element.ecLevel,
      onChange: (next) => controller.updateElement(id, { ecLevel: next }),
    });
    register(ec, (current) => current.ecLevel);

    return group('QR code', [value.node, ec.node]);
  }

  function buildBarcodeGroup(element) {
    const id = element.id;
    const value = textField({
      label: 'Content',
      value: element.value,
      placeholder: 'ABC-123',
      maxLength: CONFIG.bounds.maxValueChars,
      onInput: (next) => controller.updateElement(id, { value: next }, { coalesceKey: 'bc' }),
    });
    register(value, (current) => current.value);

    const showText = toggle({
      label: 'Human readable',
      checked: element.showText,
      onChange: (next) => controller.updateElement(id, { showText: next }),
    });
    register(showText, (current) => current.showText);

    return group('Barcode', [value.node, showText.node]);
  }

  function buildImageGroup(element) {
    const id = element.id;
    const replace = actionButton('Replace image', {
      icon: icon('image', { size: 15 }),
      onClick: async () => {
        const image = await onPickImage();
        if (image) controller.updateElement(id, { src: image.src });
      },
    });
    register(replace, () => null);

    const fit = segmented({
      label: 'Fit',
      options: [
        ['contain', 'Contain'],
        ['cover', 'Cover'],
        ['stretch', 'Stretch'],
      ],
      value: element.fit,
      onChange: (next) => controller.updateElement(id, { fit: next }),
    });
    register(fit, (current) => current.fit);

    const dither = select({
      label: 'Tone',
      options: [
        ['auto', 'Use print setting'],
        ['threshold', 'Crisp'],
        ['floyd', 'Floyd-Steinberg'],
        ['atkinson', 'Atkinson'],
      ],
      value: element.dither,
      onChange: (next) => controller.updateElement(id, { dither: next }),
    });
    register(dither, (current) => current.dither);

    return group('Image', [replace.node, fit.node, dither.node]);
  }

  function buildRectGroup(element) {
    const id = element.id;
    const stroke = slider({
      label: 'Stroke',
      min: 1,
      max: 12,
      step: 1,
      value: element.strokePx,
      unit: ' px',
      onInput: (value, info) => controller.updateElement(id, { strokePx: value }, { coalesceKey: gestureKey('stroke', info) }),
    });
    register(stroke, (current) => current.strokePx);

    const filled = toggle({ label: 'Filled', checked: element.filled, onChange: (value) => controller.updateElement(id, { filled: value }) });
    register(filled, (current) => current.filled);

    const radius = slider({
      label: 'Corner radius',
      min: 0,
      max: 24,
      step: 1,
      value: element.radiusPx,
      unit: ' px',
      onInput: (value, info) => controller.updateElement(id, { radiusPx: value }, { coalesceKey: gestureKey('radius', info) }),
    });
    register(radius, (current) => current.radiusPx);

    return group('Frame', [stroke.node, filled.node, radius.node]);
  }

  function buildGeometryGroup(element) {
    const id = element.id;
    // Geometry is displayed in tenths of a millimetre; a 0.5 mm step made the
    // native validity check reject the displayed value permanently.
    const maxX = round1(pxToMm(documentWidthPx(controller.document)));
    const maxY = round1(pxToMm(documentHeightPx(controller.document)));
    const minSize = round1(pxToMm(CONFIG.geometry.minElementPx));
    const x = numberField({ label: 'X', value: round1(pxToMm(element.x)), min: 0, max: maxX, step: 0.1, unit: 'mm', onChange: (v) => controller.updateElement(id, { x: mmToPx(v) }) });
    const y = numberField({ label: 'Y', value: round1(pxToMm(element.y)), min: 0, max: maxY, step: 0.1, unit: 'mm', onChange: (v) => controller.updateElement(id, { y: mmToPx(v) }) });
    const w = numberField({ label: 'Width', value: round1(pxToMm(element.w)), min: minSize, max: maxX, step: 0.1, unit: 'mm', onChange: (v) => controller.updateElement(id, { w: mmToPx(v) }) });
    const h = numberField({ label: 'Height', value: round1(pxToMm(element.h)), min: minSize, max: maxY, step: 0.1, unit: 'mm', onChange: (v) => controller.updateElement(id, { h: mmToPx(v) }) });
    register(x, (current) => round1(pxToMm(current.x)));
    register(y, (current) => round1(pxToMm(current.y)));
    register(w, (current) => round1(pxToMm(current.w)));
    register(h, (current) => round1(pxToMm(current.h)));
    geometryFields = { x, y, w, h };

    const rotation = segmented({
      label: 'Rotation',
      options: ROTATION_OPTIONS,
      value: String(element.rotation),
      onChange: (value) => controller.updateElement(id, { rotation: Number(value) }),
    });
    register(rotation, (current) => String(current.rotation));

    return group('Geometry', [row(x.node, y.node), row(w.node, h.node), rotation.node]);
  }

  function buildArrangeGroup(element) {
    const id = element.id;
    const alignControls = [
      alignButton('alignLeft', 'Align left', 'left'),
      alignButton('alignCenterH', 'Center horizontally', 'centerX'),
      alignButton('alignRight', 'Align right', 'right'),
      alignButton('rotate', 'Rotate 90°', null),
      alignButton('alignTop', 'Align top', 'top'),
      alignButton('alignMiddleV', 'Center vertically', 'centerY'),
      alignButton('alignBottom', 'Align bottom', 'bottom'),
      // A copy of a locked element is unlocked and editable, so this action
      // stays available when the lock disables every other element action.
      alignButton('copy', 'Duplicate', 'duplicate', { elementScoped: false }),
    ];
    for (const control of alignControls) register(control, () => null, { elementScoped: control.elementScoped });
    const alignButtons = el('div', { class: 'icon-grid' }, ...alignControls.map((control) => control.node));

    const zControls = [
      // The same spec the layer row uses: one direction per action, one label.
      ...Z_ORDER_ACTIONS.map((action) => actionButton(action.label, { small: true, onClick: () => controller.reorder(id, action.delta) })),
      actionButton('Delete', { small: true, tone: 'danger', onClick: () => controller.removeElement(id) }),
    ];
    // Element-scoped like every other arrange action: a locked element shows
    // all three disabled instead of accepting a silent no-op.
    for (const control of zControls) register(control, () => null);
    const zButtons = buttonRow(zControls.map((control) => control.node));

    const lock = toggle({ label: 'Locked', checked: element.locked, onChange: (value) => controller.updateElement(id, { locked: value }) });
    register(lock, (current) => current.locked, { elementScoped: false });
    const visible = toggle({ label: 'Visible', checked: element.visible, onChange: (value) => controller.updateElement(id, { visible: value }) });
    register(visible, (current) => current.visible, { elementScoped: false });

    return group('Arrange', [alignButtons, zButtons, lock.node, visible.node]);
  }

  function alignButton(iconName, title, axis, { elementScoped = true } = {}) {
    const node = el('button', { type: 'button', title, 'aria-label': title }, icon(iconName, { size: 15 }));
    on(node, 'click', () => {
      const id = controller.selection;
      if (!id) return;
      if (axis === 'duplicate') controller.duplicateElement(id);
      else if (axis === null) controller.rotateElement(id, 90);
      else controller.alignElement(id, axis);
    });
    return {
      node,
      elementScoped,
      setDisabled(next) {
        node.disabled = Boolean(next);
      },
    };
  }

  function build() {
    const element = controller.selected;
    const key = element?.id ?? '__doc__';
    // Check the cache before touching the DOM: clearing first would always
    // destroy the focused field and force the user to click back in.
    if (key === builtFor && container.childElementCount) return;
    container.textContent = '';
    fields = [];
    builtFor = key;

    container.append(buildDocumentGroup());

    if (element) {
      container.append(...buildElementGroups(element));
    } else {
      container.append(
        el(
          'div',
          { class: 'empty' },
          el('span', { class: 'icon' }, icon('layers', { size: 20 })),
          el('span', {}, 'Select an element to edit it'),
          el('span', { class: 'hint' }, 'Or add one from the toolbar')
        )
      );
    }
    sync();
  }

  function render() {
    build();
    sync();
  }

  function reset() {
    builtFor = '__none__';
    render();
  }

  return { render, sync, reset };
}
