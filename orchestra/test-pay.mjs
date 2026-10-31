import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webpSize } from './webp.mjs';
import { sign, verifySignature, createStripe } from './stripe.mjs';
import { parseKeys, whoHasKey, sessionSecret, makeCookie, readCookie } from './admin.mjs';

// The smallest headers of the three WebP kinds, built by hand: RIFF, size, WEBP, then the first chunk.
const riff = (chunk, body) => {
  const data = Buffer.concat([Buffer.from(chunk, 'latin1'), Buffer.alloc(4), body]);
  data.writeUInt32LE(body.length, 4);
  const head = Buffer.alloc(12); head.write('RIFF', 0, 'latin1'); head.writeUInt32LE(4 + data.length, 4); head.write('WEBP', 8, 'latin1');
  return Buffer.concat([head, data]);
};
const lossy = (w, h) => { const b = Buffer.alloc(10); b.set([0x9d, 0x01, 0x2a], 3); b.writeUInt16LE(w, 6); b.writeUInt16LE(h, 8); return riff('VP8 ', b); };
const lossless = (w, h) => { const b = Buffer.alloc(10); b[0] = 0x2f; b.writeUInt32LE(((w - 1) | ((h - 1) << 14)) >>> 0, 1); return riff('VP8L', b); };
const extended = (w, h) => { const b = Buffer.alloc(10); b.writeUIntLE(w - 1, 4, 3); b.writeUIntLE(h - 1, 7, 3); return riff('VP8X', b); };

test('a WebP header tells its size, whichever of the three kinds it is', () => {
  assert.deepEqual(webpSize(lossy(480, 240)), { width: 480, height: 240 });
  assert.deepEqual(webpSize(lossless(300, 1024)), { width: 300, height: 1024 });
  assert.deepEqual(webpSize(extended(4000, 3000)), { width: 4000, height: 3000 });
});

test('anything that is not a WebP header has no size', () => {
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452000001e0000000f0', 'hex');
  const notWebp = lossy(10, 10); notWebp.write('WAVE', 8, 'latin1');
  const badStart = lossy(10, 10); badStart[23] = 0;
  const badSignature = lossless(10, 10); badSignature[20] = 0;
  for (const bad of [png, notWebp, badStart, badSignature, lossy(10, 10).subarray(0, 25), Buffer.alloc(0), lossy(0, 10), null, 'RIFF'])
    assert.equal(webpSize(bad), null);
});

// ---------- Stripe ----------
const SECRET = 'whsec_test_secret', BODY = '{"id":"evt_1","type":"checkout.session.completed"}';

test('a Stripe event is believed only with a fresh signature from the shared secret over the exact body', () => {
  const t = 1_800_000_000;
  assert.ok(verifySignature(BODY, sign(BODY, SECRET, t), SECRET, t + 10));
  assert.ok(!verifySignature(BODY, sign(BODY, 'whsec_other', t), SECRET, t));
  assert.ok(!verifySignature(BODY.replace('evt_1', 'evt_2'), sign(BODY, SECRET, t), SECRET, t));
  assert.ok(!verifySignature(BODY, sign(BODY, SECRET, t), SECRET, t + 301), 'too old');
  assert.ok(!verifySignature(BODY, sign(BODY, SECRET, t + 400), SECRET, t), 'from the future');
  const v1 = sign(BODY, SECRET, t).split(',')[1];
  assert.ok(verifySignature(BODY, `t=${t},v1=${'0'.repeat(64)},${v1}`, SECRET, t), 'one of several signatures is enough');
  for (const header of [`t=${t}`, 'v1=abc', '', 'garbage', undefined, `t=x,${v1}`]) assert.ok(!verifySignature(BODY, header, SECRET, t), String(header));
});

const recorder = (reply = { id: 'cs_1', url: 'https://checkout.stripe.test/pay/cs_1' }, status = 200) => {
  const calls = [];
  const fetch = async (url, init) => { calls.push({ url, init, body: new URLSearchParams(init.body) }); return new Response(JSON.stringify(reply), { status }); };
  return { calls, fetch };
};
const order = { id: 'o-0123456789abcdef01234567', amount: 15000, currency: 'usd', heldUntil: 1_800_001_860_000 };

test('checkout asks Stripe for one card payment of the amount the server set, tied to the order', async () => {
  const { calls, fetch } = recorder();
  const stripe = createStripe({ key: 'sk_test_x', base: 'https://stripe.test', fetch });
  assert.deepEqual(await stripe.checkout({ order, site: 'https://orchestra.example', label: 'Agent Orchestra seat' }), { id: 'cs_1', url: 'https://checkout.stripe.test/pay/cs_1' });
  const [{ url, init, body }] = calls;
  assert.equal(url, 'https://stripe.test/v1/checkout/sessions');
  assert.equal(init.method, 'POST');
  assert.equal(init.headers.authorization, 'Bearer sk_test_x');
  assert.equal(init.headers['content-type'], 'application/x-www-form-urlencoded');
  assert.deepEqual(Object.fromEntries(body), {
    mode: 'payment', 'payment_method_types[0]': 'card', 'line_items[0][quantity]': '1',
    'line_items[0][price_data][currency]': 'usd', 'line_items[0][price_data][unit_amount]': '15000',
    'line_items[0][price_data][product_data][name]': 'Agent Orchestra seat',
    client_reference_id: order.id, 'metadata[order]': order.id, 'payment_intent_data[metadata][order]': order.id,
    expires_at: '1800001860', success_url: `https://orchestra.example/?siparis=${order.id}`,
    cancel_url: `https://orchestra.example/?siparis=${order.id}&iptal=1`,
  });
});

test('a refund names the payment and carries an idempotency key, so a second click refunds nothing more', async () => {
  const { calls, fetch } = recorder({ id: 're_1' });
  await createStripe({ key: 'sk_test_x', base: 'https://stripe.test', fetch }).refund('pi_1', 'refund-o-1');
  assert.equal(calls[0].url, 'https://stripe.test/v1/refunds');
  assert.equal(calls[0].init.headers['idempotency-key'], 'refund-o-1');
  assert.deepEqual(Object.fromEntries(calls[0].body), { payment_intent: 'pi_1' });
});

test('a refund Stripe answers as failed or canceled is an error, not a refund; the refund id comes back', async () => {
  for (const status of ['failed', 'canceled']) {
    const { fetch } = recorder({ id: 're_1', status });
    await assert.rejects(createStripe({ key: 'sk', base: 'https://stripe.test', fetch }).refund('pi_1', 'k'), new RegExp(status));
  }
  await assert.rejects(createStripe({ key: 'sk', base: 'https://stripe.test', fetch: recorder({}).fetch }).refund('pi_1', 'k'));
  const { fetch } = recorder({ id: 're_2', status: 'pending', amount: 300 });
  assert.deepEqual(await createStripe({ key: 'sk', base: 'https://stripe.test', fetch }).refund('pi_1', 'k'), { id: 're_2', status: 'pending' });
});

test('a Stripe error carries its status and code; a payment already refunded counts as refunded', async () => {
  const stripe = (answer, status) => createStripe({ key: 'sk', base: 'https://stripe.test', fetch: recorder(answer, status).fetch });
  await assert.rejects(stripe({ error: { message: 'No such payment_intent', code: 'resource_missing' } }, 400).refund('pi_1', 'k'),
    (error) => error.status === 400 && error.code === 'resource_missing');
  await assert.rejects(stripe({ error: { message: 'down' } }, 500).refund('pi_1', 'k'), (error) => error.status === 500);
  assert.deepEqual(await stripe({ error: { message: 'Charge has already been refunded.', code: 'charge_already_refunded' } }, 400).refund('pi_1', 'k'),
    { id: null, status: 'already_refunded' });
});

test('ending a session asks Stripe to expire it, so it can no longer be paid', async () => {
  const { calls, fetch } = recorder({ id: 'cs_1', status: 'expired' });
  await createStripe({ key: 'sk_test_x', base: 'https://stripe.test', fetch }).expire('cs_1');
  assert.equal(calls[0].url, 'https://stripe.test/v1/checkout/sessions/cs_1/expire');
  assert.equal(calls[0].init.method, 'POST');
});

test('a Stripe error is thrown, not taken for a session', async () => {
  const { fetch } = recorder({ error: { message: 'No such key' } }, 401);
  await assert.rejects(createStripe({ key: 'sk_bad', base: 'https://stripe.test', fetch }).checkout({ order, site: 'https://x', label: 'x' }), /401/);
  const empty = recorder({}, 200);
  await assert.rejects(createStripe({ key: 'sk', base: 'https://stripe.test', fetch: empty.fetch }).checkout({ order, site: 'https://x', label: 'x' }));
});

// ---------- the management panel's keys and session ----------
const SELIM = 'a'.repeat(24), OZER = 'b9'.repeat(16);

test('panel keys are named and at least 24 characters; others are left out', () => {
  const keys = parseKeys(` selim:${SELIM} , ozer:${OZER},kisa:abc,:${'c'.repeat(30)},Bad Name:${'d'.repeat(30)},yalniz`);
  assert.deepEqual([...keys.keys()], ['selim', 'ozer']);
  assert.equal(parseKeys('').size, 0); assert.equal(parseKeys(undefined).size, 0);
});

test('a key tells who is signing in, and nothing else matches', () => {
  const keys = parseKeys(`selim:${SELIM},ozer:${OZER}`);
  assert.equal(whoHasKey(keys, OZER), 'ozer');
  for (const given of [SELIM.slice(1), `${SELIM}x`, '', undefined, 42]) assert.equal(whoHasKey(keys, given), null);
});

test('the session cookie names its holder until it runs out, and any change to it is refused', () => {
  const secret = sessionSecret(`selim:${SELIM}`), now = 1_800_000_000_000;
  const cookie = makeCookie('selim', secret, now);
  assert.equal(readCookie(cookie, secret, now + 1000), 'selim');
  assert.equal(readCookie(cookie, secret, now + 12 * 3600_000 + 1), null, 'expired after 12 hours');
  const [name, until, mac] = cookie.split('.');
  for (const bad of [`ozer.${until}.${mac}`, `${name}.${Number(until) + 1}.${mac}`, `${name}.${until}.${'0'.repeat(mac.length)}`, 'x', '', undefined])
    assert.equal(readCookie(bad, secret, now), null, String(bad));
  assert.equal(readCookie(cookie, sessionSecret(`selim:${OZER}`), now), null, 'new keys end old sessions');
});
