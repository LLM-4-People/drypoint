/** Settings sheet generated from the declarative schema. */

import { settingsForSurface } from '../core/settings.js';
import { el } from '../core/dom.js';
import { group } from './controls.js';
import { openModal } from './modal.js';
import { buildSettingControl } from './setting-control.js';

export function openSettingsSheet() {
  const body = el('div', {});
  const groups = new Map();
  for (const definition of settingsForSurface('settings')) {
    if (!groups.has(definition.group)) groups.set(definition.group, []);
    groups.get(definition.group).push(definition);
  }

  for (const [title, definitions] of groups) {
    const controls = definitions.map((definition) => buildSettingControl(definition).node);
    body.append(group(title, controls));
  }

  openModal({
    title: 'Settings',
    body,
    actions: [{ label: 'Done', tone: 'primary' }],
  });
}
