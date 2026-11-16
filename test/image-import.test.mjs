import test from 'node:test';
import assert from 'node:assert/strict';

import { CONFIG } from '../src/core/config.js';
import { importImageFile, pickImageFile } from '../src/editor/image-import.js';
import { installDom } from './helpers/fake-dom.mjs';

const file = (size) => ({ size, name: 'label.png', type: 'image/png' });

test('a valid file is read and decoded once', async () => {
  const calls = [];
  const result = await importImageFile(file(1234), {
    read: async (picked) => {
      calls.push(picked);
      return 'data:image/png;base64,AAAA';
    },
    decode: async (src) => {
      assert.equal(src, 'data:image/png;base64,AAAA');
      return { naturalWidth: 40, naturalHeight: 30 };
    },
  });
  assert.deepEqual(result, {
    src: 'data:image/png;base64,AAAA',
    width: 40,
    height: 30,
    name: 'label.png',
  });
  assert.equal(calls.length, 1);
});

test('an over-size file is refused before it is read', async () => {
  let reads = 0;
  await assert.rejects(
    importImageFile(file(CONFIG.image.maxFileBytes + 1), {
      read: async () => {
        reads++;
        return 'should not be read';
      },
      decode: async () => ({ naturalWidth: 1, naturalHeight: 1 }),
    }),
    /too large[\s\S]*MB/
  );
  assert.equal(reads, 0, 'readAsDataUrl was never called');
});

test('dismissing the picker resolves null instead of hanging', async () => {
  installDom();
  const create = document.createElement.bind(document);
  let input = null;
  document.createElement = (tag) => {
    const node = create(tag);
    if (String(tag).toLowerCase() === 'input') input = node;
    return node;
  };
  try {
    const picked = pickImageFile();
    assert.ok(input, 'the picker created its file input');
    input.dispatch('cancel');
    assert.equal(await picked, null);
  } finally {
    document.createElement = create;
  }
});
