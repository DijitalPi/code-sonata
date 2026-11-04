import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addCoupon, stopCoupon, check, usedOf, discount, couponView, cleanCoupons, codeOf } from './coupons.mjs';
import { createBook } from './orders.mjs';
import { TIERS } from './web/seats.mjs';

const T0 = Date.UTC(2026, 10, 3, 9, 0), DAY = 86_400_000;
const at = (t, col = 0) => ({ ring: TIERS[t].rings[0], col, width: 1, depth: 1 });
const order = (code, state) => ({ id: 'o-x', coupon: code, state });

test('a code is letters, digits and dashes, 3 to 24, read in capitals; it names a tier, a limit and a number of days', () => {
  const book = createBook();
  const { coupon } = addCoupon(book, { code: ' linkedin ', tier: 'middle', max: 50, days: 7, by: 'selim', now: T0 });
  assert.deepEqual(coupon, { code: 'LINKEDIN', tier: 'middle', max: 50, until: T0 + 7 * DAY, stopped: false, created: T0, by: 'selim' });
  assert.deepEqual(book.coupons, [coupon]);
  const bad = (extra) => addCoupon(book, { code: 'OK-1', tier: 'any', max: 1, days: 1, now: T0, ...extra }).error;
  assert.equal(bad({ code: 'linkedin' }), 'exists');
  for (const code of ['AB', 'X'.repeat(25), 'KOD BU', 'KÜPON', 7]) assert.equal(bad({ code }), 'code', String(code));
  assert.equal(bad({ tier: 'vip' }), 'tier');
  for (const max of [0, 1001, 2.5, '5']) assert.equal(bad({ max }), 'max', String(max));
  for (const days of [0, 91, 1.5]) assert.equal(bad({ days }), 'days', String(days));
  assert.equal(codeOf(42), '');
});

test('a code works on its tier until it is stopped, runs out of time or of uses', () => {
  const book = createBook();
  addCoupon(book, { code: 'ON-1', tier: 'front', max: 2, days: 7, now: T0 });
  addCoupon(book, { code: 'HER', tier: 'any', max: 1, days: 1, now: T0 });
  assert.equal(check(book, 'on-1', at(0), T0).coupon.code, 'ON-1');
  assert.equal(check(book, 'ON-1', at(1), T0).error, 'tier');
  assert.equal(check(book, 'ON-1', null, T0).coupon.code, 'ON-1', 'without a block only the code is checked');
  for (const t of [0, 1, 2]) assert.equal(check(book, 'HER', at(t), T0).coupon.code, 'HER');
  assert.equal(check(book, 'YOK', at(0), T0).error, 'code');
  assert.equal(check(book, 'HER', at(0), T0 + DAY).error, 'code', 'out of time');
  stopCoupon(book, 'her');
  assert.equal(check(book, 'HER', at(0), T0).error, 'code', 'stopped');
  assert.equal(stopCoupon(book, 'YOK').error, 'coupon');
  book.orders.push(order('ON-1', 'held'), order('ON-1', 'live'));
  assert.equal(usedOf(book, 'ON-1'), 2);
  assert.equal(check(book, 'ON-1', at(0), T0).error, 'used');
});

test('an order that runs out, is rejected or comes down gives its use back', () => {
  const book = createBook();
  for (const state of ['expired', 'refunded', 'removed']) book.orders.push(order('ON-1', state));
  assert.equal(usedOf(book, 'ON-1'), 0);
  for (const state of ['held', 'paid', 'problem', 'live']) assert.equal(usedOf({ ...book, orders: [order('ON-1', state)] }, 'ON-1'), 1, state);
});

test("the free seat is one seat of the block's tier", () => {
  assert.deepEqual([0, 1, 2].map((t) => discount(at(t))), TIERS.map((tr) => tr.price * 100));
});

test('the panel sees each code with its uses and whether it still works', () => {
  const book = createBook();
  for (const [code, max, days] of [['A-1', 5, 7], ['B-1', 1, 7], ['C-1', 5, 1], ['D-1', 5, 7]]) addCoupon(book, { code, tier: 'any', max, days, now: T0 });
  stopCoupon(book, 'D-1');
  book.orders.push(order('B-1', 'paid'), order('A-1', 'live'));
  assert.deepEqual(couponView(book, T0 + 2 * DAY).map((c) => [c.code, c.used, c.state]),
    [['A-1', 1, 'open'], ['B-1', 1, 'used'], ['C-1', 0, 'expired'], ['D-1', 0, 'stopped']]);
});

test('codes are kept with the orders and read back; a broken one is left out', () => {
  const book = createBook();
  addCoupon(book, { code: 'LINKEDIN', tier: 'middle', max: 50, days: 7, now: T0 });
  const saved = JSON.parse(JSON.stringify({ ...book, coupons: [...book.coupons, { code: 'kotu', tier: 'middle', max: 5, until: T0 }, null] }));
  assert.deepEqual(createBook(saved).coupons.map((c) => c.code), ['LINKEDIN']);
  assert.deepEqual(createBook().coupons, []);
  assert.deepEqual(cleanCoupons('x'), []);
});
