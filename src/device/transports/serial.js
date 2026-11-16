/**
 * Web Serial transport: Bluetooth Classic SPP.
 *
 * Chrome 117+ opens an RFCOMM service through Web Serial, including the COM
 * port Windows creates for a paired SPP device.
 */

import { CONFIG } from '../../core/config.js';
import { createLogger } from '../../core/log.js';

const log = createLogger('transport.serial');

/**
 * Reduce any form the platform reports a Bluetooth service class ID in (a
 * 16-bit number, a short hex string, or the full 128-bit UUID) to the eight
 * hex digits every comparison uses. Chrome returns a number for a mapped SPP
 * port and the UUID string for a custom one, so both forms must match.
 */
export function canonicalSpp(id) {
  if (typeof id === 'number') {
    return Number.isFinite(id) ? Math.trunc(id).toString(16).padStart(8, '0').slice(-8) : null;
  }
  if (typeof id !== 'string') return null;
  const hex = id.replace(/^0x/i, '').replace(/[^0-9a-f]/gi, '').toLowerCase();
  if (!hex) return null;
  return hex.slice(0, 8).padStart(8, '0');
}

/** The configured SPP service in both forms the Web Serial API accepts. */
const SPP_SERVICE_ID = canonicalSpp(CONFIG.transport.sppService);
const SPP_SHORT_ID = Number.parseInt(SPP_SERVICE_ID, 16);

/**
 * The one actionable wording for a refused serial permission.
 *
 * Chrome reports a blocked or revoked serial permission as a `SecurityError`
 * whose message is only "Permission denied". The operator cannot act on that:
 * the fix is a site setting, not a retry.
 */
export const SERIAL_PERMISSION_HINT = 'Allow serial access for this site in the browser’s site settings, then reconnect.';

/**
 * Add the concrete next step to a permission refusal, and leave every other
 * failure untouched (a cancelled picker is a `NotFoundError`, not a denial).
 * @template T
 * @param {T} error
 * @returns {T|Error}
 */
function withPermissionHint(error) {
  const name = error?.name ?? '';
  const denied = name === 'SecurityError' || name === 'NotAllowedError' || /permission denied/i.test(error?.message ?? '');
  if (!denied) return error;
  const message = error?.message ? `${error.message}. ${SERIAL_PERMISSION_HINT}` : SERIAL_PERMISSION_HINT;
  const hinted = new Error(message);
  hinted.name = name || 'SecurityError';
  hinted.cause = error;
  return hinted;
}

export class SerialTransport {
  kind = 'serial';
  #port = null;
  #reader = null;
  #writer = null;
  #onData = () => {};
  #onClose = () => {};
  #closing = false;

  static available() {
    return typeof navigator !== 'undefined' && 'serial' in navigator;
  }

  static async granted() {
    if (!SerialTransport.available()) return null;
    let ports;
    try {
      // This is the connect path from the header pill. A blocked site
      // permission surfaces here, before any picker, so it needs the same
      // actionable wording request() and open() add.
      ports = await navigator.serial.getPorts();
    } catch (error) {
      throw withPermissionHint(error);
    }
    // Only a port that reports the SPP service is this printer. Falling back to
    // an arbitrary authorised port would retry an unusable one forever and
    // never offer the picker; null makes the caller ask instead.
    return ports.find((port) => canonicalSpp(port.getInfo().bluetoothServiceClassId) === SPP_SERVICE_ID) ?? null;
  }

  static async request() {
    try {
      return await navigator.serial.requestPort({
        // The short alias and the UUID are the same service; a port may answer
        // either form, so the filter list carries both.
        filters: [{ bluetoothServiceClassId: SPP_SHORT_ID }, { bluetoothServiceClassId: CONFIG.transport.sppService }],
      });
    } catch (error) {
      if (error.name === 'NotFoundError') {
        log.warn('no SPP device matched the filter, falling back to the full port list');
        try {
          return await navigator.serial.requestPort();
        } catch (retryError) {
          throw withPermissionHint(retryError);
        }
      }
      throw withPermissionHint(error);
    }
  }

  onData(callback) {
    this.#onData = callback;
  }

  onClose(callback) {
    this.#onClose = callback;
  }

  async open(port) {
    this.#port = port;
    try {
      await port.open({ baudRate: CONFIG.transport.serialBaudRate, bufferSize: CONFIG.transport.serialBufferSize });
    } catch (error) {
      // A revoked permission surfaces here too, after a port was chosen: the
      // same concrete next step applies.
      throw withPermissionHint(error);
    }
    this.#writer = port.writable.getWriter();
    this.#reader = port.readable.getReader();
    this.#readLoop();
    log.info('serial port opened', { service: port.getInfo().bluetoothServiceClassId ?? 'unknown' });
  }

  async #readLoop() {
    try {
      for (;;) {
        const { value, done } = await this.#reader.read();
        if (done) break;
        if (value?.length) this.#onData(value);
      }
      if (!this.#closing) this.#onClose(null);
    } catch (error) {
      if (!this.#closing) {
        log.error('serial read failed', { message: error.message });
        this.#onClose(error);
      }
    }
  }

  async write(bytes) {
    if (!this.#writer) throw new Error('Serial port is not open');
    await this.#writer.write(bytes);
  }

  describe() {
    return 'Bluetooth serial (SPP)';
  }

  async close() {
    this.#closing = true;
    // Closing is best-effort by design, but a failure still leaves a trace:
    // a port that cannot be released explains the next open() failure.
    try {
      await this.#reader?.cancel();
    } catch (error) {
      log.debug('serial reader cancel failed', { message: error.message });
    }
    try {
      this.#reader?.releaseLock();
    } catch (error) {
      log.debug('serial reader release failed', { message: error.message });
    }
    try {
      this.#writer?.releaseLock();
    } catch (error) {
      log.debug('serial writer release failed', { message: error.message });
    }
    try {
      await this.#port?.close();
    } catch (error) {
      log.debug('serial port close failed', { message: error.message });
    }
    this.#reader = null;
    this.#writer = null;
    this.#port = null;
    log.info('serial port closed');
  }
}
