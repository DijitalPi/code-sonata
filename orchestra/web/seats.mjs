// The amphitheatre around the orchestra, sold seat by seat. The plan is fixed, so a seat is the same seat on
// every screen: lengths are in orchestra radii (the hall's R), angles in degrees with 0 straight up, -90 left
// and 90 right, as the hall draws its stage. The page and the server share it and agree on what a block is.
const INNER = 1.14, OUTER = 1.9, RINGS = 40;
const pitch = (OUTER - INNER) / RINGS;
// Rows near the stage cost most. Within a tier every row has the same number of seats, so a block is a
// rectangle of rows and columns and an image fits it; outer seats are a little wider, as in a real hall.
const TIER_SPEC = [['front', 'Ön sıra', 25, 8], ['middle', 'Orta', 10, 15], ['back', 'Arka', 3, 17]];
export const SEAT_LIMITS = { width: 12, depth: 6 };
// The front block sold by auction (auction.mjs): bigger than any block bought seat by seat, so it is one of a kind.
// Rules in dollars; the page and the server read the same numbers.
export const AUCTION = Object.freeze({ block: Object.freeze({ ring: 0, col: 88, width: 24, depth: 4 }), start: 2400, step: 100, max: 100_000 });
export const isAuctionBlock = (b) => Boolean(b) && b.ring === AUCTION.block.ring && b.col === AUCTION.block.col
  && b.width === AUCTION.block.width && b.depth === AUCTION.block.depth;

const rings = [], tiers = [];
for (const [name, label, price, count] of TIER_SPEC) {
  const first = rings.length, last = first + count - 1;
  const cols = Math.round(Math.PI * (INNER + ((first + last) / 2 + .5) * pitch) / pitch);
  for (let k = first; k <= last; k++) rings.push({ k, r: INNER + (k + .5) * pitch, cols, tier: tiers.length });
  tiers.push({ name, label, price, rings: [first, last], cols, seats: cols * count });
}
export const TIERS = tiers;
export const PLAN = { inner: INNER, outer: OUTER, pitch, rings, count: tiers.reduce((sum, t) => sum + t.seats, 0) };

export const tierOf = (k) => tiers[rings[k]?.tier];

export function seat(k, c) {
  const ring = rings[k];
  return { id: `r${k}c${c}`, k, c, r: ring.r, a: -90 + (c + .5) * 180 / ring.cols, price: tiers[ring.tier].price };
}

// A block: `depth` rows from `ring` outwards, `width` seats from `col` clockwise, all in one tier.
export function validBlock(b) {
  if (!b || typeof b !== 'object') return false;
  const { ring, col, width, depth } = b;
  if (![ring, col, width, depth].every(Number.isInteger)) return false;
  if (width < 1 || depth < 1 || (!isAuctionBlock(b) && (width > SEAT_LIMITS.width || depth > SEAT_LIMITS.depth))) return false;
  const first = rings[ring], last = rings[ring + depth - 1];
  return Boolean(first && last && first.tier === last.tier && col >= 0 && col + width <= first.cols);
}

export const blockPrice = (b) => b.width * b.depth * tierOf(b.ring).price;

export function blockSeats(b) {
  const ids = [];
  for (let k = b.ring; k < b.ring + b.depth; k++) for (let c = b.col; c < b.col + b.width; c++) ids.push(`r${k}c${c}`);
  return ids;
}

export function taken(blocks) {
  const used = new Set();
  for (const b of blocks) if (validBlock(b)) for (const id of blockSeats(b)) used.add(id);
  return used;
}

export const canPlace = (b, used) => validBlock(b) && !blockSeats(b).some((id) => used.has(id));

export function blockArc(b) {
  const cols = rings[b.ring].cols;
  return { r1: rings[b.ring].r - pitch / 2, r2: rings[b.ring + b.depth - 1].r + pitch / 2,
    a1: -90 + b.col * 180 / cols, a2: -90 + (b.col + b.width) * 180 / cols };
}

// The seat under a point given as distance from the stage centre (in radii) and angle, or null.
export function seatAt(r, a) {
  const k = Math.floor((r - INNER) / pitch);
  if (!rings[k] || a < -90 || a >= 90) return null;
  return { k, c: Math.floor((a + 90) / 180 * rings[k].cols) };
}

// Like a piano seen from the stage: low notes to the left, high notes to the right.
export const noteAngle = (pitch) => Math.min(1, Math.max(0, (pitch - 36) / 60)) * 180 - 90;

export function litBlocks(blocks, angle, spread = 3) {
  return blocks.filter((b) => { const { a1, a2 } = blockArc(b); return angle >= a1 - spread && angle <= a2 + spread; });
}

// Holders as the server publishes them: anything malformed, off the plan, on a sold seat, with a remote image
// (the page loads images from this site only) or a link that is not a web address is left out.
const IMAGE = /^\/seat-images\/[a-z0-9-]{1,40}\.(webp|png|jpe?g)$/;
// What a holder shows: a name of up to 40 characters and a web address, or null.
export function cleanHolder(h) {
  const name = typeof h?.name === 'string' ? h.name.trim() : '';
  if (!name || name.length > 40) return null;
  let link = null;
  try { link = typeof h.link === 'string' && h.link.length <= 300 ? new URL(h.link) : null; } catch { link = null; }
  return link && ['http:', 'https:'].includes(link.protocol) ? { name, link: link.href } : null;
}
export function cleanSeats(data) {
  const out = [], used = new Set(), ids = new Set();
  for (const s of Array.isArray(data?.seats) ? data.seats : []) {
    if (!s || typeof s !== 'object' || typeof s.id !== 'string' || !/^[a-z0-9-]{1,32}$/.test(s.id) || ids.has(s.id)) continue;
    const block = { ring: s.ring, col: s.col, width: s.width, depth: s.depth };
    if (!canPlace(block, used)) continue;
    const holder = cleanHolder(s);
    if (!holder) continue;
    if (s.image != null && !(typeof s.image === 'string' && IMAGE.test(s.image))) continue;
    for (const id of blockSeats(block)) used.add(id);
    ids.add(s.id);
    out.push({ id: s.id, ...block, ...holder, image: s.image ?? null });
  }
  return out;
}
