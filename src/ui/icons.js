/** Inline icon set. One owner for icon paths; every UI module uses icon(). */

const NS = 'http://www.w3.org/2000/svg';

const PATHS = {
  text: 'M5 5h14M12 5v14',
  qr: 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h2v2h-2zM18 14h2v2h-2zM14 18h2v2h-2zM18 18h2v2h-2z',
  barcode: 'M4 6v12M7 6v12M10 6v9M13 6v12M16 6v9M19 6v12',
  image: 'M4 5h16v14H4zM4 15l4-4 4 4 3-3 5 5',
  rect: 'M4 6h16v12H4z',
  undo: 'M9 7H4v5M4 12a8 8 0 1 0 3-6',
  redo: 'M15 7h5v5M20 12a8 8 0 1 1-3-6',
  trash: 'M4 7h16M9 7V5h6v2M7 7l1 13h8l1-13',
  copy: 'M9 9h11v11H9zM5 15V4h11',
  eye: 'M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6zM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z',
  eyeOff: 'M3 3l18 18M10.6 10.6a2 2 0 0 0 2.8 2.8M6.2 6.2C3.6 8 2 12 2 12s3.5 6 10 6c1.6 0 3-.4 4.2-1M9.9 5.2A9.6 9.6 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3 3.7',
  lock: 'M6 11h12v9H6zM9 11V8a3 3 0 0 1 6 0v3',
  unlock: 'M6 11h12v9H6zM9 11V8a3 3 0 0 1 5.6-1.5',
  up: 'M12 19V5M6 11l6-6 6 6',
  down: 'M12 5v14M6 13l6 6 6-6',
  printer: 'M7 9V4h10v5M7 17H5a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2h-2M7 14h10v6H7z',
  bluetooth: 'M7 7l10 10-5 4V3l5 4L7 17',
  settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
  x: 'M6 6l12 12M18 6L6 18',
  check: 'M5 13l4 4L19 7',
  refresh: 'M20 11a8 8 0 1 0-2 6M20 5v6h-6',
  download: 'M12 4v10M8 10l4 4 4-4M5 19h14',
  zoomIn: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM16 16l5 5M11 8v6M8 11h6',
  zoomOut: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM16 16l5 5M8 11h6',
  fit: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5',
  rotate: 'M4 9a8 8 0 1 1 2 8M4 4v5h5',
  alignLeft: 'M4 5v14M8 8h9M8 12h6M8 16h9',
  alignCenterH: 'M12 4v16M7 8h10M9 12h6M7 16h10',
  alignRight: 'M20 5v14M7 8h9M10 12h6M7 16h9',
  alignTop: 'M5 4h14M8 8v9M12 8v6M16 8v9',
  alignMiddleV: 'M4 12h16M8 7v10M12 9v6M16 7v10',
  alignBottom: 'M5 20h14M8 7v9M12 10v6M16 7v9',
  plus: 'M12 5v14M5 12h14',
  more: 'M6 12h.01M12 12h.01M18 12h.01',
  chevronDown: 'M6 9l6 6 6-6',
  chevronRight: 'M9 6l6 6-6 6',
  alert: 'M12 4l9 16H3zM12 10v4M12 17v.5',
  info: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 11v5M12 8v.5',
  plug: 'M9 3v6M15 3v6M6 9h12v4a6 6 0 0 1-12 0zM12 19v3',
  battery: 'M3 8h14v8H3zM17 11h3v2h-3',
  tape: 'M4 6h16v9H4zM4 15a3 3 0 1 0 3 3M20 15a3 3 0 1 1-3 3',
  calibrate: 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6zM10 7h4M7 10v4M17 10v4M10 17h4',
  layers: 'M12 3l9 5-9 5-9-5zM3 13l9 5 9-5M3 17l9 5 9-5',
  grid: 'M3 3h18v18H3zM9 3v18M15 3v18M3 9h18M3 15h18',
  wand: 'M4 20l10-10M13 3l1.5 3L18 7.5 14.5 9 13 12l-1.5-3L8 7.5 11.5 6zM19 15l1 2 2 1-2 1-1 2-1-2-2-1 2-1z',
};

export function icon(name, { size = 18, stroke = 1.7 } = {}) {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', String(stroke));
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(NS, 'path');
  path.setAttribute('d', PATHS[name] ?? PATHS.info);
  svg.append(path);
  return svg;
}
