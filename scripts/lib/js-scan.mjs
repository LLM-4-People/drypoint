/**
 * One dependency-free JavaScript lexer for the build scripts.
 *
 * The precache generator needs two views of a module and they must agree:
 *
 *   code   — the source with comments blanked out (newlines preserved), so an
 *            `import()` mentioned in a comment is never mistaken for a
 *            dependency while string contents stay intact;
 *   inside — one flag per offset that sits inside a string, template literal or
 *            regex literal, so an `import()` that is only text is skipped.
 *
 * Both views come from a single pass. A second scanner with its own idea of
 * quotes/regexes is how the `/['"]/`-before-imports bug appeared: the comment
 * stripper swallowed the rest of the file while the specifier scan kept going.
 * Regex-vs-division is decided from the preceding token the way a real parser
 * does it, with the one control-paren exception (`if (x) /re/.test(y)`).
 *
 * Known limit: a regex literal that is the first token after a block-closing
 * `}` is read as division. That form is rare, imports are matched from line
 * starts rather than from this state, and the app has no such module.
 */

/** Words after which the parser expects an expression, so `/` starts a regex. */
const EXPRESSION_KEYWORDS = new Set([
  'await',
  'case',
  'delete',
  'do',
  'else',
  'in',
  'instanceof',
  'new',
  'of',
  'return',
  'throw',
  'typeof',
  'void',
  'yield',
]);

/** Keywords whose parenthesised condition can be followed by a regex. */
const CONTROL_KEYWORDS = new Set(['if', 'for', 'while', 'with']);

const IDENTIFIER_START = /[A-Za-z_$\u0080-\uffff]/;
const IDENTIFIER_PART = /[\w$\u0080-\uffff]/;
const NUMBER_PART = /[0-9a-fA-FxXoObBeE._]/;
const REGEX_FLAG = /[a-z]/i;

/**
 * Lex a JavaScript source.
 *
 * @param {string} source
 * @returns {{ code: string, inside: Uint8Array }} `code` keeps every offset and
 *   blanks only comments; `inside[i] === 1` marks string/template/regex text.
 */
export function lexJavaScript(source) {
  const text = String(source);
  // split('') keeps UTF-16 offsets aligned with `text.length`; [...text] would
  // split surrogate pairs and shift every later index.
  const code = text.split('');
  const inside = new Uint8Array(text.length);

  let index = 0;
  /** Whether the previous significant token can end an expression. */
  let previous = null;
  let lastWord = '';
  const parens = [];

  const blank = (from, to) => {
    for (let at = from; at < to; at++) {
      if (code[at] !== '\n' && code[at] !== '\r') code[at] = ' ';
    }
  };
  const mask = (from, to) => {
    inside.fill(1, Math.max(0, from), Math.min(text.length, to));
  };

  function scanString(quote) {
    const start = index;
    index++;
    while (index < text.length) {
      const char = text[index];
      if (char === '\\') {
        index += 2;
        continue;
      }
      if (char === quote) {
        index++;
        break;
      }
      if (char === '\n') break; // unterminated: a string cannot span lines
      index++;
    }
    mask(start, index);
  }

  function scanRegex() {
    const start = index;
    index++;
    let characterClass = false;
    while (index < text.length) {
      const char = text[index];
      if (char === '\\') {
        index += 2;
        continue;
      }
      if (char === '\n') break;
      if (char === '[') characterClass = true;
      else if (char === ']') characterClass = false;
      else if (char === '/' && !characterClass) {
        index++;
        break;
      }
      index++;
    }
    while (index < text.length && REGEX_FLAG.test(text[index])) index++;
    mask(start, index);
  }

  function scanTemplate() {
    inside[index] = 1; // opening backtick
    index++;
    while (index < text.length) {
      const char = text[index];
      if (char === '\\') {
        inside[index] = 1;
        if (index + 1 < text.length) inside[index + 1] = 1;
        index += 2;
        continue;
      }
      if (char === '`') {
        inside[index] = 1;
        index++;
        return;
      }
      if (char === '$' && text[index + 1] === '{') {
        index += 2;
        scanCode(true);
        continue;
      }
      inside[index] = 1;
      index++;
    }
  }

  function scanCode(stopAtBraceClose) {
    let depth = 0;
    while (index < text.length) {
      const char = text[index];
      if (stopAtBraceClose && char === '}' && depth === 0) {
        index++; // the `}` that ends the template expression
        return;
      }
      if (char === ' ' || char === '\t' || char === '\n' || char === '\r' || char === '\f' || char === '\v') {
        index++;
        continue;
      }

      if (char === '#' && index === 0 && text[1] === '!') {
        const start = index;
        while (index < text.length && text[index] !== '\n') index++;
        blank(start, index);
        continue;
      }

      if (char === '/' && text[index + 1] === '/') {
        const start = index;
        while (index < text.length && text[index] !== '\n') index++;
        blank(start, index);
        continue;
      }
      if (char === '/' && text[index + 1] === '*') {
        const start = index;
        index += 2;
        while (index < text.length && !(text[index] === '*' && text[index + 1] === '/')) index++;
        index = Math.min(index + 2, text.length);
        blank(start, index);
        continue;
      }

      // A slash is a regex only where an expression may start; after an
      // operand it is division (`width / height`) and the lexer must not
      // consume the rest of the file looking for a closing slash.
      if (char === '/' && previous !== 'operand') {
        scanRegex();
        previous = 'operand';
        lastWord = '';
        continue;
      }
      if (char === '"' || char === "'") {
        scanString(char);
        previous = 'operand';
        lastWord = '';
        continue;
      }
      if (char === '`') {
        scanTemplate();
        previous = 'operand';
        lastWord = '';
        continue;
      }

      if (IDENTIFIER_START.test(char)) {
        const start = index;
        while (index < text.length && IDENTIFIER_PART.test(text[index])) index++;
        const word = text.slice(start, index);
        lastWord = word;
        previous = EXPRESSION_KEYWORDS.has(word) ? 'operator' : 'operand';
        continue;
      }
      if (char >= '0' && char <= '9') {
        while (index < text.length && NUMBER_PART.test(text[index])) index++;
        previous = 'operand';
        lastWord = '';
        continue;
      }

      if (char === '(') {
        parens.push(CONTROL_KEYWORDS.has(lastWord));
        previous = 'operator';
        lastWord = '';
        index++;
        continue;
      }
      if (char === ')') {
        const control = parens.pop() === true;
        // `if (ready) /re/.test(x)` starts an expression after the condition.
        previous = control ? 'operator' : 'operand';
        lastWord = '';
        index++;
        continue;
      }
      if (char === '{') {
        depth++;
        previous = 'operator';
        lastWord = '';
        index++;
        continue;
      }
      if (char === '}') {
        if (depth > 0) depth--;
        previous = 'operand';
        lastWord = '';
        index++;
        continue;
      }
      if (char === ']') {
        previous = 'operand';
        lastWord = '';
        index++;
        continue;
      }
      if ((char === '+' || char === '-') && text[index + 1] === char) {
        // Postfix `i++` keeps the operand state; prefix `++i` expects an operand.
        index += 2;
        lastWord = '';
        continue;
      }
      if (char === '.') {
        index++;
        lastWord = '';
        continue;
      }

      previous = 'operator';
      lastWord = '';
      index++;
    }
  }

  scanCode(false);
  return { code: code.join(''), inside };
}
