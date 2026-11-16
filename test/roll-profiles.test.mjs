import test from 'node:test';
import assert from 'node:assert/strict';

import { allRollProfiles, applyRollProfile, getRollProfile, rememberRoll } from '../src/device/roll-profiles.js';
import { CONFIG } from '../src/core/config.js';

test('roll profiles ignore invalid values and absent barcodes', () => {
  assert.equal(rememberRoll('', { lengthMm: 40 }), null);
  assert.equal(rememberRoll('invalid-roll', { lengthMm: Number.NaN, labelType: 99 }), null);
  assert.equal(getRollProfile('invalid-roll'), null);

  const partial = rememberRoll('invalid-roll', { lengthMm: 5000, labelType: 1 });
  assert.equal(partial.lengthMm, undefined, 'an out-of-range length is dropped');
  assert.equal(partial.labelType, 1, 'a valid label type is still stored');
  assert.equal(getRollProfile(null), null);
});

test('roll profiles persist valid geometry and return copies', () => {
  const saved = rememberRoll('test-roll-a', { lengthMm: 40, labelType: 1 });
  assert.equal(saved.lengthMm, 40);
  assert.equal(saved.labelType, 1);

  const first = getRollProfile('test-roll-a');
  first.lengthMm = 999;
  assert.equal(getRollProfile('test-roll-a').lengthMm, 40, 'callers cannot mutate the store');

  const all = allRollProfiles();
  all['test-roll-a'].lengthMm = 1;
  assert.equal(getRollProfile('test-roll-a').lengthMm, 40);
});

test('the roll profile map is capped and evicts the oldest entry', () => {
  const cap = CONFIG.device.maxRollProfiles;
  for (let index = 0; index < cap + 10; index++) {
    rememberRoll(`capped-${index}`, { lengthMm: 30, labelType: 1 });
  }
  const profiles = allRollProfiles();
  assert.ok(Object.keys(profiles).length <= cap);
  assert.ok(profiles[`capped-${cap + 9}`], 'the newest profile survives');
  assert.equal(profiles['capped-0'], undefined, 'the oldest new profile was evicted');
});

test('a saved profile reapplies the length and the tape type the printer supports', () => {
  const changes = [];
  const applied = applyRollProfile(
    { lengthMm: 50, labelType: 2 },
    {
      capabilities: { labelTypes: [1, 2, 3] },
      lengthMm: 40,
      labelType: '1',
      setLength: (value) => changes.push(['length', value]),
      setLabelType: (value) => changes.push(['labelType', value]),
    }
  );
  assert.deepEqual(changes, [
    ['length', 50],
    ['labelType', '2'],
  ]);
  assert.equal(applied.length, 2);
});

test('a profile only reapplies what actually differs and what the printer supports', () => {
  const changes = [];
  const applied = applyRollProfile(
    { lengthMm: 40, labelType: 5 },
    {
      capabilities: { labelTypes: [1, 2, 3] },
      lengthMm: 40,
      labelType: '1',
      setLength: (value) => changes.push(['length', value]),
      setLabelType: (value) => changes.push(['labelType', value]),
    }
  );
  assert.deepEqual(changes, [], 'the length already matches and type 5 is unsupported');
  assert.deepEqual(applied, []);
});
