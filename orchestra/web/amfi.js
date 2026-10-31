// The amphitheatre around the stage: ~10,000 seats on a fixed plan (seats.mjs), sold blocks with their
// image, and light that follows the music. The seats are drawn once into a layer and reused every frame;
// a frame only adds the glow of the notes just heard and, while someone picks a place, their block.
import { PLAN, TIERS, blockArc, seatAt, noteAngle, blockSeats, validBlock } from './seats.mjs';

const rad = (d) => (d * Math.PI) / 180;
const TIER_DOTS = ['rgba(232, 182, 90, .34)', 'rgba(232, 182, 90, .22)', 'rgba(232, 182, 90, .14)'];

export function createAmfi() {
  let holders = [], demo = false, bySeat = new Map(), version = 0;
  const images = new Map();          // holder id -> drawable (image or canvas) once loaded
  let layer = null, layerKey = '';
  const wedges = [];                 // [angle, strength] of notes heard, fading
  const pending = [];                // [serverTime, angle] of notes still to sound
  let ghost = null;                  // { block, ok } while placing
  let reserved = [], reservedSeats = new Set();   // blocks someone is paying for or waiting to have approved

  function setHolders(list, options = {}) {
    holders = list; demo = Boolean(options.demo); bySeat = new Map(); version++;
    for (const h of holders) for (const id of blockSeats(h)) bySeat.set(id, h);
    for (const h of holders) {
      if (images.has(h.id) && !options.fresh) continue;
      if (h.drawable) { images.set(h.id, h.drawable); continue; }
      if (!h.image) continue;
      const img = new Image();
      img.onload = () => { images.set(h.id, img); version++; };
      img.src = h.image;
    }
  }

  // Screen point of a plan point (radius in R, angle in degrees) for the hall geometry G.
  const point = (G, r, a) => ({ x: G.cx + Math.sin(rad(a)) * r * G.R, y: G.cy - Math.cos(rad(a)) * r * G.R });
  // An annular sector in canvas angles (0 = right, clockwise): plan angle a is canvas angle a - 90.
  function sector(g, G, { r1, r2, a1, a2 }) {
    g.beginPath();
    g.arc(G.cx, G.cy, r2 * G.R, rad(a1 - 90), rad(a2 - 90));
    g.arc(G.cx, G.cy, r1 * G.R, rad(a2 - 90), rad(a1 - 90), true);
    g.closePath();
  }

  function build(G, width, height, dpr) {
    const key = `${width}x${height}@${dpr}:${G.cx}:${G.cy}:${G.R}:${version}`;
    if (layer && key === layerKey) return layer;
    layer ||= document.createElement('canvas');
    layer.width = Math.max(1, Math.round(width * dpr)); layer.height = Math.max(1, Math.round(height * dpr));
    const c = layer.getContext('2d');
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    const pitchPx = PLAN.pitch * G.R, dot = Math.max(.7, pitchPx * .3);
    // Empty seats, one path per tier: cheap even for ten thousand.
    TIERS.forEach((tier, t) => {
      c.beginPath();
      for (let k = tier.rings[0]; k <= tier.rings[1]; k++) {
        const ring = PLAN.rings[k];
        for (let col = 0; col < ring.cols; col++) {
          if (bySeat.has(`r${k}c${col}`) || reservedSeats.has(`r${k}c${col}`)) continue;
          const { x, y } = point(G, ring.r, -90 + (col + .5) * 180 / ring.cols);
          c.moveTo(x + dot, y); c.arc(x, y, dot, 0, Math.PI * 2);
        }
      }
      c.fillStyle = TIER_DOTS[t]; c.fill();
    });
    // Reserved blocks: taken, nameless, a shade darker than an empty seat until they are approved.
    for (const b of reserved) {
      sector(c, G, blockArc(b)); c.fillStyle = '#2a2218'; c.fill();
      c.strokeStyle = 'rgba(230, 180, 90, .25)'; c.lineWidth = 1; c.stroke();
    }
    // Sold blocks: a cream card cut to the curve, the image upright and whole inside it, seat seams on top.
    for (const h of holders) {
      const arc = blockArc(h), img = images.get(h.id);
      c.save(); sector(c, G, arc);
      c.fillStyle = img ? '#efe6d4' : '#3a2f1c'; c.fill(); c.clip();
      const mid = point(G, (arc.r1 + arc.r2) / 2, (arc.a1 + arc.a2) / 2);
      const boxW = rad(arc.a2 - arc.a1) * (arc.r1 + arc.r2) / 2 * G.R, boxH = (arc.r2 - arc.r1) * G.R;
      if (img) {
        const scale = Math.min(boxW / (img.naturalWidth || img.width), boxH / (img.naturalHeight || img.height));
        const w = (img.naturalWidth || img.width) * scale, hgt = (img.naturalHeight || img.height) * scale;
        c.drawImage(img, mid.x - w / 2, mid.y - hgt / 2, w, hgt);
      } else if (boxH > 9) {
        c.fillStyle = '#e6b45a'; c.font = `600 ${Math.min(boxH * .6, 14)}px 'Instrument Sans', system-ui, sans-serif`;
        c.textAlign = 'center'; c.textBaseline = 'middle';
        c.fillText(h.name.slice(0, Math.max(1, Math.floor(boxW / 8))), mid.x, mid.y);
      }
      if (pitchPx >= 5) {
        c.strokeStyle = 'rgba(11, 9, 7, .35)'; c.lineWidth = .8;
        const cols = PLAN.rings[h.ring].cols;
        for (let i = 1; i < h.width; i++) {
          const a = -90 + (h.col + i) * 180 / cols, p1 = point(G, arc.r1, a), p2 = point(G, arc.r2, a);
          c.beginPath(); c.moveTo(p1.x, p1.y); c.lineTo(p2.x, p2.y); c.stroke();
        }
        for (let j = 1; j < h.depth; j++) {
          c.beginPath(); c.arc(G.cx, G.cy, (arc.r1 + j * PLAN.pitch) * G.R, rad(arc.a1 - 90), rad(arc.a2 - 90)); c.stroke();
        }
      }
      c.restore();
      sector(c, G, arc); c.strokeStyle = demo ? 'rgba(230, 180, 90, .5)' : 'rgba(230, 180, 90, .7)'; c.lineWidth = 1; c.stroke();
    }
    layerKey = key;
    return layer;
  }

  // A note sounds at serverTime `at`: when it is heard, its direction lights up.
  function note(at, pitch) { if (pending.length < 300) pending.push([at, noteAngle(pitch)]); }

  function draw(g, G, { width, height, dpr, heard, dt, still }) {
    g.drawImage(build(G, width, height, dpr), 0, 0, width, height);
    for (let i = pending.length - 1; i >= 0; i--) if (pending[i][0] <= heard) { if (!still) wedges.push([pending[i][1], 1]); pending.splice(i, 1); }
    if (wedges.length > 40) wedges.splice(0, wedges.length - 40);
    const lit = new Map();
    for (let i = wedges.length - 1; i >= 0; i--) {
      const w = wedges[i]; w[1] -= dt * 1.8;
      if (w[1] <= 0) { wedges.splice(i, 1); continue; }
      sector(g, G, { r1: PLAN.inner, r2: PLAN.outer, a1: w[0] - 2.5, a2: w[0] + 2.5 });
      g.fillStyle = `rgba(243, 208, 140, ${(.09 * w[1]).toFixed(3)})`; g.fill();
      for (const h of holders) { const { a1, a2 } = blockArc(h); if (w[0] >= a1 - 3 && w[0] <= a2 + 3) lit.set(h, Math.max(lit.get(h) || 0, w[1])); }
    }
    for (const [h, s] of lit) {
      sector(g, G, blockArc(h));
      g.fillStyle = `rgba(243, 208, 140, ${(.28 * s).toFixed(3)})`; g.fill();
      g.strokeStyle = `rgba(255, 226, 160, ${(.95 * s).toFixed(3)})`; g.lineWidth = 1.6; g.stroke();
    }
    if (ghost) {
      sector(g, G, blockArc(ghost.block));
      g.fillStyle = ghost.ok ? 'rgba(230, 180, 90, .45)' : 'rgba(217, 83, 79, .4)'; g.fill();
      g.save(); g.shadowColor = ghost.ok ? '#f3d08c' : '#d9534f'; g.shadowBlur = 18;
      g.strokeStyle = ghost.ok ? '#f3d08c' : '#d9534f'; g.lineWidth = 2.5; g.stroke(); g.restore();
    }
  }

  // The seat under a screen point, and who holds it.
  function hit(G, x, y) {
    const dx = x - G.cx, dy = G.cy - y, r = Math.hypot(dx, dy) / G.R, a = Math.atan2(dx, dy) * 180 / Math.PI;
    const place = seatAt(r, a);
    return place && { ...place, holder: bySeat.get(`r${place.k}c${place.c}`) || null };
  }

  function setReserved(blocks) {
    reserved = (Array.isArray(blocks) ? blocks : []).filter(validBlock);
    reservedSeats = new Set(reserved.flatMap(blockSeats)); version++;
  }

  return { setHolders, setReserved, note, draw, hit, setGhost: (g) => { ghost = g; }, holders: () => holders, reserved: () => reserved, isDemo: () => demo };
}

// The demo concert's full house: generated marks, never real names, clearly called examples.
export function demoHolders(count = 140) {
  let seed = 20261031; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const colors = ['#d9534f', '#4a90d9', '#5cb85c', '#9b59b6', '#f39c12', '#1abc9c', '#e84393', '#2d3436', '#0984e3', '#e6b45a'];
  const letters = 'ABCDEFGHIKLMNOPRSTUVYZ';
  const out = [], used = new Set();
  for (let tries = 0; out.length < count && tries < count * 20; tries++) {
    const t = rnd() < .3 ? 0 : rnd() < .55 ? 1 : 2, tier = TIERS[t];
    const depth = 1 + Math.floor(rnd() ** 1.6 * Math.min(4, tier.rings[1] - tier.rings[0])), width = depth === 1 && rnd() < .5 ? 1 : 1 + Math.floor(rnd() ** 1.4 * 7);
    const ring = tier.rings[0] + Math.floor(rnd() * (tier.rings[1] - tier.rings[0] + 2 - depth)), col = Math.floor(rnd() * (tier.cols - width));
    const block = { ring, col, width, depth };
    const ids = blockSeats(block);
    if (ring + depth - 1 > tier.rings[1] || ids.some((id) => used.has(id))) continue;
    ids.forEach((id) => used.add(id));
    const n = out.length + 1, mark = letters[Math.floor(rnd() * letters.length)] + letters[Math.floor(rnd() * letters.length)];
    out.push({ id: `demo-${n}`, ...block, name: `Örnek koltuk ${n}`, link: null, image: null, drawable: demoMark(mark, colors[Math.floor(rnd() * colors.length)], width, depth, rnd) });
  }
  return out;
}

function demoMark(text, color, width, depth, rnd) {
  const c = document.createElement('canvas'), w = 40 * Math.max(1, width), h = 40 * Math.max(1, depth);
  c.width = w; c.height = h;
  const g = c.getContext('2d');
  g.fillStyle = color; g.fillRect(0, 0, w, h);
  g.fillStyle = 'rgba(255, 255, 255, .92)';
  const s = Math.min(w, h);
  if (rnd() < .5) { g.beginPath(); g.arc(w / 2, h / 2, s * .32, 0, Math.PI * 2); g.fill(); g.fillStyle = color; }
  g.font = `700 ${s * .34}px system-ui, sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(text, w / 2, h / 2 + 1);
  return c;
}
