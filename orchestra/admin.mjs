// The management panel's door: named keys (ADMIN_KEYS="selim:<key>,ozer:<key>", each key 24+ characters) and a
// signed session cookie "<name>.<until ms>.<hmac>", so the record shows who approved or refunded what.
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export const SESSION_MS = 12 * 3600_000;
const digest = (text) => createHash("sha256").update(String(text)).digest();

export function parseKeys(text) {
  const keys = new Map();
  for (const pair of String(text || "").split(",")) {
    const at = pair.indexOf(":"), name = pair.slice(0, at).trim(), key = pair.slice(at + 1).trim();
    if (at > 0 && /^[a-z0-9-]{1,20}$/.test(name) && key.length >= 24) keys.set(name, key);
  }
  return keys;
}

// Every key is compared, as digests of equal length, so neither the match nor the key length shows in the timing.
export function whoHasKey(keys, given) {
  if (typeof given !== "string" || !given) return null;
  const want = digest(given);
  let who = null;
  for (const [name, key] of keys) if (timingSafeEqual(digest(key), want)) who = name;
  return who;
}

export const sessionSecret = (keysText) => digest(`yonetim:${keysText}`);
const mac = (body, secret) => createHmac("sha256", secret).update(body).digest("hex");

export function makeCookie(name, secret, now) {
  const body = `${name}.${now + SESSION_MS}`;
  return `${body}.${mac(body, secret)}`;
}

export function readCookie(value, secret, now) {
  const m = typeof value === "string" && value.match(/^([a-z0-9-]{1,20})\.(\d{1,16})\.([0-9a-f]{64})$/);
  if (!m || Number(m[2]) < now) return null;
  return timingSafeEqual(Buffer.from(m[3], "hex"), Buffer.from(mac(`${m[1]}.${m[2]}`, secret), "hex")) ? m[1] : null;
}
