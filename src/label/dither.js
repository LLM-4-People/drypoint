/**
 * Continuous-tone to 1-bit conversion. Pure functions over an RGBA buffer so
 * they can be unit-tested without a DOM.
 */

export const DITHER = Object.freeze({
  THRESHOLD: 'threshold',
  FLOYD: 'floyd',
  ATKINSON: 'atkinson',
});

/** Perceptual luminance of an RGBA pixel; transparent pixels read as white. */
export function luminanceAt(data, index) {
  const alpha = data[index + 3];
  if (alpha < 8) return 255;
  return 0.299 * data[index] + 0.587 * data[index + 1] + 0.114 * data[index + 2];
}

export function toGray(imageData) {
  const { data, width, height } = imageData;
  const gray = new Float32Array(width * height);
  for (let i = 0, p = 0; i < gray.length; i++, p += 4) gray[i] = luminanceAt(data, p);
  return gray;
}

/** Simple threshold: keeps antialiased text crisp. */
export function thresholdGray(gray, threshold) {
  const out = new Uint8Array(gray.length);
  for (let i = 0; i < gray.length; i++) out[i] = gray[i] < threshold ? 0 : 255;
  return out;
}

/** Floyd–Steinberg error diffusion. */
export function floydSteinberg(gray, width, height, threshold) {
  const buffer = Float32Array.from(gray);
  const out = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const old = buffer[i];
      const value = old < threshold ? 0 : 255;
      out[i] = value;
      const error = old - value;
      if (x + 1 < width) buffer[i + 1] += (error * 7) / 16;
      if (y + 1 < height) {
        if (x > 0) buffer[i + width - 1] += (error * 3) / 16;
        buffer[i + width] += (error * 5) / 16;
        if (x + 1 < width) buffer[i + width + 1] += (error * 1) / 16;
      }
    }
  }
  return out;
}

/** Atkinson error diffusion: lighter, softer, popular for thermal printers. */
export function atkinson(gray, width, height, threshold) {
  const buffer = Float32Array.from(gray);
  const out = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const old = buffer[i];
      const value = old < threshold ? 0 : 255;
      out[i] = value;
      const error = (old - value) / 8;
      if (x + 1 < width) buffer[i + 1] += error;
      if (x + 2 < width) buffer[i + 2] += error;
      if (y + 1 < height) {
        if (x > 0) buffer[i + width - 1] += error;
        buffer[i + width] += error;
        if (x + 1 < width) buffer[i + width + 1] += error;
      }
      if (y + 2 < height) buffer[i + width * 2] += error;
    }
  }
  return out;
}

/**
 * Convert a glyph canvas to a hard alpha mask: every pixel at or above the cut
 * becomes solid black ink, everything else becomes fully transparent. Luminance
 * is deliberately ignored so colour emoji (whose RGB is bright) still print as
 * solid silhouettes instead of vanishing.
 */
export function alphaMask(imageData, cut = 128) {
  const { data } = imageData;
  for (let p = 0; p < data.length; p += 4) {
    const ink = data[p + 3] >= cut;
    data[p] = 0;
    data[p + 1] = 0;
    data[p + 2] = 0;
    data[p + 3] = ink ? 255 : 0;
  }
  return imageData;
}

/**
 * @param {ImageData} imageData
 * @param {'threshold'|'floyd'|'atkinson'} mode
 * @param {number} threshold 0–255
 * @returns {ImageData} black/white pixels, alpha preserved as opaque
 */
export function ditherImageData(imageData, mode, threshold = 150) {
  const { width, height } = imageData;
  const gray = toGray(imageData);
  const bits =
    mode === DITHER.FLOYD
      ? floydSteinberg(gray, width, height, threshold)
      : mode === DITHER.ATKINSON
        ? atkinson(gray, width, height, threshold)
        : thresholdGray(gray, threshold);

  const out = new ImageData(width, height);
  for (let i = 0, p = 0; i < bits.length; i++, p += 4) {
    const value = bits[i];
    out.data[p] = value;
    out.data[p + 1] = value;
    out.data[p + 2] = value;
    out.data[p + 3] = 255;
  }
  return out;
}
