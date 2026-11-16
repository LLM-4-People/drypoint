/**
 * Request/response session over any transport. Owns timeouts, frame parsing,
 * request serialisation and error propagation; nothing above this layer
 * touches bytes.
 */

import { CONFIG } from '../core/config.js';
import { createEmitter } from '../core/events.js';
import { createLogger } from '../core/log.js';
import { FrameReader } from './frames.js';
import { OP } from './commands.js';
import { PrinterError, abortReason, cancelledError, describeErrorCode } from './errors.js';

export class Session {
  /** At most one entry: exchange() serialises callers through #tail. */
  #pending = [];
  #tail = null;
  /**
   * Request opcodes that left the wire unanswered. The firmware answers an
   * unsupported request with a late negative (0x00) instead of the expected
   * reply, and replies arrive in request order, so the oldest unanswered
   * request owns the next 0x00. One credit per request that may still answer:
   * an exchange timeout and an abort after its write was issued. Bounded by
   * CONFIG.protocol.maxUnansweredReplies so a silent printer cannot grow it.
   */
  #unanswered = [];
  #reader = new FrameReader();
  #events = createEmitter();
  #log;
  #closed = false;

  /**
   * @param {{write(bytes:Uint8Array):Promise<void>, onData(cb:Function):void,
   *          onClose(cb:Function):void, describe():string}} link
   */
  constructor(link, { name = 'session' } = {}) {
    this.link = link;
    this.#log = createLogger(name);
    link.onData((bytes) => this.#ingest(bytes));
    link.onClose((error) => this.#fail(error ? new PrinterError(`Connection lost: ${error.message}`, { fatal: true }) : new PrinterError('Disconnected', { fatal: true })));
  }

  get events() {
    return this.#events;
  }

  get closed() {
    return this.#closed;
  }

  #ingest(bytes) {
    this.#log.trace('rx', bytes);
    for (const frame of this.#reader.push(bytes)) this.#dispatch(frame);
  }

  #dispatch(frame) {
    if (frame.cmd === OP.NOT_SUPPORTED) {
      // The firmware answers unsupported requests with opcode 0x00 instead of
      // the expected reply, and the frame carries no request id. A request
      // that already timed out may still receive that answer: consume it for
      // that request instead of rejecting the next one. Only 0x00 is safe to
      // reassign — 0xDB is also an unsolicited printer error.
      const timedOut = this.#unanswered.shift();
      if (timedOut !== undefined) {
        // The current request may have been the one that answered: remember
        // that so its own timeout does not invent a second pending answer.
        const current = this.#pending[0];
        if (current) current.lateNegative = true;
        this.#log.warn('late 0x00 answers a timed-out request', { request: `0x${timedOut.toString(16)}` });
        return;
      }
      const entry = this.#pending[0];
      if (!entry) {
        this.#log.warn('unsolicited 0x00 reply with no pending request');
        return;
      }
      this.#settle(entry, { error: new PrinterError('Command is not supported by this firmware', { unsupported: true }) });
      return;
    }

    if (frame.cmd === OP.ERROR) {
      const code = frame.data[0] ?? 0;
      const error = new PrinterError(describeErrorCode(code), { code, fatal: false });
      const entry = this.#pending[0];
      if (entry) {
        // The caller of this exchange is the single reporter: it toasts the
        // failure its own request received. Emitting here as well made one
        // rejected command produce two toasts and two error log entries.
        this.#log.error('printer reported an error', { code, message: error.message });
        this.#settle(entry, { error });
        return;
      }
      // Nothing owns the failure: a printer error while idle (no request in
      // flight) still has to reach the main error channel.
      this.#log.error('printer reported an error with no pending request', { code, message: error.message });
      this.#events.emit('error', error);
      return;
    }

    const entry = this.#pending[0];
    if (entry && entry.cmd === frame.cmd) {
      // Replies are in order, so a successful answer proves every older
      // request was overtaken: none of them can still answer, so every credit
      // in the ledger is retired.
      this.#unanswered.length = 0;
      this.#settle(entry, { frame });
      return;
    }
    // Unsolicited frames (row counters, status) are informational.
    this.#events.emit('frame', frame);
  }

  /**
   * Record that one request may still answer with a late negative. The ledger
   * is a bounded FIFO: the oldest credit is dropped when the cap is reached, so
   * the newest unanswered requests (the ones a late 0x00 most likely belongs
   * to) stay attributable.
   */
  #rememberUnanswered(entry) {
    this.#unanswered.push(entry.requestOpcode);
    while (this.#unanswered.length > CONFIG.protocol.maxUnansweredReplies) this.#unanswered.shift();
  }

  /** Remove an entry from the queue and release its timer and abort listener. */
  #discard(entry) {
    if (entry.settled) return;
    entry.settled = true;
    clearTimeout(entry.timer);
    entry.cleanup?.();
    const at = this.#pending.indexOf(entry);
    if (at >= 0) this.#pending.splice(at, 1);
  }

  /** Resolve or reject exactly one entry and remove it from the queue. */
  #settle(entry, { frame, error } = {}) {
    if (entry.settled) return;
    this.#discard(entry);
    if (error) entry.reject(error);
    else entry.resolve(frame);
  }

  #fail(error) {
    if (this.#closed) return;
    this.#closed = true;
    this.#unanswered.length = 0;
    for (const entry of this.#pending.splice(0)) this.#settle(entry, { error });
    this.#events.emit('closed', error);
  }

  /**
   * Write bytes to the link, bounded like a request.
   *
   * A write that never settles says nothing about what the printer received,
   * so the stream is left in an unknown state: the session fails instead of
   * letting a later frame be parsed as a continuation of a half-sent one.
   * @param {Uint8Array} bytes
   * @param {{signal?:AbortSignal, timeoutMs?:number}} [options]
   */
  async write(bytes, { signal, timeoutMs = CONFIG.protocol.timeouts.write } = {}) {
    if (this.#closed) throw new PrinterError('Connection is closed', { fatal: true });
    if (signal?.aborted) throw abortReason(signal);
    this.#log.trace('tx', bytes);

    let sent;
    try {
      // Call the link synchronously so a fast transport can answer the frame
      // before this write returns, exactly like a real port.
      sent = Promise.resolve(this.link.write(bytes));
    } catch (error) {
      sent = Promise.reject(error);
    }
    // The loser of the race may settle later; nobody awaits it any more.
    sent.catch(() => {});

    let timer;
    let onAbort;
    const bound = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new PrinterError(`The link did not accept a write within ${timeoutMs} ms`, { timeout: true })), timeoutMs);
      timer?.unref?.();
      if (signal) {
        onAbort = () => reject(abortReason(signal));
        signal.addEventListener('abort', onAbort, { once: true });
      }
    });

    try {
      await Promise.race([sent, bound]);
    } catch (error) {
      if (error.timeout) {
        const fatal = new PrinterError(error.message, { fatal: true, timeout: true });
        this.#fail(fatal);
        throw fatal;
      }
      throw error;
    } finally {
      clearTimeout(timer);
      if (onAbort) signal.removeEventListener('abort', onAbort);
    }
  }

  /**
   * Send a frame and wait for its reply. Callers are serialised so exactly one
   * request is outstanding, which makes every reply unambiguous.
   * @param {Uint8Array} bytes
   * @param {number} replyCmd
   * @param {{timeoutMs?:number, signal?:AbortSignal}|number} [options]
   */
  exchange(bytes, replyCmd, options = {}) {
    const { timeoutMs = CONFIG.protocol.timeouts.control, signal } = typeof options === 'number' ? { timeoutMs: options } : options;
    const run = () => this.#performExchange(bytes, replyCmd, timeoutMs, signal);
    // Start the first request synchronously so a fast link cannot answer
    // before its entry exists; later callers wait for the tail.
    const result = this.#tail ? this.#tail.then(run, run) : run();
    const tail = result.then(
      () => {},
      () => {}
    );
    this.#tail = tail;
    tail.finally(() => {
      if (this.#tail === tail) this.#tail = null;
    });
    return result;
  }

  async #performExchange(bytes, replyCmd, timeoutMs, signal) {
    if (this.#closed) throw new PrinterError('Connection is closed', { fatal: true });
    if (signal?.aborted) throw abortReason(signal);

    const entry = this.#createEntry(replyCmd, timeoutMs, signal, bytes[2]);
    this.#pending.push(entry);
    // The entry's own timeout owns this exchange: a link whose write never
    // settles must not keep the tail (and every later request) waiting.
    entry.writeIssued = true;
    void this.write(bytes).catch((error) => this.#settle(entry, { error }));
    return entry.promise;
  }

  #createEntry(replyCmd, timeoutMs, signal, requestOpcode) {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const entry = {
      cmd: replyCmd,
      requestOpcode,
      promise,
      resolve,
      reject,
      settled: false,
      timer: null,
      cleanup: null,
      lateNegative: false,
      /** The exchange's write reached the link; a late 0x00 may still arrive. */
      writeIssued: false,
    };
    entry.timer = setTimeout(() => {
      if (entry.settled) return;
      if (entry.lateNegative) {
        // Its answer was already consumed for the older credit: report what
        // the printer said instead of a timeout for a request it answered.
        this.#settle(entry, { error: new PrinterError('Command is not supported by this firmware', { unsupported: true }) });
        return;
      }
      // Remember the request a late negative may still belong to, then let the
      // timeout reject the caller's promise.
      this.#rememberUnanswered(entry);
      this.#settle(entry, {
        error: new PrinterError(`No reply to 0x${requestOpcode.toString(16)} within ${timeoutMs} ms`, { timeout: true }),
      });
    }, timeoutMs);
    if (signal) {
      const onAbort = () => {
        if (entry.settled) return;
        // An exchange aborted after its request reached the wire can still
        // answer with a late negative; one that never wrote cannot.
        if (entry.writeIssued && !entry.lateNegative) this.#rememberUnanswered(entry);
        this.#settle(entry, { error: abortReason(signal) });
      };
      signal.addEventListener('abort', onAbort, { once: true });
      entry.cleanup = () => signal.removeEventListener('abort', onAbort);
    }
    return entry;
  }

  close() {
    if (this.#closed) return;
    this.#fail(new PrinterError('Disconnected', { fatal: true }));
  }
}
