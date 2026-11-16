/**
 * One owner for the dev server's tracked state: the port-keyed pid file,
 * process liveness, command verification and a bounded wait for exit.
 *
 * The file is JSON so an operator can inspect it:
 *   .run/server-<port>.pid → { pid, port, startedAt }
 */

import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { link, readFile, readlink, rm, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';

export const DEFAULT_PORT = 8080;
export const SERVER_SCRIPT = 'serve.mjs';
const ROOT = resolve(import.meta.dirname, '..', '..');
/** This checkout's canonical dev server, the only script stop may signal. */
export const SERVER_SCRIPT_PATH = join(ROOT, 'scripts', SERVER_SCRIPT);

/** Parse a port from --port, --port=N or PORT, falling back to 8080. */
export function resolvePort(argv = process.argv.slice(2), env = process.env) {
  const inline = argv.find((argument) => argument.startsWith('--port='));
  const flagIndex = argv.indexOf('--port');
  let raw;
  if (inline) {
    raw = inline.slice('--port='.length);
    // `--port=` is a flag with no value, not a request for the default.
    if (raw === '') throw new Error('--port needs a value');
  } else if (flagIndex >= 0) {
    raw = argv[flagIndex + 1];
    // `--port --pid 1` must not silently target 8080.
    if (raw === undefined || raw.startsWith('--')) throw new Error('--port needs a value');
  } else {
    raw = env.PORT;
  }
  if (raw === undefined || raw === '') return DEFAULT_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`invalid port ${JSON.stringify(raw)}; expected an integer from 1 to 65535`);
  }
  return port;
}

export function pidFileFor(root, port) {
  return join(root, '.run', `server-${port}.pid`);
}

/**
 * Parse the bind host from --host, --host= or HOST.
 *
 * The default is loopback: a dev server must never expose the app to the LAN
 * because a flag or a variable was missing. A flag with no value is an error,
 * exactly like --port, rather than a silent fallback to the default.
 */
export function resolveHost(argv = process.argv.slice(2), env = process.env) {
  const inline = argv.find((argument) => argument.startsWith('--host='));
  const index = argv.indexOf('--host');
  let raw;
  if (inline) {
    raw = inline.slice('--host='.length);
    if (raw === '') throw new Error('--host needs a value');
  } else if (index >= 0) {
    raw = argv[index + 1];
    if (raw === undefined || raw.startsWith('--')) throw new Error('--host needs a value');
  } else {
    raw = env.HOST;
  }
  if (raw === undefined || raw === '') return '127.0.0.1';
  return String(raw);
}

/**
 * @returns {{state:'missing'}|{state:'invalid', raw:string, error:Error}|{state:'tracked', record:object, raw:string}}
 */
export async function readTrackedServer(file) {
  let raw;
  try {
    raw = await readFile(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return { state: 'missing' };
    throw error;
  }
  try {
    const record = JSON.parse(raw);
    if (!record || !Number.isInteger(record.pid) || record.pid <= 0) throw new Error('missing a positive integer pid');
    return { state: 'tracked', record, raw };
  } catch (error) {
    return { state: 'invalid', raw, error };
  }
}

/**
 * Atomically create the pid file; fails with EEXIST when another start won.
 *
 * The body is written to a private temporary file and published with `link`,
 * which is atomic and exclusive. Creating the target directly with
 * `writeFile(..., { flag: 'wx' })` makes it visible at `open()` before its
 * bytes are written, so a concurrent start can read it as `invalid`, delete
 * the winner's record and claim the port too. `link` makes the complete file
 * appear in one step, so a racing reader sees either nothing or the whole
 * record.
 */
export async function writeTrackedServer(file, record) {
  const body = `${JSON.stringify(record)}\n`;
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, body, { flag: 'wx', mode: 0o600 });
    await link(temp, file);
    return record;
  } finally {
    await rm(temp, { force: true });
  }
}

/** True when the process exists (EPERM still means it exists). */
export function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

/**
 * Best-effort command line for a pid. /proc first, then ps (POSIX) or
 * PowerShell CIM (Windows). null means "cannot verify", which callers treat as
 * unsafe rather than as permission to signal.
 */
export async function readProcessCommand(pid) {
  try {
    const raw = await readFile(`/proc/${pid}/cmdline`, 'utf8');
    const command = raw.split('\0').filter(Boolean).join(' ').trim();
    if (command) return command;
  } catch {
    // Not Linux, or the process vanished; fall through.
  }
  try {
    if (process.platform === 'win32') {
      // tasklist only reports the image name, not the script, so use CIM for
      // the command line. If PowerShell is unavailable the caller refuses to
      // signal rather than guessing.
      const output = execFileSync(
        'powershell.exe',
        ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`],
        { encoding: 'utf8', windowsHide: true }
      );
      return output.trim() || null;
    }
    const output = execFileSync('ps', ['-p', String(pid), '-o', 'args='], { encoding: 'utf8' });
    return output.trim() || null;
  } catch {
    return null;
  }
}

/** The process working directory, needed to resolve a relative script path. */
export async function readProcessCwd(pid) {
  try {
    return await readlink(`/proc/${pid}/cwd`);
  } catch {
    return null;
  }
}

/** Split a joined command line into argv-like tokens, respecting simple quotes. */
function commandTokens(command) {
  return (command.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((token) => token.replace(/^["']|["']$/g, ''));
}

const NODE_EXECUTABLES = new Set(['node', 'node.exe', 'nodejs', 'nodejs.exe']);

/**
 * The command must be this project's dev server, never an unrelated process.
 *
 * A bare `serve.mjs` substring is not ownership: `vim scripts/serve.mjs` and
 * another checkout's server both contain it. The script token must resolve to
 * this checkout's canonical `scripts/serve.mjs` (absolute, or relative to the
 * process working directory), and a node executable must appear before it.
 */
export function commandLooksLikeServer(command, { root = ROOT, cwd = null } = {}) {
  if (typeof command !== 'string') return false;
  const canonical = join(resolve(root), 'scripts', SERVER_SCRIPT);
  const tokens = commandTokens(command);
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (!token.toLowerCase().includes(SERVER_SCRIPT)) continue;
    // A relative script can only be verified against the real process cwd.
    if (!token.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(token) && !cwd) return false;
    if (resolve(cwd ?? '', token) !== canonical) continue;
    return tokens.slice(0, index).some((earlier) => NODE_EXECUTABLES.has(basename(earlier).toLowerCase()));
  }
  return false;
}

/** Wait until the pid disappears, or the timeout elapses. */
export async function waitForExit(pid, timeoutMs = 5000, intervalMs = 100) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return !isProcessAlive(pid);
}

/** Remove the file only when it still describes this process. */
export async function removeTrackedServerIfOwned(file, pid) {
  try {
    const tracked = await readTrackedServer(file);
    if (tracked.state === 'tracked' && tracked.record.pid === pid) await rm(file, { force: true });
  } catch {
    // Cleanup is best-effort; a leftover file is handled as stale on next start.
  }
}

/**
 * Delete a pid file only if it still holds the value we inspected. A blind
 * `rm` after a read can delete the file a concurrent start just created, which
 * leaves that server running but untracked.
 *
 * `expected` is the pid we read, or `null` for an unreadable file.
 * @returns {Promise<boolean>} whether anything was removed
 */
async function discardTrackedFile(file, expected, remove, read = readTrackedServer) {
  let current;
  try {
    current = await read(file);
  } catch {
    return false;
  }
  const stillOurs = expected === null ? current.state === 'invalid' : current.state === 'tracked' && current.record.pid === expected;
  if (!stillOurs) return false;
  await remove(file);
  return true;
}

const defaultRemove = (file) => rm(file, { force: true });

/**
 * Claim the port's pid file for this process. The result is returned instead of
 * exiting so the orchestration is testable; the caller prints and exits.
 *
 * Every deletion re-reads the file first, so losing a race never deletes the
 * winner's record.
 *
 * @returns {Promise<{ok:true, record:object}|{ok:false, reason:'tracked'|'race', record?:object}>}
 */
export async function claimTrackedServer({
  file,
  port,
  pid = process.pid,
  startedAt = new Date().toISOString(),
  root = ROOT,
  deps = {},
}) {
  const read = deps.read ?? readTrackedServer;
  const alive = deps.alive ?? isProcessAlive;
  const commandFor = deps.commandFor ?? readProcessCommand;
  const cwdFor = deps.cwdFor ?? readProcessCwd;
  const write = deps.write ?? writeTrackedServer;
  const remove = deps.remove ?? defaultRemove;
  const warn = deps.warn ?? (() => {});

  const record = { pid, port, startedAt };
  for (let attempt = 0; attempt < 3; attempt++) {
    const tracked = await read(file);
    if (tracked.state === 'invalid') {
      warn(`${file} is unreadable; replacing it`);
      await discardTrackedFile(file, null, remove, read);
    } else if (tracked.state === 'tracked') {
      if (tracked.record.port !== port) {
        warn(`${file} describes port ${tracked.record.port}; replacing it`);
        await discardTrackedFile(file, tracked.record.pid, remove, read);
      } else if (alive(tracked.record.pid)) {
        const command = await commandFor(tracked.record.pid);
        const cwd = command === null ? null : await cwdFor(tracked.record.pid);
        if (command === null || commandLooksLikeServer(command, { root, cwd })) return { ok: false, reason: 'tracked', record: tracked.record };
        warn(`pid ${tracked.record.pid} is not the dev server (${command}); replacing ${file}`);
        await discardTrackedFile(file, tracked.record.pid, remove, read);
      } else {
        warn(`removing stale ${file} (pid ${tracked.record.pid} is not running)`);
        await discardTrackedFile(file, tracked.record.pid, remove, read);
      }
    }
    try {
      await write(file, record);
      return { ok: true, record };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      // Another start won the race between our read and write; inspect again.
    }
  }
  return { ok: false, reason: 'race' };
}

/**
 * Stop the server tracked in `file` for `port`, or explain why not.
 * @returns {Promise<{code:number, messages:Array<{level:'info'|'error', text:string}>}>}
 */
export async function stopTrackedServer({ file, port, root = ROOT, deps = {} }) {
  const read = deps.read ?? readTrackedServer;
  const alive = deps.alive ?? isProcessAlive;
  const commandFor = deps.commandFor ?? readProcessCommand;
  const cwdFor = deps.cwdFor ?? readProcessCwd;
  const signal = deps.signal ?? ((pid, name) => process.kill(pid, name));
  const wait = deps.wait ?? waitForExit;
  const removeOwned = deps.removeOwned ?? removeTrackedServerIfOwned;
  const messages = [];
  const done = (code) => ({ code, messages });

  const tracked = await read(file);
  if (tracked.state === 'missing') {
    messages.push({ level: 'info', text: `no tracked server for port ${port}` });
    return done(0);
  }
  if (tracked.state === 'invalid') {
    messages.push({ level: 'error', text: `${file} is unreadable; refusing to signal anything.` });
    messages.push({ level: 'error', text: `Inspect or remove it by hand: ${file}` });
    return done(1);
  }

  const { record } = tracked;
  if (record.port !== port || !Number.isInteger(record.pid) || record.pid <= 0) {
    messages.push({ level: 'error', text: `${file} does not describe a server for port ${port}; refusing to signal anything.` });
    return done(1);
  }

  if (!alive(record.pid)) {
    await removeOwned(file, record.pid);
    messages.push({ level: 'info', text: `removed stale pid file for port ${port} (pid ${record.pid} is not running)` });
    return done(0);
  }

  const command = await commandFor(record.pid);
  const cwd = command === null ? null : await cwdFor(record.pid);
  if (!command || !commandLooksLikeServer(command, { root, cwd })) {
    messages.push({
      level: 'error',
      text: `refusing to stop pid ${record.pid}: ${command ? `it is ${command}` : 'its command cannot be verified'}.`,
    });
    messages.push({ level: 'error', text: `The pid file was kept: ${file}` });
    return done(1);
  }

  messages.push({ level: 'info', text: `stopping server for port ${port} (pid ${record.pid})…` });
  try {
    signal(record.pid, 'SIGTERM');
  } catch (error) {
    if (error.code === 'ESRCH') {
      await removeOwned(file, record.pid);
      messages.push({ level: 'info', text: `server for port ${port} had already exited` });
      return done(0);
    }
    messages.push({ level: 'error', text: `could not signal pid ${record.pid}: ${error.message}` });
    return done(1);
  }

  if (!(await wait(record.pid, 5000))) {
    messages.push({ level: 'error', text: `pid ${record.pid} did not exit within 5s; the pid file was kept.` });
    return done(1);
  }

  await removeOwned(file, record.pid);
  messages.push({ level: 'info', text: `stopped server for port ${port}` });
  return done(0);
}
