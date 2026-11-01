// Selling seats: the buyer's checkout, Stripe's events, and the management panel's API. The server hands every
// request here first; anything not about the shop is left to it. The order book lives in ORDERS_FILE, waiting
// logos in SEATS_DIR/pending (shown only in the panel), approved ones in SEATS_DIR (public, /seat-images/).
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createBook, hold, setSession, drop, paid, expire, sweep, approve, reject, remove, startRefund, stopRefund, liveSeats, reserved, summary, buyerState } from "./orders.mjs";
import { createStripe, verifySignature } from "./stripe.mjs";
import { parseKeys, whoHasKey, sessionSecret, makeCookie, readCookie, SESSION_MS } from "./admin.mjs";
import { webpSize } from "./webp.mjs";
import { createAuctions, start, minBid, openBid, setBidSession, expireBid, confirmBid, released, toRelease, due, end, captured,
  captureRefused, close, setOrder, leader, winner, blocking, sweepBids, publicView, bidView, panelView, PAGE_MS } from "./auction.mjs";
import { PLAN, tierOf, cleanSeats, AUCTION, taken } from "./web/seats.mjs";
import { EN } from "./web/lang-en.mjs";

const IMAGE_MAX = 300 * 1024, IMAGE_SIDE = 1024;
const TRIES = 5, TRIES_MS = 10 * 60_000, LOGINS = 5, LOGINS_MS = 60_000;
const ORDER = /^o-[0-9a-f]{24}$/, BID = /^b-[0-9a-f]{24}$/;

// Up to `limit` bytes of a request body, or null once it is longer or breaks off.
async function body(req, limit) {
  const chunks = [];
  let size = 0;
  try { for await (const chunk of req) { size += chunk.length; if (size > limit) return null; chunks.push(chunk); } }
  catch { return null; }
  return Buffer.concat(chunks).toString("utf8");
}
function parse(raw) {
  try { const value = JSON.parse(raw || "{}"); return value && typeof value === "object" && !Array.isArray(value) ? value : null; }
  catch { return null; }
}
function send(res, code, data, headers = {}) {
  res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store", ...headers });
  res.end(data === undefined ? "" : JSON.stringify(data));
}
// Counts an attempt in its window: true once there were more than `max`.
function over(map, key, now, max, windowMs) {
  const w = map.get(key);
  if (!w || now - w[0] > windowMs) { map.set(key, [now, 1]); }
  else w[1]++;
  if (map.size > 10_000) for (const [k, v] of map) if (now - v[0] > windowMs) map.delete(k);
  return map.get(key)[1] > max;
}

export function createShop({ env = process.env, hand = () => [], log = console.log, fetch = globalThis.fetch }) {
  const seatsDir = env.SEATS_DIR || "", ordersFile = env.ORDERS_FILE || "";
  const keys = parseKeys(env.ADMIN_KEYS), secret = sessionSecret(env.ADMIN_KEYS || ""), secure = env.TRUST_PROXY === "1";
  const stripe = createStripe({ key: env.STRIPE_SECRET_KEY, base: env.STRIPE_API_BASE || undefined, fetch });
  let book = createBook(), readable = true;
  if (ordersFile && existsSync(ordersFile)) {
    try {
      const data = JSON.parse(readFileSync(ordersFile, "utf8"));
      if (!Array.isArray(data?.orders)) throw new Error("no list of orders");
      book = createBook(data);
    } catch (error) { readable = false; log(`orders: not read, payment stays closed (${error.message})`); }
  }
  // The front-block auction (auction.mjs) lives in AUCTION_FILE; it needs payment open and its own file.
  const auctionFile = env.AUCTION_FILE || "";
  let ab = createAuctions(), auctionReadable = true;
  if (auctionFile && existsSync(auctionFile)) {
    try { ab = createAuctions(JSON.parse(readFileSync(auctionFile, "utf8"))); }
    catch (error) { auctionReadable = false; log(`auction: not read, stays closed (${error.message})`); }
  }
  // Payment opens only with someone to approve what is paid.
  const open = Boolean(env.STRIPE_SECRET_KEY && env.STRIPE_WEBHOOK_SECRET && ordersFile && seatsDir && readable && keys.size > 0);
  const panelOpen = keys.size > 0 && readable && Boolean(ordersFile);
  const auctionOpen = open && Boolean(auctionFile) && auctionReadable;
  const tries = new Map(), logins = new Map(), deciding = new Set();
  const pending = (id) => join(seatsDir, "pending", `${id}.webp`), shown = (id) => join(seatsDir, `${id}.webp`);
  const forget = (file) => { try { unlinkSync(file); } catch { /* already gone */ } };

  // A change to the book counts once it is on disk: if the file cannot be written it is undone and the error goes
  // on, so the same request again (Stripe resends an event, the panel is clicked again) finds the order as it was.
  // The address digest is never written; it only limits holds while the server runs.
  function commit(change, changed = (result) => Boolean(result) && !result.error) {
    const before = structuredClone(book);
    try {
      const result = change();
      if (!changed(result)) return result;
      writeFileSync(`${ordersFile}.tmp`, JSON.stringify(book, (k, v) => (k === "ipKey" ? undefined : v)));
      renameSync(`${ordersFile}.tmp`, ordersFile);
      return result;
    } catch (error) { book = before; throw error; }
  }
  const find = (id) => book.orders.find((o) => o.id === id);
  function commitAuction(change, changed = (result) => Boolean(result) && !result.error) {
    const before = structuredClone(ab);
    try {
      const result = change();
      if (!changed(result)) return result;
      writeFileSync(`${auctionFile}.tmp`, JSON.stringify(ab, (k, v) => (k === "ipKey" ? undefined : v)));
      renameSync(`${auctionFile}.tmp`, auctionFile);
      return result;
    } catch (error) { ab = before; throw error; }
  }
  // Auction steps run one at a time: a hold reported, the end, a capture, a start from the panel.
  let line = Promise.resolve();
  const serial = (step) => { const run = line.then(step); line = run.catch(() => {}); return run; };
  const siteOf = (site) => (env.PUBLIC_URL ? new URL(env.PUBLIC_URL).origin : site);
  const when = (ms) => new Date(ms).toISOString().replace("T", " ").slice(0, 16) + " UTC";
  async function releaseAll(bids) {
    for (const b of bids) {
      try { await stripe.cancelIntent(b.payment, `release-${b.id}`); await serial(() => commitAuction(() => released(ab, b.id))); }
      catch (error) { log(`auction: hold of ${b.id} not let go yet (${error.message})`); }
    }
  }
  // The auction holds the block until the winner's order takes it over; meanwhile no normal order may take its seats.
  const auctionHolds = () => auctionOpen && blocking(ab) && !(ab.auction.order && find(ab.auction.order));
  const occupied = () => (auctionHolds() ? [...hand(), AUCTION.block] : hand());
  const label = (o) => { const n = o.width * o.depth; return `${EN[tierOf(o.ring).label] || tierOf(o.ring).label} · ${n} seat${n === 1 ? "" : "s"}`; };
  async function tell(text) {
    if (!env.SLACK_WEBHOOK_URL) return;
    try {
      const res = await fetch(env.SLACK_WEBHOOK_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }), signal: AbortSignal.timeout(5000) });
      if (!res.ok) log(`slack: ${res.status}`);
    } catch (error) { log(`slack: ${error.message}`); }
  }
  function told(order, site) {
    const what = `${order.name} · ${tierOf(order.ring).label} · ${order.width * order.depth} koltuk · ${order.amount / 100} $`;
    const where = `${env.PUBLIC_URL ? new URL(env.PUBLIC_URL).origin : site}/yonetim/#bekleyen`;
    return order.state === "problem"
      ? `Sorunlu koltuk ödemesi: ${what} (${order.reason === "amount" ? "tutar tutmuyor" : "yer artık dolu"}). İade için: ${where}`
      : `Yeni koltuk satışı: ${what}. Onay bekliyor: ${where}`;
  }

  // ---------- the buyer ----------
  async function checkout(req, res, { foreign, key, now, site }) {
    if (foreign) return send(res, 403, { error: "origin" });
    if (over(tries, key, now, TRIES, TRIES_MS)) return send(res, 429, { error: "tries" });
    const data = parse(await body(req, 450 * 1024));
    if (!data) return send(res, 400, { error: "body" });
    if (data.terms !== true) return send(res, 400, { error: "terms" });
    const m = typeof data.image === "string" && data.image.match(/^data:image\/webp;base64,([A-Za-z0-9+/=]+)$/);
    const image = m ? Buffer.from(m[1], "base64") : null, size = image && webpSize(image);
    if (!size || image.length > IMAGE_MAX || size.width > IMAGE_SIDE || size.height > IMAGE_SIDE) return send(res, 400, { error: "image" });
    const id = `o-${randomBytes(12).toString("hex")}`;
    mkdirSync(join(seatsDir, "pending"), { recursive: true });
    writeFileSync(pending(id), image);
    let held;
    try { held = commit(() => hold(book, { id, block: data.block, name: data.name, link: data.link, ipKey: key, now }, occupied())); }
    catch (error) { forget(pending(id)); throw error; }
    if (held.error) { forget(pending(id)); return send(res, { block: 400, holder: 400, taken: 409, busy: 429, full: 429 }[held.error], { error: held.error }); }
    let session;
    try { session = await stripe.checkout({ order: held.order, site: env.PUBLIC_URL ? new URL(env.PUBLIC_URL).origin : site, label: `Agent Orchestra · ${label(held.order)}` }); }
    catch (error) {
      log(`checkout: ${error.message}`);
      commit(() => drop(book, id, now)); forget(pending(id));
      return send(res, 502, { error: "stripe" });
    }
    // The page is open: the buyer gets it even if its id cannot be written now (the payment event carries it).
    setSession(book, id, session.id);
    try { commit(() => true); } catch (error) { log(`checkout: session id not saved yet (${error.message})`); }
    return send(res, 200, { id, url: session.url });
  }

  // Only the buyer knows the order id (it is in their return address), so knowing it is enough to cancel.
  async function giveUp(res, id, { foreign, now }) {
    if (foreign) return send(res, 403, { error: "origin" });
    const order = find(id);
    if (!order) return send(res, 404, { error: "order" });
    if (order.state !== "held") return send(res, 409, { error: "state" });
    // A held order without its page id (it could not be written before a restart) may still have an open page:
    // the seats wait for Stripe's own end of it.
    if (!order.session) return send(res, 502, { error: "session" });
    try { await stripe.expire(order.session); }
    catch (error) { log(`cancel: ${error.message}`); return send(res, 502, { error: "stripe" }); }
    return commit(() => expire(book, id, now)) ? send(res, 200, { state: "expired" }) : send(res, 409, { error: "state" });
  }

  // ---------- the auction ----------
  async function placeBid(req, res, { foreign, key, now, site }) {
    if (foreign) return send(res, 403, { error: "origin" });
    if (over(tries, key, now, TRIES, TRIES_MS)) return send(res, 429, { error: "tries" });
    const data = parse(await body(req, 2048));
    if (!data) return send(res, 400, { error: "body" });
    if (data.terms !== true) return send(res, 400, { error: "terms" });
    const id = `b-${randomBytes(12).toString("hex")}`;
    const made = await serial(() => commitAuction(() => openBid(ab, { id, amount: data.amount, ipKey: key, now })));
    if (made.error) return send(res, { closed: 409, amount: 400, busy: 429, full: 429 }[made.error], { error: made.error, min: minBid(ab), max: AUCTION.max });
    let session;
    try { session = await stripe.bidCheckout({ bid: made.bid, site: siteOf(site), expiresAt: now + PAGE_MS, label: "Agent Orchestra · front block auction bid" }); }
    catch (error) {
      log(`bid: ${error.message}`);
      await serial(() => commitAuction(() => expireBid(ab, id, now)));
      return send(res, 502, { error: "stripe" });
    }
    setBidSession(ab, id, session.id);
    try { await serial(() => commitAuction(() => true)); } catch (error) { log(`bid: session id not saved yet (${error.message})`); }
    return send(res, 200, { id, url: session.url });
  }

  async function giveUpBid(res, id, { foreign, now }) {
    if (foreign) return send(res, 403, { error: "origin" });
    const b = ab.bids.find((x) => x.id === id);
    if (!b) return send(res, 404, { error: "bid" });
    if (b.state !== "pending") return send(res, 409, { error: "state" });
    if (!b.session) return send(res, 502, { error: "session" });
    try { await stripe.expire(b.session); } catch (error) { log(`bid cancel: ${error.message}`); return send(res, 502, { error: "stripe" }); }
    return (await serial(() => commitAuction(() => expireBid(ab, id, now)))) ? send(res, 200, { state: "expired" }) : send(res, 409, { error: "state" });
  }

  // Stripe holds money for a bid: what it holds is read from Stripe itself, not from the event.
  async function bidEvent(event, session, id, now) {
    if (event.type === "checkout.session.expired") return serial(() => commitAuction(() => expireBid(ab, id, now)));
    if (event.type !== "checkout.session.completed" || typeof session.payment_intent !== "string") return;
    const intent = await stripe.intent(session.payment_intent);   // fails: 500, and Stripe sends the event again
    const done = await serial(() => commitAuction(() => confirmBid(ab, { id, status: intent.status, capturable: intent.amount_capturable,
      currency: intent.currency, payment: intent.id, email: session.customer_details?.email, now }), (r) => r.changed));
    if (!done.changed) return;
    if (done.top) await tell(`Açık artırmada yeni en yüksek teklif: ${done.bid.amount} $. Bitiş: ${when(ab.auction.endsAt)}.`);
    await releaseAll(done.release);
  }

  async function stripeEvent(req, res, { now, site }) {
    const raw = await body(req, 64 * 1024);
    if (raw === null || !verifySignature(raw, req.headers["stripe-signature"], env.STRIPE_WEBHOOK_SECRET, Math.floor(now / 1000))) return send(res, 400, { error: "signature" });
    const event = parse(raw), session = event?.data?.object;
    const id = session?.metadata?.order || session?.client_reference_id;
    try {
      const bidId = session?.metadata?.bid;
      if (BID.test(bidId || "")) {
        if (!auctionOpen) { log(`stripe event: bid ${bidId} while the auction is closed (its hold runs out at Stripe)`); return send(res, 200, { received: true }); }
        await bidEvent(event, session, bidId, now);
        return send(res, 200, { received: true });
      }
      if (event?.type === "checkout.session.completed" && session?.payment_status === "paid" && ORDER.test(id || "")) {
        const done = commit(() => paid(book, { id, amount: session.amount_total, currency: session.currency, email: session.customer_details?.email,
          payment: typeof session.payment_intent === "string" ? session.payment_intent : null, session: session.id, now }, occupied()), (r) => r.changed);
        if (done.changed) await tell(told(done.order, site));
        // Money taken for an order the book does not have (forgotten, or a book restored from a copy): never silent.
        else if (!done.order) { log(`stripe event: payment for unknown order ${id}`); await tell(`Kaydı olmayan koltuk ödemesi: sipariş ${id}, Stripe oturumu ${session.id}. Stripe panelinden kontrol et, gerekirse iade et.`); }
      } else if (event?.type === "checkout.session.expired" && ORDER.test(id || "")) {
        commit(() => expire(book, id, now));
      }
      return send(res, 200, { received: true });
    } catch (error) {
      log(`stripe event: ${error.message}`);
      return send(res, 500, { error: "event" });   // Stripe sends it again
    }
  }

  // ---------- the panel ----------
  const who = (req) => readCookie(String(req.headers.cookie || "").match(/(?:^|;\s*)yonetim=([^;]+)/)?.[1], secret, Date.now());
  const cookie = (value, age) => `yonetim=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${age}${secure ? "; Secure" : ""}`;
  const forPanel = (o) => { const { ipKey, ...rest } = o; return rest; };

  async function login(req, res, { key, now }) {
    if (over(logins, key, now, LOGINS, LOGINS_MS)) return send(res, 429, { error: "tries" });
    const name = whoHasKey(keys, parse(await body(req, 2048))?.key);
    if (!name) return send(res, 401, { error: "key" });
    log(`panel: ${name} signed in`);
    return send(res, 200, { name }, { "set-cookie": cookie(makeCookie(name, secret, Date.now()), SESSION_MS / 1000) });
  }

  const withRefund = (order, refunded) => { if (!order.error && refunded) order.refund = refunded.id; return order; };
  // One decision per order at a time: a refund is awaited, and nothing else may move the order meanwhile.
  async function decide(req, res, id, action, by, now) {
    if (deciding.has(id)) return send(res, 409, { error: "busy" });
    deciding.add(id);
    try { return await decideNow(req, res, id, action, by, now); }
    finally { deciding.delete(id); }
  }
  async function decideNow(req, res, id, action, by, now) {
    const order = find(id);
    const data = parse(await body(req, 2048)) || {};
    const reason = typeof data.reason === "string" ? data.reason : "";
    const allowed = { approve: ["paid"], reject: ["paid", "problem"], remove: ["live"] }[action];
    if (!order || !allowed.includes(order.state)) return send(res, 409, { error: "state" });
    const refund = action === "reject" || (action === "remove" && (data.refund === true || order.refunding));
    let refunded = null;
    if (refund) {
      if (!order.payment) return send(res, 409, { error: "payment" });
      const earlier = Boolean(order.refunding);   // an earlier try whose outcome is not known
      commit(() => startRefund(book, id));
      try { refunded = await stripe.refund(order.payment, `refund-${order.id}`); }
      catch (error) {
        // Only a clear no from Stripe means nothing was refunded. A lost or broken answer (and 409: the same key is
        // still being worked on) may hide a refund: the mark stays until rejecting again settles it. A no to a
        // retry (429, 401) answers only the retry, not the earlier try, so the mark stays then too.
        const refused = error.refused || (error.status >= 400 && error.status < 500 && error.status !== 409);
        log(`refund: ${error.message}${refused && !earlier ? "" : " (outcome unknown, kept as refunding)"}`);
        if (refused && !earlier) commit(() => stopRefund(book, id));
        return send(res, 502, { error: refused && !earlier ? "stripe" : "unknown" });
      }
    }
    let done;
    if (action === "approve") {
      if (order.refunding) return send(res, 409, { error: "refunding" });
      // The logo goes public with the order, or the order waits.
      try { if (!existsSync(shown(id))) renameSync(pending(id), shown(id)); }
      catch (error) { log(`approve: logo not moved (${error.message})`); return send(res, 409, { error: "image" }); }
      const back = () => { try { renameSync(shown(id), pending(id)); } catch { /* left public; the order is not live */ } };
      try { done = commit(() => approve(book, id, by, now, occupied())); } catch (error) { back(); throw error; }
      if (done.error) back();
    } else if (action === "reject") { done = commit(() => withRefund(reject(book, id, by, reason, now), refunded)); if (!done.error) forget(pending(id)); }
    else { done = commit(() => withRefund(remove(book, id, by, reason, refund, now), refunded)); if (!done.error) forget(shown(id)); }
    if (done.error) return send(res, 409, { error: done.error });
    return send(res, 200, { order: forPanel(find(id)) });
  }

  async function auctionPanel(res, step, by, now) {
    if (!auctionOpen) return send(res, 404, { error: "closed" });
    if (step === "start") {
      const order = ab.auction?.order && find(ab.auction.order);
      const done = await serial(() => commitAuction(() => start(ab, { id: `a-${randomBytes(12).toString("hex")}`, by, now,
        used: taken([...hand(), ...liveSeats(book), ...reserved(book)]), again: Boolean(order && ["refunded", "removed"].includes(order.state)) })));
      if (done.error) return send(res, 409, { error: done.error });
      await tell(`Açık artırma başladı: sahnenin önü, 96 koltuk, ${AUCTION.start} $'dan. Bitiş: ${when(ab.auction.endsAt)}.`);
      return send(res, 200, panelView(ab));
    }
    return send(res, 404, { error: "not found" });   // capture, close: Task 6
  }

  async function panel(req, res, url, { foreign, key, now }) {
    const path = url.pathname.slice("/api/yonetim/".length);
    if (req.method === "POST" && (foreign || req.headers["x-yonetim"] !== "1")) return send(res, 403, { error: "origin" });
    if (path === "login" && req.method === "POST") return login(req, res, { key, now });
    if (path === "logout" && req.method === "POST") return send(res, 204, undefined, { "set-cookie": cookie("", 0) });
    const name = who(req);
    if (!name) return send(res, 401, { error: "login" });
    if (path === "state" && req.method === "GET")
      return send(res, 200, { me: name, checkout: open, seats: PLAN.count, summary: summary(book, now), orders: book.orders.map(forPanel), events: book.events.slice(-100),
        auction: auctionOpen ? panelView(ab) : null });
    const image = path.match(/^image\/(o-[0-9a-f]{24})$/);
    if (image && req.method === "GET") {
      for (const file of [pending(image[1]), shown(image[1])]) {
        try { const data = await readFile(file); res.writeHead(200, { "content-type": "image/webp", "cache-control": "no-store" }); return res.end(data); }
        catch { /* try the next place */ }
      }
      return send(res, 404, { error: "image" });
    }
    const auctionStep = path.match(/^auction\/(start|capture|close)$/);
    if (auctionStep && req.method === "POST") return auctionPanel(res, auctionStep[1], name, now);
    const action = path.match(/^orders\/(o-[0-9a-f]{24})\/(approve|reject|remove)$/);
    if (action && req.method === "POST") return decide(req, res, action[1], action[2], name, now);
    return send(res, 404, { error: "not found" });
  }

  return {
    open, panelOpen,
    // What the hall shows: seats added by hand and approved orders, and where held or paid blocks are.
    seatsPayload: () => ({ seats: cleanSeats({ seats: [...hand(), ...liveSeats(book)] }),
      reserved: [...reserved(book), ...(auctionHolds() ? [AUCTION.block] : [])], checkout: open, auction: auctionOpen ? publicView(ab) : null }),
    // true when the request was the shop's to answer.
    async handle(req, res, url, ctx) {
      try { return await route(req, res, url, ctx); }
      catch (error) {
        log(`shop: ${error.message}`);
        if (!res.headersSent) send(res, 500, { error: "server" }); else res.end();
        return true;
      }
    },
    sweep(now) {
      try {
        const { pruned, stale } = commit(() => sweep(book, now), (r) => r.expired.length + r.pruned.length > 0);
        for (const o of [...pruned, ...stale]) forget(pending(o.id));
      } catch (error) { log(`orders: sweep not saved, will retry (${error.message})`); }
    },
  };

  async function route(req, res, url, ctx) {
    const p = url.pathname;
    if (p === "/api/auction" && req.method === "GET") { auctionOpen ? send(res, 200, publicView(ab) ?? { state: null }) : send(res, 404, { error: "closed" }); return true; }
    if (p === "/api/auction/bid" && req.method === "POST") { if (!auctionOpen) send(res, 404, { error: "closed" }); else await placeBid(req, res, ctx); return true; }
    const bidPath = p.match(/^\/api\/auction\/bid\/(b-[0-9a-f]{24})(\/cancel)?$/);
    if (bidPath && auctionOpen && req.method === "GET" && !bidPath[2]) { const v = bidView(ab, bidPath[1]); v ? send(res, 200, v) : send(res, 404, { error: "bid" }); return true; }
    if (bidPath && auctionOpen && req.method === "POST" && bidPath[2]) { await giveUpBid(res, bidPath[1], ctx); return true; }
    if (p === "/api/seats/checkout" && req.method === "POST") { if (!open) send(res, 404, { error: "closed" }); else await checkout(req, res, ctx); return true; }
    const order = p.match(/^\/api\/seats\/order\/(o-[0-9a-f]{24})$/);
    if (order && req.method === "GET") {
      const o = find(order[1]);
      o ? send(res, 200, { state: buyerState(o) }) : send(res, 404, { error: "order" });
      return true;
    }
    const cancel = p.match(/^\/api\/seats\/order\/(o-[0-9a-f]{24})\/cancel$/);
    if (cancel && req.method === "POST") { if (!open) send(res, 404, { error: "closed" }); else await giveUp(res, cancel[1], ctx); return true; }
    if (p === "/api/stripe" && req.method === "POST") { if (!open) send(res, 404, { error: "closed" }); else await stripeEvent(req, res, ctx); return true; }
    if (p.startsWith("/api/yonetim/")) { if (!panelOpen) send(res, 404, { error: "not found" }); else await panel(req, res, url, ctx); return true; }
    return false;
  }
}
