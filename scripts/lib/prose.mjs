/**
 * Prose rules shared by the documentation gate.
 *
 * Three tells are mechanical, so they are enforced here instead of left to a
 * reviewer: typographic dashes (em dash, en dash, figure dash, horizontal bar),
 * a double hyphen used as punctuation, and Title Case headings. The rules name
 * the character or shape, so a finding is actionable without a second lookup.
 *
 * CLI options are not prose: `npm run build -- --check` and `--flag` stay
 * legal. A Markdown rule (`---`) and a table separator stay legal too.
 */

import brand from '../../brand.json' with { type: 'json' };

const DASH = /[\u2012\u2013\u2014\u2015]/g;
const DASH_NAMES = Object.freeze({
  '\u2012': 'figure dash',
  '\u2013': 'en dash',
  '\u2014': 'em dash',
  '\u2015': 'horizontal bar',
});

/** Words that stay lower-case in a sentence-case heading. */
const FUNCTION_WORDS = new Set([
  'a', 'an', 'and', 'as', 'at', 'be', 'but', 'by', 'for', 'from', 'if', 'in', 'into', 'is', 'it',
  'its', 'of', 'on', 'or', 'per', 'so', 'that', 'the', 'this', 'to', 'up', 'via', 'was', 'we',
  'what', 'when', 'where', 'which', 'who', 'why', 'with', 'you', 'your', 'not', 'no', 'all', 'any',
]);

/**
 * Names that are capitalised in every position. A heading made only of these is
 * not Title Case, it is a proper name.
 */
const PROPER_WORDS = new Set([
  brand.name, 'Android', 'Bluetooth', 'Chrome', 'ChromeOS', 'CodeQL', 'Dependabot', 'Edge',
  'Firefox', 'GitHub', 'Java', 'Linux', 'Mac', 'Node', 'Pages', 'Safari', 'Scorecard', 'WebView',
  'Windows', 'iOS', 'APK', 'API', 'BLE', 'CI', 'CLI', 'CSP', 'CSS', 'HTML', 'HTTP', 'HTTPS',
  'JSON', 'JS', 'OIDC', 'PWA', 'SDK', 'SHA', 'SLSA', 'SPP', 'UI', 'URL', 'UTF', 'UX', 'XML',
  'YAML', 'D110', 'D11',
]);

/**
 * Every typographic dash in a text file, with its 1-based line number.
 * An em dash is never syntax in this repository, so this scans source and
 * documentation alike.
 *
 * @param {string} file repo-relative path
 * @param {string} text
 * @returns {{file: string, line: number, message: string}[]}
 */
export function dashFindings(file, text) {
  const findings = [];
  for (const [index, line] of String(text).split('\n').entries()) {
    for (const match of line.matchAll(DASH)) {
      findings.push({
        file,
        line: index + 1,
        message: `${DASH_NAMES[match[0]]} is not allowed; use a comma, colon or period`,
      });
    }
  }
  return findings;
}

/**
 * A double hyphen used as punctuation. Allowed shapes:
 *   - `npm run build -- --check` (a CLI separator before another option),
 *   - `--flag` (an option, no space after the run),
 *   - `---` or longer (a Markdown rule or a table separator).
 *
 * @param {string} file repo-relative path
 * @param {string} text
 * @returns {{file: string, line: number, message: string}[]}
 */
export function doubleDashFindings(file, text) {
  const findings = [];
  for (const [index, line] of String(text).split('\n').entries()) {
    for (const match of line.matchAll(/(?<![\p{L}\p{N}_-])--(?![\p{L}\p{N}_-])|(?<=[\p{L}\p{N}_])--(?=[\p{L}\p{N}_])/gu)) {
      const before = line.slice(0, match.index);
      const after = line.slice(match.index + 2);
      if (before.endsWith('-') || after.startsWith('-')) continue;
      const next = /^\s*(\S)/.exec(after)?.[1] ?? '';
      if (next === '-') continue;
      findings.push({
        file,
        line: index + 1,
        message: 'double hyphen used as punctuation; use a comma, colon or period',
      });
    }
  }
  return findings;
}

/**
 * Every word of a heading, with inline code and link targets removed. Function
 * words stay in: a lower-case article is the strongest evidence of sentence
 * case, so dropping it would make "Build the Android APK" look like a title.
 */
function headingWords(heading) {
  const text = String(heading)
    .replace(/`[^`]*`/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ');
  return text
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.replace(/^-+|-+$/g, ''))
    .filter((word) => word.length > 0 && /^\p{L}/u.test(word));
}

/**
 * Headings that capitalise every content word, which is Title Case rather than
 * sentence case. A heading made only of proper names and acronyms (for example
 * `GitHub Pages`) is not a finding.
 *
 * @param {string} file repo-relative path
 * @param {string} markdown
 * @returns {{file: string, line: number, message: string}[]}
 */
export function titleCaseFindings(file, markdown) {
  const findings = [];
  for (const [index, line] of String(markdown).split('\n').entries()) {
    const match = /^ {0,3}#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (!match) continue;
    const words = headingWords(match[1]);
    if (words.length < 2) continue;
    const capitalised = words.filter((word) => /^\p{Lu}/u.test(word));
    if (capitalised.length !== words.length) continue;
    const ordinary = capitalised.filter(
      (word) =>
        !PROPER_WORDS.has(word) &&
        !FUNCTION_WORDS.has(word.toLowerCase()) &&
        !/^\p{Lu}[\p{Lu}\p{N}]+$/u.test(word)
    );
    if (ordinary.length === 0) continue;
    findings.push({
      file,
      line: index + 1,
      message: `heading is title case; use sentence case: ${match[1]}`,
    });
  }
  return findings;
}

/**
 * Every prose rule for one Markdown file.
 *
 * @param {string} file
 * @param {string} text
 * @returns {{file: string, line: number, message: string}[]}
 */
export function proseFindings(file, text) {
  return [
    ...dashFindings(file, text),
    ...doubleDashFindings(file, text),
    ...(file.toLowerCase().endsWith('.md') ? titleCaseFindings(file, text) : []),
  ];
}
