/**
 * Page-side consumer for service-worker messages. `sw.js` posts a
 * `precache-error` message when an install fails; the worker itself cannot
 * surface that to the person using the app, so the page must listen.
 */

/** @typedef {{message:string, problems:string[]}} PrecacheFailure */

/**
 * Subscribe to `precache-error` messages from a ServiceWorkerContainer.
 * @param {EventTarget} serviceWorker the container (`navigator.serviceWorker`)
 * @param {(failure: PrecacheFailure) => void} onError
 * @returns {() => void} unsubscribe
 */
export function watchPrecacheErrors(serviceWorker, onError) {
  const listener = (event) => {
    const data = event?.data;
    if (data?.type !== 'precache-error') return;
    onError({
      message: String(data.message ?? 'Precache failed'),
      problems: Array.isArray(data.problems) ? data.problems.map(String) : [],
    });
  };
  serviceWorker.addEventListener('message', listener);
  return () => serviceWorker.removeEventListener('message', listener);
}

/**
 * The page's one reaction to a failed precache install: one error line in the
 * diagnostics log and one visible toast, both injected by the caller. Without
 * this a failed install is invisible until the next offline start.
 *
 * @param {EventTarget} serviceWorker the container (`navigator.serviceWorker`)
 * @param {{log:{error:Function}, toast:Function}} sinks page-owned reporters
 * @returns {() => void} unsubscribe
 */
export function registerPrecacheErrors(serviceWorker, { log, toast }) {
  return watchPrecacheErrors(serviceWorker, ({ message, problems }) => {
    log.error('precache install failed', { message, problems });
    toast(message, { tone: 'error' });
  });
}

/**
 * The one boot boundary for the offline shell.
 *
 * A browser without service workers and the Android shell's WebView must do
 * neither step: they have no worker to register and no install to report. The
 * boundary lives here rather than in `main.js` so a caller that skips it is a
 * test failure, not an invisible regression.
 *
 * @param {{serviceWorker?: object|null, isAndroidShell?: boolean,
 *          addWindowListener: Function, log: object, toast: Function}} options
 * @returns {boolean} whether this boot registered the offline shell
 */
export function bootOfflineShell({ serviceWorker = null, isAndroidShell = false, addWindowListener, log, toast }) {
  if (!serviceWorker || isAndroidShell) return false;
  registerPrecacheErrors(serviceWorker, { log, toast });
  addWindowListener('load', () => {
    // Bypass the HTTP cache for the worker and its imported manifest so a
    // deploy is picked up even behind an aggressively caching static host.
    serviceWorker.register('sw.js', { updateViaCache: 'none' }).catch((error) => log.warn('service worker failed', { message: error.message }));
  });
  return true;
}
