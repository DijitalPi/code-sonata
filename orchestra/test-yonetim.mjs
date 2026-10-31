import { test } from 'node:test';
import assert from 'node:assert/strict';
import { install, add } from './fake-dom.mjs';

// The management panel against a recorded server: what it shows and exactly what it asks for.
const doc = install({ url: 'http://localhost/yonetim/' });
const root = add(doc.body, 'div', { id: 'yonetim' });
const T = Date.UTC(2026, 9, 31, 10, 42), KEY = 'k'.repeat(30);
const order = (id, state, extra = {}) => ({ id, state, ring: 0, col: 10, width: 3, depth: 2, name: 'Acme', link: 'https://acme.example/',
  amount: 15000, currency: 'usd', email: 'ali@acme.example', session: 'cs_1', payment: 'pi_1', created: T, heldUntil: T, paidAt: T,
  decidedAt: null, decidedBy: null, reason: null, refunded: false, ...extra });
const STATE = {
  me: 'selim', checkout: true, seats: 10042, summary: { pending: 2, liveSeats: 6, revenue: 30000, month: 15000 },
  orders: [order('o-a', 'paid'), order('o-b', 'problem', { name: 'Beta', col: 20, reason: 'amount' }), order('o-c', 'live', { name: 'Gamma', col: 40 }),
    order('o-d', 'held', { name: 'Delta', col: 60, paidAt: null, email: null })],
  events: [{ at: T, order: 'o-a', what: 'paid', by: null }, { at: T + 60_000, order: 'o-c', what: 'live', by: 'ozer' }],
};
let signedIn = false, refuse = null, refusal = 'x';
const calls = [];
globalThis.fetch = async (url, init = {}) => {
  const call = { url, method: init.method || 'GET', headers: init.headers || {}, body: init.body ? JSON.parse(init.body) : undefined };
  calls.push(call);
  const reply = (status, body = {}) => new Response(JSON.stringify(body), { status });
  if (url === '/api/yonetim/login') return call.body?.key === KEY ? (signedIn = true, reply(200, { name: 'selim' })) : reply(401, { error: 'key' });
  if (!signedIn) return reply(401, { error: 'login' });
  if (url === '/api/yonetim/state') return reply(200, STATE);
  if (refuse) return reply(refuse, { error: refusal });
  return reply(200, { order: {} });
};
await import('./web/yonetim/yonetim.js');

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const settle = async () => { for (let i = 0; i < 5; i++) await tick(); };
const buttons = (text) => root.querySelectorAll('button').filter((b) => b.textContent.trim() === text && !b.closest('[hidden]'));
const button = (text) => buttons(text)[0];
const go = async (hash) => { location.hash = hash; dispatchEvent(new Event('hashchange')); await settle(); };
const text = () => root.textContent.replace(/\s+/g, ' ');
const last = () => calls.at(-1);

test('without a session the panel asks for the key, and the right key opens it', async () => {
  await settle();
  const form = root.querySelector('form'), key = root.querySelector('input');
  assert.ok(form && !form.closest('[hidden]'));
  assert.equal(key.getAttribute('type'), 'password');
  key.value = 'wrong'; await form.onsubmit({ preventDefault() {} }); await settle();
  assert.match(text(), /Anahtar yanlış\./);
  key.value = KEY; await form.onsubmit({ preventDefault() {} }); await settle();
  const login = calls.find((c) => c.url === '/api/yonetim/login' && c.body.key === KEY);
  assert.deepEqual([login.method, login.headers['x-yonetim']], ['POST', '1']);
  assert.ok(form.closest('[hidden]'), 'the key form is gone');
  for (const shown of ['selim', 'Onay bekleyen', '2', '6 / 10.042', '300 $', '150 $', 'ozer onayladı']) assert.ok(text().includes(shown), shown);
});

test('a waiting order shows who paid what; approving it asks the server once', async () => {
  await go('#bekleyen');
  const cards = root.querySelectorAll('article');
  assert.equal(cards.length, 2);
  assert.ok(cards[0].textContent.includes('ali@acme.example') && cards[0].textContent.includes('150 $'));
  assert.match(cards[1].textContent, /Tutar tutmuyor/);
  assert.equal(buttons('Onayla').length, 1, 'a problem is refunded, never approved');
  assert.equal(cards[0].querySelector('img').getAttribute('src'), '/api/yonetim/image/o-a');
  assert.equal(cards[0].querySelector('a[href="https://acme.example/"]').getAttribute('rel'), 'noopener noreferrer');
  calls.length = 0;
  await button('Onayla').onclick(); await settle();
  assert.deepEqual([calls[0].url, calls[0].method, calls[0].headers['x-yonetim']], ['/api/yonetim/orders/o-a/approve', 'POST', '1']);
  assert.match(text(), /Onaylandı: Acme salonda\./);
});

test('rejecting asks for a reason first and refunds only on the second click', async () => {
  await go('#bekleyen');
  calls.length = 0;
  button('Reddet').onclick(); await settle();
  assert.equal(calls.length, 0);
  assert.ok(button('Reddet ve iade et') && button('Vazgeç'));
  button('Vazgeç').onclick(); await settle();
  assert.equal(button('Reddet ve iade et'), undefined);
  button('Reddet').onclick(); await settle();
  root.querySelector('textarea').value = 'Logo okunmuyor';
  await button('Reddet ve iade et').onclick(); await settle();
  assert.deepEqual([calls[0].url, calls[0].body], ['/api/yonetim/orders/o-a/reject', { reason: 'Logo okunmuyor' }]);
  assert.match(text(), /İade edildi: Acme\./);
  refuse = 502;
  try {
    button('Reddet').onclick(); await settle();
    await button('Reddet ve iade et').onclick(); await settle();
    assert.match(text(), /Stripe iadeyi kabul etmedi\. Biraz sonra yeniden dene\./);
  } finally { refuse = null; }
});

test('a refused approval says why: no logo, seats added by hand, or another step under way', async () => {
  await go('#bekleyen');
  refuse = 409;
  try {
    for (const [why, said] of [['image', /Logosu bulunamadı/], ['taken', /elle koltuk eklenmiş/], ['busy', /başka bir işlem sürüyor/],
      ['refunding', /iadesi başlamış.*Reddet/], ['state', /artık o durumda değil/]]) {
      refusal = why;
      await button('Onayla').onclick(); await settle();
      assert.match(text(), said, why);
    }
    refuse = 502; refusal = 'unknown';
    await button('Onayla').onclick(); await settle();
    assert.match(text(), /yanıt alınamadı; iade yapılmış olabilir/);
  } finally { refuse = null; refusal = 'x'; }
});

test('the seats list filters by state, and a live seat comes down with or without a refund', async () => {
  await go('#koltuklar');
  assert.equal(root.querySelectorAll('tbody tr').length, 4);
  // On a phone the table scrolls sideways: the state sits beside the name so it is seen without scrolling.
  assert.deepEqual(root.querySelectorAll('thead th').slice(0, 2).map((th) => th.textContent), ['Ad', 'Durum']);
  button('Yayında').onclick(); await settle();
  const rows = root.querySelectorAll('tbody tr');
  assert.equal(rows.length, 1);
  assert.match(rows[0].textContent, /Gamma/);
  button('Kaldır').onclick(); await settle();
  root.querySelector('input[type="checkbox"]').checked = true;
  calls.length = 0;
  await buttons('Kaldır').at(-1).onclick(); await settle();
  assert.deepEqual([calls[0].url, calls[0].body], ['/api/yonetim/orders/o-c/remove', { refund: true, reason: '' }]);
});

test('a session that runs out goes back to the key', async () => {
  signedIn = false;
  await go('#genel');
  button('Yenile')?.onclick(); await settle();
  const form = root.querySelector('form');
  assert.ok(!form.closest('[hidden]'));
});

test('an order whose refund was started says so on its card', async () => {
  STATE.orders[0].refunding = true;
  try {
    const form = root.querySelector('form');
    root.querySelector('input').value = KEY; await form.onsubmit({ preventDefault() {} }); await settle();
    await go('#bekleyen');
    assert.match(text(), /İadesi başladı, kaydı tamamlanmadı\. Reddet ile bitir\./);
  } finally { STATE.orders[0].refunding = false; }
});
