/**
 * The one parser for the browser harness's timeout knob.
 *
 * `D110_CHROME_TIMEOUT_MS` bounds two different waits with two different
 * defaults: Chromium's DevTools start and the editor mount. Both read the same
 * environment variable through this function, so the knob cannot drift into two
 * parsers with two validation rules.
 *
 * @param {Record<string, string|undefined>} env
 * @param {number} fallback
 * @returns {number}
 */
export function chromeTimeoutMs(env, fallback) {
  const raw = Number(env?.D110_CHROME_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}
