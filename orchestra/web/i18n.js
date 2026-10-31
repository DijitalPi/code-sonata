// Languages. The page and the code are written in Turkish; another language is a dictionary keyed by the
// Turkish text (lang-en.mjs). Text the code writes later is translated as it appears, so a status line set
// anywhere follows the chosen language; canvas drawings call t() themselves. Adding a language means one
// more dictionary file and one more entry in LANGS.
import { EN } from './lang-en.mjs';

export const LANGS = { tr: 'Türkçe', en: 'English' };
const DICTS = { en: EN };
const tables = {};
let lang = pick();

function pick() {
  const asked = new URLSearchParams(location.search).get('lang');
  if (asked in LANGS) return asked;
  try { const saved = localStorage.getItem('lang'); if (saved in LANGS) return saved; } catch { /* private mode */ }
  return /^tr\b/i.test(navigator.language || '') ? 'tr' : 'en';
}

// Exact keys, and keys with {placeholders} as patterns, the most specific (longest fixed text) first.
function table(code) {
  if (tables[code]) return tables[code];
  const exact = new Map(), patterns = [];
  for (const [key, value] of Object.entries(DICTS[code] || {})) {
    if (!/\{\w+\}/.test(key)) { exact.set(key, value); continue; }
    const fixed = key.replace(/\{\w+\}/g, '').length;
    const source = key.split(/(\{\w+\})/).map((part) => /^\{\w+\}$/.test(part) ? `(?<${part.slice(1, -1)}>[\\s\\S]*?)` : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('');
    patterns.push({ re: new RegExp(`^${source}$`), value, fixed });
  }
  patterns.sort((a, b) => b.fixed - a.fixed);
  return (tables[code] = { exact, patterns });
}

function translate(text, depth = 0) {
  if (lang === 'tr' || !text || depth > 3) return text;
  const lead = text.match(/^\s*/)[0], tail = text.slice(lead.length).match(/\s*$/)[0], core = text.trim();
  if (!core) return text;
  const { exact, patterns } = table(lang);
  if (exact.has(core)) return lead + exact.get(core) + tail;
  for (const { re, value } of patterns) {
    const m = core.match(re);
    if (m) return lead + value.replace(/\{(\w+)\}/g, (_, name) => translate(m.groups[name] ?? '', depth + 1)) + tail;
  }
  return text;
}

export const getLang = () => lang;
export function t(text, vars) {
  const out = translate(text);
  return vars ? out.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? '') : out;
}
export const num = (n) => Number(n).toLocaleString(lang === 'tr' ? 'tr-TR' : 'en-US');

// ---------- the page ----------
const ATTRS = ['aria-label', 'placeholder', 'title'];
const seen = new WeakMap();          // node -> { tr, shown } so a language switch can go back to Turkish
const skip = (node) => node.parentElement?.closest('script, style, textarea, [translate="no"]');

function textNode(node) {
  if (skip(node)) return;
  let rec = seen.get(node);
  if (!rec || node.nodeValue !== rec.shown) seen.set(node, rec = { tr: node.nodeValue, shown: null });
  const out = translate(rec.tr);
  rec.shown = out;
  if (node.nodeValue !== out) node.nodeValue = out;
}
function element(el) {
  for (const name of ATTRS) {
    if (!el.hasAttribute(name)) continue;
    const key = `${name}:`, store = seen.get(el) || {};
    const now = el.getAttribute(name);
    if (!store[key] || now !== store[key].shown) store[key] = { tr: now, shown: null };
    store[key].shown = translate(store[key].tr);
    seen.set(el, store);
    if (now !== store[key].shown) el.setAttribute(name, store[key].shown);
  }
}
function walk(root) {
  if (root.nodeType === 3) return textNode(root);
  if (root.nodeType !== 1 || root.closest?.('script, style')) return;
  element(root);
  const it = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  for (let node = it.nextNode(); node; node = it.nextNode()) node.nodeType === 3 ? textNode(node) : element(node);
}

// The server may have sent the head in English already (?lang=en): keep its Turkish original either way.
const turkish = (text) => Object.keys(EN).find((key) => EN[key] === text) ?? text;
const head = { title: turkish(document.title), description: turkish(document.querySelector('meta[name="description"]')?.content) };
function apply() {
  document.documentElement.lang = lang;
  document.title = translate(head.title);
  const description = document.querySelector('meta[name="description"]');
  if (description && head.description) description.content = translate(head.description);
  // The moment's title starts as a suggestion; follow the language until the listener types their own.
  const input = document.getElementById('moment-title-input');
  if (input && [EN['Bugünkü çalışmanın sesi'], 'Bugünkü çalışmanın sesi'].includes(input.value)) input.value = translate('Bugünkü çalışmanın sesi');
  walk(document.body);
  for (const control of document.querySelectorAll('[data-lang]')) {
    if (control.tagName === 'SELECT') control.value = lang;
    else control.hidden = control.dataset.lang === lang;
  }
}

export function setLang(code) {
  if (!(code in LANGS)) return;
  lang = code;
  try { localStorage.setItem('lang', code); } catch { /* private mode */ }
  const url = new URL(location.href);
  if (url.searchParams.has('lang')) { url.searchParams.set('lang', code); history.replaceState(null, '', url); }
  apply();
  dispatchEvent(new CustomEvent('lang', { detail: code }));
}

new MutationObserver((changes) => {
  if (lang === 'tr') return;
  for (const change of changes) {
    if (change.type === 'characterData') textNode(change.target);
    else if (change.type === 'attributes') element(change.target);
    else for (const node of change.addedNodes) walk(node);
  }
}).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS });

document.addEventListener('change', (event) => { if (event.target.matches('select[data-lang]')) setLang(event.target.value); });
document.addEventListener('click', (event) => { const b = event.target.closest('button[data-lang]'); if (b) setLang(b.dataset.lang); });
apply();
