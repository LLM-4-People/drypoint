/**
 * Minimal DOM used by tests that exercise canvas and UI modules in Node.
 *
 * It implements only the surface those modules touch: an element tree,
 * attributes, listeners, focus, the handful of selectors the layer panel uses,
 * and a recording 2D canvas context. It is test scaffolding, not a browser.
 */

function classNames(node) {
  return String(node.className ?? '')
    .split(/\s+/)
    .filter(Boolean);
}

/** Split a selector list on top-level commas (brackets and parens nest). */
function splitSelectors(selector) {
  const parts = [];
  let depth = 0;
  let current = '';
  for (const char of String(selector)) {
    if (char === '[' || char === '(') depth++;
    else if (char === ']' || char === ')') depth--;
    if (char === ',' && depth === 0) {
      if (current.trim()) parts.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

function matchesCompound(node, compound) {
  let text = String(compound).trim();
  // The app only uses a trailing :not(...) (e.g. button:not([disabled])).
  const negation = text.match(/:not\((.*)\)$/);
  if (negation) {
    text = text.slice(0, negation.index);
    if (matches(node, negation[1])) return false;
  }
  if (!text) return true;
  return text
    .split(/(?=[.#[])/)
    .map((part) => part.trim())
    .filter(Boolean)
    .every((part) => {
      if (part.startsWith('.')) return classNames(node).includes(part.slice(1));
      if (part.startsWith('#')) return node.id === part.slice(1);
      if (part.startsWith('[')) {
        const match = part.match(/^\[([^=\]]+)(?:="([^"]*)")?\]$/);
        if (!match) return false;
        return match[2] === undefined ? node.hasAttribute(match[1]) : node.getAttribute(match[1]) === match[2];
      }
      return node.tagName === part.toUpperCase();
    });
}

/** Match the selectors used by the app: tag, .class, #id, [attr], :not(...), lists. */
function matches(node, selector) {
  if (!node || node.nodeType !== 1) return false;
  return splitSelectors(selector).some((compound) => matchesCompound(node, compound));
}

export class FakeElement {
  constructor(tagName, nodeType = 1) {
    this.tagName = nodeType === 1 ? String(tagName).toUpperCase() : '#TEXT';
    this.nodeType = nodeType;
    this.children = [];
    this.parentNode = null;
    this.attributes = new Map();
    this.dataset = {};
    this.style = {};
    this.className = '';
    this.id = '';
    this.type = '';
    this.value = '';
    this.min = '';
    this.max = '';
    this.step = '';
    this.placeholder = '';
    this.title = '';
    this.rows = 0;
    this.spellcheck = true;
    this.inputMode = '';
    this.accept = '';
    this.files = null;
    this.href = '';
    this.download = '';
    this.checked = false;
    this.disabled = false;
    this.hidden = false;
    this.selectionStart = 0;
    this.selectionEnd = 0;
    this.selectionDirection = 'none';
    this._text = '';
    this.listeners = new Map();
  }

  get textContent() {
    // Like the real DOM: child text nodes contribute to the value.
    if (this.children.length) return this.children.map((child) => child.textContent).join('');
    return this._text;
  }

  /** Like the real DOM: assigning text replaces every child node. */
  set textContent(value) {
    this._text = String(value);
    for (const child of this.children) child.parentNode = null;
    this.children = [];
  }

  get childElementCount() {
    return this.children.filter((child) => child.nodeType === 1).length;
  }

  get lastChild() {
    return this.children.at(-1) ?? null;
  }

  append(...nodes) {
    for (const node of nodes) this.appendChild(node);
  }

  prepend(...nodes) {
    for (const node of nodes.reverse()) this.insertBefore(node, this.children[0] ?? null);
  }

  appendChild(node) {
    if (node.parentNode) node.parentNode.removeChild(node);
    node.parentNode = this;
    this.children.push(node);
    return node;
  }

  insertBefore(node, reference) {
    if (node.parentNode) node.parentNode.removeChild(node);
    const index = reference ? this.children.indexOf(reference) : -1;
    node.parentNode = this;
    if (index < 0) this.children.push(node);
    else this.children.splice(index, 0, node);
    return node;
  }

  before(...nodes) {
    if (!this.parentNode) return;
    for (const node of nodes) this.parentNode.insertBefore(node, this);
  }

  after(...nodes) {
    if (!this.parentNode) return;
    const reference = this.nextSibling;
    for (const node of nodes) this.parentNode.insertBefore(node, reference);
  }

  get nextSibling() {
    const siblings = this.parentNode?.children ?? [];
    const index = siblings.indexOf(this);
    return index >= 0 ? (siblings[index + 1] ?? null) : null;
  }

  get previousElementSibling() {
    const siblings = (this.parentNode?.children ?? []).filter((child) => child.nodeType === 1);
    const index = siblings.indexOf(this);
    return index > 0 ? siblings[index - 1] : null;
  }

  get firstElementChild() {
    return this.children.find((child) => child.nodeType === 1) ?? null;
  }

  removeChild(node) {
    const index = this.children.indexOf(node);
    if (index >= 0) this.children.splice(index, 1);
    node.parentNode = null;
    // Real browsers move focus to the body when the focused subtree leaves
    // the document. Model it so focus-restoration tests are not false passes.
    if (node.contains?.(globalThis.document?.activeElement)) globalThis.document.activeElement = null;
    return node;
  }

  remove() {
    this.parentNode?.removeChild(this);
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
    if (name === 'id') this.id = String(value);
    if (name.startsWith('data-')) this.dataset[name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = String(value);
  }

  /** dataset writes attributes in the real DOM, so selectors must see them. */
  datasetValue(name) {
    const key = name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    return Object.prototype.hasOwnProperty.call(this.dataset, key) ? String(this.dataset[key]) : undefined;
  }

  getAttribute(name) {
    if (name.startsWith('data-')) {
      const value = this.datasetValue(name);
      return value === undefined ? null : value;
    }
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }

  hasAttribute(name) {
    if (name.startsWith('data-')) return this.datasetValue(name) !== undefined;
    return this.attributes.has(name);
  }

  removeAttribute(name) {
    this.attributes.delete(name);
  }

  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(handler);
  }

  removeEventListener(type, handler) {
    this.listeners.get(type)?.delete(handler);
  }

  /** Test helper: run every listener for a type with a minimal event. */
  dispatch(type, event = {}) {
    const base = {
      type,
      target: this,
      currentTarget: this,
      defaultPrevented: false,
      stopPropagation() {},
      preventDefault() {
        this.defaultPrevented = true;
      },
    };
    const merged = { ...base, ...event };
    for (const handler of this.listeners.get(type) ?? []) handler(merged);
    return merged;
  }

  /** Like a real HTMLElement: programmatic activation. */
  click() {
    return this.dispatch('click');
  }

  /**
   * Test scaffolding for CSS `display`: a resolver can model a real rule such
   * as "the action strip is display:none until the row is focused". A node the
   * browser would not lay out cannot take focus.
   */
  static displayResolver = null;

  setSelectionRange(start, end = start, direction = 'none') {
    this.selectionStart = start;
    this.selectionEnd = end;
    this.selectionDirection = direction;
  }

  focus() {
    if (FakeElement.displayResolver?.(this) === 'none') return;
    const wasActive = globalThis.document.activeElement === this;
    globalThis.document.activeElement = this;
    globalThis.document.focusLog?.push(this);
    // A newly focused text control puts the caret at the end; that is exactly
    // what a reparent would lose without movePreservingFocus's restore.
    if (!wasActive && (this.tagName === 'INPUT' || this.tagName === 'TEXTAREA')) {
      const end = String(this.value ?? '').length;
      this.selectionStart = end;
      this.selectionEnd = end;
      this.selectionDirection = 'none';
    }
  }

  blur() {
    if (globalThis.document.activeElement === this) globalThis.document.activeElement = null;
  }

  /** The dialog focus trap only counts nodes that are laid out. */
  getClientRects() {
    return [{ width: 1, height: 1 }];
  }

  contains(node) {
    if (!node) return false;
    return node === this || this.children.some((child) => child.contains?.(node));
  }

  closest(selector) {
    let node = this;
    while (node) {
      if (matches(node, selector)) return node;
      node = node.parentNode;
    }
    return null;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  querySelectorAll(selector) {
    const found = [];
    const walk = (node) => {
      for (const child of node.children) {
        if (matches(child, selector)) found.push(child);
        walk(child);
      }
    };
    walk(this);
    return found;
  }
}

export class FakeImageData {
  constructor(width, height) {
    this.width = width;
    this.height = height;
    this.data = new Uint8ClampedArray(width * height * 4);
  }
}

export class FakeContext {
  constructor(canvas) {
    this.canvas = canvas;
    this.ops = [];
    this.font = '';
    this.textAlign = 'start';
    this.textBaseline = 'alphabetic';
    this.fillStyle = '#000000';
    this.strokeStyle = '#000000';
    this.lineWidth = 1;
    this.imageSmoothingEnabled = true;
  }

  record(op) {
    this.ops.push(op);
  }

  save() {
    this.record({ op: 'save' });
  }

  restore() {
    this.record({ op: 'restore' });
  }

  translate(x, y) {
    this.record({ op: 'translate', x, y });
  }

  rotate(angle) {
    this.record({ op: 'rotate', angle });
  }

  beginPath() {
    this.record({ op: 'beginPath' });
  }

  rect(x, y, w, h) {
    this.record({ op: 'rect', x, y, w, h });
  }

  roundRect(x, y, w, h, radius) {
    this.record({ op: 'roundRect', x, y, w, h, radius });
  }

  clip() {
    this.record({ op: 'clip' });
  }

  fillRect(x, y, w, h) {
    this.record({ op: 'fillRect', x, y, w, h, fillStyle: this.fillStyle });
  }

  fillText(text, x, y) {
    this.record({ op: 'fillText', text, x, y, font: this.font, textAlign: this.textAlign });
  }

  drawImage(image, x, y, w, h) {
    this.record({ op: 'drawImage', image, x, y, w, h });
  }

  fill() {
    this.record({ op: 'fill', fillStyle: this.fillStyle });
  }

  stroke() {
    this.record({ op: 'stroke', lineWidth: this.lineWidth });
  }

  getImageData(x, y, w, h) {
    return new FakeImageData(w, h);
  }

  clearRect(x, y, w, h) {
    this.record({ op: 'clearRect', x, y, w, h });
  }

  strokeRect(x, y, w, h) {
    this.record({ op: 'strokeRect', x, y, w, h });
  }

  setTransform(a, b, c, d, e, f) {
    this.record({ op: 'setTransform', a, b, c, d, e, f });
  }

  setLineDash(dash) {
    this.record({ op: 'setLineDash', dash });
  }

  measureText(text) {
    const match = /(\d+(?:\.\d+)?)px/.exec(this.font);
    const size = match ? Number(match[1]) : 10;
    return { width: String(text ?? '').length * size * 0.55 };
  }

  putImageData(data, x, y) {
    this.record({ op: 'putImageData', data, x, y });
  }
}

export class FakeCanvas extends FakeElement {
  constructor() {
    super('canvas');
    this.width = 300;
    this.height = 150;
    this.context = null;
    this.capturedPointers = new Set();
  }

  getContext() {
    this.context ??= new FakeContext(this);
    return this.context;
  }

  /** CSS size, so pointer coordinates match the laid-out canvas. */
  getBoundingClientRect() {
    const width = Number.parseFloat(this.style.width) || this.width;
    const height = Number.parseFloat(this.style.height) || this.height;
    return { left: 0, top: 0, width, height, right: width, bottom: height };
  }

  setPointerCapture(pointerId) {
    this.capturedPointers.add(pointerId);
  }

  hasPointerCapture(pointerId) {
    return this.capturedPointers.has(pointerId);
  }

  releasePointerCapture(pointerId) {
    this.capturedPointers.delete(pointerId);
  }
}

/** Model one CSS display rule for focus tests; null restores real-sounding behaviour. */
export function setDisplayResolver(resolver) {
  FakeElement.displayResolver = resolver;
}

/**
 * Install the fake DOM and the globals the canvas/dither code expects.
 * @returns the fake document so tests can read activeElement.
 */
export function installDom() {
  const body = new FakeElement('body');
  const documentElement = new FakeElement('html');
  const created = [];
  const documentListeners = new Map();
  const dispatchTo = (listeners, type, event) => {
    const base = {
      type,
      target: null,
      currentTarget: null,
      defaultPrevented: false,
      preventDefault() {
        this.defaultPrevented = true;
      },
      stopPropagation() {},
      ...event,
    };
    for (const handler of [...(listeners.get(type) ?? [])]) handler(base);
    return base;
  };
  const doc = {
    activeElement: null,
    body,
    documentElement,
    created,
    /** Every successful focus() call, in order; tests assert move/restore order. */
    focusLog: [],
    createElement(tag) {
      const node = String(tag).toLowerCase() === 'canvas' ? new FakeCanvas() : new FakeElement(tag);
      created.push(node);
      return node;
    },
    createElementNS(_namespace, tag) {
      const node = new FakeElement(tag);
      created.push(node);
      return node;
    },
    createTextNode(text) {
      const node = new FakeElement('#text', 3);
      node.textContent = String(text);
      created.push(node);
      return node;
    },
    addEventListener(type, handler) {
      if (!documentListeners.has(type)) documentListeners.set(type, new Set());
      documentListeners.get(type).add(handler);
    },
    removeEventListener(type, handler) {
      documentListeners.get(type)?.delete(handler);
    },
    /** Test helper: dispatch a document-level event. */
    dispatch(type, event = {}) {
      return dispatchTo(documentListeners, type, { target: doc, currentTarget: doc, ...event });
    },
    querySelector(selector) {
      return body.querySelector(selector);
    },
    querySelectorAll(selector) {
      return body.querySelectorAll(selector);
    },
  };
  const windowListeners = new Map();
  const fakeWindow = globalThis.window ?? {};
  fakeWindow.addEventListener = (type, handler) => {
    if (!windowListeners.has(type)) windowListeners.set(type, new Set());
    windowListeners.get(type).add(handler);
  };
  fakeWindow.removeEventListener = (type, handler) => {
    windowListeners.get(type)?.delete(handler);
  };
  fakeWindow.dispatch = (type, event = {}) => dispatchTo(windowListeners, type, { target: fakeWindow, currentTarget: fakeWindow, ...event });
  globalThis.window = fakeWindow;
  globalThis.document = doc;
  globalThis.Node = FakeElement;
  globalThis.ImageData = FakeImageData;
  // The canvas reads its accent from a CSS custom property. Tests can override
  // this global; the default resolves inline styles and otherwise returns ''.
  globalThis.getComputedStyle ??= (node) => ({
    getPropertyValue: (name) => node?.style?.[name] ?? '',
    maxHeight: node?.style?.maxHeight ?? '',
  });
  return doc;
}
