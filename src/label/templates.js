/** Starter templates. Each returns a fresh document (validated on insert). */

import { CONFIG } from '../core/config.js';
import { barcodeMinimumWidth, barcodeModules } from './barcode.js';
import { createDocument, createElement, ELEMENT_TYPES, documentHeightPx, documentWidthPx } from './schema.js';

const pad = CONFIG.geometry.paddingPx;

function base(lengthMm, copies = 1) {
  return createDocument({ lengthMm, copies });
}

function fullText(doc, text, extra = {}) {
  return createElement(ELEMENT_TYPES.TEXT, {
    text,
    x: pad,
    y: pad,
    w: documentWidthPx(doc) - pad * 2,
    h: documentHeightPx(doc) - pad * 2,
    rotation: 0,
    ...extra,
  });
}

export const TEMPLATES = [
  {
    id: 'text',
    label: 'Text',
    build: () => {
      const doc = base(40);
      doc.elements = [fullText(doc, 'Label')];
      return doc;
    },
  },
  {
    id: 'name',
    label: 'Name tag',
    build: () => {
      const doc = base(50);
      doc.elements = [fullText(doc, 'Name\nRole', { bold: true })];
      return doc;
    },
  },
  {
    id: 'qr',
    label: 'QR code',
    build: () => {
      const doc = base(40);
      const size = documentHeightPx(doc) - pad * 2;
      doc.elements = [
        createElement(ELEMENT_TYPES.QR, { value: 'https://', x: pad, y: pad, w: size, h: size }),
        createElement(ELEMENT_TYPES.TEXT, {
          text: 'Scan me',
          x: pad + size + 6,
          y: pad,
          w: documentWidthPx(doc) - size - pad * 3 - 6,
          h: documentHeightPx(doc) - pad * 2,
          fontPx: 18,
        }),
      ];
      return doc;
    },
  },
  {
    id: 'cable',
    label: 'Cable',
    build: () => {
      const doc = base(60);
      // The barcode owner decides the width: symbol modules plus the Code 128
      // quiet zone. The text column takes whatever the label has left.
      const barcode = createElement(ELEMENT_TYPES.BARCODE, { value: 'CBL-001', showText: false });
      const barcodeWidth = barcodeMinimumWidth(barcodeModules(barcode.symbology, barcode.value).length);
      const textWidth = Math.max(CONFIG.geometry.minElementPx, documentWidthPx(doc) - barcodeWidth - pad * 3);
      doc.elements = [
        createElement(ELEMENT_TYPES.TEXT, { text: barcode.value, x: pad, y: pad, w: textWidth, h: documentHeightPx(doc) - pad * 2, bold: true }),
        createElement(ELEMENT_TYPES.BARCODE, {
          value: barcode.value,
          symbology: barcode.symbology,
          x: textWidth + pad * 2,
          y: pad,
          w: documentWidthPx(doc) - textWidth - pad * 3,
          h: documentHeightPx(doc) - pad * 2,
          showText: false,
        }),
      ];
      return doc;
    },
  },
  {
    id: 'frame',
    label: 'Framed',
    build: () => {
      const doc = base(40);
      doc.elements = [
        createElement(ELEMENT_TYPES.RECT, { x: 2, y: 2, w: documentWidthPx(doc) - 4, h: documentHeightPx(doc) - 4, strokePx: 2, radiusPx: 6 }),
        fullText(doc, 'Hello', { x: pad + 4, y: pad + 4, w: documentWidthPx(doc) - pad * 2 - 8, h: documentHeightPx(doc) - pad * 2 - 8, bold: true }),
      ];
      return doc;
    },
  },
  {
    id: 'blank',
    label: 'Blank',
    build: () => {
      const doc = base(40);
      doc.elements = [];
      return doc;
    },
  },
];

/** Calibration label: model, serial tail and a frame. */
export function testDocument(capabilities) {
  const doc = base(40);
  const model = capabilities?.model ?? 'D110';
  const serial = (capabilities?.serial ?? 'TEST').slice(-6);
  doc.elements = [
    createElement(ELEMENT_TYPES.RECT, { x: 2, y: 2, w: documentWidthPx(doc) - 4, h: documentHeightPx(doc) - 4, strokePx: 2, radiusPx: 4 }),
    fullText(doc, `${model}\n${serial}`, { x: pad + 4, y: pad + 4, w: documentWidthPx(doc) - pad * 2 - 8, h: documentHeightPx(doc) - pad * 2 - 8, bold: true }),
  ];
  return doc;
}
