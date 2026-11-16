/**
 * The one writer for the action bar's status line.
 *
 * A toned status ("Saved", a job outcome, a chosen device line) is transient:
 * it holds for `holdMs` and then falls back to the live connection state. An
 * untoned status is a fact that stands until something replaces it (an idle
 * disconnect says "Disconnected" and must not be wiped by a timer left over
 * from an earlier message), so writing one cancels any pending revert.
 *
 * `schedule`/`cancel` are injectable so the hold and the cancellation are
 * tested on a fake clock instead of with a real timer.
 */
export function createStatusLine({ element, connected = () => false, holdMs, schedule = setTimeout, cancel = clearTimeout }) {
  let timer = 0;
  /**
   * @param {string} text
   * @param {string} [tone] non-empty for a transient status
   */
  function write(text, tone = '') {
    element.textContent = text;
    element.dataset.tone = tone;
    cancel(timer);
    timer = 0;
    if (!tone) return;
    timer = schedule(() => {
      timer = 0;
      element.textContent = connected() ? 'Ready' : '';
      element.dataset.tone = '';
    }, holdMs);
  }
  return { write, stop: () => cancel(timer) };
}
