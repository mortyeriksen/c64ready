// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// Just enough DOM for the side-panel and VIBES-button tests to run in Node:
// a tree of elements with attributes, classes, a small selector engine
// (tag, #id, .class, [attr], [attr=v], :scope, ' ' and '>' combinators),
// event listeners with bubbling, innerHTML in both directions, rects the test
// assigns by hand, and the globals the modules reach for (document, window,
// localStorage, getComputedStyle, requestAnimationFrame, matchMedia, the
// three observers). Not a browser: what it does not model, it does not fake.

const VOID = new Set(['br', 'hr', 'img', 'input', 'path', 'circle', 'rect', 'line', 'meta', 'link']);

export class MiniEvent {
  constructor(type, props = {}) {
    Object.assign(this, props);
    this.type = type;
    this.target = props.target ?? null;
    this.defaultPrevented = false;
    this.stopped = false;
    this.stoppedImmediate = false;
  }
  preventDefault() { this.defaultPrevented = true; }
  stopPropagation() { this.stopped = true; }
  stopImmediatePropagation() { this.stopped = true; this.stoppedImmediate = true; }
}

class Listeners {
  constructor() { this._map = new Map(); }
  addEventListener(type, fn) {
    if (!this._map.has(type)) this._map.set(type, []);
    if (!this._map.get(type).includes(fn)) this._map.get(type).push(fn);
  }
  removeEventListener(type, fn) {
    const list = this._map.get(type);
    if (list) { const i = list.indexOf(fn); if (i >= 0) list.splice(i, 1); }
  }
  _invoke(ev) {
    for (const fn of [...(this._map.get(ev.type) ?? [])]) {
      fn.call(this, ev);
      if (ev.stoppedImmediate) break;
    }
  }
  listenerCount(type) { return (this._map.get(type) ?? []).length; }
}

class MiniText {
  constructor(data) { this.nodeType = 3; this.data = String(data); this.parentNode = null; }
  get textContent() { return this.data; }
  cloneNode() { return new MiniText(this.data); }
}

export class MiniElement extends Listeners {
  constructor(doc, tag) {
    super();
    this.ownerDocument = doc;
    this.nodeType = 1;
    this.localName = tag.toLowerCase();
    this.tagName = tag.toUpperCase();
    this.attrs = new Map();
    this.childNodes = [];
    this.parentNode = null;
    this.style = {};
    this.hidden = false;
    // Geometry is whatever the test says it is.
    this._rect = { left: 0, top: 0, width: 0, height: 0 };
    this._display = 'block';
    this.classList = {
      add: (...names) => { const s = this._classes(); for (const n of names) s.add(n); this._setClasses(s); },
      remove: (...names) => { const s = this._classes(); for (const n of names) s.delete(n); this._setClasses(s); },
      contains: (n) => this._classes().has(n),
      toggle: (n, force) => {
        const s = this._classes();
        const on = force === undefined ? !s.has(n) : !!force;
        if (on) s.add(n); else s.delete(n);
        this._setClasses(s);
        return on;
      },
    };
  }

  // ── attributes / classes ──────────────────────────────────────────────────
  _classes() { return new Set((this.attrs.get('class') ?? '').split(/\s+/).filter(Boolean)); }
  _setClasses(set) { if (set.size) this.attrs.set('class', [...set].join(' ')); else this.attrs.delete('class'); }
  get className() { return this.attrs.get('class') ?? ''; }
  set className(v) { if (v) this.attrs.set('class', String(v)); else this.attrs.delete('class'); }
  get id() { return this.attrs.get('id') ?? ''; }
  set id(v) { if (v) this.attrs.set('id', String(v)); else this.attrs.delete('id'); }
  getAttribute(n) { return this.attrs.has(n) ? this.attrs.get(n) : null; }
  setAttribute(n, v) { this.attrs.set(n, String(v)); }
  hasAttribute(n) { return this.attrs.has(n); }
  removeAttribute(n) { this.attrs.delete(n); }

  // ── tree ──────────────────────────────────────────────────────────────────
  get children() { return this.childNodes.filter(n => n.nodeType === 1); }
  get firstChild() { return this.childNodes[0] ?? null; }
  get firstElementChild() { return this.children[0] ?? null; }
  get nextElementSibling() {
    if (!this.parentNode) return null;
    const sib = this.parentNode.children;
    return sib[sib.indexOf(this) + 1] ?? null;
  }
  get isConnected() {
    let n = this;
    while (n.parentNode) n = n.parentNode;
    return n === this.ownerDocument.documentElement;
  }
  appendChild(node) { return this.insertBefore(node, null); }
  prepend(node) { return this.insertBefore(node, this.childNodes[0] ?? null); }
  insertBefore(node, ref) {
    if (node.parentNode) node.parentNode._detach(node);
    const i = ref ? this.childNodes.indexOf(ref) : -1;
    if (ref && i < 0) throw new Error('insertBefore: reference node is not a child');
    if (i < 0) this.childNodes.push(node); else this.childNodes.splice(i, 0, node);
    node.parentNode = this;
    return node;
  }
  _detach(node) {
    const i = this.childNodes.indexOf(node);
    if (i >= 0) this.childNodes.splice(i, 1);
    node.parentNode = null;
  }
  remove() { if (this.parentNode) this.parentNode._detach(this); }
  contains(node) { for (let n = node; n; n = n.parentNode) if (n === this) return true; return false; }
  cloneNode(deep) {
    const c = new MiniElement(this.ownerDocument, this.localName);
    for (const [k, v] of this.attrs) c.attrs.set(k, v);
    c.style = { ...this.style };
    c.hidden = this.hidden;
    c._rect = { ...this._rect };
    c._display = this._display;
    if (deep) for (const n of this.childNodes) c.appendChild(n.cloneNode(true));
    return c;
  }
  *descendants() {
    for (const n of this.childNodes) {
      if (n.nodeType !== 1) continue;
      yield n;
      yield* n.descendants();
    }
  }

  // ── text / markup ─────────────────────────────────────────────────────────
  get textContent() { return this.childNodes.map(n => n.textContent).join(''); }
  set textContent(v) {
    for (const n of this.childNodes) n.parentNode = null;
    this.childNodes = [];
    if (v !== '' && v != null) this.appendChild(new MiniText(v));
  }
  get innerHTML() { return this.childNodes.map(serialize).join(''); }
  set innerHTML(html) {
    for (const n of this.childNodes) n.parentNode = null;
    this.childNodes = [];
    parseInto(this.ownerDocument, String(html), this);
  }

  // ── selectors ─────────────────────────────────────────────────────────────
  matches(selector) { return parseSelector(selector).some(chain => matchChain(this, chain, this)); }
  querySelectorAll(selector) {
    const chains = parseSelector(selector);
    const out = [];
    for (const el of this.descendants()) if (chains.some(c => matchChain(el, c, this))) out.push(el);
    return out;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
  closest(selector) {
    const chains = parseSelector(selector);
    for (let n = this; n && n.nodeType === 1; n = n.parentNode) {
      if (chains.some(c => matchChain(n, c, n))) return n;
    }
    return null;
  }

  // ── geometry ──────────────────────────────────────────────────────────────
  getBoundingClientRect() {
    const r = this._rect;
    return { left: r.left, top: r.top, width: r.width, height: r.height, right: r.left + r.width, bottom: r.top + r.height, x: r.left, y: r.top };
  }
  get clientWidth() { return this._rect.width; }
  get clientHeight() { return this._rect.height; }
  get offsetWidth() { return this._rect.width; }
  get offsetHeight() { return this._rect.height; }

  // ── behaviour ─────────────────────────────────────────────────────────────
  focus() { this.ownerDocument.activeElement = this; }
  blur() { if (this.ownerDocument.activeElement === this) this.ownerDocument.activeElement = this.ownerDocument.body; }
  click() { return this.dispatchEvent(new MiniEvent('click')); }
  setPointerCapture(id) { this._captured = id; }
  releasePointerCapture() { this._captured = null; }
  dispatchEvent(ev) {
    if (!ev.target) ev.target = this;
    for (let n = this; n; n = n.parentNode ?? (n === this.ownerDocument.documentElement ? this.ownerDocument : null)) {
      n._invoke(ev);
      if (ev.stopped) break;
    }
    return !ev.defaultPrevented;
  }
  getContext(kind) {
    if (this.localName !== 'canvas' || this.ownerDocument._no2d) return null;
    if (!this._ctx) this._ctx = recordingContext();
    return this._ctx;
  }
}

// A 2D context that remembers what was asked of it.
function recordingContext() {
  const calls = [];
  const state = { calls, fillStyle: '', globalAlpha: 1 };
  return new Proxy(state, {
    get(t, k) {
      if (k in t) return t[k];
      return (...args) => { calls.push([k, ...args]); };
    },
  });
}

// ── markup ──────────────────────────────────────────────────────────────────
const TOKEN = /<!--[\s\S]*?-->|<\/([a-zA-Z][\w:-]*)\s*>|<([a-zA-Z][\w:-]*)((?:\s+[^\s=>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>|([^<]+)/g;
const ATTR = /([^\s=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;

function parseInto(doc, html, parent) {
  const stack = [parent];
  TOKEN.lastIndex = 0;
  let m;
  while ((m = TOKEN.exec(html))) {
    if (m[1]) { if (stack.length > 1) stack.pop(); }
    else if (m[2]) {
      const el = doc.createElement(m[2]);
      ATTR.lastIndex = 0;
      let a;
      while ((a = ATTR.exec(m[3] ?? ''))) el.attrs.set(a[1], a[2] ?? a[3] ?? a[4] ?? '');
      stack[stack.length - 1].appendChild(el);
      if (!m[4] && !VOID.has(el.localName)) stack.push(el);
    } else if (m[5] && m[5].trim()) {
      stack[stack.length - 1].appendChild(new MiniText(m[5]));
    }
  }
}

function serialize(node) {
  if (node.nodeType === 3) return node.data;
  const attrs = [...node.attrs].map(([k, v]) => v === '' ? ` ${k}` : ` ${k}="${v}"`).join('');
  if (VOID.has(node.localName) && !node.childNodes.length) return `<${node.localName}${attrs}/>`;
  return `<${node.localName}${attrs}>${node.childNodes.map(serialize).join('')}</${node.localName}>`;
}

// ── selectors ───────────────────────────────────────────────────────────────
// A chain is [{ combinator, compound }...] read left to right; matching walks
// it right to left from the candidate element.
function parseSelector(selector) {
  return selector.split(',').map(part => {
    const chain = [];
    const re = /\s*(>)?\s*((?::scope|[a-zA-Z*][\w-]*|#[\w-]+|\.[\w-]+|\[[^\]]+\])+)/g;
    let m;
    while ((m = re.exec(part.trim()))) {
      chain.push({ combinator: m[1] ? '>' : ' ', compound: parseCompound(m[2]) });
    }
    return chain;
  });
}

function parseCompound(text) {
  const c = { scope: false, tag: null, id: null, classes: [], attrs: [] };
  const re = /:scope|[a-zA-Z*][\w-]*|#[\w-]+|\.[\w-]+|\[([^\]=]+)(?:=("?)([^"\]]*)\2)?\]/g;
  let m;
  while ((m = re.exec(text))) {
    const t = m[0];
    if (t === ':scope') c.scope = true;
    else if (t[0] === '#') c.id = t.slice(1);
    else if (t[0] === '.') c.classes.push(t.slice(1));
    else if (t[0] === '[') c.attrs.push({ name: m[1].trim(), value: m[3] === undefined ? null : m[3] });
    else c.tag = t.toLowerCase();
  }
  return c;
}

function matchCompound(el, c, scope) {
  if (c.scope && el !== scope) return false;
  if (c.tag && c.tag !== '*' && el.localName !== c.tag) return false;
  if (c.id && el.id !== c.id) return false;
  for (const cls of c.classes) if (!el.classList.contains(cls)) return false;
  for (const a of c.attrs) {
    if (!el.attrs.has(a.name)) return false;
    if (a.value !== null && el.attrs.get(a.name) !== a.value) return false;
  }
  return true;
}

function matchChain(el, chain, scope) {
  let i = chain.length - 1;
  if (!matchCompound(el, chain[i].compound, scope)) return false;
  let node = el;
  while (i > 0) {
    const comb = chain[i].combinator;
    i--;
    if (comb === '>') {
      node = node.parentNode;
      if (!node || node.nodeType !== 1 || !matchCompound(node, chain[i].compound, scope)) return false;
    } else {
      node = node.parentNode;
      while (node && node.nodeType === 1 && !matchCompound(node, chain[i].compound, scope)) node = node.parentNode;
      if (!node || node.nodeType !== 1) return false;
    }
  }
  return true;
}

// ── document + globals ──────────────────────────────────────────────────────
class MiniDocument extends Listeners {
  constructor() {
    super();
    this.nodeType = 9;
    this.hidden = false;
    this._no2d = false;
    this.documentElement = new MiniElement(this, 'html');
    this.body = new MiniElement(this, 'body');
    this.documentElement.appendChild(this.body);
    this.activeElement = this.body;
  }
  createElement(tag) { return new MiniElement(this, tag); }
  createTextNode(text) { return new MiniText(text); }
  querySelector(s) { return this.documentElement.matches(s) ? this.documentElement : this.documentElement.querySelector(s); }
  querySelectorAll(s) { return this.documentElement.querySelectorAll(s); }
  getElementById(id) { for (const el of this.documentElement.descendants()) if (el.id === id) return el; return null; }
  dispatchEvent(ev) { if (!ev.target) ev.target = this; this._invoke(ev); return !ev.defaultPrevented; }
}

class Observer {
  constructor(cb) { this.cb = cb; this.targets = []; this.constructor.all.push(this); }
  observe(t) { this.targets.push(t); }
  disconnect() { this.targets = []; }
  fire(arg) { this.cb(arg, this); }
}

/** Install the globals and return handles the tests drive things with. */
export function installMiniDom({ innerWidth = 1400, innerHeight = 900, devicePixelRatio = 2 } = {}) {
  const document = new MiniDocument();
  const store = new Map();
  const localStorage = {
    getItem: k => store.has(k) ? store.get(k) : null,
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: k => store.delete(k),
    clear: () => store.clear(),
    get size() { return store.size; },
  };
  const frames = [];
  let rafId = 0;
  const media = { matches: false, listeners: [], addEventListener(type, fn) { this.listeners.push(fn); }, fire() { for (const fn of this.listeners) fn({ matches: this.matches }); } };
  const win = new Listeners();

  class ResizeObserver extends Observer {} ResizeObserver.all = [];
  class IntersectionObserver extends Observer {} IntersectionObserver.all = [];
  class MutationObserver extends Observer {} MutationObserver.all = [];

  Object.assign(globalThis, {
    document, localStorage, ResizeObserver, IntersectionObserver, MutationObserver,
    innerWidth, innerHeight, devicePixelRatio,
    getComputedStyle: (el) => ({ display: el._display }),
    requestAnimationFrame: (fn) => { frames.push({ id: ++rafId, fn }); return rafId; },
    cancelAnimationFrame: (id) => { const i = frames.findIndex(f => f.id === id); if (i >= 0) frames.splice(i, 1); },
    matchMedia: () => media,
    addEventListener: (t, fn) => win.addEventListener(t, fn),
    removeEventListener: (t, fn) => win.removeEventListener(t, fn),
    dispatchEvent: (ev) => { win._invoke(ev); return true; },
  });
  globalThis.window = globalThis;

  return {
    document, localStorage, store, media, win,
    ResizeObserver, IntersectionObserver, MutationObserver,
    /** Run every queued animation frame once, in order, with this timestamp. */
    flushFrames(now) {
      const batch = frames.splice(0, frames.length);
      for (const f of batch) f.fn(now);
      return batch.length;
    },
    get pendingFrames() { return frames.length; },
    fireWindow(type, props) { const ev = new MiniEvent(type, props); win._invoke(ev); return ev; },
  };
}

/** Dispatch an event on an element or the document; returns the event. */
export function fire(target, type, props = {}) {
  const ev = new MiniEvent(type, props);
  target.dispatchEvent(ev);
  return ev;
}
