/**
 * `node --check` parses but never notices an unused binding. This scan is the
 * reference-count gate: every named or default import, in every source and test
 * module, must be read somewhere else in that module, and every export of the
 * app's own modules must have a consumer outside the module that declares it.
 *
 * The shared lexer blanks comments, strings, templates and regex literals, so a
 * name quoted in prose or a fixture cannot keep a dead import or export alive.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { lexJavaScript } from '../scripts/lib/js-scan.mjs';
import { projectRoot } from './helpers/project-files.mjs';

const ROOTS = ['src', 'scripts', 'test'];

function modules(directory, prefix = '') {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const path = join(directory, entry.name);
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...modules(path, relative));
    else if (/\.(?:m?js)$/.test(entry.name)) files.push(relative);
  }
  return files;
}

/** Imported local names from one module's masked code. */
export function importedNames(code) {
  const names = [];
  for (const match of code.matchAll(/(^|\n)\s*import\s+([^;]+?)\s+from\s+['"][^'"]+['"];?/g)) {
    const clause = match[2].replace(/\s+/g, ' ').trim();
    const named = clause.match(/\{([\s\S]*?)\}/)?.[1];
    if (named) {
      for (const part of named.split(',')) {
        const specifier = part.trim();
        if (!specifier || specifier.startsWith('type ')) continue;
        const local = specifier.split(/\s+as\s+/).at(-1).trim();
        if (local) names.push(local);
      }
    }
    const rest = clause.replace(/\{[\s\S]*?\}/, '').replace(/^\*|\s+as\s+\w+/g, '').replace(/,/g, ' ').trim();
    if (rest && !rest.startsWith('*')) names.push(rest.split(/\s+/)[0]);
  }
  return names;
}

test('every module uses every binding it imports', () => {
  const files = [...ROOTS.flatMap((root) => modules(join(projectRoot, root), root)), 'sw.js'];
  const unused = [];
  for (const file of files) {
    const source = readFileSync(join(projectRoot, file), 'utf8');
    const { code, inside } = lexJavaScript(source);
    // Blank every import span in place (same length), then mask comment and
    // string interiors. The specifier is a string, so import detection has to
    // read `code`; the usage scan must read the masked text or a fixture could
    // keep a dead binding alive.
    const withoutImports = code.replace(
      /(^|\n)\s*import\s+[^;]+?\s+from\s+['"][^'"]+['"];?/g,
      (statement) => ' '.repeat(statement.length)
    );
    const body = [...withoutImports].map((character, index) => (inside[index] ? ' ' : character)).join('');
    for (const name of importedNames(code)) {
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const reads = new RegExp(`(?<![\\w$])${escaped}(?![\\w$])`, 'g');
      let used = false;
      for (const read of body.matchAll(reads)) {
        // `obj.name` and `obj?.name` are property reads, not the binding;
        // `...name` is a spread and does read it.
        const before = body.slice(Math.max(0, read.index - 2), read.index);
        if (before.endsWith('.') && before !== '..') continue;
        used = true;
        break;
      }
      if (!used) unused.push(`${file}: ${name}`);
    }
  }
  assert.deepEqual(unused, [], 'remove imports nothing reads');
});

/** Names one module exports, read from comment-blanked code. */
export function exportedNames(code) {
  const names = [];
  for (const match of code.matchAll(/^export\s+(?:async\s+)?(?:function|const|let|class)\s+([A-Za-z_$][\w$]*)/gm)) {
    names.push(match[1]);
  }
  for (const match of code.matchAll(/^export\s*\{([^}]*)\}/gm)) {
    for (const part of match[1].split(',')) {
      const specifier = part.trim();
      if (!specifier) continue;
      const exported = specifier.split(/\s+as\s+/).at(-1).trim();
      if (exported) names.push(exported);
    }
  }
  return names;
}

test('every exported name has a consumer outside its own module', () => {
  // A name used only by the module that declares it is a private detail with a
  // public keyword: it widens the API surface and survives refactors unnoticed.
  // Dynamic importers keep a name alive through the identifier they read.
  const files = [...ROOTS.flatMap((root) => modules(join(projectRoot, root), root)), 'sw.js'];
  const parsed = files.map((file) => {
    const { code, inside } = lexJavaScript(readFileSync(join(projectRoot, file), 'utf8'));
    const body = [...code].map((character, index) => (inside[index] ? ' ' : character)).join('');
    return { file, code, body };
  });

  const dead = [];
  for (const { file, code } of parsed) {
    // Third-party vendor code keeps its upstream API whatever this app uses.
    if (!file.startsWith('src/') || file.startsWith('src/vendor/')) continue;
    for (const name of exportedNames(code)) {
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const pattern = new RegExp(`(?<![\\w$])${escaped}(?![\\w$])`);
      const consumed = parsed.some((other) => other.file !== file && pattern.test(other.body));
      if (!consumed) dead.push(`${file}: ${name}`);
    }
  }
  assert.deepEqual(dead, [], 'unexport a name nothing else reads, or wire it');
});
