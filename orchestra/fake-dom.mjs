// Just enough of a browser page for the tests to load the page modules in Node: elements, text, simple
// selectors (tag, #id, .class, [attr], [attr="v"], descendants, commas), events, and the window globals
// the modules read. No layout, no drawing. Call install() before importing a module that touches the page.

class Node_ extends EventTarget {
  parentNode = null;
  get parentElement() { return this.parentNode?.nodeType === 1 ? this.parentNode : null; }
  remove() { if (this.parentNode) { const list = this.parentNode.childNodes; list.splice(list.indexOf(this), 1); this.parentNode = null; } }
}

class Text_ extends Node_ {
  nodeType = 3;
  constructor(value) { super(); this.nodeValue = String(value); }
  get textContent() { return this.nodeValue; }
}

function parse(selector) {
  return selector.split(',').map((one) => one.trim().split(/\s+/).map((compound) =>
    compound.match(/^[\w-]+|#[\w-]+|\.[\w-]+|\[[^\]]+\]/g).map((part) => {
      if (part[0] === '#') return (e) => e.id === part.slice(1);
      if (part[0] === '.') return (e) => e.classList.contains(part.slice(1));
      if (part[0] === '[') {
        const [, name, value] = part.match(/^\[([\w:-]+)(?:="?([^"\]]*)"?)?\]$/);
        return (e) => e.hasAttribute(name) && (value === undefined || e.getAttribute(name) === value);
      }
      return (e) => e.tagName === part.toUpperCase();
    })));
}
const fits = (e, parts) => parts.every((test) => test(e));
function matches(e, selector) {
  return parse(selector).some((chain) => {
    if (!fits(e, chain.at(-1))) return false;
    let i = chain.length - 2;
    for (let up = e.parentElement; up && i >= 0; up = up.parentElement) if (fits(up, chain[i])) i--;
    return i < 0;
  });
}

class Element_ extends Node_ {
  nodeType = 1;
  childNodes = [];
  attributes = new Map();
  hidden = false;
  constructor(tag) {
    super(); this.tagName = tag.toUpperCase();
    const own = new Set();
    const sync = () => this.attributes.set('class', [...own].join(' '));
    this.classList = {
      add: (...names) => { names.forEach((n) => own.add(n)); sync(); },
      remove: (...names) => { names.forEach((n) => own.delete(n)); sync(); },
      toggle: (name, on = !own.has(name)) => { on ? own.add(name) : own.delete(name); sync(); return on; },
      contains: (name) => own.has(name),
      reset: (value) => { own.clear(); String(value).split(/\s+/).filter(Boolean).forEach((n) => own.add(n)); },
    };
  }
  get id() { return this.getAttribute('id') || ''; }
  set id(value) { this.setAttribute('id', value); }
  get className() { return this.getAttribute('class') || ''; }
  set className(value) { this.setAttribute('class', value); }
  set translate(on) { this.setAttribute('translate', on ? 'yes' : 'no'); }
  get content() { return this.getAttribute('content') ?? ''; }
  set content(value) { this.setAttribute('content', value); }
  getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); if (name === 'class') this.classList.reset(value); }
  hasAttribute(name) { return this.attributes.has(name); }
  removeAttribute(name) { this.attributes.delete(name); }
  get children() { return this.childNodes.filter((n) => n.nodeType === 1); }
  append(...nodes) {
    for (const n of nodes) {
      const node = typeof n === 'string' ? new Text_(n) : n;
      node.remove(); node.parentNode = this; this.childNodes.push(node);
    }
  }
  replaceChildren(...nodes) { for (const n of [...this.childNodes]) n.remove(); this.append(...nodes); }
  get textContent() { return this.childNodes.map((n) => n.textContent).join(''); }
  set textContent(value) { this.replaceChildren(String(value)); }
  *descendants() { for (const n of this.childNodes) { yield n; if (n.nodeType === 1) yield* n.descendants(); } }
  querySelectorAll(selector) { return [...this.descendants()].filter((n) => n.nodeType === 1 && matches(n, selector)); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  matches(selector) { return matches(this, selector); }
  closest(selector) { for (let e = this; e; e = e.parentElement) if (matches(e, selector)) return e; return null; }
  focus() { globalThis.document.activeElement = this; }
  getBoundingClientRect() { return { left: 0, top: 0, width: 0, height: 0 }; }
}

class Document_ extends EventTarget {
  constructor() {
    super();
    this.documentElement = new Element_('html');
    this.head = new Element_('head'); this.body = new Element_('body');
    this.documentElement.append(this.head, this.body);
    this.activeElement = this.body;
  }
  get title() { return this.head.querySelector('title')?.textContent ?? ''; }
  set title(value) {
    let title = this.head.querySelector('title');
    if (!title) this.head.append(title = new Element_('title'));
    title.textContent = value;
  }
  createElement(tag) { return new Element_(tag); }
  createTextNode(value) { return new Text_(value); }
  getElementById(id) { return this.documentElement.querySelector(`#${id}`); }
  querySelector(selector) { return this.documentElement.querySelector(selector); }
  querySelectorAll(selector) { return this.documentElement.querySelectorAll(selector); }
  createTreeWalker(root, show) {
    const nodes = [...root.descendants()].filter((n) => (n.nodeType === 3 ? show & 4 : show & 1));
    return { nextNode: () => nodes.shift() || null };
  }
}

// A page at `url` with the browser language `language`; returns the document to build the page in.
export function install({ url = 'http://localhost/', language = 'tr-TR' } = {}) {
  const win = new EventTarget(), store = new Map();
  const set = (name, value) => Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  set('document', new Document_());
  set('location', new URL(url));
  set('history', { replaceState: (_state, _title, next) => set('location', new URL(next, globalThis.location)) });
  set('localStorage', { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) });
  set('navigator', { language });
  set('NodeFilter', { SHOW_ELEMENT: 1, SHOW_TEXT: 4 });
  set('MutationObserver', class { observe() {} disconnect() {} });
  set('Image', class { set src(value) { this._src = value; } });
  set('addEventListener', win.addEventListener.bind(win));
  set('removeEventListener', win.removeEventListener.bind(win));
  set('dispatchEvent', win.dispatchEvent.bind(win));
  return globalThis.document;
}

// <tag id=… attr=…>text</tag>, appended to `parent`.
export function add(parent, tag, attrs = {}, text = '') {
  const e = globalThis.document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) e.setAttribute(name, value);
  if (text) e.append(text);
  parent.append(e);
  return e;
}
