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
import { PLAN, tierOf, cleanSeats } from "./web/seats.mjs";
import { EN } from "./web/lang-en.mjs";

const IMAGE_MAX = 300 * 1024, IMAGE_SIDE = 1024;
const TRIES = 5, TRIES_MS = 10 * 60_000, LOGINS = 5, LOGINS_MS = 60_000;
const ORDER = /^o-[0-9a-f]{24}$/;

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
  // Payment opens only with someone to approve what is paid.
  const open = Boolean(env.STRIPE_SECRET_KEY && env.STRIPE_WEBHOOK_SECRET && ordersFile && seatsDir && readable && keys.size > 0);
  const panelOpen = keys.size > 0 && readable && Boolean(ordersFile);
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
    try { held = commit(() => hold(book, { id, block: data.block, name: data.name, link: data.link, ipKey: key, now }, hand())); }
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

  async function stripeEvent(req, res, { now, site }) {
    const raw = await body(req, 64 * 1024);
    if (raw === null || !verifySignature(raw, req.headers["stripe-signature"], env.STRIPE_WEBHOOK_SECRET, Math.floor(now / 1000))) return send(res, 400, { error: "signature" });
    const event = parse(raw), session = event?.data?.object;
    const id = session?.metadata?.order || session?.client_reference_id;
    try {
      if (event?.type === "checkout.session.completed" && session?.payment_status === "paid" && ORDER.test(id || "")) {
        const done = commit(() => paid(book, { id, amount: session.amount_total, currency: session.currency, email: session.customer_details?.email,
          payment: typeof session.payment_intent === "string" ? session.payment_intent : null, session: session.id, now }, hand()), (r) => r.changed);
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
      try { done = commit(() => approve(book, id, by, now, hand())); } catch (error) { back(); throw error; }
      if (done.error) back();
    } else if (action === "reject") { done = commit(() => withRefund(reject(book, id, by, reason, now), refunded)); if (!done.error) forget(pending(id)); }
    else { done = commit(() => withRefund(remove(book, id, by, reason, refund, now), refunded)); if (!done.error) forget(shown(id)); }
    if (done.error) return send(res, 409, { error: done.error });
    return send(res, 200, { order: forPanel(find(id)) });
  }

  async function panel(req, res, url, { foreign, key, now }) {
    const path = url.pathname.slice("/api/yonetim/".length);
    if (req.method === "POST" && (foreign || req.headers["x-yonetim"] !== "1")) return send(res, 403, { error: "origin" });
    if (path === "login" && req.method === "POST") return login(req, res, { key, now });
    if (path === "logout" && req.method === "POST") return send(res, 204, undefined, { "set-cookie": cookie("", 0) });
    const name = who(req);
    if (!name) return send(res, 401, { error: "login" });
    if (path === "state" && req.method === "GET")
      return send(res, 200, { me: name, checkout: open, seats: PLAN.count, summary: summary(book, now), orders: book.orders.map(forPanel), events: book.events.slice(-100) });
    const image = path.match(/^image\/(o-[0-9a-f]{24})$/);
    if (image && req.method === "GET") {
      for (const file of [pending(image[1]), shown(image[1])]) {
        try { const data = await readFile(file); res.writeHead(200, { "content-type": "image/webp", "cache-control": "no-store" }); return res.end(data); }
        catch { /* try the next place */ }
      }
      return send(res, 404, { error: "image" });
    }
    const action = path.match(/^orders\/(o-[0-9a-f]{24})\/(approve|reject|remove)$/);
    if (action && req.method === "POST") return decide(req, res, action[1], action[2], name, now);
    return send(res, 404, { error: "not found" });
  }

  return {
    open, panelOpen,
    // What the hall shows: seats added by hand and approved orders, and where held or paid blocks are.
    seatsPayload: () => ({ seats: cleanSeats({ seats: [...hand(), ...liveSeats(book)] }), reserved: reserved(book), checkout: open }),
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
