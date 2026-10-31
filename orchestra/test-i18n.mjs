import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { EN } from './web/lang-en.mjs';

// Text that is the same in every language (names, licences, addresses) or never shown.
const SAME = new Set(['Agent', 'Orchestra', 'MIDI.js Soundfonts', 'CC BY 3.0', 'smplr', 'dijitalpi.com/iletisim', 'English', 'Türkçe', 'TR', 'EN', 'ĞÜŞİÖÇ', 'https://']);
const shape = (key) => key.replace(/\{\w+\}/g, '{}');
const shapes = new Set(Object.keys(EN).map(shape));
const web = (name) => readFile(new URL(`./web/${name}`, import.meta.url), 'utf8');

test('every text and label written in the page has an English version', async () => {
  const html = (await web('index.html')).replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, '');
  const unescape = (s) => s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  const texts = [...html.matchAll(/>([^<>]+)</g)].map((m) => unescape(m[1]).replace(/\s+/g, ' ').trim()).filter((s) => /\p{L}{2}/u.test(s));
  const attrs = [...html.matchAll(/(?:aria-label|placeholder|title)="([^"]+)"/g), ...html.matchAll(/<meta (?:name|property)="(?:description|og:title|og:description|twitter:title|twitter:description)" content="([^"]+)"/g)].map((m) => unescape(m[1]));
  const missing = [...texts, ...attrs].filter((s) => !SAME.has(s) && !(s in EN));
  assert.deepEqual(missing, []);
});

test('every Turkish message the code writes has an English version', async () => {
  const missing = [];
  for (const name of ['app.js', 'experience.js', 'buy.js', 'amfi.js', 'video.js', 'views.js']) {
    const source = (await web(name)).replace(/^\s*\/\/.*$/gm, '');
    for (const m of source.matchAll(/'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g)) {
      const raw = m[1] ?? m[2] ?? m[3];
      if (!/[çğıöşüÇĞİÖŞÜ]/.test(raw) || /^[\w.-]+$/.test(raw) || SAME.has(raw)) continue;
      // A template's ${…} parts become placeholders; nested literals are checked on their own.
      let text = '', depth = 0;
      for (let i = 0; i < raw.length; i++) {
        if (!depth && raw.startsWith('${', i)) { depth = 1; i++; text += '{}'; continue; }
        if (depth) { if (raw[i] === '{') depth++; else if (raw[i] === '}') depth--; continue; }
        text += raw[i];
      }
      text = text.replace(/\\(.)/g, '$1').trim();
      if (!text || /^\{\}$/.test(text)) continue;
      if (!(text in EN) && !shapes.has(text) && !shapes.has(text.replace(/\s*·\s*$/, '')) && !SAME.has(text)) missing.push(`${name}: ${text}`);
    }
  }
  assert.deepEqual(missing, []);
});

test('English keeps every placeholder of its Turkish key and adds none', () => {
  for (const [key, value] of Object.entries(EN)) {
    const names = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    assert.deepEqual(names(value), names(key), key);
  }
});

test('the English text keeps the plain-language rules: no long dash in what readers see', () => {
  for (const value of Object.values(EN)) assert.ok(!/[—–]/.test(value), value);
});
