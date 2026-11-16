/**
 * Web Bluetooth transport: BLE GATT. The D110_M exposes the same frames over a
 * single write/notify characteristic; writes are paced because the
 * characteristic is write-without-response.
 */

import { CONFIG } from '../../core/config.js';
import { sleep } from '../../core/format.js';
import { createLogger } from '../../core/log.js';
import { buildCommand } from '../../protocol/commands.js';

const log = createLogger('transport.ble');

export class BleTransport {
  kind = 'ble';
  #device = null;
  #characteristic = null;
  #onData = () => {};
  #onClose = () => {};
  #closing = false;

  static available() {
    return typeof navigator !== 'undefined' && 'bluetooth' in navigator;
  }

  static async granted() {
    if (!BleTransport.available() || !navigator.bluetooth.getDevices) return null;
    const devices = await navigator.bluetooth.getDevices();
    return devices.find((device) => CONFIG.transport.bleNamePrefixes.some((prefix) => device.name?.startsWith(prefix))) ?? null;
  }

  static request() {
    return navigator.bluetooth.requestDevice({
      filters: CONFIG.transport.bleNamePrefixes.map((namePrefix) => ({ namePrefix })),
      optionalServices: [CONFIG.transport.bleService],
    });
  }

  onData(callback) {
    this.#onData = callback;
  }

  onClose(callback) {
    this.#onClose = callback;
  }

  async open(device) {
    this.#device = device;
    device.addEventListener(
      'gattserverdisconnected',
      () => {
        if (!this.#closing) this.#onClose(new Error('Printer disconnected'));
      },
      { once: true }
    );

    const server = await device.gatt.connect();
    const service = await server.getPrimaryService(CONFIG.transport.bleService);
    const characteristic = await service.getCharacteristic(CONFIG.transport.bleCharacteristic);
    this.#characteristic = characteristic;

    await characteristic.startNotifications();
    characteristic.addEventListener('characteristicvaluechanged', (event) => {
      const view = event.target.value;
      this.#onData(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
    });

    // The command registry owns the connect frame (including its 0x03 prefix);
    // the transport must not keep a second copy of those bytes.
    await characteristic.writeValueWithoutResponse(buildCommand('connect'));
    log.info('BLE connected', { name: device.name ?? 'unknown' });
  }

  async write(bytes) {
    if (!this.#characteristic) throw new Error('Bluetooth printer is not connected');
    await sleep(CONFIG.transport.bleWritePacingMs);
    if (this.#characteristic.writeValueWithoutResponse) {
      await this.#characteristic.writeValueWithoutResponse(bytes);
    } else {
      await this.#characteristic.writeValue(bytes);
    }
  }

  describe() {
    return `Bluetooth LE (${this.#device?.name ?? 'D110'})`;
  }

  async close() {
    this.#closing = true;
    try {
      this.#device?.gatt?.disconnect();
    } catch (error) {
      // The link may already be gone; record why the disconnect failed.
      log.debug('BLE disconnect failed', { message: error.message });
    }
    this.#characteristic = null;
    this.#device = null;
    log.info('BLE closed');
  }
}
