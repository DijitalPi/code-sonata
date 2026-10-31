// Selling seats end to end over HTTP: the real server, a fake Stripe and a fake Slack on this machine.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import http from 'node:http';
import { mkdir, mkdtemp, readFile, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sign } from './stripe.mjs';
import { createShop } from './shop.mjs';
import { TIERS, blockPrice } from './web/seats.mjs';

const PORT = 4530, base = `http://127.0.0.1:${PORT}`;
const WEBHOOK = 'whsec_test_shop', SELIM = 's'.repeat(30), OZER = 'z'.repeat(30);

// Fake Stripe: records every call, answers a session or a refund, or fails when told to.
const stripeCalls = [];
let stripeFails = false, pause = null;   // stripeFails: true (500) or a status; pause: { path, until } holds that call's answer
const stripe = http.createServer(async (req, res) => {
  let body = ''; for await (const chunk of req) body += chunk;
  stripeCalls.push({ path: req.url, headers: req.headers, body: new URLSearchParams(body) });
  if (stripeFails === 'hang up') return req.socket.destroy();
  if (stripeFails) { res.writeHead(stripeFails === true ? 500 : stripeFails); return res.end('{"error":{"message":"down"}}'); }
  if (pause && req.url === pause.path) await pause.until;
  const n = stripeCalls.length;
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(req.url === '/v1/refunds' ? { id: `re_${n}` } : { id: `cs_${n}`, url: `https://checkout.stripe.test/c/cs_${n}` }));
});
const slackPosts = [];
const slack = http.createServer(async (req, res) => {
  let body = ''; for await (const chunk of req) body += chunk;
  slackPosts.push(JSON.parse(body)); res.writeHead(200); res.end('ok');
});
await Promise.all([new Promise((r) => stripe.listen(0, '127.0.0.1', r)), new Promise((r) => slack.listen(0, '127.0.0.1', r))]);

const dir = await mkdtemp(join(tmpdir(), 'shop-'));
const env = {
  TRUST_PROXY: '1', SEATS_DIR: dir, SEATS_FILE: join(dir, 'seats.json'), ORDERS_FILE: join(dir, 'orders.json'),
  STRIPE_SECRET_KEY: 'sk_test_shop', STRIPE_WEBHOOK_SECRET: WEBHOOK, STRIPE_API_BASE: `http://127.0.0.1:${stripe.address().port}`,
  SLACK_WEBHOOK_URL: `http://127.0.0.1:${slack.address().port}/hook`, ADMIN_KEYS: `selim:${SELIM},ozer:${OZER}`, PUBLIC_URL: 'https://orchestra.example.test',
};
await writeFile(env.SEATS_FILE, JSON.stringify({ seats: [{ id: 'hand', ring: TIERS[0].rings[0], col: 100, width: 2, depth: 1, name: 'Hand', link: 'https://hand.example/' }] }));

async function start(port, extra) {
  const child = spawn(process.execPath, ['orchestra/server.mjs'], { env: { ...process.env, PORT: String(port), ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => { child.stdout.on('data', (x) => { if (String(x).includes('Agent Orchestra')) resolve(); }); child.once('exit', (code) => reject(new Error(`server exited ${code}`))); });
  return child;
}
let server = await start(PORT, env);
after(async () => { server.kill(); stripe.close(); slack.close(); await rm(dir, { recursive: true, force: true }); });

// A WebP header of the given size, with some bytes after it like a real file.
function webp(w, h, extra = 64) {
  const body = Buffer.alloc(10 + extra); body.set([0x9d, 0x01, 0x2a], 3); body.writeUInt16LE(w, 6); body.writeUInt16LE(h, 8);
  const chunk = Buffer.concat([Buffer.from('VP8 '), Buffer.alloc(4), body]); chunk.writeUInt32LE(body.length, 4);
  const head = Buffer.alloc(12); head.write('RIFF'); head.writeUInt32LE(4 + chunk.length, 4); head.write('WEBP', 8);
  return `data:image/webp;base64,${Buffer.concat([head, chunk]).toString('base64')}`;
}
const front = TIERS[0].rings[0];
const block = (col, width = 3, depth = 2) => ({ ring: front, col, width, depth });
let address = 0;
const buy = (extra = {}, headers = {}) => fetch(`${base}/api/seats/checkout`, {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': `10.0.0.${++address}`, ...headers },
  body: JSON.stringify({ block: block(0), name: 'Acme', link: 'https://acme.example', image: webp(480, 240), terms: true, ...extra }),
});
const seats = async () => (await fetch(`${base}/api/seats`)).json();
const event = (type, object, t = Math.floor(Date.now() / 1000)) => {
  const raw = JSON.stringify({ id: `evt_${Math.random()}`, type, data: { object } });
  return fetch(`${base}/api/stripe`, { method: 'POST', headers: { 'stripe-signature': sign(raw, WEBHOOK, t), 'content-type': 'application/json' }, body: raw });
};
const completed = (order, amount, extra = {}) => event('checkout.session.completed', {
  id: 'cs_x', object: 'checkout.session', payment_status: 'paid', amount_total: amount, currency: 'usd',
  client_reference_id: order, metadata: { order }, payment_intent: `pi_${order}`, customer_details: { email: 'ali@acme.example' }, ...extra,
});
const panel = (path, { cookie, method = 'GET', body, headers = {} } = {}) => fetch(`${base}/api/yonetim/${path}`, {
  method, headers: { 'x-yonetim': '1', 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...headers }, body: body && JSON.stringify(body),
});
// Five sign-ins a minute per address: tests past the fifth come from another one.
async function login(key = SELIM, from = '10.9.9.9') {
  const res = await panel('login', { method: 'POST', body: { key }, headers: { 'x-forwarded-for': from } });
  return { res, cookie: res.headers.get('set-cookie')?.split(';')[0] };
}

test('without payment settings the page keeps saying payment is not open, and the panel does not exist', async () => {
  const child = await start(PORT + 1, { SEATS_FILE: env.SEATS_FILE });
  try {
    const p = `http://127.0.0.1:${PORT + 1}`;
    assert.equal((await (await fetch(`${p}/api/seats`)).json()).checkout, false);
    assert.equal((await fetch(`${p}/api/seats/checkout`, { method: 'POST', body: '{}' })).status, 404);
    assert.equal((await fetch(`${p}/api/stripe`, { method: 'POST', body: '{}' })).status, 404);
    assert.equal((await fetch(`${p}/yonetim/`)).status, 404);
    assert.equal((await fetch(`${p}/api/yonetim/state`)).status, 404);
  } finally { child.kill(); await once(child, 'exit'); }
});

test('checkout holds the block and opens a Stripe page for the price the server sets', async () => {
  assert.equal((await seats()).checkout, true);
  const res = await buy({ block: block(0), amount: 1 });
  assert.equal(res.status, 200);
  const { id, url } = await res.json();
  assert.match(id, /^o-[0-9a-f]{24}$/);
  assert.equal(url, `https://checkout.stripe.test/c/cs_${stripeCalls.length}`);
  const call = stripeCalls.at(-1);
  assert.equal(call.path, '/v1/checkout/sessions');
  assert.equal(call.body.get('line_items[0][price_data][unit_amount]'), String(blockPrice(block(0)) * 100));
  assert.equal(call.body.get('success_url'), `https://orchestra.example.test/?siparis=${id}`);
  assert.match(call.body.get('line_items[0][price_data][product_data][name]'), /^Agent Orchestra · \S.* · 6 seats$/);
  assert.deepEqual((await seats()).reserved, [block(0)]);
  assert.deepEqual(await (await fetch(`${base}/api/seats/order/${id}`)).json(), { state: 'held' });
  assert.ok((await stat(join(dir, 'pending', `${id}.webp`))).size > 0);
  assert.equal((await fetch(`${base}/seat-images/pending/${id}.webp`)).status, 404, 'a waiting logo is not public');
});

test('one seat is named "1 seat" on the Stripe page', async () => {
  assert.equal((await buy({ block: block(30, 1, 1) })).status, 200);
  assert.match(stripeCalls.at(-1).body.get('line_items[0][price_data][product_data][name]'), / · 1 seat$/);
});

test('checkout refuses taken seats, a bad logo, missing terms, other sites and too many tries', async () => {
  assert.equal((await buy({ block: block(1) })).status, 409, 'held a moment ago');
  assert.equal((await buy({ block: block(100, 1, 1) })).status, 409, 'added by hand');
  assert.equal((await buy({ block: block(10), image: webp(2000, 100) })).status, 400, 'too large');
  assert.equal((await buy({ block: block(10), image: 'data:image/png;base64,iVBORw0KGgo=' })).status, 400, 'not WebP');
  assert.equal((await buy({ block: block(10), image: webp(100, 100, 310_000) })).status, 400, 'over 300 KB');
  assert.equal((await buy({ block: block(10), terms: false })).status, 400);
  assert.equal((await buy({ block: block(10), link: 'javascript:alert(1)' })).status, 400);
  assert.equal((await buy({ block: block(10) }, { origin: 'https://evil.example' })).status, 403);
  const same = { 'x-forwarded-for': '10.1.1.1' };
  const statuses = [];
  for (let i = 0; i < 6; i++) statuses.push((await buy({ block: block(20 + i * 4, 1, 1) }, same)).status);
  assert.deepEqual(statuses, [200, 200, 429, 429, 429, 429], 'two held at once, and five tries in ten minutes');
});

test('when Stripe cannot be reached the hold is let go at once', async () => {
  stripeFails = true;
  try {
    const res = await buy({ block: block(60) });
    assert.equal(res.status, 502);
    assert.ok(!(await seats()).reserved.some((b) => b.col === 60));
  } finally { stripeFails = false; }
  assert.equal((await buy({ block: block(60) })).status, 200, 'the seats are free again');
});

test('a buyer who comes back without paying lets the seats go at once', async () => {
  const { id } = await (await buy({ block: block(140) })).json();
  const cancel = (order, headers = {}) => fetch(`${base}/api/seats/order/${order}/cancel`, { method: 'POST', headers });
  assert.equal((await cancel(id, { origin: 'https://evil.example' })).status, 403);
  stripeFails = true;
  try { assert.equal((await cancel(id)).status, 502, 'Stripe must close the page first'); } finally { stripeFails = false; }
  assert.ok((await seats()).reserved.some((b) => b.col === 140));
  assert.equal((await cancel(id)).status, 200);
  assert.match(stripeCalls.at(-1).path, /^\/v1\/checkout\/sessions\/cs_\d+\/expire$/);
  assert.ok(!(await seats()).reserved.some((b) => b.col === 140));
  assert.deepEqual(await (await fetch(`${base}/api/seats/order/${id}`)).json(), { state: 'expired' });
  assert.equal((await cancel(id)).status, 409, 'only a held order is cancelled');
  assert.equal((await cancel('o-eeeeeeeeeeeeeeeeeeeeeeee')).status, 404);
});

test('Stripe events count only with a valid signature; a payment makes the order wait and tells Slack once', async () => {
  const { id } = await (await buy({ block: block(70), name: 'Beta Ltd' })).json();
  const raw = JSON.stringify({ id: 'evt_bad', type: 'checkout.session.completed', data: { object: {} } });
  assert.equal((await fetch(`${base}/api/stripe`, { method: 'POST', body: raw })).status, 400, 'no signature');
  assert.equal((await fetch(`${base}/api/stripe`, { method: 'POST', headers: { 'stripe-signature': sign(raw, 'whsec_other', Math.floor(Date.now() / 1000)) }, body: raw })).status, 400);
  const before = slackPosts.length;
  assert.equal((await completed('o-ffffffffffffffffffffffff', 100)).status, 200, 'an order this server does not know');
  assert.equal(slackPosts.length, before + 1, 'money taken for an order not in the book is told, never dropped silently');
  assert.match(slackPosts.at(-1).text, /o-ffffffffffffffffffffffff/);
  assert.equal((await completed('cs-not-ours', 100)).status, 200, 'another product on the same Stripe account');
  assert.equal(slackPosts.length, before + 1);
  assert.equal((await event('checkout.session.completed', {}, Math.floor(Date.now() / 1000) - 600)).status, 400, 'too old');
  const posts = slackPosts.length;
  assert.equal((await completed(id, blockPrice(block(70)) * 100)).status, 200);
  assert.equal((await completed(id, blockPrice(block(70)) * 100)).status, 200, 'Stripe may send it again');
  assert.deepEqual(await (await fetch(`${base}/api/seats/order/${id}`)).json(), { state: 'paid' });
  assert.equal(slackPosts.length, posts + 1);
  assert.match(slackPosts.at(-1).text, /Beta Ltd/);
  assert.match(slackPosts.at(-1).text, /https:\/\/orchestra\.example\.test\/yonetim\/#bekleyen/);
  const hall = await seats();
  assert.ok(hall.reserved.some((b) => b.col === 70));
  assert.ok(!JSON.stringify(hall).includes('ali@acme') && !JSON.stringify(hall).includes('pi_'), 'nothing about the buyer');
});

test('a payment of the wrong amount waits as a problem; an expired session frees its seats', async () => {
  const { id } = await (await buy({ block: block(80) })).json();
  await completed(id, 1);
  assert.match(slackPosts.at(-1).text, /Sorunlu/);
  const late = await (await buy({ block: block(90) })).json();
  assert.equal((await event('checkout.session.expired', { id: 'cs_y', metadata: { order: late.id }, client_reference_id: late.id })).status, 200);
  assert.ok(!(await seats()).reserved.some((b) => b.col === 90));
  assert.deepEqual(await (await fetch(`${base}/api/seats/order/${late.id}`)).json(), { state: 'expired' });
});

test('the panel opens only with a named key, from this site, with its header, and its cookie stays out of scripts', async () => {
  assert.equal((await panel('state')).status, 401);
  assert.equal((await login('wrong'.repeat(6))).res.status, 401);
  const { res, cookie } = await login(OZER);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { name: 'ozer' });
  const set = res.headers.get('set-cookie');
  assert.match(set, /HttpOnly/); assert.match(set, /SameSite=Strict/); assert.match(set, /Secure/); assert.match(set, /Max-Age=43200/);
  assert.equal((await panel('state', { cookie })).status, 200);
  assert.equal((await fetch(`${base}/api/yonetim/state`, { headers: { cookie } })).status, 200, 'reading needs no header');
  const order = 'o-000000000000000000000000';
  assert.equal((await panel(`orders/${order}/approve`, { cookie, method: 'POST', headers: { 'x-yonetim': '' } })).status, 403);
  assert.equal((await panel(`orders/${order}/approve`, { cookie, method: 'POST', headers: { origin: 'https://evil.example' } })).status, 403);
  const page = await fetch(`${base}/yonetim/`);
  assert.equal(page.status, 200);
  assert.equal(page.headers.get('x-robots-tag'), 'noindex');
  const tries = [];
  for (let i = 0; i < 6; i++) tries.push((await panel('login', { method: 'POST', body: { key: 'x'.repeat(30) }, headers: { 'x-forwarded-for': '10.8.8.8' } })).status);
  assert.deepEqual(tries, [401, 401, 401, 401, 401, 429]);
});

test('approving puts the block and its logo in the hall; rejecting refunds it once and frees the seats', async () => {
  const { cookie } = await login();
  const a = await (await buy({ block: block(110), name: 'Gamma' })).json();
  const b = await (await buy({ block: block(120), name: 'Delta' })).json();
  await completed(a.id, blockPrice(block(110)) * 100);
  await completed(b.id, blockPrice(block(120)) * 100);
  const state = await (await panel('state', { cookie })).json();
  const waiting = state.orders.find((o) => o.id === a.id);
  assert.deepEqual([waiting.state, waiting.email, waiting.name], ['paid', 'ali@acme.example', 'Gamma']);
  assert.ok(!('ipKey' in waiting));
  assert.equal((await panel(`image/${a.id}`, { cookie })).headers.get('content-type'), 'image/webp');
  assert.equal((await panel(`image/${a.id}`)).status, 401);

  assert.equal((await panel(`orders/${a.id}/approve`, { cookie, method: 'POST' })).status, 200);
  const hall = await seats();
  assert.ok(hall.seats.some((s) => s.id === a.id && s.name === 'Gamma' && s.image === `/seat-images/${a.id}.webp`));
  assert.equal((await fetch(`${base}/seat-images/${a.id}.webp`)).status, 200);

  const refunds = stripeCalls.filter((c) => c.path === '/v1/refunds').length;
  assert.equal((await panel(`orders/${b.id}/reject`, { cookie, method: 'POST', body: { reason: 'Logo okunmuyor' } })).status, 200);
  const refund = stripeCalls.at(-1);
  assert.equal(refund.path, '/v1/refunds');
  assert.equal(refund.body.get('payment_intent'), `pi_${b.id}`);
  assert.equal(refund.headers['idempotency-key'], `refund-${b.id}`);
  assert.equal((await panel(`orders/${b.id}/reject`, { cookie, method: 'POST', body: {} })).status, 409, 'already refunded');
  assert.equal(stripeCalls.filter((c) => c.path === '/v1/refunds').length, refunds + 1);
  assert.ok(!(await seats()).reserved.some((s) => s.col === 120));
  await assert.rejects(stat(join(dir, 'pending', `${b.id}.webp`)));
  const after = await (await panel('state', { cookie })).json();
  assert.deepEqual(after.events.filter((e) => e.order === b.id).at(-1), { at: after.events.at(-1).at, order: b.id, what: 'refunded', by: 'selim' });
  assert.equal(after.summary.pending >= 1, true);

  assert.equal((await panel(`orders/${a.id}/remove`, { cookie, method: 'POST', body: { refund: false, reason: 'şikâyet' } })).status, 200);
  assert.ok(!(await seats()).seats.some((s) => s.id === a.id));
  assert.equal(stripeCalls.filter((c) => c.path === '/v1/refunds').length, refunds + 1, 'removed without a refund');
});

test('a refund Stripe refuses leaves the order as it was; one whose answer was lost keeps it from being approved', async () => {
  const { cookie } = await login();
  const c = await (await buy({ block: block(130) })).json();
  await completed(c.id, blockPrice(block(130)) * 100);
  const onDisk = async () => JSON.parse(await readFile(env.ORDERS_FILE, 'utf8')).orders.find((o) => o.id === c.id);
  stripeFails = 400;
  try { assert.equal((await panel(`orders/${c.id}/reject`, { cookie, method: 'POST', body: {} })).status, 502); }
  finally { stripeFails = false; }
  assert.deepEqual(await (await fetch(`${base}/api/seats/order/${c.id}`)).json(), { state: 'paid' });
  assert.equal((await onDisk()).refunding, false, 'Stripe said no: nothing was refunded');
  for (const lost of [true, 'hang up']) {
    stripeFails = lost;
    try { assert.equal((await panel(`orders/${c.id}/reject`, { cookie, method: 'POST', body: {} })).status, 502); }
    finally { stripeFails = false; }
    assert.equal((await onDisk()).refunding, true, `${lost}: the refund may have been made`);
    assert.equal((await panel(`orders/${c.id}/approve`, { cookie, method: 'POST' })).status, 409);
  }
  // A retry Stripe refuses says nothing about the earlier try, which may have refunded: the mark stays.
  for (const refused of [429, 401]) {
    stripeFails = refused;
    try { assert.equal((await panel(`orders/${c.id}/reject`, { cookie, method: 'POST', body: {} })).status, 502); }
    finally { stripeFails = false; }
    assert.equal((await onDisk()).refunding, true, `${refused} after a lost answer`);
    assert.equal((await panel(`orders/${c.id}/approve`, { cookie, method: 'POST' })).status, 409);
  }
  assert.equal((await panel(`orders/${c.id}/reject`, { cookie, method: 'POST', body: {} })).status, 200);
});

test('a live order whose refund answer was lost is removed only with the refund, even after a refused retry', async () => {
  const { cookie } = await login(SELIM, '10.9.9.12');
  const g = await (await buy({ block: block(40), name: 'Eta' })).json();
  await completed(g.id, blockPrice(block(40)) * 100);
  assert.equal((await panel(`orders/${g.id}/approve`, { cookie, method: 'POST' })).status, 200);
  const remove = (refund) => panel(`orders/${g.id}/remove`, { cookie, method: 'POST', body: { refund, reason: 'şikâyet' } });
  stripeFails = true;
  try { assert.equal((await remove(true)).status, 502); } finally { stripeFails = false; }
  stripeFails = 429;
  try { assert.equal((await remove(false)).status, 502, 'the refund may be owed, so it is tried again'); } finally { stripeFails = false; }
  const refunds = stripeCalls.filter((c) => c.path === '/v1/refunds').length;
  assert.equal((await remove(false)).status, 200);
  assert.equal(stripeCalls.filter((c) => c.path === '/v1/refunds').length, refunds + 1, 'removed with the refund');
  const saved = JSON.parse(await readFile(env.ORDERS_FILE, 'utf8')).orders.find((o) => o.id === g.id);
  assert.deepEqual([saved.state, saved.refunded, saved.refunding], ['removed', true, false]);
});

test('an order is decided one step at a time: approving while its refund is under way is refused', async () => {
  const { cookie } = await login();
  const d = await (await buy({ block: block(170), name: 'Epsilon' })).json();
  await completed(d.id, blockPrice(block(170)) * 100);
  let go; pause = { path: '/v1/refunds', until: new Promise((resolve) => { go = resolve; }) };
  try {
    const rejecting = panel(`orders/${d.id}/reject`, { cookie, method: 'POST', body: {} });
    while (!stripeCalls.some((c) => c.path === '/v1/refunds' && c.headers['idempotency-key'] === `refund-${d.id}`)) await new Promise((r) => setTimeout(r, 5));
    assert.equal((await panel(`orders/${d.id}/approve`, { cookie, method: 'POST' })).status, 409);
    go();
    assert.equal((await rejecting).status, 200);
  } finally { pause = null; go?.(); }
  assert.deepEqual(await (await fetch(`${base}/api/seats/order/${d.id}`)).json(), { state: 'refunded' });
  assert.ok(!(await seats()).seats.some((s) => s.id === d.id));
});

test('a paid order whose logo is missing is not approved, and waits', async () => {
  const { cookie } = await login(SELIM, '10.9.9.10');
  const e = await (await buy({ block: block(180), name: 'Zeta' })).json();
  await completed(e.id, blockPrice(block(180)) * 100);
  await unlink(join(dir, 'pending', `${e.id}.webp`));
  assert.equal((await panel(`orders/${e.id}/approve`, { cookie, method: 'POST' })).status, 409);
  assert.deepEqual(await (await fetch(`${base}/api/seats/order/${e.id}`)).json(), { state: 'paid' });
  assert.equal((await panel(`orders/${e.id}/reject`, { cookie, method: 'POST', body: {} })).status, 200, 'it can still be refunded');
});

test('a change the server cannot write is undone, the server keeps running, and Stripe\'s retry is written', async () => {
  const { id } = await (await buy({ block: block(150) })).json();
  const tmp = `${env.ORDERS_FILE}.tmp`, posts = slackPosts.length;
  await mkdir(tmp);
  try {
    assert.equal((await completed(id, blockPrice(block(150)) * 100)).status, 500);
    assert.deepEqual(await (await fetch(`${base}/api/seats/order/${id}`)).json(), { state: 'held' });
    assert.equal((await buy({ block: block(160) })).status, 500);
    assert.ok(!(await seats()).reserved.some((b) => b.col === 160), 'a hold that is not on disk is not kept');
  } finally { await rm(tmp, { recursive: true }); }
  assert.equal((await completed(id, blockPrice(block(150)) * 100)).status, 200);
  const disk = await readFile(env.ORDERS_FILE, 'utf8');
  assert.equal(JSON.parse(disk).orders.find((o) => o.id === id).state, 'paid');
  assert.equal(slackPosts.length, posts + 1);
  assert.ok(!disk.includes('ipKey'), 'the address digest stays in memory');
});

// Holds Stripe's answer to `path` until the order file cannot be written, then lets it through.
async function failWriteDuring(path, request) {
  let go; pause = { path, until: new Promise((resolve) => { go = resolve; }) };
  const tmp = `${env.ORDERS_FILE}.tmp`, before = stripeCalls.length;
  try {
    const pending = request();
    while (!stripeCalls.slice(before).some((c) => c.path === path)) await new Promise((r) => setTimeout(r, 5));
    await mkdir(tmp);
    go();
    return await pending;
  } finally { pause = null; go?.(); }
}

test('a refund Stripe made is never forgotten: a write that fails after it keeps the order from being approved', async () => {
  const { cookie } = await login(SELIM, '10.9.9.11');
  const f = await (await buy({ block: block(190), name: 'Eta' })).json();
  await completed(f.id, blockPrice(block(190)) * 100);
  try {
    const res = await failWriteDuring('/v1/refunds', () => panel(`orders/${f.id}/reject`, { cookie, method: 'POST', body: {} }));
    assert.equal(res.status, 500);
    assert.equal(JSON.parse(await readFile(env.ORDERS_FILE, 'utf8')).orders.find((o) => o.id === f.id).refunding, true, 'on disk before Stripe was asked');
    const approve = await panel(`orders/${f.id}/approve`, { cookie, method: 'POST' });
    assert.deepEqual([approve.status, (await approve.json()).error], [409, 'refunding']);
  } finally { await rm(`${env.ORDERS_FILE}.tmp`, { recursive: true, force: true }); }
  const refunds = stripeCalls.filter((c) => c.path === '/v1/refunds' && c.headers['idempotency-key'] === `refund-${f.id}`).length;
  assert.equal((await panel(`orders/${f.id}/reject`, { cookie, method: 'POST', body: {} })).status, 200, 'rejecting again finishes it');
  assert.equal(stripeCalls.filter((c) => c.path === '/v1/refunds' && c.headers['idempotency-key'] === `refund-${f.id}`).length, refunds + 1, 'with the same key: Stripe refunds once');
  const saved = JSON.parse(await readFile(env.ORDERS_FILE, 'utf8')).orders.find((o) => o.id === f.id);
  assert.deepEqual([saved.state, saved.refunded, saved.refunding, saved.refund], ['refunded', true, false, `re_${stripeCalls.length}`]);
});

test('a Stripe page that opened is handed to the buyer even if its id could not be written yet', async () => {
  try {
    const res = await failWriteDuring('/v1/checkout/sessions', () => buy({ block: block(195, 1, 1) }));
    assert.equal(res.status, 200);
    assert.match((await res.json()).url, /^https:\/\/checkout\.stripe\.test\//);
  } finally { await rm(`${env.ORDERS_FILE}.tmp`, { recursive: true, force: true }); }
});

test('after a restart, a hold whose Stripe page id was never written is not let go by a cancel', async () => {
  let id;
  try {
    const res = await failWriteDuring('/v1/checkout/sessions', () => buy({ block: block(197, 1, 1) }));
    ({ id } = await res.json());
  } finally { await rm(`${env.ORDERS_FILE}.tmp`, { recursive: true, force: true }); }
  server.kill(); await once(server, 'exit');
  server = await start(PORT, env);
  const res = await fetch(`${base}/api/seats/order/${id}/cancel`, { method: 'POST' });
  assert.equal(res.status, 502, 'the page may still be open: Stripe ends it, then the seats go');
  assert.ok((await seats()).reserved.some((b) => b.col === 197));
});

test('payment opens only with someone to approve it, and stays shut on an order file it cannot trust', async () => {
  const pay = { STRIPE_SECRET_KEY: 'sk', STRIPE_WEBHOOK_SECRET: 'whsec', SEATS_DIR: dir, ORDERS_FILE: join(dir, 'other.json') };
  const quiet = () => {};
  assert.equal(createShop({ env: pay, log: quiet }).open, false, 'no ADMIN_KEYS');
  assert.equal(createShop({ env: { ...pay, ADMIN_KEYS: `selim:${SELIM}` }, log: quiet }).open, true);
  await writeFile(pay.ORDERS_FILE, '{}');
  assert.equal(createShop({ env: { ...pay, ADMIN_KEYS: `selim:${SELIM}` }, log: quiet }).open, false, 'an order file without its list');
});

test('orders and holds survive a restart, read back from the file', async () => {
  const before = await seats();
  server.kill(); await once(server, 'exit');
  JSON.parse(await readFile(env.ORDERS_FILE, 'utf8'));
  server = await start(PORT, env);
  assert.deepEqual(await seats(), before);
});
