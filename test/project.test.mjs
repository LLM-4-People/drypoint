import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import brand from '../brand.json' with { type: 'json' };
import { CONFIG } from '../src/core/config.js';
import { SETTINGS_SCHEMA, printSettingsSnapshot } from '../src/core/settings.js';
import { INFO_PROJECTION } from '../src/device/manager.js';
import { shortcutIntent } from '../src/editor/shortcuts.js';
import { lexJavaScript } from '../scripts/lib/js-scan.mjs';
import { isIgnored, parseIgnore } from '../scripts/lib/tree.mjs';
import { listProjectFiles, listRootFiles, projectRoot, readProjectFile as read } from './helpers/project-files.mjs';

const pkg = JSON.parse(read('package.json'));
const indexHtml = read('index.html');
const css = read('assets/app.css');
const readme = read('README.md');

/* ---------------- package and settings contracts ---------------- */

test('the npm test glob survives cmd.exe (double quotes, never single quotes)', () => {
  // cmd.exe passes single quotes through literally; Node then matches no file
  // and exits 0, which is a false green on Windows.
  assert.equal(pkg.scripts.test, 'node --test "test/*.test.mjs"');
  assert.doesNotMatch(pkg.scripts.test, /'/);
});

test('the supported Node range is declared', () => {
  assert.equal(pkg.engines?.node, '>=22');
});

test('the package version and the app version are one fact', () => {
  assert.equal(pkg.version, CONFIG.app.version);

  // package.json is the one owner the build reads; the template carries only
  // placeholders, so an APK version cannot drift from the app version. How the
  // placeholders are rendered is verified by android-manifest.test.mjs.
  const template = read('android/AndroidManifest.template.xml');
  assert.match(template, /android:versionName="@VERSION_NAME@"/);
  assert.match(template, /android:versionCode="@VERSION_CODE@"/);
  assert.doesNotMatch(template, /\b\d+\.\d+\.\d+\b/, 'the template carries no version copy');
});

test('dead configuration keys stay deleted', () => {
  assert.equal(CONFIG.device.battery.lowPercent, undefined);
  assert.equal(CONFIG.ui.previewMaxScale, undefined);
  assert.equal(CONFIG.ui.compactPreviewRatio, undefined);
  assert.equal(CONFIG.ui.panelWidthPx, undefined);
  assert.equal(CONFIG.device.autoShutdownDefault, undefined);
  assert.equal(CONFIG.transport.reconnectDelaysMs, undefined);
  assert.equal(CONFIG.print.speed, undefined, 'the unused SET_PRINT_SPEED bounds are gone');
  assert.equal(CONFIG.ui.zoom.fitMin, undefined, 'Fit no longer has a minimum');
  // The setting key survives: it is the job's quality switch, not CONFIG bounds.
  assert.match(read('src/device/print-options.js'), /JOB_SPEED\[settings\['print\.speed'\]\]/);
});

/**
 * The only text a read gate may trust: comments, strings and template literals
 * are blanked, so prose or a fixture cannot claim a consumer.
 * @param {string} source
 * @returns {string}
 */
export function scannedSource(source) {
  const { code, inside } = lexJavaScript(source);
  return [...code].map((character, index) => (inside[index] ? ' ' : character)).join('');
}

/**
 * Whether one CONFIG leaf is read in already-scanned source.
 * @param {string} sources comment- and string-free text of every consumer
 * @param {string[]} path leaf path below CONFIG
 * @returns {boolean}
 */
export function configLeafConsumed(sources, path) {
  const escape = (key) => key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Dotted reads may wrap or space the dots; a reference to a deeper path still
  // starts with the leaf path, which is what a consumed table needs.
  const dotted = (keys) => `CONFIG${keys.map((key) => `\\s*\\.\\s*${escape(key)}`).join('')}`;
  if (new RegExp(dotted(path)).test(sources)) return true;
  const parent = path.slice(0, -1);
  if (parent.length === 0) return false;
  // Destructuring (`const { widthPx } = CONFIG.geometry`) is the other real
  // read form; it names the key only in the pattern, so a leaf scan has to
  // resolve the parent object explicitly.
  const pattern = new RegExp(`\\{([^{}]*)\\}\\s*=\\s*${dotted(parent)}(?![\\w.])`, 'g');
  for (const match of sources.matchAll(pattern)) {
    const names = match[1].split(',').map((part) => part.trim().split(':')[0].trim());
    if (names.includes(path.at(-1))) return true;
  }
  return false;
}

test('every CONFIG leaf is read outside its own module', () => {
  // The precache generator stamps CONFIG.offline.navigationTimeoutMs into the
  // service-worker manifest (a classic script cannot import the config), so it
  // is a real consumer too. Every file is scanned with comments and strings
  // blanked: a comment that mentions a leaf is not a reader.
  const sources = [...listProjectFiles('src'), ...listProjectFiles('scripts')]
    .filter((file) => (file.endsWith('.js') || file.endsWith('.mjs')) && file !== 'src/core/config.js')
    .map((file) => scannedSource(read(file)))
    .join('\n');

  // A leaf is a primitive, an array, or a lookup table whose keys are all
  // numeric ids. A table is one value: reading it consumes every entry.
  const leaves = [];
  const walk = (value, path) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      leaves.push(path);
      return;
    }
    const keys = Object.keys(value);
    if (keys.length > 0 && keys.every((key) => /^\d+$/.test(key))) {
      leaves.push(path);
      return;
    }
    for (const [key, child] of Object.entries(value)) walk(child, [...path, key]);
  };
  walk(CONFIG, []);

  // `storagePrefix` is read by config.js's own storageKey() helper: the prefix
  // has exactly one reader, so no module can build a storage key by hand.
  const ownerInternal = new Set(['app.storagePrefix']);
  const unused = leaves
    .map((path) => path.join('.'))
    .filter((path) => !ownerInternal.has(path) && !configLeafConsumed(sources, path.split('.')));
  assert.deepEqual(unused, [], 'every CONFIG value has a consumer');
});

test('the label-type table has one owner', () => {
  assert.deepEqual(Object.keys(CONFIG.print.labelTypes), ['1', '2', '3', '5']);
  assert.doesNotMatch(read('src/protocol/commands.js'), /LABEL_TYPES/, 'the command registry no longer keeps a copy');
  const tape = SETTINGS_SCHEMA.find((definition) => definition.key === 'print.labelType');
  assert.deepEqual(
    tape.options,
    Object.entries(CONFIG.print.labelTypes),
    'the settings options are generated from the one table'
  );
});

test('the threshold bounds and default have one owner', () => {
  const definition = SETTINGS_SCHEMA.find((item) => item.key === 'print.threshold');
  assert.equal(definition.min, CONFIG.print.threshold.min);
  assert.equal(definition.max, CONFIG.print.threshold.max);
  assert.equal(definition.step, CONFIG.print.threshold.step);
  assert.equal(definition.default, CONFIG.print.threshold.default);
  assert.equal(CONFIG.print.thresholdDefault, Math.round((CONFIG.print.threshold.default / 100) * 255));
});

test('one diagnostics entry limit is shared by the report and the viewer', () => {
  assert.equal(CONFIG.diagnostics.maxBytesInReport, undefined, 'the misleading byte name is gone');
  assert.equal(CONFIG.diagnostics.maxEntriesInReport, 2000);
  const log = read('src/core/log.js');
  const main = read('src/main.js');
  assert.match(log, /maxEntriesInReport/);
  assert.match(main, /getLogEntries\(\)\.slice\(-CONFIG\.diagnostics\.maxEntriesInReport\)/);
  assert.doesNotMatch(main, /slice\(-200\)/, 'the viewer no longer hard-codes a second limit');
});

test('one selector names every setting a print job reads', () => {
  const snapshot = printSettingsSnapshot();
  const printingKeys = SETTINGS_SCHEMA.filter((definition) => definition.group === 'Printing').map((definition) => definition.key);
  assert.deepEqual(Object.keys(snapshot).sort(), printingKeys.sort());
});

test('the authored brand prefixes reach every consumer', () => {
  const serve = read('scripts/serve.mjs');
  const stop = read('scripts/stop.mjs');
  for (const [file, source] of [['serve', serve], ['stop', stop]]) {
    assert.match(source, /\$\{BRAND\.cliPrefix\}/, `${file} reads the one CLI prefix`);
    assert.doesNotMatch(source, /['"`]drypoint:/, `${file} hard-codes no prefix`);
  }
  assert.match(read('src/main.js'), /`\$\{CONFIG\.app\.id\}-diagnostics-/);
  assert.doesNotMatch(read('src/main.js'), /drypoint-diagnostics/);
});

/* ---------------- H12: product name and theme colours ---------------- */

test('the manifest colours mirror the CSS theme tokens', () => {
  const root = css.match(/^:root\s*\{([\s\S]*?)^\}/m)?.[1];
  assert.ok(root, ':root token block');
  const token = (name) => root.match(new RegExp(`--${name}:\\s*([^;]+);`))?.[1].trim();

  const background = token('bg');
  assert.match(background, /^#[0-9a-f]{6}$/, '--bg is a plain colour');

  const manifest = JSON.parse(read('manifest.webmanifest'));
  assert.equal(manifest.background_color, background, 'manifest background_color mirrors --bg');
  assert.equal(manifest.theme_color, background, 'manifest theme_color mirrors --bg');
  assert.equal(indexHtml.match(/<meta name="theme-color" content="([^"]+)"/)?.[1], background, 'index.html theme-color mirrors --bg');
});

/* ---------------- H11: dead selector, unused type, alias ---------------- */

test('the coarse scroll margin list has no dead selector', () => {
  const rule = css.match(/\.input,\s*\.select,\s*\.segmented,\s*\.switch\s*\{\s*scroll-margin-block:\s*var\(--actionbar-clearance\);\s*\}/);
  assert.ok(rule, 'the four real controls keep the scroll margin');
  assert.doesNotMatch(rule[0], /\.field\b/);
  assert.doesNotMatch(css, /(^|[\s,])\.field\s*[,{]/m, 'no .field selector remains');
});

test('the settings type is narrowed to the types the schema uses', () => {
  const settingsSource = read('src/core/settings.js');
  const declared = [...settingsSource.match(/@typedef \{([^}]+)\} SettingType/)[1].matchAll(/'([^']+)'/g)].map((match) => match[1]);
  const used = [...new Set(SETTINGS_SCHEMA.map((definition) => definition.type))];
  assert.deepEqual([...declared].sort(), [...used].sort(), 'SettingType equals the schema type set');
  assert.deepEqual([...used].sort(), ['enum', 'range', 'toggle']);

  const control = read('src/ui/setting-control.js');
  for (const type of declared) {
    if (type === 'range') assert.match(control, /return slider\(/, 'range is the remaining slider branch');
    else assert.match(control, new RegExp(`control\\.type === '${type}'`), `${type} has a branch`);
  }
  assert.doesNotMatch(control, /=== 'number'/, 'the unused numeric type is gone');
  assert.doesNotMatch(control, /=== 'text'/, 'the unused text type is gone');
  assert.doesNotMatch(control, /class: 'hint'/, 'the unreachable fallback control is gone');
  assert.doesNotMatch(settingsSource, /case 'number'/, 'coercion handles only the declared types');
});

test('history compares documents through one function', () => {
  const history = read('src/label/history.js');
  assert.doesNotMatch(history, /sameDocument/, 'the one-line alias is gone');
  assert.match(history, /sameValue\(document, present\)/);
});

/* ---------------- README contracts ---------------- */

test('the README command table is generated from package.json', () => {
  const start = readme.indexOf('<!-- generated:scripts -->');
  const end = readme.indexOf('<!-- /generated:scripts -->');
  assert.ok(start >= 0 && end > start, 'the command table has its generated markers');

  // The table is the generated block, so it lists the scripts exactly once and
  // in the owner's order. docs-generated.test.mjs proves the bytes are current.
  const block = readme.slice(start, end);
  const documented = new Set([...block.matchAll(/^\| `npm (?:run )?([\w:.-]+)`/gm)].map((match) => match[1]));
  assert.deepEqual([...documented].sort(), Object.keys(pkg.scripts).sort(), 'every script is documented');

  // Prose may name a script but not invent one. `npm install` and `npm ci` are
  // package-manager commands, not package.json scripts, so only script-shaped
  // invocations are considered.
  const prose = readme.slice(0, start) + readme.slice(end);
  for (const match of prose.matchAll(/npm run ([\w:.-]+)/g)) {
    assert.ok(pkg.scripts[match[1]], `README names npm script "${match[1]}"`);
  }
  for (const match of prose.matchAll(/npm (start|stop|test)\b/g)) {
    assert.ok(pkg.scripts[match[1]], `README names npm script "${match[1]}"`);
  }
});

const SHORTCUT_EXPECTATIONS = Object.freeze({
  Print: { type: 'print' },
  Undo: { type: 'undo' },
  Redo: { type: 'redo' },
  'Duplicate the selected element': { type: 'duplicate' },
  'Delete the selected element': { type: 'delete' },
  'Clear the selection': { type: 'deselect' },
  'Nudge the selection 1 px': { type: 'nudge', step: 1 },
  'Nudge the selection 8 px': { type: 'nudge', step: 8 },
});

/** Every keyboard event a README shortcut cell stands for. */
function shortcutEvents(cell) {
  const parts = cell.replaceAll('`', '').split(' + ').map((part) => part.trim());
  const keyName = parts.pop();
  const modifiers = new Set(parts);
  const keys = keyName === 'Arrow keys' ? ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'] : [keyName];
  const events = [];
  for (const key of keys) {
    for (const meta of modifiers.has('Ctrl/Cmd') ? [false, true] : [false]) {
      events.push({
        key,
        ctrlKey: modifiers.has('Ctrl/Cmd') && !meta,
        metaKey: modifiers.has('Ctrl/Cmd') && meta,
        shiftKey: modifiers.has('Shift'),
      });
    }
  }
  return events;
}

test('every shortcut in the README table maps to a real editor intent', () => {
  const section = readme.slice(readme.indexOf('### Keyboard shortcuts'), readme.indexOf('## Offline behaviour'));
  const rows = section
    .split('\n')
    .filter((line) => line.trim().startsWith('|'))
    .slice(2)
    .map((line) => line.split('|').slice(1, -1).map((cell) => cell.trim()));

  assert.ok(rows.length >= 5, 'the README has a shortcut table');
  const seen = new Set();
  for (const [shortcutCell, action] of rows) {
    const expected = SHORTCUT_EXPECTATIONS[action];
    assert.ok(expected, `the test knows the README action "${action}"`);
    seen.add(action);
    for (const alternative of shortcutCell.split(' or ')) {
      for (const event of shortcutEvents(alternative)) {
        const intent = shortcutIntent(event, { inField: false, hasSelection: true, hasDialog: false });
        assert.ok(intent, `${shortcutCell} (${action}) resolves to an intent`);
        assert.equal(intent.type, expected.type, `${shortcutCell} is ${expected.type}`);
        if ('step' in expected) {
          assert.equal(intent.step, expected.step, `${shortcutCell} step`);
          assert.equal(intent.key, event.key, `${shortcutCell} keeps the arrow key`);
        }
      }
    }
  }
  assert.deepEqual([...seen].sort(), Object.keys(SHORTCUT_EXPECTATIONS).sort(), 'the table covers every declared action');
});

test('the README documents the printer actions that exist', () => {
  const panel = read('src/ui/print-panel.js');
  const manager = read('src/device/manager.js');
  for (const label of ['Choose printer', 'Forget printer']) {
    assert.ok(readme.includes(label), `README documents "${label}"`);
    assert.ok(panel.includes(`actionButton('${label}'`), `the panel builds "${label}"`);
  }
  assert.match(manager, /async function choosePrinter\(/);
  assert.match(manager, /connect\(\{ preference, choose: true \}\)/, 'Choose printer always requests a picker');
  assert.match(manager, /choose \? await Transport\.request\(\)/, 'the choose path never uses a granted device');
  assert.match(manager, /async function forgetPrinter\(/);
  assert.match(panel, /Forget the saved printer\?/, 'Forget printer asks for confirmation');
  assert.match(panel, /browser’s site settings/, 'the panel names the one place a browser permission lives');
});

test('the README output row matches the panel description', () => {
  const panel = read('src/ui/print-panel.js');
  const description = panel.match(/const OUTPUT_DESCRIPTION = '([^']+)'/)?.[1];
  assert.ok(description, 'the panel owns one output description');
  assert.ok(readme.includes(`Output: ${description}`), 'the README states the same output');
});

test('the README names the job setting Print quality', () => {
  assert.match(readme, /Print quality/);
  assert.doesNotMatch(readme, /print mode \(normal\/quality\)/i, 'the old job-speed name is gone');
  assert.equal(SETTINGS_SCHEMA.find((definition) => definition.key === 'print.speed').label, 'Print quality');
});

test('the README two-finger pan matches the canvas', () => {
  assert.match(readme, /Two fingers on a zoomed label pan the stage/);
  const canvas = read('src/editor/canvas.js');
  assert.match(canvas, /function beginPan\(\)\s*\{\s*if \(drag\) cancelDrag\(\)/, 'a second touch cancels the pending drag');
  assert.match(canvas, /touchPoints\.size >= 2/);
  assert.match(canvas, /scrollContainer\.scrollLeft/);
});

test('the README server section matches the dev server defaults and surface', () => {
  const serve = read('scripts/serve.mjs');
  const serverState = read('scripts/lib/server-state.mjs');
  const defaultHost = serverState.match(/if \(raw === undefined \|\| raw === ''\) return '([^']+)'/)?.[1];
  assert.ok(defaultHost, 'the server has one loopback default');
  assert.ok(readme.includes(defaultHost), 'the README states the loopback default');
  assert.match(serve, /host = resolveHost\(\)/, 'serve.mjs binds through the shared resolver');
  assert.doesNotMatch(serve, /function resolveHost/, 'the resolver lives in one owner');
  assert.match(readme, /--host 0\.0\.0\.0/, 'the LAN bind is an explicit opt-in');
  assert.match(readme, /serves only the app surface/, 'the README states the app-surface-only rule');
  assert.match(readme, /keystore, docs, scripts, tests and\s+`\.run` are not reachable/);
  assert.match(serve, /isAllowed\(file\)/, 'the server re-asserts the allowlist');
  assert.match(serve, /allowed = new Set\(\[\.\.\.built\.files, SW_FILE, OUTPUT\]\)/, 'only the manifest plus the worker are served');
});

test('the README print gate states the silent-heartbeat refusal', () => {
  assert.match(readme, /heartbeat goes\s+unanswered, the\s+print is refused/);
  assert.match(read('src/device/manager.js'), /did not report its sensors, so nothing was printed/);
});

test('the README source-tree summary names every source area and doc', () => {
  const tree = readme.match(/## How it is put together[\s\S]*?```\n([\s\S]*?)```/)?.[1];
  assert.ok(tree, 'the source tree is a fenced block');
  const rows = tree.split('\n');
  const has = (prefix) => rows.some((line) => line.trimStart().startsWith(prefix));

  const areas = new Set(
    listProjectFiles('src')
      .filter((file) => file.split('/').length > 2)
      .map((file) => file.split('/')[1])
  );
  for (const area of areas) assert.ok(has(`src/${area}/`), `the README tree names src/${area}/`);
  for (const doc of listProjectFiles('docs').filter((file) => file.endsWith('.md'))) {
    assert.ok(tree.includes(doc.split('/')[1]), `the README tree names ${doc.split('/')[1]}`);
  }
});

/* ---------------- documentation accuracy ---------------- */

/**
 * Parse the fenced module map into the file paths it lists. A directory line
 * (trailing slash) owns the deeper, more-indented lines below it.
 */
function parseModuleMap(markdown) {
  const section = markdown.slice(markdown.indexOf('## Module map'));
  const block = section.match(/```[^\n]*\n([\s\S]*?)\n```/)?.[1];
  assert.ok(block, 'the module map is a fenced block');
  const files = [];
  const stack = [];
  for (const raw of block.split('\n')) {
    if (!raw.trim()) continue;
    const indent = raw.length - raw.trimStart().length;
    const token = raw.trim().split(/\s+/)[0];
    while (stack.length && stack.at(-1).indent >= indent) stack.pop();
    const parent = stack.at(-1)?.path ?? '';
    if (token.endsWith('/')) {
      stack.push({ indent, path: `${parent}${token}` });
      continue;
    }
    files.push(`${parent}${token}`);
  }
  return files;
}

test('the ARCHITECTURE module map lists every real src, scripts and docs file', () => {
  const files = parseModuleMap(read('docs/ARCHITECTURE.md'));
  assert.equal(files.length, new Set(files).size, 'no file is listed twice');

  const actual = [
    ...listProjectFiles('src'),
    ...listProjectFiles('scripts'),
    ...listProjectFiles('docs').filter((file) => file.endsWith('.md')),
  ].sort();
  const listed = files.filter((file) => /^(?:src|scripts|docs)\//.test(file)).sort();
  assert.deepEqual(listed, actual, 'the module map has no missing or phantom file');

  for (const anchor of ['index.html', 'manifest.webmanifest', 'sw.js', 'assets/app.css', 'assets/precache.js']) {
    assert.ok(files.includes(anchor), `the module map lists ${anchor}`);
  }
});

test('the ARCHITECTURE module map lists every root Markdown document', () => {
  const files = parseModuleMap(read('docs/ARCHITECTURE.md'));
  const roots = listRootFiles().filter((file) => file.endsWith('.md'));
  assert.ok(roots.includes('README.md') && roots.length >= 6, 'the root Markdown is real');
  for (const file of roots) assert.ok(files.includes(file), `the module map lists ${file}`);
  for (const file of files.filter((entry) => !entry.includes('/') && entry.endsWith('.md'))) {
    assert.ok(roots.includes(file), `the module map has no phantom root document: ${file}`);
  }
});

test('the ARCHITECTURE discovery chain lists only the probed GetInfo keys', () => {
  const doc = read('docs/ARCHITECTURE.md');
  const block = doc
    .slice(doc.indexOf('### Device discovery'))
    .match(/```[^`]*```/)?.[0];
  assert.ok(block, 'the discovery chain is a fenced block');
  const probeList = block.match(/GetInfo probes \(([\s\S]*?)\)/)?.[1].replace(/\s+/g, ' ').trim();
  assert.equal(probeList, 'model, serial, density, label type, auto shutdown, battery, firmware, hardware');
  for (const diagnostic of ['speed', 'print mode', 'Bluetooth', 'area', 'accuracy', 'language']) {
    assert.doesNotMatch(block, new RegExp(diagnostic, 'i'), `${diagnostic} is not a discovery probe`);
  }

  const paragraph = doc.slice(doc.indexOf('The seven GetInfo keys'), doc.indexOf('At least one core probe'));
  assert.match(paragraph, /seven GetInfo keys/);
  for (const name of ['job speed', 'head width', 'accuracy', 'language', 'Bluetooth address', 'printer print mode', 'print area']) {
    assert.ok(paragraph.includes(name), `the diagnostic list names ${name}`);
  }
});

test('PROTOCOL.md GetInfo table matches the projection: 8 probed, 7 diagnostic', () => {
  const protocol = read('docs/PROTOCOL.md');
  assert.match(protocol, /The table has all 15 keys: 8 are probed during\s+discovery and 7 are diagnostic-only/);

  const section = protocol.slice(protocol.indexOf('### `GetInfo` keys'), protocol.indexOf('## Error codes'));
  const rows = section
    .split('\n')
    .filter((line) => /^\|\s*`0x[0-9A-F]{2}`/.test(line))
    .map((line) => line.split('|').slice(1, -1).map((cell) => cell.trim()));
  const documented = new Map(rows.map((cells) => [Number.parseInt(cells[0].replaceAll('`', ''), 16), cells[3]]));

  assert.equal(rows.length, INFO_PROJECTION.length, 'one documented row per projection entry');
  assert.equal(documented.size, rows.length, 'no duplicate documented key');
  const probed = INFO_PROJECTION.filter(({ field }) => field !== 'diagnostic');
  const diagnostic = INFO_PROJECTION.filter(({ field }) => field === 'diagnostic');
  assert.equal(probed.length, 8, '8 probed keys');
  assert.equal(diagnostic.length, 7, '7 diagnostic keys');

  for (const { key, field, name } of INFO_PROJECTION) {
    const consumer = documented.get(key);
    assert.ok(consumer, `PROTOCOL documents 0x${key.toString(16).padStart(2, '0')} (${name})`);
    assert.equal(
      consumer.startsWith('diagnostic only'),
      field === 'diagnostic',
      `${name} is classified the same way in the doc and the projection`
    );
  }
});

test('PROTOCOL.md boolean TLV list matches the decoder flags', () => {
  const protocol = read('docs/PROTOCOL.md');
  assert.match(protocol, /A boolean TLV must carry at least one byte/);
  const listed = [...protocol.match(/This applies to\s+([\s\S]*?)\./)[1].matchAll(/`([^`]+)`/g)].map((match) => match[1]);
  const decoded = [...read('src/protocol/replies.js').matchAll(/flag\('([^']+)'\)/g)].map((match) => match[1]);

  assert.equal(decoded.length, 6, 'every decoded boolean goes through flag()');
  assert.deepEqual([...listed].sort(), [...decoded].sort(), 'the three-state rule names exactly the decoded booleans');
});

test('PROTOCOL.md and the manager agree that a silent heartbeat refuses a print', () => {
  const protocol = read('docs/PROTOCOL.md');
  assert.match(protocol, /refuses the job \("The printer did not report its\s+sensors, so nothing was printed\."\)/);
  assert.match(read('src/device/manager.js'), /did not report its sensors, so nothing was printed/);
});

test('ANDROID.md keeps the signing, asset and filename contracts', () => {
  const doc = read('docs/ANDROID.md');
  const build = read('scripts/build-android.mjs');
  const androidPackage = 'dev/llm4people/drypoint';
  const java = read(`android/app/src/main/java/${androidPackage}/BleBridge.java`);
  const ignored = read('.gitignore').trim().split('\n');

  assert.match(doc, /`android\/keystore\/` is excluded from\s+version control: \*\*back it up securely\*\*/);
  for (const rule of ['android/build/', 'android/build-*/', 'android/keystore/']) {
    assert.ok(ignored.includes(rule), `.gitignore keeps ${rule}`);
  }

  assert.match(doc, /Changing the signing key costs one uninstall/);
  assert.match(doc, /different key/);
  const packageName = brand.appId;
  assert.match(read('android/AndroidManifest.template.xml'), /package="@PACKAGE@"/, 'the template has no second package owner');
  assert.ok(doc.includes(`adb uninstall ${packageName}`), 'the documented uninstall command names the real package');
  assert.match(build, /directory = join\(androidDir, 'keystore'\)/);
  assert.match(build, /const store = env\.ANDROID_KEYSTORE_FILE \|\| join\(directory, 'drypoint-release\.jks'\)/);
  assert.ok(doc.includes('android/keystore/drypoint-release.jks'));

  assert.match(doc, /SHA-256 digest/);
  assert.match(build, /await readManifest\(root\)/, 'the APK builder reads the manifest through its owner');
  assert.match(build, /if \(!isAllowed\(file\)\) fail\(/);
  assert.match(build, /await resolveSurfacePath\(file\)/);
  assert.match(doc, /app-surface allowlist/);

  assert.match(doc, /single filename segment \(no empty\s+name, separators, NUL, `\.` or `\.\.`\)/);
  const safeName = read(`android/app/src/main/java/${androidPackage}/SafeFileName.java`);
  assert.match(safeName, /static boolean isSafe\(String name\)/);
  assert.ok(safeName.includes("name.indexOf('\\0') >= 0"), 'the bridge rejects NUL');
  assert.match(java, /SafeFileName\.isSafe\(name\)/, 'the bridge delegates to the one rule');

  assert.match(doc, /\*\*Choose printer\*\*/);
  assert.match(doc, /\*\*Forget printer\*\*/);
  assert.match(doc, /the next connection asks\s+again/);
});

test('the one dev-only dependency is locked and tracked', () => {
  // The app still ships no npm runtime dependency; the workflow policy is the
  // only consumer of a package. `npm ci` reproduces it from the tracked lock.
  assert.deepEqual(pkg.dependencies ?? {}, {}, 'the app has no runtime dependency');
  assert.equal(pkg.devDependencies?.yaml, '^2.9.1', 'the workflow policy parses YAML with yaml@^2.9.1');
  assert.equal(existsSync(join(projectRoot, 'package-lock.json')), true, 'the lockfile exists');
  const lock = JSON.parse(read('package-lock.json'));
  assert.equal(lock.packages?.['node_modules/yaml']?.version, '2.9.1');
  assert.equal(lock.packages?.['node_modules/yaml']?.dev, true, 'yaml is dev-only');
  const ignored = read('.gitignore').trim().split('\n');
  assert.equal(ignored.includes('package-lock.json'), false, 'the lockfile is not ignored');
  // A lockfile that is present but untracked gives `npm ci` a different tree on
  // every clone. The test runs in the repository; no checkout means no build.
  execFileSync('git', ['ls-files', '--error-unmatch', 'package-lock.json'], { cwd: projectRoot, stdio: 'ignore' });
});

test('.gitignore keeps every secret, artifact and local file out of git', () => {
  const ignored = read('.gitignore').trim().split('\n');
  const required = {
    'build output': ['android/build/', 'android/build-*/', '_site/', 'dist/', 'coverage/', 'node_modules/'],
    'local runtime state': ['.run/', '*.tmp', '*.log'],
    'signing material': ['android/keystore/', 'keystore.properties', '*.jks', '*.keystore', '*.p12', '*.pem', '*.key'],
    'package artifacts': ['*.apk', '*.aab', '*.idsig'],
    environment: ['.env*'],
    'editor and OS noise': ['.DS_Store', '.idea/', '.vscode/'],
  };
  for (const [group, rules] of Object.entries(required)) {
    for (const rule of rules) assert.ok(ignored.includes(rule), `.gitignore keeps the ${group} rule ${rule}`);
  }

  // The strings above could be listed but never match. The walker that the
  // privacy gate uses decides; these are the paths that must never be staged.
  const parsed = parseIgnore(read('.gitignore'));
  for (const path of [
    'android/build/drypoint.apk',
    'android/build-abc123/base.apk',
    'android/keystore/drypoint-release.jks',
    'android/keystore/keystore.properties',
    'release.p12',
    'release.pem',
    'server.key',
    'drypoint.aab',
    'drypoint.apk.idsig',
    '.run/server-8080.pid',
    'debug.log',
    '_site/index.html',
    'dist/drypoint-1.0.0.apk',
    'coverage/lcov.info',
    'node_modules/x/index.js',
    '.env.local',
    '.DS_Store',
    '.idea/workspace.xml',
    '.vscode/settings.json',
    'build.tmp',
  ]) {
    assert.equal(isIgnored(path, parsed), true, `${path} is ignored`);
  }
  for (const path of ['src/main.js', 'README.md', 'android/app/src/main/java/dev/llm4people/drypoint/MainActivity.java', 'docs/PRINTERS.md']) {
    assert.equal(isIgnored(path, parsed), false, `${path} is published`);
  }
});

test('the CONFIG gate accepts a real read and not a comment or a string', () => {
  const path = ['ui', 'previewMaxScale'];
  const forged = '// CONFIG.ui.previewMaxScale is read here\nconst note = "CONFIG.ui.previewMaxScale";\n';
  assert.equal(configLeafConsumed(scannedSource(forged), path), false, 'prose and a fixture are not readers');
  assert.equal(configLeafConsumed(scannedSource(`const scale = CONFIG.ui.previewMaxScale;`), path), true, 'a dotted read counts');
  assert.equal(
    configLeafConsumed(scannedSource(`const { previewMaxScale } = CONFIG.ui;`), path),
    true,
    'a destructured read counts'
  );
});
