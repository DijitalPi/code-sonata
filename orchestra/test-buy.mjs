import { test } from 'node:test';
import assert from 'node:assert/strict';
import { install, add } from './fake-dom.mjs';

// The seat panel and the hall, as far as buy.js reaches into them.
const doc = install();
const panel = add(doc.body, 'aside', { id: 'panel' });
for (const id of ['seats-title', 'seat-tiers', 'seat-price', 'seat-count', 'seat-place', 'seat-status', 'seat-form',
  'seat-pay', 'seat-again', 'seat-pay-status', 'holders', 'holders-lead']) add(panel, 'div', { id });
for (const id of ['seat-image', 'seat-name', 'seat-link', 'seat-terms']) add(panel, 'input', { id });
Object.assign(add(panel, 'canvas', { id: 'seat-preview' }), { width: 480, height: 240 });
add(panel, 'input', { id: 'seat-width' }).value = '3';
add(panel, 'input', { id: 'seat-depth' }).value = '2';
add(doc.body, 'button', { 'data-open': 'seats' });
const canvas = add(add(doc.body, 'main', { class: 'stage' }), 'canvas', { id: 'hall' });
const ghosts = [], reservedNow = [];
const amfi = { holders: () => [], reserved: () => reservedNow, setGhost: (ghost) => ghosts.push(ghost), hit: () => null };
// The network and the browser's own steps, recorded instead of done.
const calls = [], logos = [], went = [];
let answer = () => ({ status: 200, body: {} });
globalThis.fetch = async (url, init = {}) => {
  calls.push({ url, init });
  const { status, body } = answer(url, init);
  return new Response(JSON.stringify(body), { status });
};
const { setupBuying, followOrder } = await import('./web/buy.js');
setupBuying({ canvas, geometry: () => ({}), amfi, encode: async (img) => { logos.push(img); return 'data:image/webp;base64,UklGRg=='; }, go: (url) => went.push(url) });

const view = (name) => dispatchEvent(new CustomEvent('view', { detail: name }));
const key = (name) => dispatchEvent(Object.assign(new Event('keydown'), { key: name }));

test('going to another view while placing a block ends the placing', () => {
  view('seats');
  doc.getElementById('seat-place').onclick();
  assert.ok(doc.body.classList.contains('is-placing'));
  const status = doc.getElementById('seat-status').textContent;
  view('home');
  assert.ok(!doc.body.classList.contains('is-placing'), 'the hall is no longer in placing mode');
  assert.ok(doc.querySelector('.place-bar').hidden, 'the placing bar is gone');
  assert.equal(ghosts.at(-1), null, 'no block is left drawn in the hall');
  key('Enter');
  assert.equal(doc.getElementById('seat-status').textContent, status, 'Enter no longer picks a place behind the new view');
});

const $ = (id) => doc.getElementById(id);
const place = () => $('seat-place').onclick();
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const shop = (checkout) => dispatchEvent(new CustomEvent('shop', { detail: { checkout } }));
async function fillForm({ terms }) {
  view('seats'); place(); key('Enter');
  $('seat-image').files = [new File([new Uint8Array(8)], 'logo.png', { type: 'image/png' })];
  $('seat-image').dispatchEvent(new Event('change'));
  await tick();
  $('seat-name').value = 'Acme'; $('seat-link').value = 'https://acme.example'; $('seat-terms').checked = terms;
}

test('seats someone is paying for count as taken while placing', () => {
  view('seats'); place();
  const first = ghosts.at(-1).block;
  key('Escape');
  reservedNow.push(first);
  view('seats'); place();
  const next = ghosts.at(-1);
  assert.ok(next.ok);
  assert.ok(next.block.col + next.block.width <= first.col || next.block.col >= first.col + first.width || next.block.ring !== first.ring);
  key('Escape'); reservedNow.length = 0;
});

test('with payment closed the form says so and sends nothing', async () => {
  shop(false);
  await fillForm({ terms: true });
  calls.length = 0;
  await $('seat-pay').onclick();
  assert.match($('seat-pay-status').textContent, /^Ödeme henüz açık değil/);
  assert.equal(calls.length, 0);
});

test('with payment open the terms come first, then the logo goes to checkout and the buyer to Stripe', async () => {
  shop(true);
  await fillForm({ terms: false });
  calls.length = 0;
  await $('seat-pay').onclick();
  assert.equal($('seat-pay-status').textContent, 'Koltuk şartlarını okuyup kutuyu işaretle.');
  assert.equal(calls.length, 0);
  $('seat-terms').checked = true;
  answer = () => ({ status: 200, body: { id: 'o-1', url: 'https://checkout.stripe.test/c/1' } });
  await $('seat-pay').onclick();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/seats/checkout');
  assert.equal(calls[0].init.method, 'POST');
  const sent = JSON.parse(calls[0].init.body);
  assert.deepEqual(Object.keys(sent).sort(), ['block', 'image', 'link', 'name', 'terms']);
  assert.deepEqual([sent.name, sent.link, sent.image, sent.terms], ['Acme', 'https://acme.example/', 'data:image/webp;base64,UklGRg==', true]);
  assert.deepEqual(Object.keys(sent.block).sort(), ['col', 'depth', 'ring', 'width']);
  assert.equal(logos.length, 1);
  assert.deepEqual(went, ['https://checkout.stripe.test/c/1']);
});

test('a place taken a moment ago, or a server that cannot open Stripe, is said plainly', async () => {
  shop(true);
  await fillForm({ terms: true });
  answer = () => ({ status: 409, body: { error: 'taken' } });
  await $('seat-pay').onclick();
  assert.equal($('seat-pay-status').textContent, 'Bu yer az önce başkası tarafından tutuldu. Başka bir yer seç.');
  answer = () => ({ status: 502, body: { error: 'stripe' } });
  await $('seat-pay').onclick();
  assert.equal($('seat-pay-status').textContent, 'Ödeme sayfası açılamadı. Birazdan yeniden dene.');
  answer = () => ({ status: 429, body: { error: 'busy' } });
  await $('seat-pay').onclick();
  assert.equal($('seat-pay-status').textContent, 'Çok fazla deneme oldu. Birkaç dakika sonra yeniden dene.');
});

test('back from Stripe the buyer reads what became of the order', async () => {
  const states = ['held', 'held', 'paid'];
  answer = () => ({ status: 200, body: { state: states.shift() } });
  await followOrder('o-1', { wait: 0 });
  assert.equal($('seat-status').textContent, 'Ödemen alındı. Koltuğun onay bekliyor; onaylanınca salonda görünecek.');
  answer = () => ({ status: 404, body: {} });
  await followOrder('o-2', { wait: 0 });
  assert.equal($('seat-status').textContent, 'Bu sipariş bulunamadı.');
  answer = () => ({ status: 200, body: { state: 'held' } });
  await followOrder('o-3', { wait: 0, tries: 2 });
  assert.match($('seat-status').textContent, /^Ödemen henüz bize ulaşmadı/);
});

test('back from Stripe without paying, the held place is let go', async () => {
  calls.length = 0;
  answer = () => ({ status: 200, body: { state: 'expired' } });
  await followOrder('o-4', { cancelled: true });
  assert.deepEqual([calls[0].url, calls[0].init.method], ['/api/seats/order/o-4/cancel', 'POST']);
  assert.equal($('seat-status').textContent, 'Ödeme yapılmadı. Ayırdığın yer bırakıldı.');
});

test('a cancel that comes after the payment tells what really happened', async () => {
  calls.length = 0;
  answer = (url) => (url.endsWith('/cancel') ? { status: 409, body: { error: 'state' } } : { status: 200, body: { state: 'paid' } });
  await followOrder('o-5', { cancelled: true, wait: 0 });
  assert.equal(calls[1].url, '/api/seats/order/o-5');
  assert.equal($('seat-status').textContent, 'Ödemen alındı. Koltuğun onay bekliyor; onaylanınca salonda görünecek.');
});

test('reading the terms keeps the chosen place', async () => {
  shop(true);
  await fillForm({ terms: true });
  view('terms'); view('seats');
  calls.length = 0;
  answer = () => ({ status: 200, body: { id: 'o-6', url: 'https://checkout.stripe.test/c/6' } });
  await $('seat-pay').onclick();
  assert.equal(calls[0]?.url, '/api/seats/checkout', $('seat-pay-status').textContent);
});

test('a cancel that could not reach Stripe says only what the order shows', async () => {
  answer = (url) => (url.endsWith('/cancel') ? { status: 502, body: { error: 'stripe' } } : { status: 200, body: { state: 'paid' } });
  await followOrder('o-7', { cancelled: true, wait: 0 });
  assert.equal($('seat-status').textContent, 'Ödemen alındı. Koltuğun onay bekliyor; onaylanınca salonda görünecek.');
  answer = (url) => (url.endsWith('/cancel') ? { status: 502, body: { error: 'stripe' } } : { status: 200, body: { state: 'held' } });
  await followOrder('o-8', { cancelled: true, wait: 0 });
  assert.equal($('seat-status').textContent, 'Ödemen bize ulaşmadı. Ulaşmazsa ayırdığın yer en geç bir saat içinde bırakılır.');
  answer = () => ({ status: 503, body: {} });
  await followOrder('o-9', { cancelled: true, wait: 0 });
  assert.equal($('seat-status').textContent, 'Ödemenin durumu şu an doğrulanamadı. Bağlantın gelince bu sayfayı yenile.');
});
