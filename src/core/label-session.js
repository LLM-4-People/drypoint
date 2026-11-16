/**
 * The current label and its persistence owner.
 *
 * Three independent debounces share one flush and one failure channel. The
 * document is written through `library.save` (metadata and document together),
 * history through `writeHistory` and view state through `writeSession`. No
 * other module calls those three library methods.
 *
 * A failed document write stays owed and is retried by the next change or by
 * `flush`; a page that crashes inside the debounce window can still lose the
 * last few milliseconds of work, which the storage contract documents.
 */

import { CONFIG } from './config.js';
import { createLogger } from './log.js';
import { createDocument } from '../label/schema.js';
import { defaultSession, mergeSession, normalizeSession } from './session.js';

const log = createLogger('core.label-session');

/**
 * @param {object} options
 * @param {object} options.library the label library from `openLibrary`
 * @param {{label: object, document: object, history: object, session: object}} options.boot
 * @param {(error: Error, kind: 'document'|'history'|'session') => void} [options.onError]
 * @param {(kind: 'document'|'history'|'session', value?: object) => void} [options.onSaved]
 * @param {number} [options.persistMs]
 * @param {number} [options.historyMs]
 * @param {number} [options.sessionMs]
 */
export function createLabelSession({
  library,
  boot,
  onError = () => {},
  onSaved = () => {},
  persistMs = CONFIG.ui.debounceMs,
  historyMs = CONFIG.ui.persistence.historyMs,
  sessionMs = CONFIG.ui.persistence.sessionMs,
} = {}) {
  if (!library || !boot?.label?.id) throw new Error('The label session needs a library and a boot payload');

  let labelId = boot.label.id;
  let documentPending = null;
  let documentTimer = 0;
  let documentBlocked = false;
  let documentChain = Promise.resolve();

  let historySource = null;
  let historyTimer = 0;
  let historyChain = Promise.resolve();

  let sessionState = normalizeSession(boot.session);
  let sessionPending = false;
  let sessionTimer = 0;
  let sessionChain = Promise.resolve();

  function report(error, kind) {
    log.warn('label persistence failed', { kind, message: error?.message ?? String(error) });
    try {
      onError(error, kind);
    } catch (callbackError) {
      log.warn('the persistence failure handler threw', { message: callbackError?.message ?? String(callbackError) });
    }
  }

  function saved(kind, value) {
    try {
      onSaved(kind, value);
    } catch (error) {
      log.warn('the persistence success handler threw', { message: error?.message ?? String(error) });
    }
  }

  function enqueueDocument() {
    if (!labelId || !documentPending) return documentChain;
    documentChain = documentChain
      .then(async () => {
        while (labelId && documentPending && !documentBlocked) {
          const document = documentPending;
          documentPending = null;
          try {
            const label = await library.save(labelId, document);
            saved('document', label);
          } catch (error) {
            if (!documentPending) documentPending = document;
            documentBlocked = true;
            report(error, 'document');
            break;
          }
        }
      })
      .catch((error) => report(error, 'document'));
    return documentChain;
  }

  function enqueueHistory() {
    if (!labelId || !historySource) return historyChain;
    historyChain = historyChain
      .then(async () => {
        while (labelId && historySource) {
          const controller = historySource;
          historySource = null;
          try {
            await library.writeHistory(labelId, controller.historyState());
            saved('history');
          } catch (error) {
            if (!historySource) historySource = controller;
            report(error, 'history');
            break;
          }
        }
      })
      .catch((error) => report(error, 'history'));
    return historyChain;
  }

  function enqueueSession() {
    if (!labelId || !sessionPending) return sessionChain;
    sessionChain = sessionChain
      .then(async () => {
        while (labelId && sessionPending) {
          sessionPending = false;
          const session = sessionState;
          try {
            await library.writeSession(labelId, session);
            saved('session');
          } catch (error) {
            sessionPending = true;
            report(error, 'session');
            break;
          }
        }
      })
      .catch((error) => report(error, 'session'));
    return sessionChain;
  }

  function saveDocument(document) {
    if (!labelId) return;
    documentPending = document;
    documentBlocked = false;
    clearTimeout(documentTimer);
    documentTimer = setTimeout(() => {
      documentTimer = 0;
      enqueueDocument();
    }, persistMs);
  }

  function saveHistory(controller) {
    if (!labelId || !controller) return;
    historySource = controller;
    clearTimeout(historyTimer);
    historyTimer = setTimeout(() => {
      historyTimer = 0;
      enqueueHistory();
    }, historyMs);
  }

  function saveSession(patch) {
    if (!labelId) return;
    sessionState = mergeSession(sessionState, patch);
    sessionPending = true;
    clearTimeout(sessionTimer);
    sessionTimer = setTimeout(() => {
      sessionTimer = 0;
      enqueueSession();
    }, sessionMs);
  }

  /** Drop owed writes after a switch; they belong to the label just left. */
  function discardOwed() {
    clearTimeout(documentTimer);
    clearTimeout(historyTimer);
    clearTimeout(sessionTimer);
    documentTimer = 0;
    historyTimer = 0;
    sessionTimer = 0;
    documentPending = null;
    documentBlocked = false;
    historySource = null;
    sessionPending = false;
  }

  async function flush() {
    clearTimeout(documentTimer);
    clearTimeout(historyTimer);
    clearTimeout(sessionTimer);
    documentTimer = 0;
    historyTimer = 0;
    sessionTimer = 0;
    documentBlocked = false;
    enqueueDocument();
    enqueueHistory();
    enqueueSession();
    await Promise.all([documentChain, historyChain, sessionChain]);
  }

  async function switchTo(id) {
    await flush();
    const result = await library.read(id);
    if (!result.ok) throw new Error(result.reason);
    // Every read must succeed before the stored pointer or the in-memory
    // session moves. A failed switch leaves the old label fully intact,
    // including any write that is still owed.
    const storedSession = await library.readSession(id);
    const history = (await library.readHistory(id)) ?? { past: [], future: [] };
    const nextSession = storedSession ? normalizeSession(storedSession) : defaultSession(result.document);
    await library.setCurrent(id);
    discardOwed();
    labelId = id;
    sessionState = nextSession;
    return {
      label: result.label,
      document: result.document,
      history,
      session: sessionState,
    };
  }

  async function create(document, options) {
    await flush();
    const label = await library.create(document, options);
    return switchTo(label.id);
  }

  async function duplicate(id) {
    await flush();
    return library.duplicate(id);
  }

  async function remove(id) {
    await flush();
    const wasCurrent = id === labelId;
    await library.remove(id);
    if (!wasCurrent) return null;
    discardOwed();
    labelId = null;
    const candidates = await library.list();
    for (const candidate of candidates) {
      const result = await library.read(candidate.id);
      if (!result.ok) {
        log.warn('an unreadable label was skipped while removing the current label', { id: candidate.id, reason: result.reason });
        continue;
      }
      return switchTo(candidate.id);
    }
    const label = await library.create(createDocument());
    return switchTo(label.id);
  }

  async function resetLegacy() {
    await flush();
    const label = await library.resetLegacy();
    return switchTo(label.id);
  }

  return {
    get labelId() {
      return labelId;
    },
    saveDocument,
    saveHistory,
    saveSession,
    flush,
    switchTo,
    create,
    duplicate,
    remove,
    importDocument: (document) => create(document),
    resetLegacy,
  };
}
