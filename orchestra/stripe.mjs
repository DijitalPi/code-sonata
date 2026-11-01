// Stripe without its library: a Checkout session per order (a card hold per auction bid), a refund per rejected
// order, and the signature check on the events Stripe sends back (HMAC-SHA256 of "<t>.<body>" with the endpoint's secret).
import { createHmac, timingSafeEqual } from "node:crypto";

export const sign = (raw, secret, t) => `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${raw}`).digest("hex")}`;

export function verifySignature(raw, header, secret, nowSec, tolerance = 300) {
  if (typeof header !== "string" || !secret) return false;
  const parts = header.split(",").map((p) => p.split("="));
  const t = Number(parts.find(([k]) => k === "t")?.[1]);
  if (!Number.isInteger(t) || Math.abs(nowSec - t) > tolerance) return false;
  const want = Buffer.from(sign(raw, secret, t).split("v1=")[1], "hex");
  return parts.some(([k, v]) => k === "v1" && /^[0-9a-f]{64}$/.test(v || "") && timingSafeEqual(Buffer.from(v, "hex"), want));
}

export function createStripe({ key, base = "https://api.stripe.com", fetch = globalThis.fetch }) {
  async function call(path, fields, extra = {}, method = "POST") {
    const res = await fetch(`${base}${path}`, {
      method, body: method === "GET" ? undefined : new URLSearchParams(fields).toString(), signal: AbortSignal.timeout(10_000),
      headers: { authorization: `Bearer ${key}`, ...(method === "GET" ? {} : { "content-type": "application/x-www-form-urlencoded" }), ...extra },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(`stripe ${path}: ${res.status} ${data?.error?.message || ""}`.trim()), { status: res.status, code: data?.error?.code });
    return data;
  }
  return {
    async checkout({ order, site, label }) {
      const back = `${site}/?siparis=${order.id}`;
      const data = await call("/v1/checkout/sessions", {
        mode: "payment", "payment_method_types[0]": "card", "line_items[0][quantity]": "1",
        "line_items[0][price_data][currency]": order.currency, "line_items[0][price_data][unit_amount]": String(order.amount),
        "line_items[0][price_data][product_data][name]": label,
        client_reference_id: order.id, "metadata[order]": order.id, "payment_intent_data[metadata][order]": order.id,
        expires_at: String(Math.floor(order.heldUntil / 1000)), success_url: back, cancel_url: `${back}&iptal=1`,
      });
      if (typeof data.id !== "string" || typeof data.url !== "string") throw new Error("stripe: no session in the answer");
      return { id: data.id, url: data.url };
    },
    // A refund Stripe answers as failed or canceled did not happen (`refused`); pending (some banks) is on its way.
    // A payment refunded already (by an earlier try whose answer was lost, or by hand) counts as refunded.
    async refund(paymentIntent, idempotencyKey) {
      let data;
      try { data = await call("/v1/refunds", { payment_intent: paymentIntent }, { "idempotency-key": idempotencyKey }); }
      catch (error) { if (error.code === "charge_already_refunded") return { id: null, status: "already_refunded" }; throw error; }
      if (["failed", "canceled"].includes(data.status)) throw Object.assign(new Error(`stripe refund: ${data.status}`), { refused: true });
      if (typeof data.id !== "string") throw new Error("stripe refund: no refund in the answer");
      return { id: data.id, status: data.status };
    },
    // A buyer who came back without paying: the page closes, so the seats can go to someone else.
    expire: (session) => call(`/v1/checkout/sessions/${encodeURIComponent(session)}/expire`, {}),
    // An auction bid (auction.mjs): the same page, but the card is only held; the hold is captured if the bid wins.
    async bidCheckout({ bid, site, expiresAt, label }) {
      const back = `${site}/?teklif=${bid.id}`;
      const data = await call("/v1/checkout/sessions", {
        mode: "payment", "payment_method_types[0]": "card", "line_items[0][quantity]": "1",
        "line_items[0][price_data][currency]": "usd", "line_items[0][price_data][unit_amount]": String(bid.amount * 100),
        "line_items[0][price_data][product_data][name]": label, "payment_intent_data[capture_method]": "manual",
        client_reference_id: bid.id, "metadata[bid]": bid.id, "payment_intent_data[metadata][bid]": bid.id,
        expires_at: String(Math.floor(expiresAt / 1000)), success_url: back, cancel_url: `${back}&iptal=1`,
      });
      if (typeof data.id !== "string" || typeof data.url !== "string") throw new Error("stripe: no session in the answer");
      return { id: data.id, url: data.url };
    },
    intent: (id) => call(`/v1/payment_intents/${encodeURIComponent(id)}`, {}, {}, "GET"),
    // Letting a hold go. A hold that is no longer there (let go by an earlier try, or run out) counts as let go.
    async cancelIntent(id, idempotencyKey) {
      try { return await call(`/v1/payment_intents/${encodeURIComponent(id)}/cancel`, {}, { "idempotency-key": idempotencyKey }); }
      catch (error) { if (error.code === "payment_intent_unexpected_state") return { status: "not_held" }; throw error; }
    },
    // Taking the held money. If Stripe says the hold is in another state, it is read: captured already (an earlier try
    // whose answer was lost) is success; anything else is a clear no (`refused`).
    async captureIntent(id, idempotencyKey) {
      try { return await call(`/v1/payment_intents/${encodeURIComponent(id)}/capture`, {}, { "idempotency-key": idempotencyKey }); }
      catch (error) {
        if (error.code !== "payment_intent_unexpected_state") throw error;
        const now = await call(`/v1/payment_intents/${encodeURIComponent(id)}`, {}, {}, "GET");
        if (now.status === "succeeded") return now;
        throw Object.assign(new Error(`stripe capture: ${now.status}`), { refused: true });
      }
    },
  };
}
