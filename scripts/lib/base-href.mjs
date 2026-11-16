/**
 * One `<base href>` for the offline shell.
 *
 * The worker answers an in-scope navigation with the cached app shell, but the
 * document URL stays at the deep path. Every relative URL in the shell
 * (`assets/app.css`, `src/main.js`, the vendored script) then resolves under
 * that path and 404s, so a controlled page at
 * `/drypoint/library/deep/path#/label/x` renders unstyled HTML with no layers.
 *
 * Injecting one base element fixes every relative URL at once, without giving
 * the staged Pages build a different document or changing its precache digest.
 * The function is stamped into `sw.js` by `scripts/precache.mjs` (a classic
 * script cannot import it), so this file is the one owner and the only place to
 * change the rule.
 */

/**
 * Insert one `<base href="scope">` into an HTML document.
 *
 * The tag goes immediately after `<head>` so it applies to every later URL.
 * A document that already carries a base is left alone (it owns its own
 * resolution), and a document without a head is returned unchanged: adding a
 * base outside the head has no effect, so it would only hide the problem.
 *
 * @param {string} html the document text
 * @param {string} scope the registration scope, e.g. `https://host/drypoint/`
 * @returns {string} the rewritten document, or the input when nothing applies
 */
export function injectBase(html, scope) {
  if (typeof html !== 'string' || !html) return html;
  if (typeof scope !== 'string' || !scope) return html;
  if (/<base\b/i.test(html)) return html;
  const head = /<head\b[^>]*>/i.exec(html);
  if (!head) return html;
  const href = scope.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  const at = head.index + head[0].length;
  return `${html.slice(0, at)}<base href="${href}">${html.slice(at)}`;
}
