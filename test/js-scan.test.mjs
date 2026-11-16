/**
 * O5 regression: one lexer owns the comment/string/template/regex view.
 *
 * Before the shared lexer, `stripComments` entered quote mode on the quote
 * inside `/['"]/` and the separate string-mask pass desynchronised the same
 * way, so a module with that regex silently lost every later import while
 * `--check` stayed green. Both consumers must now see the same masked code.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { lexJavaScript } from '../scripts/lib/js-scan.mjs';
import { moduleSpecifiers, stripComments } from '../scripts/precache.mjs';

test("a /['\"]/ literal before imports cannot hide ./b.js or ./c.js", () => {
  const source = [
    "const quotes = /['\"]/;",
    "import { b } from './b.js';",
    "import { c } from './c.js';",
  ].join('\n');

  assert.deepEqual(moduleSpecifiers(source), ['./b.js', './c.js'], 'both imports survive the regex literal');
  const stripped = stripComments(source);
  assert.match(stripped, /^const quotes = \/\['"\]\/;$/m, 'the regex literal is kept intact');
  assert.match(stripped, /import \{ c \} from '\.\/c\.js';/, 'the comment view keeps the later import');
});

test('division is not mistaken for the start of a regex', () => {
  const source = [
    'const half = width / height;',
    'const ratio = total / count / 2;',
    "const quotes = /['\"]/g;",
    "import { keep } from './keep.js';",
  ].join('\n');

  assert.deepEqual(moduleSpecifiers(source), ['./keep.js'], 'the division slashes stay operators');
  const { code } = lexJavaScript(source);
  assert.ok(code.includes('width / height'), 'division is left as code');
});

test('a regex after an expression position is still recognised', () => {
  const source = [
    'function test(value) {',
    "  if (value) /['\"]/.test(value);",
    "  return /[/'\"]/.test(value);",
    '}',
    "import { after } from './after.js';",
  ].join('\n');

  assert.deepEqual(moduleSpecifiers(source), ['./after.js'], 'control parens and return values keep regex mode');
  const { inside } = lexJavaScript(source);
  assert.equal(inside[source.indexOf("if (value) /") + 'if (value) '.length], 1, 'the regex body is masked');
});

test('a template literal with ${} expressions keeps its quotes contained', () => {
  const source = [
    "const name = `prefix ${user ?? 'unknown'} suffix`;",
    'const nested = `a${`b${value}`}c`;',
    "const text = `import('./not-a-dependency.js')`;",
    "import { real } from './real.js';",
  ].join('\n');

  assert.deepEqual(moduleSpecifiers(source), ['./real.js'], 'template text is not code; the import after it is');
  const { inside } = lexJavaScript(source);
  const textStart = source.indexOf("`import('./not-a-dependency.js')`") + 1;
  assert.equal(inside[textStart], 1, 'the template text is masked');
  assert.equal(inside[source.indexOf("'unknown'")], 1, 'the quote inside ${} is a string, not the outer template');
});

test('a dynamic import inside a template expression is code, not text', () => {
  const source = "const lazy = `${await import('./lazy.js')}`;";
  assert.deepEqual(moduleSpecifiers(source), ['./lazy.js']);
});

test('line and block comments are removed without touching strings', () => {
  const source = [
    "const kept = '// not a comment /* either */';",
    "// import { gone } from './gone.js';",
    "/* import { alsoGone } from './also.js'; */",
    "import { live } from './live.js';",
  ].join('\n');

  assert.deepEqual(moduleSpecifiers(source), ['./live.js'], 'only the real import is collected');
  const stripped = stripComments(source);
  assert.ok(stripped.includes("'// not a comment /* either */'"), 'string contents are intact');
  assert.ok(!stripped.includes('gone.js'), 'comment contents are gone');
  assert.ok(stripped.includes("'./live.js'"), 'code survives');
});

test('the lexer keeps offsets and masks exactly the literal text', () => {
  const source = "const a = 'text'; const b = /re/; const c = `t`; const d = 4;";
  const { code, inside } = lexJavaScript(source);
  assert.equal(code, source, 'no comments means no change to the code view');
  assert.equal(inside.length, source.length, 'the mask is index-aligned');
  assert.equal(inside[source.indexOf("'text'")], 1);
  assert.equal(inside[source.indexOf('/re/')], 1);
  assert.equal(inside[source.indexOf('`t`')], 1);
  assert.equal(inside[source.indexOf('const a')], 0);
  assert.equal(inside[source.indexOf('const d')], 0);
});
