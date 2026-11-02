import { test } from 'node:test';
import assert from 'node:assert/strict';
import { install, add } from './fake-dom.mjs';

// The seat panel and the hall, as far as buy.js reaches into them.
const doc = install();
const panel = add(doc.body, 'aside', { id: 'panel' });
for (const id of ['seats-title', 'seat-tiers', 'seat-price', 'seat-count', 'seat-place', 'seat-status', 'seat-form',
  'seat-pay', 'seat-again', 'seat-pay-status', 'holders', 'holders-lead']) add(panel, 'div', { id });
for (const id of ['seat-image', 'seat-name', 'seat-about', 'seat-city', 'seat-link', 'seat-terms']) add(panel, 'input', { id });
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
const { setupBuying, followOrder, backFromStripe } = await import('./web/buy.js');
let hallGeometry = {};
const buying = setupBuying({ canvas, geometry: () => hallGeometry, amfi, encode: async (img) => { logos.push(img); return 'data:image/webp;base64,UklGRg=='; }, go: (url) => went.push(url) });

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
  $('seat-about').value = ' Kod yazan bir ekip '; $('seat-city').value = 'İzmir';
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
  assert.deepEqual(Object.keys(sent).sort(), ['about', 'block', 'city', 'image', 'link', 'name', 'terms']);
  assert.deepEqual([sent.name, sent.about, sent.city, sent.link, sent.image, sent.terms], ['Acme', 'Kod yazan bir ekip', 'İzmir', 'https://acme.example/', 'data:image/webp;base64,UklGRg==', true]);
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
  answer = () => ({ status: 400, body: { error: 'holder' } });
  await $('seat-pay').onclick();
  assert.equal($('seat-pay-status').textContent, 'Ad, link, tanıtım ya da şehir kabul edilmedi. Kontrol edip yeniden dene.');
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

test('back from Stripe with the outcome unknown, the address keeps the order, so reloading asks again', async () => {
  const id = 'o-0123456789abcdef01234567';
  history.replaceState(null, '', `/?siparis=${id}&iptal&lang=en`);
  answer = () => ({ status: 503, body: {} });
  await backFromStripe();
  assert.equal($('seat-status').textContent, 'Ödemenin durumu şu an doğrulanamadı. Bağlantın gelince bu sayfayı yenile.');
  assert.equal(new URLSearchParams(location.search).get('siparis'), id);
  answer = () => ({ status: 200, body: {} });
  const before = calls.length;
  await backFromStripe();                 // the reload
  assert.equal(calls[before]?.url, `/api/seats/order/${id}/cancel`);
  assert.equal($('seat-status').textContent, 'Ödeme yapılmadı. Ayırdığın yer bırakıldı.');
  assert.equal(location.search, '?lang=en', 'known now: the order leaves the address');
});

test('a buyer starts from one seat and makes the block bigger if they want', async () => {
  const { readFile } = await import('node:fs/promises');
  const html = await readFile(new URL('./web/index.html', import.meta.url), 'utf8');
  assert.match(html, /<input id="seat-width"[^>]* value="1"/);
  assert.match(html, /<input id="seat-depth"[^>]* value="1"/);
});

test('in English one seat reads as one seat, not "1 seats"', async () => {
  const { t, setLang } = await import('./web/i18n.js');
  setLang('en');
  try {
    assert.equal(t('1 koltuk'), '1 seat');
    assert.equal(t('En iyi boş yer: Orta, 3. sıradan 1 koltuk · 10 $.'), `Best free place: ${t('Orta')}, from row 3: 1 seat · ${t('10 $')}.`);
    assert.equal(t('Seçtiğin yer: Sahne önü, 1 koltuk, 90 $.'), `Your place: ${t('Sahne önü')}, 1 seat, ${t('90 $')}.`);
    assert.equal(t('Sahne önü · 1 koltuk'), `${t('Sahne önü')} · 1 seat`);
    assert.equal(t('1 koltuk · Sahne önü'), `1 seat · ${t('Sahne önü')}`);
    assert.equal(t('Sahne önü · 11 koltuk'), `${t('Sahne önü')} · 11 seats`, 'eleven stays plural');
  } finally { setLang('tr'); }
});

test('placing starts on the best free place; on a touch screen the bar says to tap', () => {
  globalThis.matchMedia = (query) => ({ matches: query === '(pointer: coarse)' });
  $('seat-width').value = '1'; $('seat-depth').value = '1';
  try {
    view('seats'); place();
    assert.match($('place-text').textContent, /^En iyi boş yer: Ön sıra, 1\. sıradan 1 koltuk · /);
    assert.equal($('place-hint').textContent, "Başka bir yere dokun ya da Burayı seç'e bas.");
    key('ArrowRight');
    assert.match($('place-text').textContent, /^Ön sıra, 1\. sıradan 1 koltuk · /, 'a moved block is no longer the suggestion');
  } finally { delete globalThis.matchMedia; key('Escape'); }
  place();
  assert.equal($('place-hint').textContent, "Tıkla ya da Enter'a bas.", 'with a mouse a click chooses');
  key('Escape');
  $('seat-width').value = '3'; $('seat-depth').value = '2';
});

test('on a phone the hall, wider than the screen while placing, opens at the suggested place', async () => {
  const { blockArc } = await import('./web/seats.mjs');
  const stage = canvas.parentElement;
  Object.assign(stage, { clientWidth: 390, scrollWidth: 975, scrollLeft: 0 });
  hallGeometry = { cx: 487.5, cy: 530, R: 266 };
  try {
    view('seats'); place();
    const arc = blockArc(ghosts.at(-1).block), a = (arc.a1 + arc.a2) / 2 * Math.PI / 180;
    const x = 487.5 + Math.sin(a) * (arc.r1 + arc.r2) / 2 * 266;
    assert.ok(stage.scrollLeft > 0);
    assert.ok(Math.abs(stage.scrollLeft + 195 - x) < 1, 'the block is in the middle of the screen');
    for (let i = 0; i < 30; i++) key('ArrowRight');
    const moved = blockArc(ghosts.at(-1).block), m = (moved.a1 + moved.a2) / 2 * Math.PI / 180;
    assert.ok(Math.abs(stage.scrollLeft + 195 - (487.5 + Math.sin(m) * (moved.r1 + moved.r2) / 2 * 266)) < 1, 'keys carry the view along');
  } finally { key('Escape'); hallGeometry = {}; Object.assign(stage, { clientWidth: 0, scrollWidth: 0, scrollLeft: 0 }); }
});

test('a hall that slides under a resting mouse keeps the suggested place; a real move moves the block', () => {
  const hit = amfi.hit; amfi.hit = () => ({ k: 3, c: 40 });
  const move = (movementX) => canvas.dispatchEvent(Object.assign(new Event('pointermove'), { pointerType: 'mouse', movementX, movementY: 0, clientX: 5, clientY: 5 }));
  try {
    view('seats'); place();
    const suggested = $('place-text').textContent;
    move(0);
    assert.equal($('place-text').textContent, suggested);
    move(4);
    assert.notEqual($('place-text').textContent, suggested);
  } finally { amfi.hit = hit; key('Escape'); }
});

test('the auction winner sends the logo with the same form: no payment, the bid id instead', async () => {
  const id = `b-${'5'.repeat(24)}`;
  shop(true);
  buying.startWinner(id);
  assert.deepEqual([$('seat-form').hidden, $('seat-pay').textContent, $('seat-again').hidden], [false, 'Logoyu gönder', true]);
  assert.match($('seat-status').textContent, /sahnenin önü, 96 koltuk/);
  assert.deepEqual(ghosts.at(-1).block, { ring: 0, col: 88, width: 24, depth: 4 });
  $('seat-image').files = [new File([new Uint8Array(8)], 'logo.png', { type: 'image/png' })];
  $('seat-image').dispatchEvent(new Event('change'));
  await tick();
  $('seat-name').value = 'Acme'; $('seat-link').value = 'https://acme.example'; $('seat-terms').checked = true;
  answer = () => ({ status: 200, body: { order: 'o-x' } });
  calls.length = 0;
  const pages = went.length;
  await $('seat-pay').onclick();
  assert.equal(calls[0].url, '/api/auction/content');
  assert.deepEqual(Object.keys(JSON.parse(calls[0].init.body)).sort(), ['about', 'city', 'id', 'image', 'link', 'name', 'terms']);
  assert.equal(JSON.parse(calls[0].init.body).id, id);
  assert.equal($('seat-pay-status').textContent, 'Logon onaya gönderildi. Onaylanınca blok salonda görünür.');
  assert.equal(went.length, pages, 'no payment page');
});

test('choosing a normal place, or leaving the panel, ends the winner mode', () => {
  buying.startWinner(`b-${'6'.repeat(24)}`);
  view('seats'); place(); key('Enter');
  assert.deepEqual([$('seat-pay').textContent, $('seat-again').hidden], ['Ödemeye geç', false]);
  buying.startWinner(`b-${'6'.repeat(24)}`);
  view('home');
  assert.deepEqual([$('seat-pay').textContent, $('seat-again').hidden], ['Ödemeye geç', false]);
});
