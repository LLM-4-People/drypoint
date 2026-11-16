/**
 * Print job: raster → frames → wire. The sequence is the D110M V4 task this firmware
 * expects; every step is named so it can be tested and aborted cleanly.
 *
 * Terminal frames: a completed job ends with printEnd (0xF3). A job that is
 * cancelled or fails after it started ends with cancelPrint (0xDA) instead —
 * never both, and never a success frame after a cancel.
 */

import { CONFIG } from '../core/config.js';
import { sleep } from '../core/format.js';
import { createLogger } from '../core/log.js';
import { encodeFrame, u16be } from '../protocol/frames.js';
import { OP } from '../protocol/commands.js';
import { decodePrintStatus } from '../protocol/replies.js';
import { PrinterError, abortReason } from '../protocol/errors.js';

const log = createLogger('device.print');

const MAX_REPEAT = CONFIG.protocol.maxRowRepeat;
const MAX_EMPTY = CONFIG.protocol.maxEmptyRepeat;

const isBlank = (row) => row.every((byte) => byte === 0);

function sameRow(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function popcountThirds(row, widthPx) {
  const third = Math.ceil(widthPx / 3);
  const counts = [0, 0, 0];
  for (let x = 0; x < widthPx; x++) {
    if (row[x >> 3] & (0x80 >> (x & 7))) counts[Math.min(2, Math.floor(x / third))]++;
  }
  return counts;
}

/** Run-length encode the raster into row frames. */
export function encodeRows(rows, widthPx) {
  const stride = Math.ceil(widthPx / 8);
  const frames = [];
  let index = 0;

  while (index < rows.length) {
    const row = rows[index];

    if (isBlank(row)) {
      let count = 1;
      while (index + count < rows.length && count < MAX_EMPTY && isBlank(rows[index + count])) count++;
      frames.push(encodeFrame(OP.PRINT_EMPTY_ROW, [...u16be(index), count]));
      index += count;
      continue;
    }

    let repeat = 1;
    while (index + repeat < rows.length && repeat < MAX_REPEAT && sameRow(rows[index + repeat], row)) repeat++;
    const [c1, c2, c3] = popcountThirds(row, widthPx);
    frames.push(encodeFrame(OP.PRINT_BITMAP_ROW, [...u16be(index), c1, c2, c3, repeat, ...row]));
    index += repeat;
  }
  return frames;
}

/**
 * @param {import('../protocol/client.js').ProtocolClient} client
 * @param {{raster:{width:number,height:number,rows:Uint8Array[]}, copies:number,
 *          speed:number, density:number, labelType:number,
 *          completionTimeoutMs?:number,
 *          onProgress?:(done:number,total:number)=>void,
 *          onStart?:()=>void, onTerminalCommit?:()=>void,
 *          signal?:AbortSignal,
 *          gate?:(sample:object|null)=>void}} job
 */
export async function runPrintJob(client, job) {
  const { raster, copies, speed, density, labelType, completionTimeoutMs, onProgress = () => {}, onStart, onTerminalCommit, signal, gate } = job;
  if (!raster?.rows?.length) throw new PrinterError('Nothing to print');

  const checkAbort = () => {
    if (signal?.aborted) throw abortReason(signal);
  };

  log.info('job start', { rows: raster.height, cols: raster.width, copies, density, speed, labelType });

  let started = false;
  let terminalCommitted = false;
  try {
    // The job's own heartbeat is the freshest device sample; the gate decides
    // on it, before any paper moves.
    const sample = await client.tryQuery('heartbeatAdvanced', {}, { signal });
    checkAbort();
    gate?.(sample);
    await client.request('setLabelType', { value: labelType }, { signal });
    await client.request('setDensity', { value: density }, { signal });
    checkAbort();
    // From here on a cancel must reach the printer even if it interrupts the
    // printStart exchange itself. onStart runs only once the job is really
    // starting: a gate refusal never reaches this point, so the UI keeps
    // "Preparing…" instead of claiming paper is moving.
    started = true;
    onStart?.();
    await client.request('printStart', { pages: copies, speed }, { signal });
    await client.tryRequest('printStatus', {}, { signal });
    await client.request('pageSize', { rows: raster.height, cols: raster.width, copies }, { signal });

    const frames = encodeRows(raster.rows, raster.width);
    for (let i = 0; i < frames.length; i++) {
      checkAbort();
      // The job's signal bounds a stalled row write; a timeout fails the link.
      await client.session.write(frames[i], { signal });
      if (i % 8 === 0 || i === frames.length - 1) onProgress(i + 1, frames.length);
    }

    await client.request('pageEnd', {}, { signal });
    await waitForPages(client, copies, signal, completionTimeoutMs);
    checkAbort();
    // Committed terminal frame: printEnd is about to go on the wire, so a
    // cancel from here on would be a no-op. Publish that before awaiting the
    // ack, so the manager can answer cancel() honestly instead of aborting a
    // job whose outcome is already decided.
    terminalCommitted = true;
    onTerminalCommit?.();
    await client.request('printEnd');
    log.info('job complete', { copies });
  } catch (error) {
    // A user cancel is a normal outcome, not a fault in the exported report.
    if (error.cancelled) log.info('job cancelled', { code: error.code });
    else log.error('job failed', { message: error.message, code: error.code });
    if (started && !terminalCommitted) await sendCancel(client);
    throw error;
  }
}

/** Best-effort cancel; the only terminal frame a non-completed job may send. */
async function sendCancel(client) {
  try {
    await client.send('cancelPrint');
  } catch (error) {
    log.debug('cancel frame failed', { message: error.message });
  }
}

/**
 * Poll the page counter until every copy is confirmed.
 *
 * The timeout is a per-page stall threshold, not a wall-clock budget for the
 * whole job: a 99-copy job on 200 mm tape legitimately runs far longer than
 * one minute, and cancelling it mid-roll because the clock ran out wastes the
 * roll. The deadline is pushed forward whenever pagesPrinted increases, so
 * "no new page for 60 s" is exactly the condition that fails the job.
 */
async function waitForPages(client, copies, signal, timeoutMs = CONFIG.protocol.timeouts.completion) {
  let deadline = Date.now() + timeoutMs;
  let pages = 0;
  while (Date.now() < deadline) {
    if (signal?.aborted) throw abortReason(signal);
    const data = await client.request('printStatus', {}, { signal });
    const printed = decodePrintStatus(data).pagesPrinted;
    if (printed > pages) {
      pages = printed;
      deadline = Date.now() + timeoutMs;
    }
    if (pages >= copies) return pages;
    await sleep(CONFIG.protocol.pollIntervalMs);
  }
  throw new PrinterError(`Printer did not confirm the job: no new page for ${timeoutMs} ms (${pages}/${copies} labels)`);
}
