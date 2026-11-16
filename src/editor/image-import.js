/** Image import: file picker + decode, returns a data URL ready for the doc. */

import { preloadImage } from '../label/images.js';

function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('That file could not be read'));
    reader.readAsDataURL(file);
  });
}

/**
 * Resolves with the decoded image, or null when the picker was dismissed.
 * Rejects when the file cannot be read or decoded; `preloadImage` owns the
 * "decoded bitmap must have pixels" check (naturalWidth/naturalHeight > 0).
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
        const src = await readAsDataUrl(file);
        const image = await preloadImage(src);
        resolve({ src, width: image.naturalWidth, height: image.naturalHeight, name: file.name });
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
