/** Minimal event emitter shared by stores, sessions and device services. */

import { createLogger } from './log.js';

const log = createLogger('core.events');

export function createEmitter() {
  const handlers = new Map();

  return {
    on(type, handler) {
      if (!handlers.has(type)) handlers.set(type, new Set());
      handlers.get(type).add(handler);
      return () => handlers.get(type)?.delete(handler);
    },
    once(type, handler) {
      const off = this.on(type, (payload) => {
        off();
        handler(payload);
      });
      return off;
    },
    off(type, handler) {
      handlers.get(type)?.delete(handler);
    },
    emit(type, payload) {
      const set = handlers.get(type);
      if (!set) return;
      for (const handler of [...set]) {
        try {
          handler(payload);
        } catch (error) {
          // Handlers must not take down the emitter; the diagnostics log still
          // names the event and the failure.
          log.debug('event handler threw', { type, message: error?.message ?? String(error) });
        }
      }
    },
    clear() {
      handlers.clear();
    },
  };
}
