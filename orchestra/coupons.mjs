// Coupon codes: a code makes one seat of a block free. They are given out by hand (a post's commenters get one by
// direct message); the panel opens and stops them. Pure: the shop keeps them in the order book's file.
import { tierOf } from "./web/seats.mjs";

export const CODE = /^[A-Z0-9-]{3,24}$/;
export const COUPON_TIERS = ["front", "middle", "back", "any"];
export const COUPON_MAX = 1000, COUPON_DAYS = 90;
const DAY = 86_400_000;
// A use is taken while its order holds seats or has them; one that runs out, is rejected or comes down gives it back.
const COUNTED = new Set(["held", "paid", "problem", "live"]);

export const codeOf = (text) => (typeof text === "string" ? text.trim().toUpperCase() : "");
const whole = (n, lo, hi) => Number.isInteger(n) && n >= lo && n <= hi;

export function cleanCoupons(list) {
  return (Array.isArray(list) ? list : []).filter((c) => c && typeof c === "object" && CODE.test(c.code)
    && COUPON_TIERS.includes(c.tier) && whole(c.max, 1, COUPON_MAX) && Number.isFinite(c.until));
}

export function addCoupon(book, { code, tier, max, days, by, now }) {
  const c = codeOf(code);
  if (!CODE.test(c)) return { error: "code" };
  if (!COUPON_TIERS.includes(tier)) return { error: "tier" };
  if (!whole(max, 1, COUPON_MAX)) return { error: "max" };
  if (!whole(days, 1, COUPON_DAYS)) return { error: "days" };
  if (book.coupons.some((k) => k.code === c)) return { error: "exists" };
  const coupon = { code: c, tier, max, until: now + days * DAY, stopped: false, created: now, by: by || null };
  book.coupons.push(coupon);
  return { coupon };
}

export function stopCoupon(book, code) {
  const coupon = book.coupons.find((k) => k.code === codeOf(code));
  if (!coupon) return { error: "coupon" };
  coupon.stopped = true;
  return { coupon };
}

export const usedOf = (book, code) => book.orders.filter((o) => o.coupon === code && COUNTED.has(o.state)).length;

// Whether a code may be used now, and on this block if one is given. Gone, stopped and out of time read alike to a buyer.
export function check(book, code, block, now) {
  const coupon = book.coupons.find((k) => k.code === codeOf(code));
  if (!coupon || coupon.stopped || now >= coupon.until) return { error: "code" };
  if (usedOf(book, coupon.code) >= coupon.max) return { error: "used" };
  if (block && coupon.tier !== "any" && tierOf(block.ring)?.name !== coupon.tier) return { error: "tier" };
  return { coupon };
}

// The seat a code makes free: one seat of the block's tier, in cents.
export const discount = (block) => tierOf(block.ring).price * 100;

export const couponView = (book, now) => book.coupons.map((c) => {
  const used = usedOf(book, c.code);
  return { ...c, used, state: c.stopped ? "stopped" : now >= c.until ? "expired" : used >= c.max ? "used" : "open" };
});
