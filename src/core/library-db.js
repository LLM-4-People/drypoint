/**
 * The IndexedDB owner for the label library.
 *
 * The database name, version, object stores, index and upgrade path live here
 * once. The rest of the app talks to the five-method adapter, so the domain is
 * testable with the memory adapter and never imports the IndexedDB API itself.
 *
 * A blocked upgrade, an unavailable IndexedDB and a failed open are typed
 * errors: the boot path can tell "this browser cannot store labels" from a
 * programming mistake, fall back to memory and show an honest notice.
 */

import { CONFIG } from './config.js';
import { deepClone } from './format.js';
import { createLogger } from './log.js';

const log = createLogger('core.library-db');

const LIBRARY_DB_VERSION = 1;

/** The object stores and their key paths, declared once for open and upgrade. */
const LIBRARY_STORES = Object.freeze({
  labels: 'id',
  documents: 'id',
  histories: 'labelId',
  sessions: 'labelId',
  meta: 'key',
});

/** The one index the library order reads. */
const LIBRARY_INDEX = Object.freeze({ store: 'labels', name: 'updatedAt', keyPath: 'updatedAt' });

const LIBRARY_DB_ERROR_CODES = Object.freeze(['unavailable', 'blocked', 'open', 'failed']);

class LibraryDbError extends Error {
  /**
   * @param {string} message
   * @param {{code?: string, cause?: unknown}} [options]
   */
  constructor(message, { code = 'open', cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'LibraryDbError';
    this.code = LIBRARY_DB_ERROR_CODES.includes(code) ? code : 'open';
  }
}

function storeNames() {
  return Object.keys(LIBRARY_STORES);
}

function requireStore(store) {
  if (!Object.prototype.hasOwnProperty.call(LIBRARY_STORES, store)) {
    throw new LibraryDbError(`Unknown library store: ${String(store)}`, { code: 'failed' });
  }
}

function validOperation(operation) {
  if (!operation || typeof operation !== 'object') return false;
  if (operation.type !== 'put' && operation.type !== 'delete') return false;
  return Object.prototype.hasOwnProperty.call(LIBRARY_STORES, operation.store);
}

function upgrade(database, transaction) {
  for (const [name, keyPath] of Object.entries(LIBRARY_STORES)) {
    if (!database.objectStoreNames.contains(name)) {
      database.createObjectStore(name, { keyPath });
    }
  }
  const labels = transaction.objectStore('labels');
  if (!labels.indexNames.contains(LIBRARY_INDEX.name)) {
    labels.createIndex(LIBRARY_INDEX.name, LIBRARY_INDEX.keyPath);
  }
}

/**
 * Open the library database and return the adapter.
 *
 * @param {{indexedDB?: IDBFactory|null, name?: string, version?: number}} [options]
 * @returns {Promise<{get: Function, getAll: Function, put: Function, delete: Function, batch: Function, close: Function}>}
 */
export function openLibraryDatabase({
  indexedDB = globalThis.indexedDB,
  name = CONFIG.app.id,
  version = LIBRARY_DB_VERSION,
} = {}) {
  if (!indexedDB || typeof indexedDB.open !== 'function') {
    return Promise.reject(new LibraryDbError('IndexedDB is not available in this context', { code: 'unavailable' }));
  }
  return new Promise((resolve, reject) => {
    let request;
    try {
      request = indexedDB.open(name, version);
    } catch (error) {
      reject(new LibraryDbError('The label library could not be opened', { code: 'open', cause: error }));
      return;
    }
    let settled = false;
    const fail = (message, code, cause) => {
      if (settled) return;
      settled = true;
      reject(new LibraryDbError(message, { code, cause }));
    };

    request.onupgradeneeded = (event) => {
      upgrade(request.result, request.transaction);
      log.info('library database upgraded', { from: event.oldVersion, to: event.newVersion });
    };
    request.onblocked = () => {
      fail(`Another tab is using an older version of the label library (database ${name})`, 'blocked');
    };
    request.onerror = () => {
      fail('The label library could not be opened', 'open', request.error);
    };
    request.onsuccess = () => {
      const database = request.result;
      // A blocked open may still succeed after the other tab closes; close it
      // instead of leaking a connection the app already replaced with memory.
      if (settled) {
        database.close();
        return;
      }
      settled = true;
      database.onversionchange = () => {
        log.info('library database closed for an upgrade');
        database.close();
      };
      resolve(adapterFor(database));
    };
  });
}

/**
 * Wrap one IDBDatabase in the five-method adapter. The domain only sees this
 * interface; the memory adapter below implements the same shape.
 */
function adapterFor(database) {
  function requestPromise(store, mode, action) {
    requireStore(store);
    return new Promise((resolve, reject) => {
      let transaction;
      try {
        transaction = database.transaction(store, mode);
      } catch (error) {
        reject(new LibraryDbError('The label library transaction could not start', { code: 'failed', cause: error }));
        return;
      }
      let result;
      transaction.oncomplete = () => resolve(result);
      transaction.onerror = () => reject(new LibraryDbError('The label library request failed', { code: 'failed', cause: transaction.error }));
      transaction.onabort = () => reject(new LibraryDbError('The label library request was aborted', { code: 'failed', cause: transaction.error }));
      try {
        const target = transaction.objectStore(store);
        const request = action(target);
        if (request) request.onsuccess = () => { result = request.result; };
      } catch (error) {
        try {
          transaction.abort();
        } catch {
          // The transaction already failed; the rejection below is the report.
        }
        reject(new LibraryDbError('The label library request failed', { code: 'failed', cause: error }));
      }
    });
  }

  function batch(operations) {
    if (!Array.isArray(operations)) {
      return Promise.reject(new LibraryDbError('A library batch must be an array', { code: 'failed' }));
    }
    if (operations.length === 0) return Promise.resolve();
    if (!operations.every(validOperation)) {
      return Promise.reject(new LibraryDbError('A library batch contains an invalid operation', { code: 'failed' }));
    }
    const stores = [...new Set(operations.map((operation) => operation.store))];
    return new Promise((resolve, reject) => {
      let transaction;
      try {
        transaction = database.transaction(stores, 'readwrite');
      } catch (error) {
        reject(new LibraryDbError('The label library transaction could not start', { code: 'failed', cause: error }));
        return;
      }
      let settled = false;
      const fail = (message, cause) => {
        if (settled) return;
        settled = true;
        reject(new LibraryDbError(message, { code: 'failed', cause }));
      };
      transaction.oncomplete = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      transaction.onerror = () => fail('The label library batch failed', transaction.error);
      transaction.onabort = () => fail('The label library batch was aborted', transaction.error);
      try {
        for (const operation of operations) {
          const store = transaction.objectStore(operation.store);
          if (operation.type === 'put') store.put(operation.value);
          else store.delete(operation.key);
        }
      } catch (error) {
        try {
          transaction.abort();
        } catch {
          // The rejection below is the report.
        }
        fail('The label library batch failed', error);
      }
    });
  }

  return {
    get: (store, key) => requestPromise(store, 'readonly', (target) => target.get(key)),
    getAll: (store) => requestPromise(store, 'readonly', (target) => target.getAll()),
    put: (store, value) =>
      requestPromise(store, 'readwrite', (target) => target.put(value)).then(() => undefined),
    delete: (store, key) =>
      requestPromise(store, 'readwrite', (target) => target.delete(key)).then(() => undefined),
    batch,
    close: () => database.close(),
  };
}

/**
 * The in-memory adapter used by the tests and by the unavailable-storage
 * fallback. It implements the same five methods. A batch validates and clones
 * every operation before touching the stores, so a refused record cannot leave
 * half a transaction behind; it does not clone unrelated stores, which matters
 * when the fallback holds a large history in memory.
 */
export function createMemoryDatabase(initial = {}) {
  const clone = (value) => (value === undefined ? undefined : deepClone(value));
  const records = new Map();
  for (const name of storeNames()) {
    const store = new Map();
    for (const [key, value] of Object.entries(initial[name] ?? {})) store.set(key, clone(value));
    records.set(name, store);
  }

  function prepare(operation) {
    if (!validOperation(operation)) throw new Error('A library batch contains an invalid operation');
    if (operation.type === 'delete') return { store: operation.store, key: operation.key, value: null };
    const value = operation.value;
    if (!value || typeof value !== 'object') throw new Error('A library record must be an object');
    const key = value[LIBRARY_STORES[operation.store]];
    if (typeof key !== 'string' || !key) throw new Error('A library record has no key');
    return { store: operation.store, key, value: clone(value) };
  }

  function apply(operation) {
    const store = records.get(operation.store);
    if (operation.value === null) store.delete(operation.key);
    else store.set(operation.key, operation.value);
  }

  return {
    get(store, key) {
      requireStore(store);
      return Promise.resolve(clone(records.get(store).get(key)));
    },
    getAll(store) {
      requireStore(store);
      return Promise.resolve([...records.get(store).values()].map(clone));
    },
    put(store, value) {
      requireStore(store);
      try {
        apply(prepare({ type: 'put', store, value }));
      } catch (error) {
        return Promise.reject(new LibraryDbError('The label library request failed', { code: 'failed', cause: error }));
      }
      return Promise.resolve();
    },
    delete(store, key) {
      requireStore(store);
      records.get(store).delete(key);
      return Promise.resolve();
    },
    batch(operations) {
      let prepared;
      try {
        if (!Array.isArray(operations)) throw new Error('A library batch must be an array');
        prepared = operations.map(prepare);
      } catch (error) {
        return Promise.reject(new LibraryDbError('The label library batch failed', { code: 'failed', cause: error }));
      }
      for (const operation of prepared) apply(operation);
      return Promise.resolve();
    },
    close() {},
  };
}
