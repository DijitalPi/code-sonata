import { test } from 'node:test';
import assert from 'node:assert/strict';
import { install, add } from './fake-dom.mjs';
import { TIERS } from './web/seats.mjs';

// The stage, the hall in it, and an amphitheatre that only remembers which block it lights.
const doc = install();
const stage = add(doc.body, 'main', { class: 'stage' });
const canvas = add(stage, 'canvas', { id: 'hall' });
const lit = [];
let demo = false;
const pictures = new Map();
const amfi = { setHover: (h) => lit.push(h?.id ?? null), picture: (h) => pictures.get(h?.id) || null, isDemo: () => demo };
const { createCard } = await import('./web/card.js');
const card = createCard({ stage, canvas, amfi });
const el = card.element;
const tick = () => new Promise((r) => setTimeout(r, 5));
// Where things are on the page: the card is 280 × 250.
const rects = ({ stageTop = 0, hallTop = 0, width = 1440, height = 900 }) => {
  stage.getBoundingClientRect = () => ({ left: 0, top: stageTop, width, height });
  canvas.getBoundingClientRect = () => ({ left: 0, top: hallTop, width, height: 600 });
  el.getBoundingClientRect = () => ({ left: 0, top: 0, width: 280, height: 250 });
};
const front = TIERS[0].rings[0];
const acme = { id: 'o-acme', ring: front, col: 10, width: 4, depth: 2, name: 'Acme', link: 'https://www.acme.example/', about: 'Kod yazan bir ekip', city: 'İzmir, Türkiye' };

test('a holder card shows the big logo, name, their line, city, link and seats, and lights the block', async () => {
  rects({});
  pictures.set('o-acme', { width: 400, height: 100 });
  card.holder(acme, 300, 400);
  assert.equal(el.hidden, false);
  const logo = el.querySelector('canvas.seat-logo');
  assert.deepEqual([logo.style.width, logo.style.height], ['252px', '63px'], 'as wide as the card allows, its own shape kept');
  assert.equal(el.querySelector('b').textContent, 'Acme');
  assert.equal(el.querySelector('p').textContent, 'Kod yazan bir ekip');
  assert.equal(el.querySelector('.city').textContent, 'İzmir, Türkiye');
  const a = el.querySelector('a');
  assert.deepEqual([a.textContent, a.getAttribute('rel') ?? a.rel], ['acme.example ↗', 'sponsored noopener']);
  assert.equal(a.getAttribute('referrerpolicy') ?? a.referrerPolicy, 'origin', 'the holder sees the visit came from here, not from which page');
  assert.match(el.querySelector('small').textContent, /^8 koltuk · /);
  assert.ok(['b', 'p', '.city', 'a'].every((s) => el.querySelector(s).getAttribute('translate') === 'no'), 'what a buyer wrote is not translated');
  assert.equal(lit.at(-1), 'o-acme');
  card.hide(false); await tick();
  assert.deepEqual([el.hidden, lit.at(-1), card.open()], [true, null, false], 'closing the card puts the light out');
});

test('the link on the card always shows the site it goes to: a long address loses its path, a long site its front (G6)', () => {
  rects({});
  const shown = (link) => { card.holder({ ...acme, link }, 300, 400); return el.querySelector('a').textContent; };
  assert.equal(shown('https://acme.example/a/b?x=1'), 'acme.example/a/b?x=1 ↗');
  assert.equal(shown(`https://acme.example/${'p'.repeat(60)}`), `acme.example/${'p'.repeat(35)} ↗`);
  const long = `trusted.example.${'a'.repeat(40)}.evil.test`;
  assert.equal(shown(`https://${long}/`), `…${long.slice(-47)} ↗`);
  assert.ok(shown(`https://${long}/`).endsWith('.evil.test ↗'), 'the end of a site name is the part that tells whose it is');
  card.hide(false);
});

test('no line, city or picture: no empty rows; a demo card is ours and translated', () => {
  rects({});
  demo = true;
  card.holder({ ...acme, id: 'demo-1', about: undefined, city: undefined, link: null }, 300, 400);
  assert.deepEqual([el.querySelector('canvas'), el.querySelector('p'), el.querySelector('.city'), el.querySelector('a')], [null, null, null, null]);
  assert.equal(el.querySelector('b').getAttribute('translate'), 'yes');
  assert.match(el.querySelector('small').textContent, /^Demo örneği, gerçek alıcı değil · /);
  demo = false;
});

test('the card opens above the point, or below it when there is no room, never over the block', () => {
  rects({});
  card.holder(acme, 300, 400);
  assert.deepEqual([el.style.left, el.style.top], ['314px', '138px'], 'above: 400 - 250 - 12');
  card.holder(acme, 300, 60);
  assert.equal(el.style.top, '78px', 'below: 60 + 18');
});

test('on a phone the hall starts lower than the stage: the card still opens at the tapped block', () => {
  // The stage starts at 60 on the page, the hall at 400; a tap 100 px into the hall is 440 px into the stage.
  rects({ stageTop: 60, hallTop: 400, width: 390 });
  card.holder(acme, 100, 100);
  assert.equal(el.style.top, '178px', '440 - 250 - 12, so it ends just above the tap');
  assert.equal(el.style.left, '102px');
});

test('other content (the auction block) lights no block; pointing back at the card keeps it open', async () => {
  rects({});
  const b = doc.createElement('b'); b.textContent = 'Sahnenin önü · 96 koltuk';
  card.other([b], 300, 400);
  assert.deepEqual([el.textContent, lit.at(-1), card.open()], ['Sahnenin önü · 96 koltuk', null, true]);
  card.hide(true);
  el.dispatchEvent(new Event('pointerenter'));
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(el.hidden, false, 'a hand on the card keeps it');
  el.dispatchEvent(new Event('pointerleave'));
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(el.hidden, true);
});
