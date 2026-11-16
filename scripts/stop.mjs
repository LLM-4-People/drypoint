/**
 * Stop the dev server tracked for a port.
 *
 * The pid file is validated (JSON shape, port, live process, command line)
 * before any signal is sent. The file is only removed once the process is
 * really gone; a refusal or timeout keeps it for inspection, and every
 * deletion re-reads the file so a concurrent start's record is never removed.
 *
 * Usage: node scripts/stop.mjs [--port 8080]   (or PORT=8080)
 *        node scripts/stop.mjs --pid 12345     (stop an untracked, verified server)
 */

import { resolve } from 'node:path';

import {
  commandLooksLikeServer,
  isProcessAlive,
  pidFileFor,
  readProcessCommand,
  resolvePort,
  stopTrackedServer,
  waitForExit,
} from './lib/server-state.mjs';

const root = resolve(import.meta.dirname, '..');

function resolvePidArgument(argv = process.argv.slice(2)) {
  const inline = argv.find((argument) => argument.startsWith('--pid='));
  const flagIndex = argv.indexOf('--pid');
  let raw;
  if (inline) {
    raw = inline.slice('--pid='.length);
    if (raw === '') throw new Error('--pid needs a value');
  } else if (flagIndex >= 0) {
    raw = argv[flagIndex + 1];
    // `--pid --port 8080` must not silently fall through to the port path.
    if (raw === undefined || raw.startsWith('--')) throw new Error('--pid needs a value');
  }
  if (raw === undefined || raw === '') return null;
  const pid = Number(raw);
  if (!Number.isInteger(pid) || pid <= 0) throw new Error(`invalid pid ${JSON.stringify(raw)}`);
  return pid;
}

/** Stop a pid that has no pid file (e.g. a server started before tracking). */
async function stopPid(pid) {
  if (!isProcessAlive(pid)) {
    console.log(`drypoint: pid ${pid} is not running`);
    return 0;
  }
  const command = await readProcessCommand(pid);
  if (!command || !commandLooksLikeServer(command)) {
    console.error(`drypoint: refusing to stop pid ${pid}: ${command ? `it is ${command}` : 'its command cannot be verified'}.`);
    return 1;
  }
  console.log(`drypoint: stopping verified server (pid ${pid})…`);
  try {
    process.kill(pid, 'SIGTERM');
  } catch (error) {
    // The process may have exited between the liveness check and the signal,
    // or belong to another user; both are reported, never thrown.
    if (error.code === 'ESRCH') {
      console.log(`drypoint: pid ${pid} had already exited`);
      return 0;
    }
    console.error(`drypoint: could not signal pid ${pid}: ${error.message}`);
    return 1;
  }
  if (!(await waitForExit(pid, 5000))) {
    console.error(`drypoint: pid ${pid} did not exit within 5s.`);
    return 1;
  }
  console.log(`drypoint: stopped server (pid ${pid})`);
  return 0;
}

let explicitPid;
try {
  explicitPid = resolvePidArgument();
} catch (error) {
  console.error(`drypoint: ${error.message}`);
  process.exit(1);
}
if (explicitPid) {
  process.exitCode = await stopPid(explicitPid);
  process.exit();
}

let port;
try {
  port = resolvePort();
} catch (error) {
  console.error(`drypoint: ${error.message}`);
  process.exit(1);
}
const pidFile = pidFileFor(root, port);

const result = await stopTrackedServer({ file: pidFile, port });
for (const message of result.messages) {
  if (message.level === 'error') console.error(`drypoint: ${message.text}`);
  else console.log(`drypoint: ${message.text}`);
}
process.exitCode = result.code;
