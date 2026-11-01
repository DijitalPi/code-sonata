import { test } from 'node:test';
import assert from 'node:assert/strict';
import { install, add } from './fake-dom.mjs';

const doc = install('https://orchestra.example.test/');
const panel = add(doc.body, 'aside', { id: 'panel' });
const box = add(panel, 'div', { id: 'auction' }); box.hidden = true;
for (const id of ['auction-price', 'auction-left', 'auction-min', 'auction-status', 'auction-form']) add(box, 'div', { id });
add(box, 'input', { id: 'auction-amount' }); add(box, 'input', { id: 'auction-terms' });
add(box, 'button', { id: 'auction-bid' }); const win = add(box, 'button', { id: 'auction-win' }); win.hidden = true;
add(doc.body, 'button', { 'data-open': 'seats' });
const calls = [], went = [], winners = [];
let answer = () => ({ status: 200, body: {} });
globalThis.fetch = async (url, init = {}) => { calls.push({ url, init }); const { status, body } = answer(url, init); return new Response(JSON.stringify(body), { status }); };
let now = Date.UTC(2026, 10, 2, 12, 0);
const { setupAuction, left, backFromBid } = await import('./web/auction.js');
const auction = setupAuction({ go: (url) => went.push(url), startWinner: (id) => winners.push(id), now: () => now });
const $ = (id) => doc.getElementById(id);
const OPEN = { state: 'open', endsAt: now + 2 * 86_400_000 + 4 * 3_600_000, current: 3100, min: 3200, bids: [] };

test('the time left reads in days and hours, then hours and minutes, then minutes and seconds', () => {
  assert.deepEqual([left(2 * 86_400_000 + 4 * 3_600_000), left(3 * 3_600_000 + 12 * 60_000), left(4 * 60_000 + 5000), left(0)],
    ['2 g 4 sa', '3 sa 12 dk', '4 dk 05 sn', 'bitti']);
});

test('the box shows while the auction runs: the price now, the time left, the lowest next bid', () => {
  auction.show(OPEN);
  assert.equal($('auction').hidden, false);
  assert.deepEqual([$('auction-price').textContent, $('auction-left').textContent, $('auction-min').textContent, $('auction-amount').value],
    ['Şu an 3.100 $', '· bitişe 2 g 4 sa', 'En az 3.200 $', '3200']);
  auction.show({ ...OPEN, state: 'unsold' });
  assert.equal($('auction').hidden, true);
  auction.show(null);
  assert.equal($('auction').hidden, true);
});

test('a bid asks for the terms, then opens Stripe and remembers its id', async () => {
  auction.show(OPEN);
  $('auction-amount').value = '3200'; $('auction-terms').checked = false;
  await $('auction-bid').onclick();
  assert.match($('auction-status').textContent, /şartları/);
  $('auction-terms').checked = true;
  answer = () => ({ status: 200, body: { id: `b-${'1'.repeat(24)}`, url: 'https://checkout.stripe.test/cs_1' } });
  await $('auction-bid').onclick();
  assert.deepEqual([calls.at(-1).url, JSON.parse(calls.at(-1).init.body)], ['/api/auction/bid', { amount: 3200, terms: true }]);
  assert.deepEqual(went, ['https://checkout.stripe.test/cs_1']);
  assert.ok(JSON.parse(localStorage.getItem('teklifler')).includes(`b-${'1'.repeat(24)}`));
});

test('a price that rose meanwhile is said, with the new lowest bid', async () => {
  answer = () => ({ status: 400, body: { error: 'amount', min: 3300, max: 100000 } });
  await $('auction-bid').onclick();
  assert.deepEqual([$('auction-status').textContent, $('auction-min').textContent], ['Bu arada fiyat yükseldi: en az 3.300 $.', 'En az 3.300 $']);
});

test('back from Stripe the bidder reads what became of the bid; the address keeps it until known', async () => {
  const id = `b-${'2'.repeat(24)}`;
  history.replaceState(null, '', `/?teklif=${id}&lang=en`);
  answer = () => ({ status: 503, body: {} });
  await backFromBid({ wait: 0, tries: 2 });
  assert.equal(new URLSearchParams(location.search).get('teklif'), id);
  answer = () => ({ status: 200, body: { state: 'top', auction: 'open', amount: 3200, current: 3200, endsAt: now + 1000, content: false } });
  await backFromBid({ wait: 0, tries: 2 });
  assert.equal($('auction-status').textContent, 'Teklifin kartında bloke edildi. Şu an öndesin.');
  assert.equal(location.search, '?lang=en');
});

test('a page closed on Stripe lets the bid go', async () => {
  const id = `b-${'3'.repeat(24)}`;
  history.replaceState(null, '', `/?teklif=${id}&iptal=1`);
  answer = (url) => (url.endsWith('/cancel') ? { status: 200, body: { state: 'expired' } } : { status: 200, body: { state: 'expired', auction: 'open' } });
  await backFromBid({ wait: 0, tries: 2 });
  assert.equal(calls.at(-1).url, `/api/auction/bid/${id}/cancel`);
  assert.equal($('auction-status').textContent, 'Teklif verilmedi. Kartından bir şey bloke edilmedi.');
});

test('a remembered bid says whether it still leads; the line says when time is up', async () => {
  localStorage.setItem('teklifler', JSON.stringify([`b-${'6'.repeat(24)}`]));
  answer = () => ({ status: 200, body: { state: 'outbid', auction: 'open', amount: 3200, current: 3300, endsAt: now + 1000, content: false } });
  await auction.remembered();
  assert.equal($('auction-status').textContent, 'Daha yüksek bir teklif geldi; blokesi kaldırıldı.');
  auction.show({ ...OPEN, endsAt: now - 1 });
  assert.equal($('auction-left').textContent, '· bitti');
});

test('a remembered winning bid shows the button that opens the logo form', async () => {
  localStorage.setItem('teklifler', JSON.stringify([`b-${'4'.repeat(24)}`]));
  answer = () => ({ status: 200, body: { state: 'winner', auction: 'won', amount: 3300, current: 3300, endsAt: now, content: false } });
  await auction.remembered();
  assert.equal($('auction').hidden, false);
  assert.equal($('auction-win').hidden, false);
  $('auction-win').onclick();
  assert.deepEqual(winners, [`b-${'4'.repeat(24)}`]);
  auction.stop();
});
