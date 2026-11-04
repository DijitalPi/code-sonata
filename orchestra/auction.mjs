// The front-block auction: one block (seats.mjs AUCTION) sold to the highest bid. A bid is a card hold on Stripe
// (manual capture): it counts once Stripe holds the money, the bid it passes is let go, and at the end the top bid is
// captured. The winner then sends a logo and the block joins the order book (orders.mjs `won`). Pure: the server
// reads and writes the file and talks to Stripe.
//
//   auction: open ─▶ capturing ─▶ won        open ─▶ unsold (nobody bid)        capturing ─▶ failed ─▶ unsold
//   bid:     pending ─▶ top ─▶ outbid | winner       pending ─▶ late (too low, too late, not the amount held)
//            pending ─▶ expired (page closed or never paid)
import { AUCTION, canPlace } from "./web/seats.mjs";

export const RUN_MS = 5 * 86_400_000, HARD_MS = 6 * 86_400_000;   // Stripe keeps a card hold seven days
export const SNIPE_MS = 10 * 60_000;      // a bid in the last ten minutes moves the end on
export const PAGE_MS = 31 * 60_000;       // a bid's Stripe page, as an order's
export const GRACE_MS = 10 * 60_000;      // a hold reported a little late still finds its bid
export const FORGET_MS = 30 * 86_400_000; // bidders' e-mails are kept a month after the end
export const RETRY_MS = 4 * 86_400_000;   // Stripe resends an event for three days: a page closed here may still report
export const PENDING_PER_IP = 2, PENDING_TOTAL = 50;
const AUCTION_STATES = new Set(["open", "capturing", "won", "unsold", "failed"]);
const BID_STATES = new Set(["pending", "top", "outbid", "winner", "late", "expired"]);
const AUCTION_ID = /^a-[0-9a-f]{24}$/, BID_ID = /^b-[0-9a-f]{24}$/;

// `old`: bids of earlier auctions that may still hold money (a page still open, a hold not let go yet). A new
// auction never forgets them: a late hold is let go, a failed letting go is tried again.
const validAuction = (a) => Boolean(a) && typeof a === "object" && AUCTION_ID.test(a.id) && AUCTION_STATES.has(a.state);
const validBid = (b) => Boolean(b) && typeof b === "object" && BID_ID.test(b.id) && BID_STATES.has(b.state) && Number.isInteger(b.amount);
export function createAuctions(data) {
  const a = data?.auction;
  const auction = validAuction(a) ? a : null;
  const valid = (list) => (Array.isArray(list) ? list : []).filter(validBid);
  const bids = auction ? valid(data.bids) : [], old = auction ? valid(data.old) : [];
  const past = (Array.isArray(data?.past) ? data.past : []).filter((p) => p && typeof p === "object").slice(-20);
  return { auction, bids, old, past };
}

// Why a written auction file cannot be trusted, or null. A file the server writes always has its auction (null
// before the first, and then no bids) and every bid whole, each under its own id; the bid marked top or winner is
// the one the auction points to, and an auction that ended with bids has it. Anything else may hide a block sold or
// a hold to capture, so it is never read as no auction.
export function auctionProblem(data) {
  if (!data || typeof data !== "object" || !("auction" in data)) return "no auction in the file";
  const a = data.auction;
  if (a !== null && !validAuction(a)) return "an auction it cannot read";
  for (const k of ["bids", "old"]) {
    if (data[k] === undefined) continue;
    if (!Array.isArray(data[k])) return `${k} is not a list`;
    const bad = data[k].find((b) => !validBid(b));
    if (bad !== undefined) return `a bid it cannot read (${bad?.id ?? "no id"})`;
  }
  const bids = data.bids || [], every = [...bids, ...(data.old || [])];
  if (new Set(every.map((b) => b.id)).size !== every.length) return "two bids with one id";   // found by id, the wrong one would be used
  if (a === null) return every.length ? "bids without their auction" : null;
  const leading = bids.filter((b) => ["top", "winner"].includes(b.state));
  if (leading.length > 1) return "more than one top bid";
  if ((a.top ?? null) !== (leading[0]?.id ?? null)) return "its top bid is not the one it points to";
  const wants = { capturing: "top", failed: "top", won: "winner" }[a.state];
  if (wants && leading[0]?.state !== wants) return `${a.state} without its ${wants} bid`;
  if (a.state !== "won" && leading[0]?.state === "winner") return `a winner while ${a.state}`;
  return null;
}

const oldOf = (ab) => ab.old || [];
// A bid of an earlier auction still matters while it may hold money: its page open, its hold not let go yet, or a
// page that ran out here but whose payment Stripe may still report.
const owing = (b, now) => b.state === "pending" || b.releasing || (b.state === "expired" && b.settledAt + RETRY_MS > now);
export const findBid = (ab, id) => ab.bids.find((b) => b.id === id) || oldOf(ab).find((b) => b.id === id) || null;
export const leader = (ab) => (ab.auction?.top ? findBid(ab, ab.auction.top) : null);
export const minBid = (ab) => { const top = leader(ab); return top ? top.amount + AUCTION.step : AUCTION.start; };
export const winner = (ab) => (ab.auction?.state === "won" ? leader(ab) : null);
// The block is the auction's while it runs and once won; the winner's order (orders.mjs) holds it after that.
export const blocking = (ab) => Boolean(ab.auction && ["open", "capturing", "won"].includes(ab.auction.state));

function settle(bid, state, now) { bid.state = state; bid.settledAt = now; bid.ipKey = null; }

export function start(ab, { id, by, now, used, again = false }) {
  const a = ab.auction;
  if (a && !["unsold", "failed"].includes(a.state) && !(a.state === "won" && again)) return { error: "state" };
  if (!canPlace(AUCTION.block, used)) return { error: "taken" };
  if (a) ab.past.push({ id: a.id, state: a.state, startedAt: a.startedAt, endedAt: a.endedAt, amount: leader(ab)?.amount ?? null, order: a.order });
  ab.auction = { id, state: "open", startedAt: now, startedBy: by, endsAt: now + RUN_MS, hardEnd: now + HARD_MS, top: null,
    endedAt: null, capturedAt: null, failedAt: null, order: null };
  ab.old = [...oldOf(ab), ...ab.bids].filter((b) => owing(b, now));
  ab.bids = [];
  return { auction: ab.auction };
}

export function openBid(ab, { id, amount, ipKey, now }) {
  const a = ab.auction;
  if (a?.state !== "open" || now >= a.endsAt) return { error: "closed" };
  if (!Number.isInteger(amount) || amount < minBid(ab) || amount > AUCTION.max) return { error: "amount" };
  const pending = ab.bids.filter((b) => b.state === "pending");
  if (pending.filter((b) => b.ipKey === ipKey).length >= PENDING_PER_IP) return { error: "busy" };
  if (pending.length >= PENDING_TOTAL) return { error: "full" };
  const bid = { id, amount, state: "pending", session: null, payment: null, email: null, ipKey, createdAt: now, settledAt: null, releasing: false };
  ab.bids.push(bid);
  return { bid };
}
export function setBidSession(ab, id, session) { const b = findBid(ab, id); if (b) b.session = session; }

// A page closed (or never paid, or Stripe could not open it) before any hold.
export function expireBid(ab, id, now) {
  const b = findBid(ab, id);
  if (b?.state !== "pending") return null;
  settle(b, "expired", now);
  return b;
}

// Stripe holds money for a bid. It counts while the auction runs, if it still beats the top bid and the hold is
// exactly the bid; otherwise whatever is held is let go. A page swept as expired may still report a hold: let go too.
export function confirmBid(ab, { id, status, capturable, currency, payment, email, now }) {
  const bid = findBid(ab, id), a = ab.auction;
  if (!bid || !["pending", "expired"].includes(bid.state) || (bid.state === "expired" && status !== "requires_capture")) return { bid, changed: false, release: [] };
  bid.payment = payment ?? null;
  bid.email = typeof email === "string" ? email.slice(0, 200) : null;
  const holding = status === "requires_capture";
  const counts = bid.state === "pending" && ab.bids.includes(bid) && holding && capturable === bid.amount * 100 && currency === "usd"
    && a?.state === "open" && now < a.endsAt && bid.amount >= minBid(ab);
  if (!counts) {
    settle(bid, "late", now);
    bid.releasing = holding && Boolean(bid.payment);
    return { bid, changed: true, release: bid.releasing ? [bid] : [] };
  }
  const passed = leader(ab);
  if (passed) { settle(passed, "outbid", now); passed.releasing = true; }
  settle(bid, "top", now);
  a.top = bid.id;
  if (now > a.endsAt - SNIPE_MS) a.endsAt = Math.min(now + SNIPE_MS, a.hardEnd);
  return { bid, changed: true, top: true, release: passed ? [passed] : [] };
}
export function released(ab, id) { const b = findBid(ab, id); if (b) b.releasing = false; return b; }
export const toRelease = (ab) => [...ab.bids, ...oldOf(ab)].filter((b) => b.releasing && b.payment);

export const due = (ab, now) => ab.auction?.state === "open" && now >= ab.auction.endsAt;
// The end. The top bid is marked for capture first (a lost answer is retried with the same key, never charged twice).
export function end(ab, now) {
  if (!due(ab, now)) return { error: "state" };
  const top = leader(ab);
  ab.auction.endedAt = now;
  ab.auction.state = top ? "capturing" : "unsold";
  return { capture: top };
}
export function captured(ab, now) {
  const a = ab.auction;
  if (a?.state !== "capturing") return { error: "state" };
  a.state = "won"; a.capturedAt = now;
  settle(leader(ab), "winner", now);
  return { auction: a };
}
export function captureRefused(ab, now) {
  const a = ab.auction;
  if (a?.state !== "capturing") return { error: "state" };
  a.state = "failed"; a.failedAt = now;
  return { auction: a };
}
export function close(ab) {
  const a = ab.auction;
  if (a?.state !== "failed") return { error: "state" };
  a.state = "unsold";
  return { auction: a };
}
export function setOrder(ab, order) {
  if (ab.auction?.state !== "won") return { error: "state" };
  ab.auction.order = order;
  return { auction: ab.auction };
}

// Pages never paid expire; bids of earlier auctions that owe nothing any more are dropped; a month after the end the
// e-mails are forgotten, but the winner's (the order needs it, and it is in the order book too).
export function sweepBids(ab, now) {
  const expired = [...ab.bids, ...oldOf(ab)].filter((b) => b.state === "pending" && b.createdAt + PAGE_MS + GRACE_MS < now);
  for (const b of expired) settle(b, "expired", now);
  const kept = oldOf(ab).filter((b) => owing(b, now)), dropped = oldOf(ab).length - kept.length;
  if (dropped) ab.old = kept;
  let forgot = 0;
  const keep = ab.auction?.state === "won" ? ab.auction.top : null;
  if (ab.auction?.endedAt && ab.auction.endedAt + FORGET_MS < now) for (const b of ab.bids) if (b.email && b.id !== keep) { b.email = null; forgot++; }
  return { expired, forgot, dropped };
}

// What anyone sees: the block, the price, the end, the bids that counted (amount and time, no one's name).
export function publicView(ab) {
  const a = ab.auction;
  if (!a) return null;
  const bids = ab.bids.filter((b) => ["top", "outbid", "winner"].includes(b.state)).sort((x, y) => y.amount - x.amount)
    .slice(0, 20).map((b) => ({ amount: b.amount, at: b.settledAt }));
  return { state: a.state, block: AUCTION.block, endsAt: a.endsAt, current: leader(ab)?.amount ?? null, min: minBid(ab), bids };
}
// What a bidder sees of their own bid (they know its id from their return address); `releasing`: its hold is still
// being let go, so the page does not say it is gone.
export function bidView(ab, id) {
  const b = findBid(ab, id);
  return b && { state: b.state, auction: ab.bids.includes(b) ? ab.auction.state : "ended", amount: b.amount, current: leader(ab)?.amount ?? null,
    endsAt: ab.auction.endsAt, content: Boolean(ab.auction.order), releasing: Boolean(b.releasing) };
}
const unaddressed = ({ ipKey, ...b }) => b;
export const panelView = (ab) => ({ auction: ab.auction, bids: ab.bids.map(unaddressed), old: oldOf(ab).map(unaddressed), past: ab.past });
