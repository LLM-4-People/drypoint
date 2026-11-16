/**
 * Android shell transport: the APK's WebView has no Web Bluetooth, so a native
 * bridge (`window.NiimbotBLE`) performs the GATT work. This class keeps the same
 * contract as SerialTransport/BleTransport, so the device manager, session and
 * print job are unchanged.
 *
 * Bridge protocol (owned here and in BleBridge.java):
 *   pickDevice(token, prefixesJson) → resolve(token, {ok, device|cancelled, error})
 *   cancelPick() → dismiss the picker, stop the scan, resolve it as cancelled
 *   lastDevice() → JSON string
 *   forgetDevice() → clears the saved lastDevice
 *   connect(token, id, service, characteristic) → resolve(token, {ok} | {error})
 *   write(base64) → boolean (queued)
 *   disconnect()
 *   saveFile(name, text) → boolean
 *   window.__niimbot.event('data'|'close', payload)
 */

import { CONFIG } from '../../core/config.js';
import { sleep } from '../../core/format.js';
import { createLogger } from '../../core/log.js';
import { buildCommand } from '../../protocol/commands.js';

const log = createLogger('transport.android');

/** One owner for the pending bridge calls and the active transport. */
const pending = new Map();
let active = null;
let installed = false;
let nextToken = 0;
/** A pick whose dialog may still be open, even after the JS call timed out. */
let picking = false;

function bridge() {
  if (typeof window !== 'undefined' && window.NiimbotBLE) return window.NiimbotBLE;
  if (typeof globalThis !== 'undefined' && globalThis.NiimbotBLE) return globalThis.NiimbotBLE;
  return null;
}

function bytesToBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function base64ToBytes(text) {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function install() {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  window.__niimbot = {
    resolve(token, payload) {
      const entry = pending.get(token);
      if (!entry) return;
      pending.delete(token);
      clearTimeout(entry.timer);
      if (entry.method === 'pickDevice') picking = false;
      if (payload?.ok) entry.resolve(payload);
      else if (payload?.cancelled) entry.reject(Object.assign(new Error('No printer selected'), { name: 'NotFoundError' }));
      else entry.reject(new Error(payload?.error ?? 'Bluetooth operation failed'));
    },
    event(type, payload) {
      if (!active) return;
      if (type === 'data') active.receive(base64ToBytes(payload));
      else if (type === 'close') active.lost(payload);
    },
  };
}

/** Reject every outstanding bridge call: a closed link can answer none of them. */
function rejectPending(message) {
  const entries = [...pending.values()];
  pending.clear();
  for (const entry of entries) {
    clearTimeout(entry.timer);
    // The picker is dismissed by close(), not broken: the native side resolves
    // it as cancelled, so the JS side must produce the same answer the manager
    // treats as a normal outcome (NotFoundError -> cancelled), not "link closed".
    if (entry.method === 'pickDevice') {
      picking = false;
      entry.reject(Object.assign(new Error('No printer selected'), { name: 'NotFoundError' }));
    } else {
      entry.reject(new Error(message));
    }
  }
}

/**
 * Call one bridge method. The native side may never answer (a stalled GATT
 * connect, a destroyed Activity, a picker nobody closes), so every call carries
 * its own timeout and the transport's close() rejects whatever is still pending.
 */
function call(method, args = [], { timeoutMs = CONFIG.transport.androidCallTimeoutMs } = {}) {
  const api = bridge();
  if (!api || typeof api[method] !== 'function') return Promise.reject(new Error('Android Bluetooth bridge is unavailable'));
  install();
  const token = `${Date.now().toString(36)}-${(nextToken += 1).toString(36)}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(token);
      log.warn('Android bridge call timed out', { method, timeoutMs });
      reject(new Error(`The Android Bluetooth bridge did not answer ${method} within ${timeoutMs} ms`));
    }, timeoutMs);
    // A pending browser timer is irrelevant to the page; in Node it must not
    // keep the process (or a test run) alive.
    timer?.unref?.();
    pending.set(token, { resolve, reject, timer, method });
    try {
      api[method](token, ...args);
    } catch (error) {
      pending.delete(token);
      clearTimeout(timer);
      reject(error);
    }
  });
}

/**
 * Dismiss whatever picker the native side still shows. A pick that timed out in
 * JavaScript leaves its dialog open, so a retry would stack a second one.
 */
function cancelPick() {
  picking = false;
  const api = bridge();
  if (!api || typeof api.cancelPick !== 'function') return false;
  try {
    api.cancelPick();
    return true;
  } catch (error) {
    log.debug('Android picker could not be dismissed', { message: error.message });
    return false;
  }
}

export class AndroidTransport {
  static kind = 'android';
  kind = AndroidTransport.kind;
  #device = null;
  #onData = () => {};
  #onClose = () => {};
  #closing = false;

  static available() {
    return Boolean(bridge());
  }

  /**
   * The native bridge already owns `lastDevice`, so the web identity is
   * ignored. The argument keeps the transport contract symmetric.
   */
  static async granted(_preferred = null) {
    const api = bridge();
    if (!api || typeof api.lastDevice !== 'function') return null;
    try {
      const raw = api.lastDevice();
      if (!raw) return null;
      const device = JSON.parse(raw);
      return device?.id ? device : null;
    } catch (error) {
      log.debug('cached Android printer could not be read', { message: error.message });
      return null;
    }
  }

  static request() {
    // A dialog from an abandoned pick would swallow the new one: dismiss it.
    if (picking) cancelPick();
    picking = true;
    return call('pickDevice', [JSON.stringify(CONFIG.transport.bleNamePrefixes)], { timeoutMs: CONFIG.transport.androidPickerTimeoutMs }).then(
      (reply) => reply.device
    );
  }

  /**
   * Clear the printer the app would otherwise reconnect to on its own. The
   * native side owns the stored selection; an older bridge without the call
   * reports "not forgotten" instead of pretending it worked.
   */
  static forget() {
    const api = bridge();
    if (!api || typeof api.forgetDevice !== 'function') return false;
    api.forgetDevice();
    log.info('Android saved printer forgotten');
    return true;
  }

  onData(callback) {
    this.#onData = callback;
  }

  onClose(callback) {
    this.#onClose = callback;
  }

  /** Called by the installed bridge event handler. */
  receive(bytes) {
    this.#onData(bytes);
  }

  /** Called by the installed bridge event handler. */
  lost(reason) {
    if (!this.#closing) this.#onClose(new Error(reason || 'Printer disconnected'));
  }

  async open(device) {
    active = this;
    this.#device = device;
    await call('connect', [device.id, CONFIG.transport.bleService, CONFIG.transport.bleCharacteristic]);
    // The command registry owns the connect frame, exactly as on BLE/SPP.
    await this.write(buildCommand('connect'));
    log.info('Android BLE connected', { name: device.name ?? 'unknown' });
  }

  async write(bytes) {
    const api = bridge();
    if (!api || !this.#device) throw new Error('Bluetooth printer is not connected');
    await sleep(CONFIG.transport.bleWritePacingMs);
    if (!api.write(bytesToBase64(bytes))) throw new Error('Bluetooth write was rejected');
  }

  describe() {
    return `Bluetooth LE (${this.#device?.name ?? 'D110'})`;
  }

  /** Reported to the manager; the web key is not written for Android. */
  identity() {
    return {
      kind: AndroidTransport.kind,
      id: typeof this.#device?.id === 'string' ? this.#device.id : '',
      name: typeof this.#device?.name === 'string' ? this.#device.name : '',
    };
  }

  async close() {
    // Stay closed: a late native event must not reach a disposed transport.
    this.#closing = true;
    // A picker nobody answered would outlive the link (and the page) it was
    // opened for; dismissing it resolves the native call as cancelled, and
    // rejectPending gives the JS caller that same cancelled answer.
    cancelPick();
    // Every call in flight belongs to the link being closed; none can complete.
    rejectPending('Android Bluetooth link closed');
    try {
      bridge()?.disconnect?.();
    } catch (error) {
      log.debug('Android BLE disconnect failed', { message: error.message });
    }
    if (active === this) active = null;
    this.#device = null;
    log.info('Android BLE closed');
  }
}
