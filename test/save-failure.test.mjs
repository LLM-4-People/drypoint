/**
 * R8-5 / save-failure owner: the notice is driven by a real throwing store, not
 * by a source grep. A dismissed notice must not suppress the next failure, and
 * a successful write must clear it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { installDom } from './helpers/fake-dom.mjs';

const dom = installDom();
const { el } = await import('../src/core/dom.js');
const host = el('div', { id: 'toasts' });
dom.body.append(host);

const { createStore } = await import('../src/core/store.js');
const { createSaveFailureNotice, SAVE_FAILURE_MESSAGE } = await import('../src/ui/save-failure.js');

let failing = true;
const values = new Map();
globalThis.localStorage = {
  getItem: (key) => values.get(key) ?? null,
  setItem(key, value) {
    if (failing) throw Object.assign(new Error('The quota has been exceeded.'), { name: 'QuotaExceededError' });
    values.set(key, value);
  },
};

const tick = () => new Promise((resolve) => setImmediate(resolve));

/** A real store wired to the real owner, exactly as main.js wires it. */
function harness(t) {
  host.textContent = '';
  failing = true;
  const notice = createSaveFailureNotice();
  const store = createStore(
    { value: 0 },
    {
      key: 'drypoint.test.save-failure',
      onError: (error, phase) => {
        if (phase === 'persist') notice.report(error);
      },
      onPersist: notice.clear,
    }
  );
  t.after(() => {
    notice.clear();
    host.textContent = '';
    values.clear();
  });
  return { notice, store };
}

const notices = () => [...host.querySelectorAll('.toast')].filter((node) => node.textContent.includes(SAVE_FAILURE_MESSAGE));

test('a real quota failure shows one persistent notice, and a successful write clears it', async (t) => {
  const { store } = harness(t);
  store.set({ value: 1 });
  store.flush();
  assert.equal(notices().length, 1, 'the failure is reported once');

  // A second failure while the notice is up is the same condition: no duplicate.
  store.set({ value: 2 });
  store.flush();
  assert.equal(notices().length, 1, 'the recurring failure stays deduplicated');

  failing = false;
  store.set({ value: 3 });
  store.flush();
  await tick();
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(notices().length, 0, 'the next successful write removes the notice');
  assert.equal(values.has('drypoint.test.save-failure'), true, 'the write actually reached storage');
});

test('dismissing the notice does not suppress the next failure', async (t) => {
  const { store } = harness(t);
  store.set({ value: 1 });
  store.flush();
  const first = notices()[0];
  assert.ok(first, 'the failure is visible');

  first.dispatch('click');
  // A second failure after the dismissal must open a new notice; the stale
  // remover used to keep the guard forever.
  store.set({ value: 2 });
  store.flush();
  assert.equal(notices().length, 2, 'a new notice is created after the dismissal');

  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(notices().length, 1, 'the dismissed node is gone and the new one stays');
});
