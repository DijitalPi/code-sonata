// The front-block auction over HTTP in this process: the shop with a fake Stripe (its fetch) and a clock the test moves.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sign } from './stripe.mjs';
import { createShop } from './shop.mjs';
import { AUCTION } from './web/seats.mjs';

const WEBHOOK = 'whsec_auction', SELIM = 's'.repeat(30), DAY = 86_400_000, MIN = 60_000;
let clock = Date.UTC(2026, 10, 2, 12, 0);
const calls = [], intents = new Map(), sessions = new Map(), slack = [];
let fail = null, n = 0;   // fail: { path: RegExp, status, code } makes matching Stripe calls fail
const reply = (status, data) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
async function fakeFetch(url, init = {}) {
  const u = new URL(url), path = u.pathname, body = new URLSearchParams(init.body || '');
  if (u.hostname === 'slack.test') { slack.push(JSON.parse(init.body).text); return new Response('ok'); }
  calls.push({ path, method: init.method || 'GET', body, key: init.headers?.['idempotency-key'] });
  if (fail?.path.test(path)) return reply(fail.status, { error: { message: 'no', code: fail.code } });
  if (path === '/v1/checkout/sessions') {
    const cs = `cs_${++n}`, pi = `pi_${n}`;
    sessions.set(cs, pi);
    intents.set(pi, { id: pi, status: 'requires_capture', amount_capturable: Number(body.get('line_items[0][price_data][unit_amount]')), currency: 'usd' });
    return reply(200, { id: cs, url: `https://checkout.stripe.test/${cs}` });
  }
  let m = path.match(/^\/v1\/payment_intents\/(pi_\d+)(\/cancel|\/capture)?$/);
  if (m) {
    const pi = intents.get(m[1]);
    if (m[2] && pi.status !== 'requires_capture') return reply(400, { error: { message: 'state', code: 'payment_intent_unexpected_state' } });
    if (m[2]) pi.status = m[2] === '/cancel' ? 'canceled' : 'succeeded';
    return reply(200, pi);
  }
  if ((m = path.match(/^\/v1\/checkout\/sessions\/(cs_\d+)\/expire$/))) return reply(200, { id: m[1], status: 'expired' });
  return reply(404, { error: { message: 'unknown' } });
}

const dir = await mkdtemp(join(tmpdir(), 'auction-'));
const env = { SEATS_DIR: dir, ORDERS_FILE: join(dir, 'orders.json'), AUCTION_FILE: join(dir, 'auction.json'), STRIPE_SECRET_KEY: 'sk_test_a',
  STRIPE_WEBHOOK_SECRET: WEBHOOK, STRIPE_API_BASE: 'https://stripe.test', SLACK_WEBHOOK_URL: 'https://slack.test/hook',
  ADMIN_KEYS: `selim:${SELIM}`, PUBLIC_URL: 'https://orchestra.example.test' };
let shop = createShop({ env, log: () => {}, fetch: fakeFetch });
const server = http.createServer(async (req, res) => {
  const mine = await shop.handle(req, res, new URL(req.url, 'http://local'), { foreign: req.headers['x-foreign'] === '1', key: req.headers['x-ip'] || 'ip-0', now: clock, site: 'https://orchestra.example.test' });
  if (!mine) { res.writeHead(404); res.end(); }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
after(async () => { server.close(); await rm(dir, { recursive: true, force: true }); });

const post = (path, body, headers = {}) => fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
const get = async (path) => (await fetch(`${base}${path}`)).json();
const panel = (path, { cookie, method = 'GET', body } = {}) => fetch(`${base}/api/yonetim/${path}`, { method, body: body && JSON.stringify(body),
  headers: { 'x-yonetim': '1', 'content-type': 'application/json', ...(cookie ? { cookie } : {}) } });
const cookie = (await panel('login', { method: 'POST', body: { key: SELIM } })).headers.get('set-cookie').split(';')[0];
const event = (type, object) => {
  const raw = JSON.stringify({ id: `evt_${Math.random()}`, type, data: { object } });
  return fetch(`${base}/api/stripe`, { method: 'POST', headers: { 'stripe-signature': sign(raw, WEBHOOK, Math.floor(clock / 1000)) }, body: raw });
};
let ip = 0;
async function bid(amount) {
  const res = await post('/api/auction/bid', { amount, terms: true }, { 'x-ip': `ip-${++ip}` });
  const data = await res.json();
  return { status: res.status, ...data, session: data.url?.split('/').pop() };
}
const piOf = (b) => sessions.get(b.session);
const hold = (b) => event('checkout.session.completed', { id: b.session, object: 'checkout.session', payment_status: 'unpaid',
  metadata: { bid: b.id }, payment_intent: piOf(b), customer_details: { email: `${b.id}@bidder.example` } });
const state = async (b) => (await get(`/api/auction/bid/${b.id}`)).state;

// A WebP header of the given size, with some bytes after it (as in test-shop.mjs).
function webp(w, h, extra = 64) {
  const body = Buffer.alloc(10 + extra); body.set([0x9d, 0x01, 0x2a], 3); body.writeUInt16LE(w, 6); body.writeUInt16LE(h, 8);
  const chunk = Buffer.concat([Buffer.from('VP8 '), Buffer.alloc(4), body]); chunk.writeUInt32LE(body.length, 4);
  const head = Buffer.alloc(12); head.write('RIFF'); head.writeUInt32LE(4 + chunk.length, 4); head.write('WEBP', 8);
  return `data:image/webp;base64,${Buffer.concat([head, chunk]).toString('base64')}`;
}

test('there is no auction until the panel starts one; then the block is off normal sale', async () => {
  assert.equal((await get('/api/auction')).state, null);
  assert.equal((await bid(2400)).status, 409);
  assert.equal((await post('/api/auction/bid', { amount: 2400, terms: true }, { 'x-foreign': '1' })).status, 403);
  assert.equal((await panel('auction/start', { method: 'POST' })).status, 401);
  assert.equal((await panel('auction/start', { cookie, method: 'POST' })).status, 200);
  const view = await get('/api/auction');
  assert.deepEqual([view.state, view.min, view.current, view.endsAt], ['open', 2400, null, clock + 5 * DAY]);
  assert.ok(shop.seatsPayload().reserved.some((b) => b.col === AUCTION.block.col && b.width === 24));
  assert.equal((await panel('auction/start', { cookie, method: 'POST' })).status, 409, 'one at a time');
  assert.match(slack.at(-1), /Açık artırma başladı/);
});

test('while the auction runs, no normal order may take a seat of its block', async () => {
  const res = await post('/api/seats/checkout', { block: { ring: 0, col: AUCTION.block.col + 22, width: 3, depth: 1 }, name: 'Acme',
    link: 'https://acme.example', image: webp(120, 40), terms: true }, { 'x-ip': 'ip-normal' });
  assert.deepEqual([res.status, (await res.json()).error], [409, 'taken']);
});

test('a bid opens a Stripe page that holds the card, and counts once Stripe holds it', async () => {
  assert.equal((await post('/api/auction/bid', { amount: 2400 })).status, 400, 'terms first');
  const a = await bid(2400);
  assert.equal(a.status, 200);
  const page = calls.find((c) => c.path === '/v1/checkout/sessions' && c.body.get('metadata[bid]') === a.id).body;
  assert.deepEqual([page.get('payment_intent_data[capture_method]'), page.get('line_items[0][price_data][unit_amount]')], ['manual', '240000']);
  assert.equal(await state(a), 'pending');
  assert.equal((await get('/api/auction')).current, null);
  assert.equal((await hold(a)).status, 200);
  assert.deepEqual([await state(a), (await get('/api/auction')).current, (await get('/api/auction')).min], ['top', 2400, 2500]);
  assert.equal((await hold(a)).status, 200, 'Stripe may send it again');
  assert.match(slack.at(-1), /yeni en yüksek teklif: 2400 \$/);
  const low = await bid(2450);
  assert.deepEqual([low.status, low.error, low.min], [400, 'amount', 2500]);
});

test('a higher held bid lets the lower hold go at once', async () => {
  const [a] = (await panel('state', { cookie }).then((r) => r.json())).auction.bids;
  const b = await bid(2500);
  await hold(b);
  assert.equal(await state(b), 'top');
  assert.equal(await state(a), 'outbid');
  assert.ok(calls.some((c) => c.path === `/v1/payment_intents/${a.payment}/cancel` && c.key === `release-${a.id}`));
  assert.equal(intents.get(a.payment).status, 'canceled');
});

test('a hold that came too late is let go; a page closed before paying expires its bid', async () => {
  const c = await bid(2600), d = await bid(2600);
  await hold(c); await hold(d);
  assert.deepEqual([await state(c), await state(d), intents.get(piOf(d)).status], ['top', 'late', 'canceled']);
  const e = await bid(2700);
  assert.equal((await post(`/api/auction/bid/${e.id}/cancel`, {})).status, 200);
  assert.equal(await state(e), 'expired');
  assert.ok(calls.some((c2) => c2.path === `/v1/checkout/sessions/${e.session}/expire`));
  assert.equal((await post(`/api/auction/bid/${e.id}/cancel`, {})).status, 409);
});

test('an unknown bid is not found; the shop without AUCTION_FILE has no auction', async () => {
  assert.equal((await fetch(`${base}/api/auction/bid/b-${'0'.repeat(24)}`)).status, 404);
  const closed = createShop({ env: { ...env, AUCTION_FILE: '' }, log: () => {}, fetch: fakeFetch });
  assert.equal(closed.seatsPayload().auction, null);
});
