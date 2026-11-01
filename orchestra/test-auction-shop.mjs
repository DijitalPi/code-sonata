// The front-block auction over HTTP in this process: the shop with a fake Stripe (its fetch) and a clock the test moves.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { Readable } from 'node:stream';
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

test('a hold Stripe could not let go is tried again at the next sweep', async () => {
  const f = await bid(2700);
  fail = { path: /\/cancel$/, status: 500 };
  try { await hold(f); } finally { fail = null; }
  const passed = (await panel('state', { cookie }).then((r) => r.json())).auction.bids.find((b) => b.state === 'outbid' && b.releasing);
  assert.ok(passed, 'still marked to let go');
  await shop.auctionSweep(clock);
  assert.equal(intents.get(passed.payment).status, 'canceled');
});

test('a bid in the last ten minutes moves the end on', async () => {
  const { endsAt } = await get('/api/auction');
  clock = endsAt - 5 * MIN;
  const g = await bid(2800); await hold(g);
  assert.equal((await get('/api/auction')).endsAt, clock + 10 * MIN);
});

test('at the end the top bid is captured once, even when the answer was lost', async () => {
  const { endsAt, current } = await get('/api/auction');
  clock = endsAt + MIN;
  fail = { path: /\/capture$/, status: 500 };
  try { await shop.auctionSweep(clock); } finally { fail = null; }
  assert.equal((await get('/api/auction')).state, 'capturing');
  const top = (await panel('state', { cookie }).then((r) => r.json())).auction.bids.find((b) => b.state === 'top');
  intents.get(top.payment).status = 'succeeded';            // Stripe did capture; only the answer was lost
  await shop.auctionSweep(clock + MIN);
  assert.equal((await get('/api/auction')).state, 'won');
  const captures = calls.filter((c) => c.path === `/v1/payment_intents/${top.payment}/capture`);
  assert.ok(captures.every((c) => c.key === `capture-${top.id}`));
  assert.match(slack.at(-1), new RegExp(`Açık artırma bitti: ${current} \\$`));
  assert.equal(await state(top), 'winner');
});

test('a capture Stripe refuses fails the auction; the panel can close it and start again', async () => {
  const other = createShop({ env: { ...env, AUCTION_FILE: join(dir, 'other.json'), ORDERS_FILE: join(dir, 'other-orders.json') }, log: () => {}, fetch: fakeFetch });
  const t = clock + DAY;
  const mine = http.createServer(async (req, res) => { if (!(await other.handle(req, res, new URL(req.url, 'http://local'), { foreign: false, key: `ip-${Math.random()}`, now: t, site: 'https://o.test' }))) { res.writeHead(404); res.end(); } });
  await new Promise((resolve) => mine.listen(0, '127.0.0.1', resolve));
  const at = `http://127.0.0.1:${mine.address().port}`;
  try {
    const login = await fetch(`${at}/api/yonetim/login`, { method: 'POST', headers: { 'x-yonetim': '1' }, body: JSON.stringify({ key: SELIM }) });
    const c2 = login.headers.get('set-cookie').split(';')[0];
    const p = (path) => fetch(`${at}/api/yonetim/${path}`, { method: 'POST', headers: { 'x-yonetim': '1', cookie: c2 } });
    assert.equal((await p('auction/start')).status, 200);
    const made = await (await fetch(`${at}/api/auction/bid`, { method: 'POST', body: JSON.stringify({ amount: 2400, terms: true }) })).json();
    const cs = made.url.split('/').pop(), raw = JSON.stringify({ id: 'evt_r', type: 'checkout.session.completed', data: { object: { id: cs, metadata: { bid: made.id }, payment_intent: sessions.get(cs), customer_details: {} } } });
    await fetch(`${at}/api/stripe`, { method: 'POST', headers: { 'stripe-signature': sign(raw, WEBHOOK, Math.floor(t / 1000)) }, body: raw });
    intents.get(sessions.get(cs)).status = 'canceled';         // the hold ran out
    await other.auctionSweep(t + 6 * DAY);
    assert.equal(other.seatsPayload().auction.state, 'failed');
    assert.match(slack.at(-1), /tahsilatı başarısız/);
    assert.equal((await p('auction/close')).status, 200);
    assert.equal(other.seatsPayload().auction.state, 'unsold');
    assert.ok(!other.seatsPayload().reserved.some((b) => b.width === 24), 'the block is on normal sale again');
  } finally { mine.close(); }
});

test('only the winning bid sends the logo; it waits for approval, then the 24-wide block is in the hall', async () => {
  const bids = (await panel('state', { cookie }).then((r) => r.json())).auction.bids;
  const win = bids.find((b) => b.state === 'winner'), lost = bids.find((b) => b.state === 'outbid');
  const send = (id, extra = {}) => post('/api/auction/content', { id, name: 'Acme', link: 'https://acme.example', image: webp(480, 120), terms: true, ...extra });
  assert.equal((await send(lost.id)).status, 409);
  assert.equal((await send(win.id, { terms: false })).status, 400);
  assert.equal((await send(win.id, { image: 'data:image/png;base64,iVBORw0KGgo=' })).status, 400);
  const first = await (await send(win.id)).json();
  assert.equal((await send(win.id, { name: 'Acme Ltd' })).status, 200, 'sent again before approval');
  const s = await panel('state', { cookie }).then((r) => r.json());
  const order = s.orders.find((o) => o.id === first.order);
  assert.deepEqual([order.state, order.name, order.amount, order.payment, order.width], ['paid', 'Acme Ltd', win.amount * 100, win.payment, 24]);
  assert.equal(s.auction.auction.order, first.order);
  assert.equal((await get(`/api/auction/bid/${win.id}`)).content, true);
  assert.equal(shop.seatsPayload().auction.state, 'won', 'the hall says sold, awaiting approval');
  assert.equal((await panel(`orders/${first.order}/approve`, { cookie, method: 'POST' })).status, 200);
  assert.ok(shop.seatsPayload().seats.some((x) => x.id === first.order && x.width === 24));
  assert.ok(!shop.seatsPayload().reserved.some((b) => b.width === 24), 'the order holds the block now, not the auction');
  assert.equal(shop.seatsPayload().auction, null, 'the hall shows the logo now, not the auction');
});

test('the auction is read back from its file after a restart', async () => {
  const before = { view: await get('/api/auction'), payload: shop.seatsPayload() };
  shop = createShop({ env, log: () => {}, fetch: fakeFetch });
  assert.deepEqual(await get('/api/auction'), before.view);
  assert.deepEqual(shop.seatsPayload(), before.payload);
  assert.ok(!(await readFile(env.AUCTION_FILE, 'utf8')).includes('ipKey'));
});

// ---------- one shop per case, from a file the test writes (Codex review, B1–B4) ----------
const FT = Date.UTC(2026, 10, 20, 12, 0), BIDX = `b-${'7'.repeat(24)}`, AIDX = `a-${'7'.repeat(24)}`;
const saved = (state) => ({ auction: { id: AIDX, state, startedAt: FT - 1000, startedBy: 'selim', endsAt: FT + 1000, hardEnd: FT + 100_000, top: BIDX,
  endedAt: state === 'open' ? null : FT, capturedAt: null, failedAt: null, order: null },
  bids: [{ id: BIDX, amount: 2400, state: state === 'won' ? 'winner' : 'top', payment: 'pi_old', session: 'cs_old', email: 'w@acme.example',
    createdAt: FT - 1000, settledAt: FT - 500, releasing: false }], past: [] });
const offline = async () => { throw new Error('no network in this case'); };
function fixture(data, stripeFetch = offline, book = null) {
  const at = mkdtempSync(join(tmpdir(), 'auction-case-'));
  const caseEnv = { ...env, SEATS_DIR: at, ORDERS_FILE: join(at, 'orders.json'), AUCTION_FILE: join(at, 'auction.json'), SLACK_WEBHOOK_URL: '' };
  writeFileSync(caseEnv.AUCTION_FILE, JSON.stringify(data));
  if (book) writeFileSync(caseEnv.ORDERS_FILE, JSON.stringify(book));
  const one = createShop({ env: caseEnv, log: () => {}, fetch: stripeFetch });
  // A request straight into the shop, no socket: body, headers and the answer it writes.
  async function request(path, payload, headers = {}, method = 'POST', now = FT) {
    const req = Object.assign(Readable.from(payload == null ? [] : [Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload))]), { method, headers });
    const out = {};
    const res = { headersSent: false, writeHead(status, h) { out.status = status; out.headers = h; }, end(b) { out.body = b ? JSON.parse(b) : {}; } };
    await one.handle(req, res, new URL(path, 'http://local'), { foreign: false, key: 'ip-case', now, site: 'https://o.test' });
    return out;
  }
  const login = async () => (await request('/api/yonetim/login', { key: SELIM }, { 'x-yonetim': '1' })).headers['set-cookie'].split(';')[0];
  return { shop: one, env: caseEnv, at, request, login, read: () => JSON.parse(readFileSync(caseEnv.AUCTION_FILE, 'utf8')),
    orders: () => JSON.parse(readFileSync(caseEnv.ORDERS_FILE, 'utf8')).orders, clear: () => rmSync(at, { recursive: true, force: true }) };
}
const logo = { name: 'Acme', link: 'https://acme.example', image: webp(120, 40), terms: true };

test('two first logos sent at once make one order (B1)', async () => {
  const f = fixture(saved('won'));
  try {
    const [a, b] = await Promise.all([f.request('/api/auction/content', { id: BIDX, ...logo }), f.request('/api/auction/content', { id: BIDX, ...logo })]);
    assert.deepEqual([a.status, b.status], [200, 200]);
    assert.equal(f.orders().length, 1);
    assert.equal(f.read().auction.order, f.orders()[0].id);
  } finally { f.clear(); }
});

test('a capture whose answer was lost is never failed by a refused retry; the block stays off sale (B2)', async () => {
  let n = 0;
  const f = fixture(saved('open'), async () => { if (++n === 1) throw new Error('answer lost'); return reply(401, { error: { message: 'invalid key' } }); });
  try {
    await f.shop.auctionSweep(FT + 2000);
    assert.equal(f.read().auction.state, 'capturing');
    await f.shop.auctionSweep(FT + 3000);
    assert.equal(f.read().auction.state, 'capturing');
    assert.ok(f.shop.seatsPayload().reserved.some((b) => b.width === 24));
  } finally { f.clear(); }
});

test('a page of an earlier auction paid after a new one started is let go at once (B3)', async () => {
  const data = saved('unsold');
  data.auction.top = null; data.bids[0].state = 'pending'; data.bids[0].settledAt = null;
  let cancels = 0;
  const f = fixture(data, async (url) => { if (url.endsWith('/cancel')) cancels++; return reply(200, { id: 'pi_old', status: 'requires_capture', amount_capturable: 240000, currency: 'usd' }); });
  try {
    assert.equal((await f.request('/api/yonetim/auction/start', {}, { cookie: await f.login(), 'x-yonetim': '1' })).status, 200);
    const raw = JSON.stringify({ id: 'evt_old', type: 'checkout.session.completed', data: { object: { id: 'cs_old', metadata: { bid: BIDX }, payment_intent: 'pi_old', customer_details: {} } } });
    assert.equal((await f.request('/api/stripe', raw, { 'stripe-signature': sign(raw, WEBHOOK, Math.floor(FT / 1000)) })).status, 200);
    assert.equal(cancels, 1);
    assert.equal((await f.request(`/api/auction/bid/${BIDX}`, null, {}, 'GET')).body.state, 'late');
  } finally { f.clear(); }
});

test('a logo the server turns down leaves the winner free to send again; until approval it may be changed (B4)', async () => {
  const f = fixture(saved('won'));
  try {
    const bad = await f.request('/api/auction/content', { id: BIDX, ...logo, name: '' });
    assert.deepEqual([bad.status, bad.body.error], [400, 'holder']);
    assert.equal((await f.request(`/api/auction/bid/${BIDX}`, null, {}, 'GET')).body.content, false);
    assert.equal((await f.request('/api/auction/content', { id: BIDX, ...logo })).status, 200);
    const view = (await f.request(`/api/auction/bid/${BIDX}`, null, {}, 'GET')).body;
    assert.deepEqual([view.content, view.editable], [true, true]);
    assert.equal((await f.request(`/api/yonetim/orders/${f.orders()[0].id}/approve`, {}, { cookie: await f.login(), 'x-yonetim': '1' })).status, 200);
    assert.equal((await f.request(`/api/auction/bid/${BIDX}`, null, {}, 'GET')).body.editable, false, 'live: no more changes');
  } finally { f.clear(); }
});

test('the order a won auction already points to is the one the logo updates, whatever its id (B1)', async () => {
  const data = saved('won'), other = `o-${'2'.repeat(24)}`;
  data.auction.order = other;
  const book = { orders: [{ id: other, state: 'paid', ...AUCTION.block, name: 'Acme', link: 'https://acme.example/', amount: 240000, currency: 'usd',
    email: null, session: null, payment: 'pi_old', created: FT, heldUntil: FT, paidAt: FT, decidedAt: null, decidedBy: null, reason: null,
    refunded: false, refunding: false, refund: null, auction: true }], events: [] };
  const f = fixture(data, offline, book);
  try {
    assert.equal((await f.request('/api/auction/content', { id: BIDX, ...logo, name: 'Acme Ltd' })).status, 200);
    assert.deepEqual(f.orders().map((o) => [o.id, o.name]), [[other, 'Acme Ltd']]);
    assert.equal(f.shop.seatsPayload().reserved.filter((b) => b.width === 24).length, 1, 'the order holds the block, once');
  } finally { f.clear(); }
});

test('a page of the last auction paid long after it ran out is still let go; it can be closed too (B3)', async () => {
  const data = saved('unsold');
  data.auction.top = null;
  data.bids = [{ ...data.bids[0], state: 'pending', settledAt: null },
    { ...data.bids[0], id: `b-${'6'.repeat(24)}`, session: 'cs_open', payment: null, state: 'pending', settledAt: null }];
  let cancels = 0, closed = 0;
  const f = fixture(data, async (url) => {
    if (url.endsWith('/cancel')) cancels++;
    if (url.endsWith('/expire')) { closed++; return reply(200, { id: 'cs_open', status: 'expired' }); }
    return reply(200, { id: 'pi_old', status: 'requires_capture', amount_capturable: 240000, currency: 'usd' });
  });
  try {
    assert.equal((await f.request('/api/yonetim/auction/start', {}, { cookie: await f.login(), 'x-yonetim': '1' })).status, 200);
    assert.equal((await f.request(`/api/auction/bid/b-${'6'.repeat(24)}/cancel`, {})).status, 200, 'an open page of the last auction can be closed');
    assert.equal(closed, 1);
    const late = FT + 60 * MIN;
    await f.shop.auctionSweep(late);
    const raw = JSON.stringify({ id: 'evt_late', type: 'checkout.session.completed', data: { object: { id: 'cs_old', metadata: { bid: BIDX }, payment_intent: 'pi_old', customer_details: {} } } });
    assert.equal((await f.request('/api/stripe', raw, { 'stripe-signature': sign(raw, WEBHOOK, Math.floor(late / 1000)) }, 'POST', late)).status, 200);
    assert.equal(cancels, 1);
  } finally { f.clear(); }
});

test('a logo that could not be written is not taken for one; sent again, it is (B4)', async () => {
  const f = fixture(saved('won'));
  try {
    const target = join(f.at, 'pending', `o-${AIDX.slice(2)}.webp`);
    mkdirSync(target, { recursive: true });                    // the logo's place cannot take a file
    assert.equal((await f.request('/api/auction/content', { id: BIDX, ...logo })).status, 500);
    const view = (await f.request(`/api/auction/bid/${BIDX}`, null, {}, 'GET')).body;
    assert.deepEqual([view.content, view.editable], [false, true]);
    rmSync(target, { recursive: true });
    assert.equal((await f.request('/api/auction/content', { id: BIDX, ...logo })).status, 200);
    assert.equal((await f.request(`/api/auction/bid/${BIDX}`, null, {}, 'GET')).body.content, true);
  } finally { f.clear(); }
});

test('an order found by its payment gets the logo and the pointer of the auction under its own id (C1)', async () => {
  const other = `o-${'3'.repeat(24)}`;
  const book = { orders: [{ id: other, state: 'paid', ...AUCTION.block, name: 'Acme', link: 'https://acme.example/', amount: 240000, currency: 'usd',
    email: null, session: null, payment: 'pi_old', created: FT, heldUntil: FT, paidAt: FT, decidedAt: null, decidedBy: null, reason: null,
    refunded: false, refunding: false, refund: null, auction: true }], events: [] };
  const f = fixture(saved('won'), offline, book);   // the auction lost its pointer; the order is known by its payment only
  try {
    const sent = await f.request('/api/auction/content', { id: BIDX, ...logo });
    assert.deepEqual([sent.status, sent.body.order, f.read().auction.order], [200, other, other]);
    assert.equal((await f.request(`/api/auction/bid/${BIDX}`, null, {}, 'GET')).body.content, true);
    assert.equal((await f.request(`/api/yonetim/orders/${other}/approve`, {}, { cookie: await f.login(), 'x-yonetim': '1' })).status, 200);
  } finally { f.clear(); }
});
