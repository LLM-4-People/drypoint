/** Image import: file picker + decode, returns a data URL ready for the doc. */

import { CONFIG } from '../core/config.js';
import { preloadImage } from '../label/images.js';

const limitMb = (CONFIG.image.maxFileBytes / (1024 * 1024)).toFixed(1);

function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('That file could not be read'));
    reader.readAsDataURL(file);
  });
}

/**
 * Read and decode one picked file. The size check is first: the data URL is
 * base64 (4 characters per 3 bytes), and `CONFIG.bounds.maxSrcChars` would
 * otherwise reject the source only after a 50 MB file had become a 67 MB
 * string and a full bitmap. `read` and `decode` are injectable for the tests.
 *
 * @returns {Promise<{src:string,width:number,height:number,name:string}>}
 */
export async function importImageFile(file, { read = readAsDataUrl, decode = preloadImage } = {}) {
  const size = Number(file?.size);
  if (!Number.isFinite(size) || size < 0) throw new Error('That file could not be read');
  if (size > CONFIG.image.maxFileBytes) {
    throw new Error(`That image is too large. Images are limited to ${limitMb} MB so the label stays printable.`);
  }
  const src = await read(file);
  const image = await decode(src);
  return { src, width: image.naturalWidth, height: image.naturalHeight, name: file.name };
}

/**
 * Resolves with the decoded image, or null when the picker was dismissed.
 * Rejects when the file is over the configured size, cannot be read or cannot
 * be decoded; `preloadImage` owns the "decoded bitmap must have pixels" check
 * (naturalWidth/naturalHeight > 0).
 */
export function pickImageFile() {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      if (!file) {
        resolve(null);
        return;
      }
      try {
        resolve(await importImageFile(file));
      } catch (error) {
        reject(error);
      }
    });
    // The native picker can be dismissed without a change event; resolve null
    // so callers do not hang forever.
    input.addEventListener('cancel', () => resolve(null));
    input.click();
  });
}
