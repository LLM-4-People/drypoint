/**
 * The Code 128 symbol table is safety-critical: a wrong pattern produces bars
 * a scanner cannot read, and nothing in the app would fail. This test pins the
 * project table to a committed JsBarcode fixture.
 *
 * Fixture: `test/fixtures/code128-patterns.json`, normalized from JsBarcode
 * 3.12.3 `src/barcodes/CODE128/constants.js`. JsBarcode is MIT-licensed
 * (https://github.com/lindell/JsBarcode); only its data table is included, and
 * the attribution travels with the fixture. Phase B owns
 * `THIRD_PARTY_NOTICES.md`; this header is the attribution until then.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { CODE128_PATTERNS, code128Modules, code128Values } from '../src/label/barcode.js';

const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/code128-patterns.json', import.meta.url), 'utf8')
);

test('the fixture is the complete 107-symbol Code 128 table', () => {
  assert.equal(fixture.license, 'MIT');
  assert.match(fixture.attribution, /JsBarcode/);
  assert.match(fixture.source, /JsBarcode/);
  const patterns = fixture.patterns;
  assert.equal(patterns.length, 107, '103 data symbols, 3 start symbols and 1 stop');
  for (const [index, pattern] of patterns.entries()) {
    const expectedLength = index === 106 ? 13 : 11;
    assert.equal(pattern.length, expectedLength, `pattern ${index} has ${expectedLength} bits`);
    assert.match(pattern, /^[01]+$/, `pattern ${index} is binary`);
    assert.equal(pattern[0], '1', `pattern ${index} starts with a bar`);
    if (index !== 106) assert.equal(pattern.at(-1), '0', `pattern ${index} ends with a space`);
  }
  assert.deepEqual(
    patterns.filter((pattern) => pattern.length === 13),
    ['1100011101011'],
    'the stop symbol is the only 13-bit pattern'
  );
});

test('the project table equals the JsBarcode fixture element by element', () => {
  assert.equal(CODE128_PATTERNS.length, fixture.patterns.length);
  for (let index = 0; index < fixture.patterns.length; index++) {
    assert.equal(
      CODE128_PATTERNS[index],
      fixture.patterns[index],
      `pattern ${index}: project ${CODE128_PATTERNS[index]} !== fixture ${fixture.patterns[index]}`
    );
  }
});

test('the table is what the encoder actually emits', () => {
  // A spot check through the public encoder: START_B, the data values, the
  // checksum and STOP must select exactly the documented patterns.
  const values = code128Values('ABC-123');
  assert.equal(values[0], 104, 'START B');
  assert.equal(values.at(-1), 106, 'STOP');
  const modules = code128Modules('ABC-123');
  for (const [position, value] of values.entries()) {
    const expected = fixture.patterns[value];
    const actual = modules
      .slice(position * 11, position * 11 + expected.length)
      .join('');
    assert.equal(actual, expected, `value ${value} emits its documented pattern`);
  }
  assert.equal(modules.length, modules.filter((bit) => bit === 0 || bit === 1).length);
});
