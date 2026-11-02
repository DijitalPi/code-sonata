// Coupons over HTTP with the shop in this process: a fake Stripe and Slack, and a clock the test moves.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sign } from './stripe.mjs';
import { createShop } from './shop.mjs';
import { TIERS, blockPrice } from './web/seats.mjs';

const WEBHOOK = 'whsec_coupon', SELIM = 's'.repeat(30), HOUR = 3_600_000;
let clock = Date.UTC(2026, 10, 3, 9, 0), n = 0;
const calls = [], slack = [];
const reply = (status, data) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
async function fakeFetch(url, init = {}) {
  const u = new URL(url);
  if (u.hostname === 'slack.test') { slack.push(JSON.parse(init.body).text); return new Response('ok'); }
  calls.push({ path: u.pathname, body: new URLSearchParams(init.body || '') });
  if (u.pathname === '/v1/checkout/sessions') return reply(200, { id: `cs_${++n}`, url: `https://checkout.stripe.test/cs_${n}` });
  if (u.pathname === '/v1/refunds') return reply(200, { id: `re_${++n}`, status: 'succeeded' });
  return reply(404, { error: { message: 'unknown' } });
}
const dir = await mkdtemp(join(tmpdir(), 'coupon-'));
const env = { SEATS_DIR: dir, ORDERS_FILE: join(dir, 'orders.json'), STRIPE_SECRET_KEY: 'sk_test_c', STRIPE_WEBHOOK_SECRET: WEBHOOK,
  STRIPE_API_BASE: 'https://stripe.test', SLACK_WEBHOOK_URL: 'https://slack.test/hook', ADMIN_KEYS: `selim:${SELIM}`, PUBLIC_URL: 'https://orchestra.example.test' };
const shop = createShop({ env, log: () => {}, fetch: fakeFetch });
const server = http.createServer(async (req, res) => {
  const mine = await shop.handle(req, res, new URL(req.url, 'http://local'), { foreign: false, key: req.headers['x-ip'] || 'ip-0', now: clock, site: 'https://orchestra.example.test' });
  if (!mine) { res.writeHead(404); res.end(); }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
after(async () => { server.close(); await rm(dir, { recursive: true, force: true }); });

const panel = (path, { cookie, method = 'GET', body } = {}) => fetch(`${base}/api/yonetim/${path}`, { method, body: body && JSON.stringify(body),
  headers: { 'x-yonetim': '1', 'content-type': 'application/json', ...(cookie ? { cookie } : {}) } });
const cookie = (await panel('login', { method: 'POST', body: { key: SELIM } })).headers.get('set-cookie').split(';')[0];
const open = (code, tier, max = 5, days = 7) => panel('coupon', { cookie, method: 'POST', body: { code, tier, max, days } });
const state = async () => (await panel('state', { cookie })).json();
const usesOf = async (code) => (await state()).coupons.find((c) => c.code === code).used;
const post = (path, body, ip = 'ip-0') => fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-ip': ip }, body: JSON.stringify(body) });
function webp(w, h, extra = 64) {   // as in test-shop.mjs
  const body = Buffer.alloc(10 + extra); body.set([0x9d, 0x01, 0x2a], 3); body.writeUInt16LE(w, 6); body.writeUInt16LE(h, 8);
  const chunk = Buffer.concat([Buffer.from('VP8 '), Buffer.alloc(4), body]); chunk.writeUInt32LE(body.length, 4);
  const head = Buffer.alloc(12); head.write('RIFF'); head.writeUInt32LE(4 + chunk.length, 4); head.write('WEBP', 8);
  return `data:image/webp;base64,${Buffer.concat([head, chunk]).toString('base64')}`;
}
const seat = (t, col, width = 1, depth = 1) => ({ ring: TIERS[t].rings[0], col, width, depth });
let ip = 0;
const buy = (block, coupon, from = `ip-${++ip}`) =>
  post('/api/seats/checkout', { block, coupon, name: 'Acme', link: 'https://acme.example', image: webp(480, 240), terms: true }, from);
const event = (type, object) => {
  const raw = JSON.stringify({ id: `evt_${Math.random()}`, type, data: { object } });
  return fetch(`${base}/api/stripe`, { method: 'POST', headers: { 'stripe-signature': sign(raw, WEBHOOK, Math.floor(clock / 1000)) }, body: raw });
};
const completed = (order, amount) => event('checkout.session.completed', { id: 'cs_x', object: 'checkout.session', payment_status: 'paid',
  amount_total: amount, currency: 'usd', client_reference_id: order, metadata: { order }, payment_intent: `pi_${order}`, customer_details: { email: 'ali@acme.example' } });

test('the panel opens a code, refuses a bad or repeated one, lists it with its uses, and stops it', async () => {
  assert.equal((await panel('coupon', { method: 'POST', body: { code: 'X-1', tier: 'any', max: 1, days: 1 } })).status, 401);
  const res = await open('linkedin', 'middle', 50, 7);
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).coupon, { code: 'LINKEDIN', tier: 'middle', max: 50, until: clock + 7 * 24 * HOUR, stopped: false,
    created: clock, by: 'selim', used: 0, state: 'open' });
  for (const [body, status, error] of [[{ code: 'LINKEDIN', tier: 'any', max: 1, days: 1 }, 409, 'exists'], [{ code: 'a b', tier: 'any', max: 1, days: 1 }, 400, 'code'],
    [{ code: 'Y-1', tier: 'vip', max: 1, days: 1 }, 400, 'tier'], [{ code: 'Y-1', tier: 'any', max: 0, days: 1 }, 400, 'max'], [{ code: 'Y-1', tier: 'any', max: 1, days: 0 }, 400, 'days']]) {
    const bad = await panel('coupon', { cookie, method: 'POST', body });
    assert.deepEqual([bad.status, (await bad.json()).error], [status, error], JSON.stringify(body));
  }
  assert.deepEqual((await state()).coupons.map((c) => [c.code, c.used, c.state]), [['LINKEDIN', 0, 'open']]);
  assert.equal((await panel('coupon/LINKEDIN/stop', { cookie, method: 'POST' })).status, 200);
  assert.equal((await state()).coupons[0].state, 'stopped');
  assert.equal((await panel('coupon/YOK-1/stop', { cookie, method: 'POST' })).status, 404);
});

test('a code is checked without holding anything; ten wrong codes an hour from one address are enough', async () => {
  await open('HER', 'any', 5);
  const ok = await post('/api/seats/coupon', { code: ' her ' }, 'ip-check');
  assert.deepEqual([ok.status, await ok.json()], [200, { code: 'HER', tier: 'any' }]);
  assert.equal(await usesOf('HER'), 0);
  assert.equal((await post('/api/seats/coupon', { code: 'LINKEDIN' }, 'ip-check')).status, 400, 'a stopped code reads as no code');
  for (let i = 0; i < 10; i++) assert.equal((await post('/api/seats/coupon', { code: `YOK-${i}` }, 'ip-guess')).status, 400);
  assert.equal((await post('/api/seats/coupon', { code: 'HER' }, 'ip-guess')).status, 429, 'even a right code, once guessing');
  assert.equal((await buy(seat(2, 0), 'HER', 'ip-guess')).status, 429);
  clock += HOUR + 1;
  assert.equal((await post('/api/seats/coupon', { code: 'HER' }, 'ip-guess')).status, 200);
});

test('one seat with a code is free: no Stripe page, it waits for approval, and Slack says so', async () => {
  await open('ARKA', 'back', 3);
  const before = calls.length;
  const res = await buy(seat(2, 10), 'arka');
  assert.equal(res.status, 200);
  const { id, free, url } = await res.json();
  assert.deepEqual([free, url], [true, undefined]);
  assert.equal(calls.length, before, 'Stripe is not asked');
  const order = (await state()).orders.find((o) => o.id === id);
  assert.deepEqual([order.state, order.amount, order.coupon, order.discount, order.payment], ['paid', 0, 'ARKA', TIERS[2].price * 100, null]);
  assert.deepEqual(await (await fetch(`${base}/api/seats/order/${id}`)).json(), { state: 'paid', free: true });
  assert.equal(slack.at(-1), 'Kuponla bedava koltuk: Acme · Arka · 1 koltuk · 0 $ · kupon ARKA. Onay bekliyor: https://orchestra.example.test/yonetim/#bekleyen');
  assert.equal(await usesOf('ARKA'), 1);
  assert.ok(shop.seatsPayload().reserved.some((b) => b.ring === TIERS[2].rings[0] && b.col === 10));
});

test('a bigger block with a code pays all but one seat on Stripe, and that payment matches', async () => {
  await open('ONSIRA', 'front', 3);
  const block = seat(0, 30, 2, 2), amount = blockPrice(block) * 100 - TIERS[0].price * 100;
  const { id, url } = await (await buy(block, 'ONSIRA')).json();
  assert.ok(url);
  const call = calls.at(-1);
  assert.equal(call.body.get('line_items[0][price_data][unit_amount]'), String(amount));
  assert.match(call.body.get('line_items[0][price_data][product_data][name]'), / · 4 seats \(1 free\)$/);
  assert.equal((await completed(id, amount)).status, 200);
  assert.equal((await state()).orders.find((o) => o.id === id).state, 'paid');
  assert.match(slack.at(-1), /^Yeni koltuk satışı: Acme · Ön sıra · 4 koltuk · 75 \$ · kupon ONSIRA\. /);
});

test("an address uses one coupon a day, a code's last use goes to one buyer, and a code works only on its tier", async () => {
  await open('TEK', 'any', 1);
  await open('IKI', 'any', 5);
  assert.equal((await buy(seat(2, 40), 'TEK', 'ip-day')).status, 200);
  const again = await buy(seat(2, 42), 'IKI', 'ip-day');
  assert.deepEqual([again.status, (await again.json()).error], [429, 'again']);
  const late = await buy(seat(2, 44), 'TEK', 'ip-other');
  assert.deepEqual([late.status, (await late.json()).error], [409, 'used']);
  const tier = await buy(seat(0, 60), 'ARKA', 'ip-tier');
  assert.deepEqual([tier.status, (await tier.json()).error], [400, 'tier']);
  assert.equal((await buy(seat(2, 46), undefined, 'ip-day')).status, 200, 'without a code the same address still buys');
  clock += 24 * HOUR;
  assert.equal((await buy(seat(2, 48), 'IKI', 'ip-day')).status, 200);
});

test('rejecting or removing a free order asks Stripe for no refund; its use comes back', async () => {
  await open('GERI', 'any', 1);
  const { id } = await (await buy(seat(2, 70), 'GERI')).json();
  const before = calls.length;
  const res = await panel(`orders/${id}/reject`, { cookie, method: 'POST', body: { reason: 'logo' } });
  assert.equal(res.status, 200);
  const { order } = await res.json();
  assert.deepEqual([order.state, order.refunded, order.refund], ['refunded', false, null]);
  assert.equal(await usesOf('GERI'), 0);
  assert.deepEqual(await (await fetch(`${base}/api/seats/order/${id}`)).json(), { state: 'refunded', free: true });
  assert.equal((await buy(seat(2, 72), 'GERI')).status, 200, 'the use came back');
  const second = (await state()).orders.find((o) => o.coupon === 'GERI' && o.state === 'paid');
  assert.equal((await panel(`orders/${second.id}/approve`, { cookie, method: 'POST' })).status, 200);
  const gone = await panel(`orders/${second.id}/remove`, { cookie, method: 'POST', body: { refund: true } });
  assert.deepEqual([gone.status, (await gone.json()).order.refunded], [200, false]);
  assert.equal(calls.length, before, 'Stripe is never asked');
});
