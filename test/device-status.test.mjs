import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { CONNECTION_STATUSES, describeDeviceStatus } from '../src/device/capabilities.js';
import { FIXTURE_SERIAL } from './fixtures/captured-unit.mjs';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('one status table covers every state the manager publishes', () => {
  // The manager is the only producer; the header pill and the panel are the
  // consumers. Extract the status literals from the lines that publish one,
  // including the quiet/error ternary, and compare them to the table.
  const manager = read('src/device/manager.js');
  const published = new Set();
  for (const line of manager.split('\n')) {
    if (!/status:/.test(line)) continue;
    for (const match of line.matchAll(/'([a-z]+)'/g)) published.add(match[1]);
  }
  assert.deepEqual([...published].sort(), [...CONNECTION_STATUSES].sort());
  // The table is also enforced at the publish choke point, so a later status
  // cannot reach the UI without a descriptor.
  assert.match(manager, /CONNECTION_STATUSES\.includes\(patch\.status\)/);
});

test('every connection status has one unambiguous description', () => {
  const connected = describeDeviceStatus({
    status: 'connected',
    transportLabel: 'Bluetooth serial (SPP)',
    capabilities: { model: 'D110_M', serial: FIXTURE_SERIAL },
  });
  assert.deepEqual(connected, {
    status: 'connected',
    dot: 'online',
    label: `D110_M · ${FIXTURE_SERIAL}`,
    title: 'Open printer controls · Bluetooth serial (SPP)',
    ariaLabel: `D110_M · ${FIXTURE_SERIAL} — open printer controls`,
    panelLabel: 'Connected',
  });

  const connecting = describeDeviceStatus({ status: 'connecting' });
  assert.equal(connecting.dot, 'connecting');
  assert.equal(connecting.label, 'Connecting…');
  assert.equal(connecting.panelLabel, 'Connecting…');

  // A connected printer that never named its model is still a printer.
  const anonymous = describeDeviceStatus({ status: 'connected', capabilities: { model: null } });
  assert.equal(anonymous.label, 'Printer');
  assert.equal(anonymous.ariaLabel, 'Printer — open printer controls');
  assert.equal(anonymous.panelLabel, 'Connected');

  const error = describeDeviceStatus({ status: 'error' });
  assert.equal(error.dot, 'error');
  assert.equal(error.label, 'Connect printer');
  assert.equal(error.panelLabel, 'Connection error');

  const idle = describeDeviceStatus({ status: 'idle' });
  assert.equal(idle.dot, 'offline');
  assert.equal(idle.label, 'Connect printer');
  assert.equal(idle.panelLabel, 'Offline');

  const panelLabels = [connected, connecting, error, idle].map(({ panelLabel }) => panelLabel);
  assert.equal(new Set(panelLabels).size, panelLabels.length, 'no two states read the same in the panel');
  assert.equal(describeDeviceStatus({}).panelLabel, 'Offline', 'an unknown state is offline, never invented');
  assert.equal(describeDeviceStatus({ status: 'nonsense' }).dot, 'offline');
});
