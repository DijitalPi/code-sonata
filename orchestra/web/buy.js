// Buying a seat, up to the payment step: pick a tier and a size, see the price, carry the block to a free
// place in the hall (mouse, finger or arrow keys), then add an image, a name and a link and see the result.
// Nothing here talks to the server: payment, upload and approval come in the second part.
import { PLAN, TIERS, SEAT_LIMITS, tierOf, blockPrice, blockArc, taken, canPlace } from './seats.mjs';
import { createAmfi } from './amfi.js';

const $ = (id) => document.getElementById(id);
const money = (n) => `${n.toLocaleString('tr')} $`;
// A small element builder; `role` is set as an attribute (not every browser reflects it as a property).
const el = (tag, { role, ...props } = {}, ...children) => {
  const e = Object.assign(document.createElement(tag), props);
  if (role) e.setAttribute('role', role);
  e.append(...children);
  return e;
};

export function setupBuying({ canvas, geometry, amfi }) {
  let tier = 0, width = 3, depth = 2, used = new Set(), ghost = null, chosen = null, placing = false, image = null;

  // ---------- tier, size and price ----------
  function sold() { used = taken(amfi.holders()); }
  function freeIn(t) {
    const tr = TIERS[t]; let free = tr.seats;
    for (const id of used) { const k = Number(id.slice(1, id.indexOf('c'))); if (k >= tr.rings[0] && k <= tr.rings[1]) free--; }
    return free;
  }
  function drawTiers() {
    sold();
    const box = $('seat-tiers');
    box.querySelectorAll('label').forEach((l) => l.remove());
    TIERS.forEach((tr, t) => {
      const input = el('input', { type: 'radio', name: 'seat-tier', value: String(t), checked: t === tier });
      input.onchange = () => { tier = t; clampSize(); price(); };
      const text = el('span', {},
        el('b', { textContent: `${tr.label} · koltuğu ${money(tr.price)}` }),
        el('small', { textContent: `${freeIn(t).toLocaleString('tr')} boş koltuk · ${tr.rings[1] - tr.rings[0] + 1} sıra` }));
      box.append(el('label', { className: 'tier' }, input, text));
    });
  }
  function clampSize() {
    const rows = TIERS[tier].rings[1] - TIERS[tier].rings[0] + 1;
    width = Math.min(SEAT_LIMITS.width, Math.max(1, Math.round(Number($('seat-width').value) || 1)));
    depth = Math.min(SEAT_LIMITS.depth, rows, Math.max(1, Math.round(Number($('seat-depth').value) || 1)));
    $('seat-depth').max = String(Math.min(SEAT_LIMITS.depth, rows));
  }
  function price() {
    $('seat-price').textContent = money(blockPrice({ ring: TIERS[tier].rings[0], col: 0, width, depth }));
    $('seat-count').textContent = `${width * depth} koltuk · ${width} yan yana, ${depth} sıra`;
  }
  for (const id of ['seat-width', 'seat-depth']) {
    $(id).addEventListener('input', () => { clampSize(); price(); });
    $(id).addEventListener('change', () => { clampSize(); $('seat-width').value = width; $('seat-depth').value = depth; price(); });
  }

  // ---------- placing the block in the hall ----------
  const text = el('span', { id: 'place-text', role: 'status' });
  const ok = el('button', { id: 'place-ok', textContent: 'Burayı seç' });
  const cancel = el('button', { id: 'place-cancel', className: 'quiet', textContent: 'Vazgeç' });
  const bar = el('div', { className: 'place-bar', hidden: true }, text, ok, cancel);
  document.querySelector('.stage').append(bar);

  // The block as close to the asked seat as the tier and the hall edges allow.
  function blockAt(k, c) {
    const tr = TIERS[tier];
    const ring = Math.min(Math.max(k, tr.rings[0]), tr.rings[1] - depth + 1);
    return { ring, col: Math.min(Math.max(c - Math.floor(width / 2), 0), tr.cols - width), width, depth };
  }
  function firstFree() {
    const tr = TIERS[tier], mid = Math.floor((tr.cols - width) / 2);
    for (let ring = tr.rings[0]; ring + depth - 1 <= tr.rings[1]; ring++)
      for (let d = 0; d < tr.cols; d++) for (const c of [mid + d, mid - d]) {
        const b = { ring, col: c, width, depth };
        if (canPlace(b, used)) return b;
      }
    return blockAt(tr.rings[0], tr.cols / 2);
  }
  function setGhost(block) {
    ghost = { block, ok: canPlace(block, used) };
    amfi.setGhost(ghost);
    ok.disabled = !ghost.ok;
    text.textContent = ghost.ok
      ? `${tierOf(block.ring).label}, ${block.ring - TIERS[tier].rings[0] + 1}. sıradan ${width * depth} koltuk · ${money(blockPrice(block))}. Tıkla ya da Enter'a bas.`
      : 'Bu koltuklardan bazıları dolu. Bloğu boş bir yere götür.';
  }
  function startPlacing() {
    clampSize(); sold(); placing = true; chosen = null;
    document.body.classList.add('is-placing'); bar.hidden = false;
    setGhost(firstFree());
    ok.focus({ preventScroll: true });
  }
  function stopPlacing() {
    placing = false; ghost = null; document.body.classList.remove('is-placing'); bar.hidden = true;
    amfi.setGhost(chosen ? { block: chosen, ok: true } : null);
  }
  function choose() {
    if (!ghost?.ok) return;
    chosen = ghost.block;
    stopPlacing();
    $('seat-form').hidden = false;
    $('seat-status').textContent = `Seçtiğin yer: ${tierOf(chosen.ring).label}, ${width * depth} koltuk, ${money(blockPrice(chosen))}.`;
    $('seat-place').textContent = 'Başka bir yer seç';
    preview();
    $('seat-image').focus();
  }
  $('seat-place').onclick = startPlacing;
  $('seat-again').onclick = startPlacing;
  ok.onclick = choose;
  cancel.onclick = () => { stopPlacing(); $('seats-title').focus(); };

  const pointed = (event) => {
    const rect = canvas.getBoundingClientRect();
    return amfi.hit(geometry(), event.clientX - rect.left, event.clientY - rect.top);
  };
  canvas.addEventListener('pointermove', (event) => {
    if (!placing || event.pointerType === 'touch') return;
    const p = pointed(event); if (p) setGhost(blockAt(p.k, p.c));
  });
  // Placing takes the hall's clicks: a mouse click chooses, a finger only moves the block (the button chooses).
  canvas.addEventListener('click', (event) => {
    if (!placing) return;
    event.stopImmediatePropagation();
    const p = pointed(event); if (!p) return;
    setGhost(blockAt(p.k, p.c));
    if (event.pointerType === 'mouse') choose();
  }, true);
  addEventListener('keydown', (event) => {
    if (!placing || !ghost) return;
    const b = ghost.block, step = { ArrowLeft: [0, -1], ArrowRight: [0, 1], ArrowUp: [1, 0], ArrowDown: [-1, 0] }[event.key];
    if (step) { event.preventDefault(); setGhost(blockAt(b.ring + step[0], b.col + Math.floor(width / 2) + step[1])); }
    else if (event.key === 'Enter') { event.preventDefault(); choose(); }
    else if (event.key === 'Escape') { event.preventDefault(); stopPlacing(); $('seats-title').focus(); }
  });

  // ---------- image, name, link, and how it will look ----------
  const previewHall = createAmfi();
  function preview() {
    if (!chosen) return;
    const c = $('seat-preview'), g = c.getContext('2d'), W = c.width, H = c.height;
    const arc = blockArc(chosen), rm = (arc.r1 + arc.r2) / 2, am = (arc.a1 + arc.a2) / 2, toRad = Math.PI / 180;
    // Close enough to read the block, not so close that the empty seats around it turn into big coins.
    const R = Math.min(22 / PLAN.pitch, (W * .42) / ((arc.a2 - arc.a1) * toRad * rm), (H * .5) / (arc.r2 - arc.r1));
    const G = { R, cx: W / 2 - Math.sin(am * toRad) * rm * R, cy: H / 2 + Math.cos(am * toRad) * rm * R };
    const mine = { id: 'onizleme', ...chosen, name: $('seat-name').value.trim() || 'Senin adın', link: null, image: null, drawable: image };
    previewHall.setHolders([...amfi.holders(), mine], { fresh: true });
    g.fillStyle = '#0b0907'; g.fillRect(0, 0, W, H);
    previewHall.draw(g, G, { width: W, height: H, dpr: 1, heard: 0, dt: 0, still: true });
  }
  $('seat-name').addEventListener('input', preview);
  $('seat-image').addEventListener('change', () => {
    const file = $('seat-image').files[0];
    $('seat-pay-status').textContent = '';
    if (!file) { image = null; preview(); return; }
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) { $('seat-pay-status').textContent = 'Yalnız PNG, JPG ya da WebP.'; return; }
    if (file.size > 2 * 1024 * 1024) { $('seat-pay-status').textContent = 'Resim en fazla 2 MB olabilir.'; return; }
    const img = new Image(), url = URL.createObjectURL(file);
    img.onload = () => { image = img; preview(); };
    img.onerror = () => { URL.revokeObjectURL(url); $('seat-pay-status').textContent = 'Bu resim açılamadı. Başka bir dosya dene.'; };
    img.src = url;
  });
  $('seat-pay').onclick = () => {
    const name = $('seat-name').value.trim(), link = $('seat-link').value.trim();
    let url = null; try { url = new URL(link); } catch { url = null; }
    const problem = !chosen ? 'Önce salonda bir yer seç.' : !image ? 'Bir logo ya da profil resmi ekle.' : !name ? 'Görünecek adı yaz.'
      : !url || !['http:', 'https:'].includes(url.protocol) ? 'Link https:// ile başlayan bir adres olmalı.' : '';
    $('seat-pay-status').textContent = problem || 'Ödeme henüz açık değil. Satış başladığında bu adımda ödeme sayfası açılacak. Seçtiğin yer ayrılmadı, hiçbir bilgi gönderilmedi.';
  };

  // Opening the view shows fresh counts; closing the panel drops the chosen place from the hall.
  addEventListener('view', (event) => {
    if (event.detail === 'seats') { drawTiers(); clampSize(); price(); }
    else if (!placing) { chosen = null; amfi.setGhost(null); }
  });
  addEventListener('holders', () => { if (!$('panel').hidden) drawTiers(); });
  clampSize(); price();
}

// The holders list in the panel: every sold block as a name and a link, for readers and search engines.
export function listHolders(holders) {
  const list = $('holders'); list.replaceChildren();
  const seatsSold = holders.reduce((n, h) => n + h.width * h.depth, 0);
  $('holders-lead').textContent = holders.length
    ? `${holders.length.toLocaleString('tr')} sahip, ${seatsSold.toLocaleString('tr')} koltuk. ${PLAN.count.toLocaleString('tr')} koltuğun ${(PLAN.count - seatsSold).toLocaleString('tr')} tanesi boş.`
    : 'Henüz satılmış koltuk yok.';
  for (const h of [...holders].sort((a, b) => a.ring - b.ring || b.width * b.depth - a.width * a.depth)) {
    const a = el('a', { href: h.link, target: '_blank', rel: 'sponsored noopener noreferrer', textContent: h.name });
    list.append(el('li', {}, a, el('small', { textContent: `${tierOf(h.ring).label} · ${h.width * h.depth} koltuk` })));
  }
}
