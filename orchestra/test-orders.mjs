import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBook, hold, setSession, drop, paid, expire, sweep, approve, reject, remove, liveSeats, reserved, summary, buyerState,
  HOLD_MS, GRACE_MS } from './orders.mjs';
import { TIERS, blockPrice } from './web/seats.mjs';

const T0 = Date.UTC(2026, 9, 31, 10, 0);
const front = TIERS[0].rings[0];
const block = (col, width = 3, depth = 2) => ({ ring: front, col, width, depth });
let n = 0;
const nextId = () => `o-${(++n).toString(16).padStart(24, '0')}`;
const ask = (book, extra = {}, hand = []) =>
  hold(book, { id: nextId(), block: block(0), name: 'Acme', link: 'https://acme.example', ipKey: 'ip-a', now: T0, ...extra }, hand);
const pay = (book, order, extra = {}) =>
  paid(book, { id: order.id, amount: order.amount, currency: 'usd', email: 'ali@acme.example', payment: 'pi_1', session: 'cs_1', now: T0 + 60_000, ...extra });

test('a hold keeps a free block for 31 minutes at the price the server sets', () => {
  const book = createBook();
  const { order } = ask(book);
  assert.equal(order.state, 'held');
  assert.equal(order.amount, blockPrice(block(0)) * 100);
  assert.equal(order.currency, 'usd');
  assert.equal(order.heldUntil, T0 + HOLD_MS);
  assert.equal(HOLD_MS, 31 * 60_000);
  assert.deepEqual([order.name, order.link], ['Acme', 'https://acme.example/']);
  assert.deepEqual(book.events.at(-1), { at: T0, order: order.id, what: 'held', by: null });
});

test('a hold is refused off the plan, with a bad name or link, or on a seat that is sold, held or paid', () => {
  const book = createBook();
  assert.deepEqual(ask(book, { block: { ring: front, col: -1, width: 3, depth: 2 } }), { error: 'block' });
  assert.deepEqual(ask(book, { block: null }), { error: 'block' });
  assert.deepEqual(ask(book, { link: 'javascript:alert(1)' }), { error: 'holder' });
  assert.deepEqual(ask(book, { name: '' }), { error: 'holder' });
  const hand = [{ id: 'hand', ...block(20), name: 'Hand', link: 'https://h.example/' }];
  assert.deepEqual(ask(book, { block: block(21) }, hand), { error: 'taken' }, 'a seat added by hand');
  const { order } = ask(book, { block: block(40) });
  assert.deepEqual(ask(book, { block: block(41), ipKey: 'ip-b' }), { error: 'taken' }, 'a held seat');
  pay(book, order);
  assert.deepEqual(ask(book, { block: block(41), ipKey: 'ip-b' }), { error: 'taken' }, 'a paid seat');
  approve(book, order.id, 'selim', T0);
  assert.deepEqual(ask(book, { block: block(41), ipKey: 'ip-b' }), { error: 'taken' }, 'a live seat');
});

test('one address holds at most two blocks at once, and the hall at most fifty', () => {
  const book = createBook();
  assert.ok(ask(book, { block: block(0) }).order);
  assert.ok(ask(book, { block: block(10) }).order);
  assert.deepEqual(ask(book, { block: block(20) }), { error: 'busy' });
  for (let i = 0; i < 48; i++) assert.ok(ask(book, { block: block(30 + i * 3, 1, 1), ipKey: `ip-${i}` }).order, String(i));
  assert.deepEqual(ask(book, { block: block(190, 1, 1), ipKey: 'ip-new' }), { error: 'full' });
});

test('a payment of the right amount makes the hold paid, once; a second report changes nothing', () => {
  const book = createBook();
  const { order } = ask(book);
  setSession(book, order.id, 'cs_1');
  assert.equal(order.session, 'cs_1');
  assert.deepEqual(pay(book, order), { order, changed: true });
  assert.equal(order.state, 'paid');
  assert.deepEqual([order.email, order.payment, order.paidAt], ['ali@acme.example', 'pi_1', T0 + 60_000]);
  assert.equal(order.ipKey, null, 'the address digest is only needed while holding');
  assert.deepEqual(pay(book, order), { order, changed: false });
  assert.equal(book.events.filter((e) => e.what === 'paid').length, 1);
  assert.deepEqual(paid(book, { id: 'o-unknown', amount: 1, currency: 'usd', now: T0 }), { order: null, changed: false });
});

test('a payment that does not match the order, or comes too late for its seats, is a problem to refund', () => {
  const book = createBook();
  const wrong = ask(book, { block: block(0) }).order;
  pay(book, wrong, { amount: wrong.amount - 1 });
  assert.deepEqual([wrong.state, wrong.reason], ['problem', 'amount']);
  const euro = ask(book, { block: block(10) }).order;
  pay(book, euro, { currency: 'eur' });
  assert.deepEqual([euro.state, euro.reason], ['problem', 'amount']);
  const late = ask(book, { block: block(20), ipKey: 'ip-b' }).order;
  expire(book, late.id, T0 + HOLD_MS);
  const other = ask(book, { block: block(20), ipKey: 'ip-c' }).order;
  assert.ok(other, 'the seats were free again');
  pay(book, late);
  assert.deepEqual([late.state, late.reason], ['problem', 'taken']);
  const slow = ask(book, { block: block(30), ipKey: 'ip-d' }).order;
  expire(book, slow.id, T0 + HOLD_MS);
  pay(book, slow);
  assert.equal(slow.state, 'paid', 'late but its seats are still free');
});

test('a hold runs out only after Stripe could still be paying; its logo goes a day later, the order after Stripe stops retrying', () => {
  const book = createBook();
  const { order } = ask(book);
  assert.deepEqual(sweep(book, T0 + HOLD_MS + GRACE_MS), { expired: [], pruned: [], stale: [] });
  assert.deepEqual(sweep(book, T0 + HOLD_MS + GRACE_MS + 1), { expired: [order], pruned: [], stale: [] });
  assert.equal(order.state, 'expired');
  assert.equal(order.ipKey, null, 'the address digest is only needed while holding');
  assert.deepEqual(reserved(book), []);
  const day = T0 + HOLD_MS + 24 * 3600_000 + 1;
  assert.deepEqual(sweep(book, day), { expired: [], pruned: [], stale: [order] });
  assert.equal(book.orders.length, 1, 'Stripe retries an event for three days: a late payment still finds its order');
  const late = ask(book, { block: block(20) }).order;
  sweep(book, T0 + HOLD_MS + GRACE_MS + 1);
  assert.equal(pay(book, late, { now: day }).order.state, 'paid');
  assert.deepEqual(sweep(book, T0 + HOLD_MS + 4 * 24 * 3600_000 + 1), { expired: [], pruned: [order], stale: [] });
  assert.deepEqual(book.orders, [late]);
  const failed = ask(book).order;
  assert.equal(drop(book, failed.id, T0), failed);
  assert.equal(failed.state, 'expired');
  assert.equal(book.events.at(-1).what, 'checkout-failed');
  assert.equal(expire(book, failed.id, T0), null, 'only a held order expires');
});

test('approve, reject and remove move an order only from the state they are meant for, and record who', () => {
  const book = createBook();
  const a = ask(book, { block: block(0) }).order, b = ask(book, { block: block(10) }).order;
  assert.deepEqual(approve(book, a.id, 'selim', T0), { error: 'state' }, 'not paid yet');
  pay(book, a); pay(book, b);
  assert.deepEqual(approve(book, a.id, 'selim', T0 + 1, [{ id: 'hand', ring: front, col: 2, width: 1, depth: 1, name: 'Hand' }]), { error: 'taken' },
    'seats added by hand after the payment are not sold twice');
  assert.equal(a.state, 'paid');
  assert.equal(approve(book, a.id, 'selim', T0 + 1), a);
  assert.deepEqual([a.state, a.decidedBy, a.decidedAt], ['live', 'selim', T0 + 1]);
  assert.equal(reject(book, b.id, 'ozer', '  Logo okunmuyor ', T0 + 2), b);
  assert.deepEqual([b.state, b.refunded, b.reason, b.decidedBy], ['refunded', true, 'Logo okunmuyor', 'ozer']);
  assert.deepEqual(reject(book, a.id, 'ozer', '', T0), { error: 'state' }, 'a live block is removed, not rejected');
  assert.equal(remove(book, a.id, 'selim', 'şikâyet', false, T0 + 3), a);
  assert.deepEqual([a.state, a.refunded], ['removed', false]);
  assert.deepEqual(remove(book, a.id, 'selim', '', true, T0), { error: 'state' });
  assert.deepEqual(approve(book, 'o-unknown', 'selim', T0), { error: 'state' });
  assert.deepEqual(book.events.slice(-3).map((e) => [e.what, e.by]), [['live', 'selim'], ['refunded', 'ozer'], ['removed', 'selim']]);
  const problem = ask(book, { block: block(50) }).order;
  pay(book, problem, { amount: 1 });
  assert.deepEqual(approve(book, problem.id, 'selim', T0), { error: 'state' }, 'a problem is refunded, never shown');
  assert.equal(reject(book, problem.id, 'selim', 'tutar', T0).state, 'refunded');
});

test('the hall sees live blocks with their logo and where held or paid ones are, nothing about the buyer', () => {
  const book = createBook();
  const live = ask(book, { block: block(0) }).order, waiting = ask(book, { block: block(10) }).order;
  pay(book, live); approve(book, live.id, 'selim', T0); pay(book, waiting);
  const held = ask(book, { block: block(20), ipKey: 'ip-b' }).order;
  assert.deepEqual(liveSeats(book), [{ id: live.id, ...block(0), name: 'Acme', link: 'https://acme.example/', image: `/seat-images/${live.id}.webp` }]);
  assert.deepEqual(reserved(book), [block(10), block(20)]);
  assert.deepEqual([buyerState(live), buyerState(waiting), buyerState(held)], ['live', 'paid', 'held']);
  pay(book, held, { amount: 1 });
  assert.equal(buyerState(held), 'paid', 'a problem looks like waiting to the buyer');
});

test('the summary counts waiting orders, live seats and money kept, this month too', () => {
  const book = createBook();
  const a = ask(book, { block: block(0) }).order, b = ask(book, { block: block(10) }).order;
  pay(book, a); pay(book, b);
  approve(book, a.id, 'selim', T0);
  const c = ask(book, { block: block(20), ipKey: 'ip-b' }).order;
  pay(book, c); reject(book, c.id, 'selim', '', T0);
  const old = ask(book, { block: block(30), ipKey: 'ip-c' }).order;
  pay(book, old, { now: Date.UTC(2026, 8, 30) }); approve(book, old.id, 'selim', T0);
  assert.deepEqual(summary(book, T0), { pending: 1, liveSeats: 12, revenue: a.amount + b.amount + old.amount, month: a.amount + b.amount });
});

test('a book read back keeps well-formed orders and the last 500 events only', () => {
  const book = createBook();
  const { order } = ask(book);
  const events = Array.from({ length: 600 }, (_, i) => ({ at: i, order: order.id, what: 'held', by: null }));
  const copy = createBook(JSON.parse(JSON.stringify({ orders: [...book.orders, { id: 'bad' }, null, { ...order, id: 'o-x', state: 'odd' }], events })));
  assert.deepEqual(copy.orders, [order]);
  assert.deepEqual([copy.events.length, copy.events[0].at], [500, 100]);
  assert.deepEqual(createBook(null), { orders: [], events: [] });
});
