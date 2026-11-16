/**
 * Centralised logging. Every module logs through a logger created here; no
 * module calls console directly. The sink keeps a bounded ring buffer that the
 * diagnostics panel and the export action read.
 */

import { CONFIG } from './config.js';
import { toHex } from './format.js';

export const LEVELS = Object.freeze({ trace: 10, debug: 20, info: 30, warn: 40, error: 50 });

const entries = [];
const listeners = new Set();
let minLevel = LEVELS[CONFIG.log.level] ?? LEVELS.info;

const REDACTED = '[redacted]';
const normaliseKey = (key) => key.toLowerCase().replace(/[^a-z0-9]/g, '');
const SECRET_KEYS = new Set(CONFIG.log.redactKeys.map(normaliseKey));
const BEARER = /\b(Bearer)\s+[A-Za-z0-9._~+/=-]+/gi;
const URL_USERINFO = /(\/\/)[^/\s:@]+:[^/\s@]+@/g;
/**
 * Query-string secrets: `?token=…`, `&api_key=…`. The key stays readable so a
 * log line still says which credential was present; only the value is masked.
 */
const QUERY_SECRET = /([?&;](?:access[_-]?token|api[_-]?key|token|secret|password|passwd|auth)=)[^&#\s"']+/gi;

/** Mask credentials that can appear inside an otherwise harmless string. */
export function redactText(text) {
  return String(text)
    .replace(BEARER, '$1 [redacted]')
    .replace(URL_USERINFO, '$1[redacted]@')
    .replace(QUERY_SECRET, '$1[redacted]');
}

/** Replace secret-shaped object values before a detail is serialised. */
function redactValue(value) {
  if (value instanceof Error) return redactText(`${value.name}: ${value.message}`);
  if (Array.isArray(value)) return value.map(redactValue);
  if (value && typeof value === 'object' && !(value instanceof Uint8Array) && !(value instanceof ArrayBuffer)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, SECRET_KEYS.has(normaliseKey(key)) ? REDACTED : redactValue(entry)])
    );
  }
  return value;
}

function normaliseLevel(level) {
  if (typeof level === 'number') return level;
  return LEVELS[String(level).toLowerCase()] ?? LEVELS.info;
}

export function setLogLevel(level) {
  minLevel = normaliseLevel(level);
}

function getLogLevel() {
  return Object.keys(LEVELS).find((name) => LEVELS[name] === minLevel) ?? 'info';
}

/** Shorten binary payloads so a log line stays readable. */
export function describeValue(value) {
  if (value instanceof Uint8Array || value instanceof ArrayBuffer) {
    const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
    const shown = bytes.subarray(0, CONFIG.log.maxBytesShown);
    const hex = toHex(shown);
    return bytes.length > shown.length ? `${hex} … (${bytes.length} bytes)` : hex;
  }
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  if (value && typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return value;
}

function record(level, scope, message, detail) {
  if (LEVELS[level] < minLevel) return;
  const described = detail === undefined ? undefined : describeValue(redactValue(detail));
  const entry = {
    at: new Date().toISOString(),
    level,
    scope,
    message: redactText(message),
    detail: typeof described === 'string' ? redactText(described) : described,
  };
  entries.push(entry);
  if (entries.length > CONFIG.log.bufferSize) entries.shift();
  for (const listener of listeners) {
    try {
      listener(entry);
    } catch {
      // A broken listener must never break logging.
    }
  }
  if (CONFIG.log.console) {
    const line = `[${entry.scope}] ${entry.message}`;
    const payload = entry.detail === undefined ? '' : entry.detail;
    const method = level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'log';
    console[method](line, payload);
  }
}

/**
 * @param {string} scope dot-separated scope name, e.g. "device.transport"
 */
export function createLogger(scope) {
  const emit = (level) => (message, detail) => record(level, scope, message, detail);
  return Object.freeze({
    scope,
    trace: emit('trace'),
    debug: emit('debug'),
    info: emit('info'),
    warn: emit('warn'),
    error: emit('error'),
    child: (childScope) => createLogger(`${scope}.${childScope}`),
  });
}

export const log = createLogger('app');

export function getLogEntries() {
  return entries.slice();
}

export function subscribeLog(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function clearLog() {
  entries.length = 0;
}

/** Machine-readable diagnostics bundle for support reports. */
export function exportLogReport(extra = {}) {
  return {
    generatedAt: new Date().toISOString(),
    // Name every identity field the report carries; a whole-object reference
    // would keep a dead CONFIG leaf alive with no reader.
    app: {
      id: CONFIG.app.id,
      name: CONFIG.app.name,
      version: CONFIG.app.version,
      documentVersion: CONFIG.app.documentVersion,
    },
    userAgent: typeof navigator === 'undefined' ? 'node' : navigator.userAgent,
    level: getLogLevel(),
    entries: entries.slice(-CONFIG.diagnostics.maxEntriesInReport),
    ...extra,
  };
}
