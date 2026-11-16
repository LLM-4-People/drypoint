/**
 * The page is the theme owner; everything that renders the theme follows it.
 *
 * The AppBar background lives in CSS (`--bg`) and the Android shell's status and
 * navigation bars cannot read CSS, so the same pass that switches the CSS theme
 * reads the resulting token and hands it to the bridge. One decision, one source
 * of the colour: no generated native colour resource can drift.
 */

/**
 * @param {object} options
 * @param {'light'|'dark'|'auto'} options.theme stored appearance setting
 * @param {boolean} [options.prefersDark] `prefers-color-scheme: dark`
 * @param {object} options.root document element
 * @param {object|null} [options.meta] the `theme-color` meta tag
 * @param {{setSystemBars?: Function}|null} [options.bridge] native shell bridge
 * @param {Function} [options.computedStyle] `getComputedStyle` (injectable)
 * @returns {{dark:boolean, background:string}}
 */
export function applyTheme({
  theme,
  prefersDark = false,
  root,
  meta = null,
  bridge = null,
  computedStyle = globalThis.getComputedStyle,
  requestFrame = globalThis.requestAnimationFrame,
}) {
  // Flipping data-theme starts every CSS colour transition at once; the
  // intermediate frame can flash a low-contrast colour (the device pill went
  // 1.01:1 for ~140 ms at boot). Suppress transitions on the root and its
  // descendants until the new theme has painted two frames.
  const dark = theme === 'dark' || (theme === 'auto' && prefersDark);
  root.classList?.add?.('theme-switching');
  try {
    if (dark) root.removeAttribute('data-theme');
    else root.dataset.theme = 'light';
  } finally {
    const done = () => root.classList?.remove?.('theme-switching');
    if (typeof requestFrame === 'function') requestFrame(() => requestFrame(done));
    else done();
  }
  // Read the token after the attribute switch: the light theme overrides --bg.
  const background = computedStyle?.(root)?.getPropertyValue('--bg')?.trim() ?? '';
  if (meta && background) meta.setAttribute('content', background);
  if (background && typeof bridge?.setSystemBars === 'function') bridge.setSystemBars(background);
  return { dark, background };
}
