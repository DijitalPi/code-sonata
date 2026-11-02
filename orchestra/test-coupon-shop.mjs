// Coupons over HTTP with the shop in this process: a fake Stripe and Slack, and a clock the test moves.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createShop } from './shop.mjs';

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
