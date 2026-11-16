/**
 * The label library domain: label metadata, documents, current selection,
 * history and view sessions.
 *
 * IndexedDB is reached only through the adapter from `library-db.js`, so every
 * rule here is testable with the memory adapter. Documents are validated at
 * every boundary; an unreadable record is reported and left untouched while
 * the other labels keep saving.
 */

import { CONFIG, storageKey } from './config.js';
import { createId, deepClone } from './format.js';
import { createLogger } from './log.js';
import { createMemoryDatabase, openLibraryDatabase } from './library-db.js';
import { normaliseHistory } from '../label/history.js';
import { DEFAULT_LABEL_NAME, createDocument, hydrateStoredDocument, validateDocument } from '../label/schema.js';
import { defaultSession, normalizeSession } from './session.js';

const log = createLogger('core.library');

/** The legacy single-label key. It is read for migration and then removed. */
const LEGACY_DOCUMENT_KEY = storageKey('document');

const META_CURRENT = 'currentLabelId';
const META_MIGRATED = 'legacyMigrated';

function defaultStorage() {
  try {
    return globalThis.localStorage ?? null;
  } catch (error) {
    log.warn('localStorage is not reachable', { message: error.message });
    return null;
  }
}

function defaultNewId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  // The UUID is the design contract; this fallback keeps a host without the
  // modern API usable instead of failing every create.
  return createId('label');
}

const defaultNow = () => Date.now();

function finiteTime(value, fallback) {
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function metadataName(document) {
  const text = typeof document?.name === 'string' ? document.name.trim() : '';
  return (text || DEFAULT_LABEL_NAME).slice(0, CONFIG.bounds.maxNameChars);
}

/** One normalised label metadata row; malformed rows are not listable. */
function normalizeLabel(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return null;
  if (typeof record.id !== 'string' || !record.id) return null;
  return {
    id: record.id,
    name: typeof record.name === 'string' && record.name.trim() ? record.name.trim().slice(0, CONFIG.bounds.maxNameChars) : DEFAULT_LABEL_NAME,
    createdAt: finiteTime(record.createdAt, 0),
    updatedAt: finiteTime(record.updatedAt, 0),
    elementCount: Number.isInteger(record.elementCount) && record.elementCount >= 0 ? record.elementCount : 0,
  };
}

function labelRecord(document, { id, createdAt, updatedAt }) {
  return {
    id,
    name: metadataName(document),
    createdAt,
    updatedAt,
    elementCount: Array.isArray(document.elements) ? document.elements.length : 0,
  };
}

function rawJson(value) {
  if (value === undefined) return null;
  try {
    const text = JSON.stringify(value);
    return typeof text === 'string' ? text : null;
  } catch {
    return null;
  }
}

function readRaw(storage, key) {
  if (!storage || typeof storage.getItem !== 'function') return null;
  try {
    return storage.getItem(key);
  } catch (error) {
    log.warn('a stored value could not be read', { key, message: error.message });
    return null;
  }
}

function removeRaw(storage, key) {
  if (!storage || typeof storage.removeItem !== 'function') return true;
  try {
    storage.removeItem(key);
    return true;
  } catch (error) {
    log.warn('a migrated stored value could not be removed', { key, message: error.message });
    return false;
  }
}

function sortLabels(labels) {
  return labels.sort(
    (a, b) =>
      b.updatedAt - a.updatedAt ||
      b.createdAt - a.createdAt ||
      a.id.localeCompare(b.id)
  );
}

/**
 * Build the domain over one adapter.
 *
 * @param {{db: object, storage: Storage|null, newId: Function, now: Function}} options
 */
function createLibrary({ db, storage, newId = defaultNewId, now = defaultNow }) {
  async function list() {
    const rows = await db.getAll('labels');
    return sortLabels(rows.map(normalizeLabel).filter(Boolean));
  }

  async function read(id) {
    if (typeof id !== 'string' || !id) return { ok: false, reason: 'That label has no valid id.', raw: null };
    const record = await db.get('documents', id);
    if (!record || typeof record !== 'object') {
      return { ok: false, reason: 'The label document is missing.', raw: null };
    }
    let document;
    try {
      document = validateDocument(record.document);
    } catch (error) {
      return { ok: false, reason: error.message, raw: rawJson(record.document) };
    }
    const label = normalizeLabel(await db.get('labels', id));
    if (!label) return { ok: false, reason: 'The label metadata is missing.', raw: rawJson(record.document) };
    return { ok: true, label, document };
  }

  async function create(document, { name } = {}) {
    const source = typeof name === 'string' ? { ...document, name } : document;
    const validated = validateDocument(source);
    const id = newId();
    const at = now();
    const label = labelRecord(validated, { id, createdAt: at, updatedAt: at });
    await db.batch([
      { type: 'put', store: 'labels', value: label },
      { type: 'put', store: 'documents', value: { id, document: validated } },
    ]);
    return label;
  }

  async function save(id, document) {
    if (typeof id !== 'string' || !id) throw new Error('That label has no valid id.');
    const existing = await db.get('labels', id);
    if (!existing) throw new Error('The label no longer exists.');
    const validated = validateDocument(document);
    const at = now();
    const createdAt = finiteTime(existing.createdAt, at);
    const label = labelRecord(validated, { id, createdAt, updatedAt: at });
    await db.batch([
      { type: 'put', store: 'labels', value: label },
      { type: 'put', store: 'documents', value: { id, document: validated } },
    ]);
    return label;
  }

  async function duplicate(id) {
    const source = await read(id);
    if (!source.ok) throw new Error(source.reason);
    const copy = deepClone(source.document);
    copy.name = `${source.label.name} copy`.slice(0, CONFIG.bounds.maxNameChars);
    return create(copy);
  }

  async function remove(id) {
    await db.batch([
      { type: 'delete', store: 'labels', key: id },
      { type: 'delete', store: 'documents', key: id },
      { type: 'delete', store: 'histories', key: id },
      { type: 'delete', store: 'sessions', key: id },
    ]);
  }

  async function currentId() {
    const record = await db.get('meta', META_CURRENT);
    const value = record?.value;
    return typeof value === 'string' && value ? value : null;
  }

  async function setCurrent(id) {
    await db.put('meta', { key: META_CURRENT, value: id });
  }

  async function readHistory(id) {
    const record = await db.get('histories', id);
    if (!record || typeof record !== 'object') return null;
    return normaliseHistory(record);
  }

  async function writeHistory(id, history) {
    const normalised = normaliseHistory(history);
    await db.put('histories', { labelId: id, ...normalised, updatedAt: now() });
  }

  async function readSession(id) {
    const record = await db.get('sessions', id);
    if (!record || typeof record !== 'object') return null;
    return normalizeSession(record);
  }

  async function writeSession(id, session) {
    const normalised = normalizeSession(session);
    await db.put('sessions', { labelId: id, ...normalised, updatedAt: now() });
  }

  async function recordMigrated() {
    await db.put('meta', { key: META_MIGRATED, value: true });
  }

  function legacyFailure(raw, error) {
    return { migrated: false, legacyError: { raw, message: error?.message ?? String(error) } };
  }

  /**
   * Migrate the single stored document once.
   *
   * A valid value becomes one label and the key is removed. An unreadable
   * value is kept and reported on every boot until the operator resets it,
   * even when the library already holds other labels: that is what keeps the
   * existing quarantine banner truthful across reloads.
   */
  async function migrateLegacy() {
    const labels = await db.getAll('labels');
    const raw = readRaw(storage, LEGACY_DOCUMENT_KEY);
    if (raw === null || raw === '') {
      await recordMigrated();
      return { migrated: false };
    }
    let parsed;
    let document;
    let readError = null;
    try {
      parsed = JSON.parse(raw);
      // Storage is stricter than import: an envelope-shaped value or a missing
      // element list is corrupt, not an empty label.
      document = hydrateStoredDocument(parsed);
    } catch (error) {
      readError = error;
    }
    if (labels.length) {
      // A library that already holds labels is never given a duplicate. The
      // key is left in place, and an unreadable one is still reported so the
      // quarantine banner survives the reload that follows a fallback boot.
      await recordMigrated();
      return readError ? legacyFailure(raw, readError) : { migrated: false };
    }
    if (readError) return legacyFailure(raw, readError);
    const label = await create(document);
    await recordMigrated();
    removeRaw(storage, LEGACY_DOCUMENT_KEY);
    log.info('legacy label migrated', { id: label.id, elements: label.elementCount });
    return { migrated: true, label };
  }

  /**
   * The label a reset must keep: the current one when it is readable,
   * otherwise the most recently updated readable one.
   */
  async function currentReadableLabel() {
    const preferred = await currentId();
    if (preferred) {
      const result = await read(preferred);
      if (result.ok) return result.label;
    }
    for (const candidate of await list()) {
      if (candidate.id === preferred) continue;
      const result = await read(candidate.id);
      if (result.ok) return result.label;
    }
    return null;
  }

  /**
   * Remove the quarantined legacy value. Boot has already opened a usable
   * label when the value is unreadable, so reset keeps that label and any
   * edits made since; it creates one only when no readable label exists.
   */
  async function resetLegacy() {
    const retained = await currentReadableLabel();
    const label = retained ?? (await create(createDocument()));
    await setCurrent(label.id);
    await recordMigrated();
    removeRaw(storage, LEGACY_DOCUMENT_KEY);
    log.warn('the unreadable legacy label was reset', { id: label.id, retained: Boolean(retained) });
    return label;
  }

  async function boot() {
    let migration = { migrated: false };
    try {
      migration = await migrateLegacy();
    } catch (error) {
      // A migration write failure must not hide a library that still opens.
      // With no labels at all, rethrow: creating a default label here would
      // strand the legacy value behind the "already populated" rule. The boot
      // owner falls back to memory and leaves both stores for a later attempt.
      const existing = await db.getAll('labels');
      log.error('the legacy label could not be migrated', { message: error.message, labels: existing.length });
      if (!existing.length) throw error;
      migration = { migrated: false, bootError: error };
    }

    let labels = await list();
    if (!labels.length) {
      const label = await create(createDocument());
      await setCurrent(label.id);
      labels = [label];
    }

    const storedCurrent = await currentId();
    let chosen = labels.find((label) => label.id === storedCurrent) ?? labels[0];
    let result = await read(chosen.id);
    let notice = null;
    if (!result.ok) {
      notice = 'A saved label could not be read. Another label was opened; the unreadable record was kept.';
      for (const candidate of labels) {
        if (candidate.id === chosen.id) continue;
        const attempt = await read(candidate.id);
        if (!attempt.ok) continue;
        result = attempt;
        chosen = candidate;
        break;
      }
      if (!result.ok) {
        const fresh = await create(createDocument());
        await setCurrent(fresh.id);
        const attempt = await read(fresh.id);
        if (!attempt.ok) throw new Error(attempt.reason);
        result = attempt;
        chosen = fresh;
        notice = 'A saved label could not be read. A new label was opened; the unreadable record was kept.';
      }
    }
    if (chosen.id !== storedCurrent) await setCurrent(chosen.id);
    const history = (await readHistory(chosen.id)) ?? { past: [], future: [] };
    const session = (await readSession(chosen.id)) ?? defaultSession(result.document);
    return {
      label: result.label,
      document: result.document,
      history,
      session,
      legacyError: migration.legacyError,
      bootError: migration.bootError,
      notice,
    };
  }

  return {
    list,
    read,
    create,
    save,
    duplicate,
    remove,
    currentId,
    setCurrent,
    readHistory,
    writeHistory,
    readSession,
    writeSession,
    migrateLegacy,
    resetLegacy,
    boot,
    close: () => db.close(),
  };
}

/**
 * Open the real IndexedDB library.
 *
 * @param {{indexedDB?: IDBFactory|null, storage?: Storage|null, newId?: Function, now?: Function, db?: object}} [options]
 *   `db` injects the adapter for tests; production passes only `indexedDB`.
 */
export async function openLibrary({
  indexedDB = globalThis.indexedDB,
  storage = defaultStorage(),
  newId = defaultNewId,
  now = defaultNow,
  db = null,
} = {}) {
  const database = db ?? (await openLibraryDatabase({ indexedDB }));
  return createLibrary({ db: database, storage, newId, now });
}

/**
 * The fallback library when IndexedDB cannot open. It holds one default label
 * and never touches the legacy key, so a transient storage failure cannot
 * destroy the single-document value a later boot may still migrate.
 */
export function createMemoryLibrary({ newId = defaultNewId, now = defaultNow } = {}) {
  return createLibrary({ db: createMemoryDatabase(), storage: null, newId, now });
}
