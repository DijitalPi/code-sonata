import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAuctions, start, minBid, openBid, setBidSession, expireBid, confirmBid, released, toRelease, due, end, captured,
  captureRefused, close, setOrder, leader, winner, blocking, sweepBids, publicView, bidView, panelView,
  RUN_MS, HARD_MS, SNIPE_MS, PAGE_MS, GRACE_MS, FORGET_MS, PENDING_PER_IP } from './auction.mjs';
import { AUCTION, taken } from './web/seats.mjs';

const T0 = Date.UTC(2026, 10, 2, 12, 0);
let n = 0;
const id = (p) => `${p}-${(++n).toString(16).padStart(24, '0')}`;
const fresh = () => { const ab = createAuctions(); start(ab, { id: id('a'), by: 'selim', now: T0, used: new Set() }); return ab; };
// Each bid from its own address unless the test names one (an address keeps at most two pages open).
const ask = (ab, amount, extra = {}) => openBid(ab, { id: id('b'), amount, ipKey: id('ip'), now: T0 + 1000, ...extra }).bid;
const hold = (ab, bid, extra = {}) => confirmBid(ab, { id: bid.id, status: 'requires_capture', capturable: bid.amount * 100, currency: 'usd',
  payment: `pi_${bid.id}`, email: 'x@y.example', now: T0 + 2000, ...extra });

test('an auction opens for five days, at most six, on a free block, and blocks it from normal sale', () => {
  const ab = createAuctions();
  assert.deepEqual(start(ab, { id: id('a'), by: 'selim', now: T0, used: taken([{ ...AUCTION.block, width: 1, depth: 1 }]) }), { error: 'taken' });
  const { auction } = start(ab, { id: id('a'), by: 'selim', now: T0, used: new Set() });
  assert.deepEqual([auction.state, auction.endsAt, auction.hardEnd, auction.startedBy], ['open', T0 + RUN_MS, T0 + HARD_MS, 'selim']);
  assert.equal(blocking(ab), true);
  assert.deepEqual(start(ab, { id: id('a'), by: 'selim', now: T0, used: new Set() }), { error: 'state' });
  assert.equal(minBid(ab), 2400);
});

test('a bid must beat the top one by a step, stay under the cap, and come while the auction runs', () => {
  const ab = fresh();
  for (const amount of [2399, 2400.5, '2400', 100_001]) assert.equal(openBid(ab, { id: id('b'), amount, ipKey: 'ip', now: T0 }).error, 'amount');
  const a = ask(ab, 2400);
  assert.equal(a.state, 'pending');
  assert.equal(minBid(ab), 2400, 'a bid counts only once Stripe holds it');
  hold(ab, a);
  assert.equal(minBid(ab), 2500);
  assert.equal(openBid(ab, { id: id('b'), amount: 2450, ipKey: 'ip', now: T0 }).error, 'amount');
  assert.equal(openBid(ab, { id: id('b'), amount: 2500, ipKey: 'ip', now: ab.auction.endsAt }).error, 'closed');
});

test('one address keeps at most two Stripe pages open', () => {
  const ab = fresh();
  for (let i = 0; i < PENDING_PER_IP; i++) ask(ab, 2400, { ipKey: 'ip' });
  assert.equal(openBid(ab, { id: id('b'), amount: 2400, ipKey: 'ip', now: T0 }).error, 'busy');
  assert.ok(openBid(ab, { id: id('b'), amount: 2400, ipKey: 'other', now: T0 }).bid);
});

test('a held bid goes on top and lets the one it passed go; a hold reported twice changes nothing', () => {
  const ab = fresh(), a = ask(ab, 2400), b = ask(ab, 2500);
  assert.deepEqual(hold(ab, a).release, []);
  const second = hold(ab, b);
  assert.deepEqual([second.top, second.release.map((x) => x.id)], [true, [a.id]]);
  assert.deepEqual([a.state, a.releasing, b.state, leader(ab).id], ['outbid', true, 'top', b.id]);
  assert.deepEqual(toRelease(ab).map((x) => x.id), [a.id]);
  released(ab, a.id);
  assert.deepEqual(toRelease(ab), []);
  assert.equal(hold(ab, b).changed, false);
});

test('a hold that is too low by now, too late, or not exactly the bid is let go at once', () => {
  const ab = fresh(), a = ask(ab, 2400), b = ask(ab, 2400), c = ask(ab, 2600), d = ask(ab, 2700);
  hold(ab, a);
  assert.deepEqual([hold(ab, b).bid.state, b.releasing], ['late', true], 'passed while its page was open');
  assert.deepEqual([hold(ab, c, { capturable: 2500 * 100 }).bid.state, c.releasing], ['late', true], 'Stripe holds another amount');
  assert.deepEqual([hold(ab, d, { now: ab.auction.endsAt }).bid.state, d.releasing], ['late', true], 'after the end');
  const e = ask(ab, 2800);
  assert.deepEqual([hold(ab, e, { status: 'requires_payment_method' }).bid.state, e.releasing], ['late', false], 'nothing held, nothing to let go');
});

test('a bid in the last ten minutes moves the end ten minutes on, never past six days', () => {
  const ab = fresh(), a = ask(ab, 2400);
  hold(ab, a, { now: ab.auction.endsAt - 5 * 60_000 });
  assert.equal(ab.auction.endsAt, T0 + RUN_MS - 5 * 60_000 + SNIPE_MS);
  ab.auction.endsAt = ab.auction.hardEnd - 60_000;
  const b = ask(ab, 2500, { now: ab.auction.hardEnd - 120_000 });
  hold(ab, b, { now: ab.auction.hardEnd - 90_000 });
  assert.equal(ab.auction.endsAt, ab.auction.hardEnd);
});

test('at the end the top bid is to be captured; captured it wins; refused it fails and can be closed', () => {
  const ab = fresh(), a = ask(ab, 2400);
  hold(ab, a);
  assert.equal(due(ab, ab.auction.endsAt - 1), false);
  assert.equal(end(ab, ab.auction.endsAt).capture.id, a.id);
  assert.equal(ab.auction.state, 'capturing');
  assert.equal(captured(ab, T0 + RUN_MS + 1).auction.state, 'won');
  assert.deepEqual([winner(ab).id, a.state], [a.id, 'winner']);
  const other = fresh(), b = ask(other, 2400); hold(other, b); end(other, other.auction.endsAt);
  assert.equal(captureRefused(other, T0).auction.state, 'failed');
  assert.equal(close(other).auction.state, 'unsold');
  assert.equal(blocking(other), false);
});

test('an auction nobody bid on ends unsold and frees the block', () => {
  const ab = fresh();
  assert.equal(end(ab, ab.auction.endsAt).capture, null);
  assert.deepEqual([ab.auction.state, blocking(ab)], ['unsold', false]);
  assert.ok(start(ab, { id: id('a'), by: 'selim', now: T0 + RUN_MS, used: new Set() }).auction, 'it can start again');
  assert.equal(ab.past.length, 1);
});

test('a won auction starts again only when its order was refunded or removed', () => {
  const ab = fresh(), a = ask(ab, 2400); hold(ab, a); end(ab, ab.auction.endsAt); captured(ab, T0);
  setOrder(ab, 'o-1');
  assert.deepEqual(start(ab, { id: id('a'), by: 'selim', now: T0, used: new Set() }), { error: 'state' });
  assert.ok(start(ab, { id: id('a'), by: 'selim', now: T0, used: new Set(), again: true }).auction);
});

test('pages never paid expire; e-mails are forgotten thirty days after the end', () => {
  const ab = fresh(), a = ask(ab, 2400), b = ask(ab, 2500);
  hold(ab, b);
  assert.deepEqual(sweepBids(ab, T0 + 1000 + PAGE_MS + GRACE_MS + 1).expired.map((x) => x.id), [a.id]);
  assert.equal(hold(ab, a, { now: T0 + PAGE_MS + GRACE_MS + 2 }).bid.state, 'late', 'a late hold on an expired page is let go');
  end(ab, ab.auction.endsAt);
  assert.equal(sweepBids(ab, ab.auction.endedAt + FORGET_MS + 1).forgot, 2);
  assert.ok(ab.bids.every((x) => x.email === null));
});

test('what the page sees: amounts and times, never e-mails or addresses; the panel sees all but addresses', () => {
  const ab = fresh(), a = ask(ab, 2400); hold(ab, a);
  const view = publicView(ab);
  assert.deepEqual([view.state, view.current, view.min, view.bids], ['open', 2400, 2500, [{ amount: 2400, at: T0 + 2000 }]]);
  assert.ok(!JSON.stringify(view).includes('x@y.example'));
  assert.deepEqual(bidView(ab, a.id), { state: 'top', auction: 'open', amount: 2400, current: 2400, endsAt: ab.auction.endsAt, content: false });
  assert.equal(bidView(ab, 'b-0'), null);
  assert.ok(!JSON.stringify(panelView(ab)).includes('ipKey'));
  const ab2 = createAuctions(JSON.parse(JSON.stringify(ab, (k, v) => (k === 'ipKey' ? undefined : v))));
  assert.deepEqual(publicView(ab2), view, 'read back from its file');
});

test('a closed page before any hold expires its bid', () => {
  const ab = fresh(), a = ask(ab, 2400);
  setBidSession(ab, a.id, 'cs_1');
  assert.equal(expireBid(ab, a.id, T0).state, 'expired');
  assert.equal(expireBid(ab, a.id, T0), null);
});

test('a new auction keeps the holds of the last one still to let go; a page of it paid late is let go too (B3)', () => {
  const ab = fresh(), a = ask(ab, 2400), b = ask(ab, 2500), c = ask(ab, 2600);
  hold(ab, a); hold(ab, b);
  end(ab, ab.auction.endsAt); captureRefused(ab, ab.auction.endsAt);
  assert.ok(start(ab, { id: id('a'), by: 'selim', now: T0 + RUN_MS, used: new Set() }).auction);
  assert.deepEqual(toRelease(ab).map((x) => x.id), [a.id], 'the passed bid of the last auction is still to let go');
  assert.equal(createAuctions(JSON.parse(JSON.stringify(ab))).old.length, 2, 'kept in the file');
  assert.deepEqual([publicView(ab).bids, minBid(ab), bidView(ab, c.id).state], [[], 2400, 'pending']);
  const late = hold(ab, c, { now: T0 + RUN_MS + 1000 });
  assert.deepEqual([late.bid.state, c.releasing, Boolean(late.top), ab.auction.top], ['late', true, false, null]);
  released(ab, a.id); released(ab, c.id);
  assert.equal(sweepBids(ab, T0 + RUN_MS + 2000).dropped, 2, 'settled ones are dropped');
  assert.deepEqual([toRelease(ab), ab.old], [[], []]);
});

test('the winner keeps their e-mail after a month; the others are forgotten (B6)', () => {
  const ab = fresh(), a = ask(ab, 2400), b = ask(ab, 2500);
  hold(ab, a); hold(ab, b);
  end(ab, ab.auction.endsAt); captured(ab, ab.auction.endsAt);
  assert.equal(sweepBids(ab, ab.auction.endedAt + FORGET_MS + 1).forgot, 1);
  assert.deepEqual([a.email, b.email], [null, 'x@y.example']);
});
