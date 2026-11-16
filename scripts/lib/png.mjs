/**
 * A minimal PNG codec for the generated raster surface.
 *
 * The generated files are output: the decoder only has to understand the
 * 8-bit truecolour forms Chromium and this project's encoder write, with or
 * without an alpha channel, non-interlaced. Both are normalised to RGBA, so
 * every consumer reads one shape; a different format fails loudly rather than
 * being guessed. One implementation serves the build checks and the tests.
 */

import { deflateSync, inflateSync } from 'node:zlib';

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function requirePng(condition, message) {
  if (!condition) throw new Error(message);
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index++) {
    let value = index;
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const body = Buffer.concat([head, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body.subarray(4)), 0);
  return Buffer.concat([body, crc]);
}

/**
 * Decode an 8-bit RGB or RGBA, non-interlaced PNG. The result is always RGBA:
 * an RGB source gets an opaque alpha byte, so a consumer never has two pixel
 * layouts to handle.
 * @param {Buffer} bytes
 * @returns {{width:number, height:number, bitDepth:number, colorType:number, data:Buffer}}
 */
export function decodePng(bytes) {
  requirePng(Buffer.isBuffer(bytes) || bytes instanceof Uint8Array, 'a PNG is bytes');
  const buffer = Buffer.from(bytes);
  requirePng(buffer.length >= 33, 'a PNG has a signature and a header');
  requirePng(
    SIGNATURE.every((value, index) => buffer[index] === value),
    'a PNG signature'
  );
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  const bitDepth = buffer[24];
  const colorType = buffer[25];
  const interlace = buffer[28];
  requirePng(width > 0 && height > 0, 'a PNG with pixels');
  requirePng(bitDepth === 8, 'an 8-bit PNG');
  requirePng(colorType === 6 || colorType === 2, 'truecolour with or without alpha (RGB or RGBA)');
  requirePng(interlace === 0, 'not interlaced');

  const chunks = [];
  for (let offset = 8; offset < buffer.length; ) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('latin1', offset + 4, offset + 8);
    requirePng(offset + 12 + length <= buffer.length, 'a complete PNG chunk');
    if (type === 'IDAT') chunks.push(buffer.subarray(offset + 8, offset + 8 + length));
    offset += 12 + length;
    if (type === 'IEND') break;
  }
  requirePng(chunks.length > 0, 'PNG image data');
  const raw = inflateSync(Buffer.concat(chunks));
  const bytesPerPixel = colorType === 6 ? 4 : 3;
  const rawStride = width * bytesPerPixel;
  const stride = width * 4;
  requirePng(raw.length >= height * (rawStride + 1), 'as many PNG rows as the header declares');
  const data = Buffer.alloc(height * stride);
  const paeth = (a, b, c) => {
    const p = a + b - c;
    const pa = Math.abs(p - a);
    const pb = Math.abs(p - b);
    const pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };
  let previous = null;
  for (let row = 0; row < height; row++) {
    const filter = raw[row * (rawStride + 1)];
    const line = raw.subarray(row * (rawStride + 1) + 1, (row + 1) * (rawStride + 1));
    // Filtering runs on the encoded channel layout, before any expansion.
    const current = Buffer.alloc(rawStride);
    for (let column = 0; column < rawStride; column++) {
      const left = column >= bytesPerPixel ? current[column - bytesPerPixel] : 0;
      const up = previous ? previous[column] : 0;
      const upLeft = previous && column >= bytesPerPixel ? previous[column - bytesPerPixel] : 0;
      const value = line[column];
      const unfiltered =
        filter === 0
          ? value
          : filter === 1
            ? value + left
            : filter === 2
              ? value + up
              : filter === 3
                ? value + ((left + up) >> 1)
                : value + paeth(left, up, upLeft);
      current[column] = unfiltered & 0xff;
    }
    for (let pixel = 0; pixel < width; pixel++) {
      const at = row * stride + pixel * 4;
      const from = pixel * bytesPerPixel;
      data[at] = current[from];
      data[at + 1] = current[from + 1];
      data[at + 2] = current[from + 2];
      data[at + 3] = bytesPerPixel === 4 ? current[from + 3] : 255;
    }
    previous = current;
  }
  return { width, height, bitDepth, colorType, data };
}

/**
 * Encode an 8-bit RGBA image. Filter 0 on every row and one deterministic
 * zlib stream: the same pixels always produce the same bytes.
 * @param {{width:number, height:number, data:Buffer, software?:string}} image
 * @returns {Buffer}
 */
export function encodePng({ width, height, data, software = '' }) {
  requirePng(Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0, 'a positive image size');
  const stride = width * 4;
  requirePng(data.length === height * stride, 'one RGBA row per image row');
  const raw = Buffer.alloc(height * (stride + 1));
  for (let row = 0; row < height; row++) {
    raw[row * (stride + 1)] = 0;
    data.copy(raw, row * (stride + 1) + 1, row * stride, (row + 1) * stride);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  header[10] = 0; // deflate
  header[11] = 0; // adaptive filtering
  header[12] = 0; // no interlace
  const parts = [Buffer.from(SIGNATURE), chunk('IHDR', header)];
  if (software) parts.push(chunk('tEXt', Buffer.from(`Software\u0000${software}`, 'latin1')));
  parts.push(chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(parts);
}

/** One RGBA pixel. */
export function pixelAt(image, x, y) {
  const at = (y * image.width + x) * 4;
  return { r: image.data[at], g: image.data[at + 1], b: image.data[at + 2], a: image.data[at + 3] };
}

/**
 * Composite an RGBA image onto one opaque colour.
 * @param {{width:number, height:number, data:Buffer}} image
 * @param {{r:number, g:number, b:number}} background
 * @returns {{width:number, height:number, data:Buffer}}
 */
export function flattenOnto(image, background) {
  const data = Buffer.from(image.data);
  for (let at = 0; at < data.length; at += 4) {
    const alpha = data[at + 3];
    const mix = (foreground, behind) => Math.round((foreground * alpha + behind * (255 - alpha)) / 255);
    data[at] = mix(data[at], background.r);
    data[at + 1] = mix(data[at + 1], background.g);
    data[at + 2] = mix(data[at + 2], background.b);
    data[at + 3] = 255;
  }
  return { width: image.width, height: image.height, data };
}
