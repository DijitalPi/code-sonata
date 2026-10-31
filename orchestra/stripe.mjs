// Stripe without its library: a Checkout session per order, a refund per rejected order, and the signature
// check on the events Stripe sends back (HMAC-SHA256 of "<t>.<body>" with the endpoint's secret).
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
  async function call(path, fields, extra = {}) {
    const res = await fetch(`${base}${path}`, {
      method: "POST", body: new URLSearchParams(fields).toString(), signal: AbortSignal.timeout(10_000),
      headers: { authorization: `Bearer ${key}`, "content-type": "application/x-www-form-urlencoded", ...extra },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`stripe ${path}: ${res.status} ${data?.error?.message || ""}`.trim());
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
    refund: (paymentIntent, idempotencyKey) => call("/v1/refunds", { payment_intent: paymentIntent }, { "idempotency-key": idempotencyKey }),
  };
}
