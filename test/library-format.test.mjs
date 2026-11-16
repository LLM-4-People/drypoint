/**
 * The pure text of the visible label library: relative times, the element
 * count and the unique default name. No DOM is needed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { CONFIG } from '../src/core/config.js';
import { DEFAULT_LABEL_NAME } from '../src/label/schema.js';
import { elementCountLabel, nextLabelName, relativeLabelTime } from '../src/ui/library-format.js';

const DAY = 86_400_000;
const HOUR = 3_600_000;
const MINUTE = 60_000;

test('relative label times use one stable wording at every boundary', () => {
  const now = new Date(2026, 10, 16, 12, 0, 0).getTime();
  const cases = [
    [now, 'just now'],
    [now - 59_000, 'just now'],
    [now - MINUTE, '1 min ago'],
    [now - 5 * MINUTE, '5 min ago'],
    [now - 59 * MINUTE, '59 min ago'],
    [now - HOUR, '1 h ago'],
    [now - 2 * HOUR, '2 h ago'],
    [now - 23 * HOUR, '23 h ago'],
    [now - DAY, '1 d ago'],
    [now - 3 * DAY, '3 d ago'],
    [now - 6 * DAY, '6 d ago'],
    [now - 7 * DAY, 'on 2026-11-09'],
    [now + MINUTE, 'just now'],
    [0, 'unknown time'],
    [Number.NaN, 'unknown time'],
  ];
  for (const [at, expected] of cases) {
    assert.equal(relativeLabelTime(at, now), expected, `${at} at ${now}`);
  }
});

test('the list never shows a singular element count for two or more', () => {
  assert.equal(elementCountLabel(0), '0 elements');
  assert.equal(elementCountLabel(1), '1 element');
  assert.equal(elementCountLabel(2), '2 elements');
  assert.equal(elementCountLabel(-1), '0 elements');
  assert.equal(elementCountLabel('4'), '0 elements');
});

test('a new label takes the next free Untitled name within the name bound', () => {
  assert.equal(nextLabelName([]), DEFAULT_LABEL_NAME);
  assert.equal(nextLabelName(['Untitled']), 'Untitled 2');
  assert.equal(nextLabelName(['Untitled', 'Untitled 2']), 'Untitled 3');
  assert.equal(nextLabelName(['Untitled 2']), 'Untitled');
  // Case-insensitive: two rows that differ only by case read as duplicates.
  assert.equal(nextLabelName(['  untitled  ']), 'Untitled 2');
  assert.equal(nextLabelName(['Untitled', 'untitled 2', 'Untitled 3']), 'Untitled 4');

  const base = 'x'.repeat(CONFIG.bounds.maxNameChars);
  const name = nextLabelName([base], { base });
  assert.equal(name.length, CONFIG.bounds.maxNameChars, 'the suffix stays inside the bound');
  assert.ok(name.endsWith(' 2'));
  assert.notEqual(name.toLowerCase(), base.toLowerCase());
});
