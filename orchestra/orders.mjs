// The seat order book: a block is held while its buyer pays on Stripe, waits for approval once paid, then shows in
// the hall. Pure: the server reads and writes the file, talks to Stripe and moves the images.
//
//   held ─▶ paid ─▶ live ─▶ removed            held ─▶ expired (runs out, or Stripe could not be reached)
//             └──▶ refunded ◀── problem         a payment that does not match its order, or comes after its seats
//                                               went to someone else, is a problem: refunded from the panel
import { validBlock, blockSeats, blockPrice, cleanHolder, taken, canPlace, AUCTION, isAuctionBlock } from "./web/seats.mjs";

export const HOLD_MS = 31 * 60_000;       // Stripe keeps a Checkout session at least 30 minutes
export const GRACE_MS = 10 * 60_000;      // a payment made in the last second may be reported a little later
export const LOGO_MS = 24 * 3600_000;     // an expired order's logo is kept a day, for a payment reported late
export const FORGET_MS = 4 * 24 * 3600_000; // the order itself outlives Stripe's three days of retrying an event
export const HELD_PER_IP = 2, HELD_TOTAL = 50, EVENTS = 500;
const STATES = new Set(["held", "paid", "problem", "live", "expired", "refunded", "removed"]);
const BLOCKING = new Set(["held", "paid", "problem", "live"]);
const ID = /^o-[0-9a-f]{24}$/;

export function createBook(data) {
  const orders = (Array.isArray(data?.orders) ? data.orders : [])
    .filter((o) => o && typeof o === "object" && ID.test(o.id) && STATES.has(o.state) && validBlock(o));
  const events = (Array.isArray(data?.events) ? data.events : []).filter((e) => e && typeof e.what === "string").slice(-EVENTS);
  return { orders, events };
}

const find = (book, id) => book.orders.find((o) => o.id === id) || null;
const blockOf = (o) => ({ ring: o.ring, col: o.col, width: o.width, depth: o.depth });
const short = (text) => (typeof text === "string" ? text.trim().slice(0, 300) : "") || null;

function note(book, order, what, by, now) {
  book.events.push({ at: now, order: order.id, what, by: by || null });
  if (book.events.length > EVENTS) book.events.splice(0, book.events.length - EVENTS);
}

// Seats nobody else may take: added by hand, or in an order that is held, paid, a problem or live.
function used(book, hand, except) {
  const seats = taken(hand);
  for (const o of book.orders) if (o !== except && BLOCKING.has(o.state)) for (const id of blockSeats(o)) seats.add(id);
  return seats;
}

export function hold(book, { id, block, name, link, ipKey, now }, hand = []) {
  const b = blockOf(block || {});
  if (!validBlock(b) || isAuctionBlock(b)) return { error: "block" };   // the auction block is sold only by auction
  const holder = cleanHolder({ name, link });
  if (!holder) return { error: "holder" };
  const held = book.orders.filter((o) => o.state === "held");
  if (held.filter((o) => o.ipKey === ipKey).length >= HELD_PER_IP) return { error: "busy" };
  if (held.length >= HELD_TOTAL) return { error: "full" };
  if (!canPlace(b, used(book, hand))) return { error: "taken" };
  const order = { id, state: "held", ...b, ...holder, amount: blockPrice(b) * 100, currency: "usd", email: null, session: null,
    payment: null, ipKey, created: now, heldUntil: now + HOLD_MS, paidAt: null, decidedAt: null, decidedBy: null, reason: null, refunded: false,
    refunding: false, refund: null };
  book.orders.push(order);
  note(book, order, "held", null, now);
  return { order };
}

export function setSession(book, id, session) {
  const order = find(book, id);
  if (order) order.session = session;
}

// The auction's winner (auction.mjs) has paid already: the block waits for approval like any paid order. Sent
// again before approval, the name and link are replaced; the amount stays what was captured.
export function won(book, { id, name, link, amount, payment, email, now }) {
  const holder = cleanHolder({ name, link });
  if (!holder) return { error: "holder" };
  const known = find(book, id);
  if (known) {
    if (known.state !== "paid") return { error: "state" };
    Object.assign(known, holder);
    note(book, known, "content", null, now);
    return { order: known };
  }
  const order = { id, state: "paid", ...AUCTION.block, ...holder, amount, currency: "usd", email: email ?? null, session: null,
    payment, ipKey: null, created: now, heldUntil: now, paidAt: now, decidedAt: null, decidedBy: null, reason: null, refunded: false,
    refunding: false, refund: null, auction: true };
  book.orders.push(order);
  note(book, order, "paid", null, now);
  return { order };
}

// The address digest only limits holds: it goes when the order stops being held.
function release(order, state) { order.state = state; order.ipKey = null; }

// Stripe could not open a payment page: the hold ends at once.
export function drop(book, id, now) {
  const order = find(book, id);
  if (order?.state !== "held") return null;
  release(order, "expired");
  note(book, order, "checkout-failed", null, now);
  return order;
}

export function paid(book, { id, amount, currency, email, payment, session, now }, hand = []) {
  const order = find(book, id);
  if (!order || !["held", "expired"].includes(order.state)) return { order, changed: false };
  Object.assign(order, { email: typeof email === "string" ? email.slice(0, 200) : null, payment: payment ?? null,
    session: session ?? order.session, paidAt: now });
  const problem = amount !== order.amount || currency !== order.currency ? "amount" : !canPlace(blockOf(order), used(book, hand, order)) ? "taken" : null;
  release(order, problem ? "problem" : "paid");
  order.reason = problem;
  note(book, order, order.state, null, now);
  return { order, changed: true };
}

export function expire(book, id, now) {
  const order = find(book, id);
  if (order?.state !== "held") return null;
  release(order, "expired");
  note(book, order, "expired", null, now);
  return order;
}

export function sweep(book, now) {
  const expired = book.orders.filter((o) => o.state === "held" && o.heldUntil + GRACE_MS < now);
  for (const o of expired) { release(o, "expired"); note(book, o, "expired", null, now); }
  const pruned = book.orders.filter((o) => o.state === "expired" && o.heldUntil + FORGET_MS < now);
  book.orders = book.orders.filter((o) => !pruned.includes(o));
  const stale = book.orders.filter((o) => o.state === "expired" && o.heldUntil + LOGO_MS < now);
  return { expired, pruned, stale };
}

function decide(book, id, from, to, by, reason, now) {
  const order = find(book, id);
  if (!order || !from.includes(order.state)) return { error: "state" };
  Object.assign(order, { state: to, decidedBy: by, decidedAt: now, reason: short(reason) ?? order.reason, refunding: false });
  note(book, order, to, by, now);
  return order;
}
// A refund is marked (and written) before Stripe is asked: if what follows is lost, the order is never approved
// and rejecting it again finishes the same refund.
export function startRefund(book, id) {
  const order = find(book, id);
  if (!order || !["paid", "problem", "live"].includes(order.state)) return { error: "state" };
  order.refunding = true;
  return order;
}
export function stopRefund(book, id) {
  const order = find(book, id);
  if (order) order.refunding = false;
  return order;
}

// Seats added by hand since the payment would hide the block: the order waits until that is sorted out.
export function approve(book, id, by, now, hand = []) {
  const order = find(book, id);
  if (order?.refunding) return { error: "refunding" };
  if (order?.state === "paid" && !canPlace(blockOf(order), used(book, hand, order))) return { error: "taken" };
  return decide(book, id, ["paid"], "live", by, null, now);
}
export function reject(book, id, by, reason, now) {
  const order = decide(book, id, ["paid", "problem"], "refunded", by, reason, now);
  if (!order.error) order.refunded = true;
  return order;
}
export function remove(book, id, by, reason, refunded, now) {
  const order = decide(book, id, ["live"], "removed", by, reason, now);
  if (!order.error) order.refunded = Boolean(refunded);
  return order;
}

export const liveSeats = (book) => book.orders.filter((o) => o.state === "live")
  .map((o) => ({ id: o.id, ...blockOf(o), name: o.name, link: o.link, image: `/seat-images/${o.id}.webp` }));
export const reserved = (book) => book.orders.filter((o) => ["held", "paid", "problem"].includes(o.state)).map(blockOf);
// What the buyer is told: a problem is still "waiting" to them until it is refunded.
export const buyerState = (o) => (o.state === "problem" ? "paid" : o.state);

export function summary(book, now) {
  const month = new Date(now).toISOString().slice(0, 7);
  const kept = book.orders.filter((o) => o.paidAt && !o.refunded);
  return {
    pending: book.orders.filter((o) => o.state === "paid" || o.state === "problem").length,
    liveSeats: book.orders.filter((o) => o.state === "live").reduce((n, o) => n + o.width * o.depth, 0),
    revenue: kept.reduce((n, o) => n + o.amount, 0),
    month: kept.filter((o) => new Date(o.paidAt).toISOString().slice(0, 7) === month).reduce((n, o) => n + o.amount, 0),
  };
}
