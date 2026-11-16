/**
 * One builder for every control declared in the settings schema. Each UI
 * surface filters the schema (see settingsForSurface) and renders the result
 * through here, so a setting has exactly one control implementation, one label
 * and one option list.
 */

import { getSetting, setSetting } from '../core/settings.js';
import { select, slider, toggle } from './controls.js';

/**
 * @param {import('../core/settings.js').SettingDef} definition schema entry
 * @param {{onChange?: Function, overrides?: Partial<import('../core/settings.js').SettingDef> & {value?: unknown}}} [options]
 *        `overrides` adapts the same definition to the machine in front of the
 *        user (a printer-reported range or a supported option subset) without
 *        forking the label or the option list.
 */
export function buildSettingControl(definition, { onChange, overrides = {} } = {}) {
  const control = { ...definition, ...overrides };
  const value = overrides.value ?? getSetting(definition.key);
  // Store first: an optional call would skip argument evaluation when no
  // onChange handler is supplied, silently dropping the setting change.
  const commit = (next) => {
    const stored = setSetting(definition.key, next);
    onChange?.(stored, definition);
  };

  if (control.type === 'toggle') {
    return toggle({ label: control.label, checked: Boolean(value), onChange: commit });
  }
  if (control.type === 'enum') {
    return select({ label: control.label, options: control.options ?? [], value, onChange: commit });
  }
  // SettingType has exactly three members; 'range' is the one left here. A
  // fourth type must add its branch and update the schema/type contract test.
  return slider({
    label: control.label,
    min: control.min ?? 0,
    max: control.max ?? 100,
    step: control.step ?? 1,
    value,
    unit: control.unit ?? '',
    onInput: commit,
  });
}
