// Buying a seat, up to the payment step: pick a tier and a size, see the price, carry the block to a free
// place in the hall (mouse, finger or arrow keys), then add an image, a name and a link and see the result.
// Nothing here talks to the server: payment, upload and approval come in the second part.
import { PLAN, TIERS, SEAT_LIMITS, tierOf, blockPrice, taken, canPlace, blockArc } from './seats.mjs';
import { createAmfi, closeUp } from './amfi.js';
import { num } from './i18n.js';

const $ = (id) => document.getElementById(id);
const money = (n) => `${num(n)} $`;
// A small element builder; `role` is set as an attribute (not every browser reflects it as a property).
const el = (tag, { role, ...props } = {}, ...children) => {
  const e = Object.assign(document.createElement(tag), props);
  if (role) e.setAttribute('role', role);
  e.append(...children);
  return e;
};

// The logo the server keeps: WebP, longest side 480 px, under 300 KB. Drawing it again also drops its metadata.
export async function webpLogo(img) {
  const w = img.naturalWidth || img.width, h = img.naturalHeight || img.height, scale = Math.min(1, 480 / Math.max(w, h));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w * scale)); c.height = Math.max(1, Math.round(h * scale));
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  for (const quality of [.85, .7, .5]) {
    const url = c.toDataURL('image/webp', quality);
    if (!url.startsWith('data:image/webp')) return null;   // a browser that cannot write WebP
    if (url.length * .75 < 300 * 1024) return url;
  }
  return null;
}

// Back from Stripe (?siparis=…): what became of the order, asked every few seconds until it is decided.
// Resolves to false while the outcome is not known.
export async function followOrder(id, { cancelled = false, wait = 3000, tries = 40 } = {}) {
  const say = (text, known = true) => { $('seat-status').textContent = text; return known; };
  if (cancelled) {
    const res = await fetch(`/api/seats/order/${id}/cancel`, { method: 'POST' }).catch(() => null);
    if (res?.ok) return say('Ödeme yapılmadı. Ayırdığın yer bırakıldı.');
    // 409: no longer held (paid in another tab, or already let go). Otherwise Stripe or the server could not be
    // reached: say only what the order shows now; a hold is let go 41 minutes after it began at the latest.
    if (res?.status !== 409) {
      const now = await fetch(`/api/seats/order/${id}`, { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
      if (!now) return say('Ödemenin durumu şu an doğrulanamadı. Bağlantın gelince bu sayfayı yenile.', false);
      if (now.state === 'held') return say('Ödemen bize ulaşmadı. Ulaşmazsa ayırdığın yer en geç bir saat içinde bırakılır.');
    }
  }
  say('Ödemen kontrol ediliyor…');
  const done = { paid: 'Ödemen alındı. Koltuğun onay bekliyor; onaylanınca salonda görünecek.', live: 'Koltuğun salonda. Teşekkürler!',
    refunded: 'Bu sipariş iade edildi.', expired: 'Bu ödemenin süresi doldu. Ayırdığın yer bırakıldı.' };
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(`/api/seats/order/${id}`, { cache: 'no-store' });
      if (res.status === 404) return say('Bu sipariş bulunamadı.');
      const { state } = await res.json();
      if (done[state]) return say(done[state]);
    } catch { /* asked again below */ }
    await new Promise((resolve) => setTimeout(resolve, wait));
  }
  return say('Ödemen henüz bize ulaşmadı. Kartından çekim yapıldıysa birkaç dakika içinde onay bekleyenlere düşer.', false);
}

// Back from Stripe: open the seat panel on the order's news. The order leaves the address once its outcome is
// known; until then reloading the page asks again, as the messages say.
export async function backFromStripe() {
  const order = new URLSearchParams(location.search).get('siparis');
  if (!/^o-[0-9a-f]{24}$/.test(order || '')) return;
  document.querySelector('[data-open="seats"]')?.click();
  if (!(await followOrder(order, { cancelled: new URLSearchParams(location.search).has('iptal') }))) return;
  const params = new URLSearchParams(location.search);
  params.delete('siparis'); params.delete('iptal');
  history.replaceState(null, '', `${location.pathname}${[...params].length ? `?${params}` : ''}${location.hash}`);
}

export function setupBuying({ canvas, geometry, amfi, encode = webpLogo, go = (url) => location.assign(url) }) {
  let tier = 0, width = 1, depth = 1, used = new Set(), ghost = null, chosen = null, placing = false, image = null;
  let checkoutOpen = false, paying = false;
  addEventListener('shop', (event) => { checkoutOpen = Boolean(event.detail?.checkout); });

  // ---------- tier, size and price ----------
  // Seats sold, and seats someone is paying for or waiting to have approved, are all taken.
  function sold() { used = taken([...amfi.holders(), ...(amfi.reserved?.() || [])]); }
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
        el('small', { textContent: `${num(freeIn(t))} boş koltuk · ${tr.rings[1] - tr.rings[0] + 1} sıra` }));
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
    $('seat-count').textContent = width * depth === 1 ? '1 koltuk' : `${width * depth} koltuk · ${width} yan yana, ${depth} sıra`;
  }
  for (const id of ['seat-width', 'seat-depth']) {
    $(id).addEventListener('input', () => { clampSize(); price(); });
    $(id).addEventListener('change', () => { clampSize(); $('seat-width').value = width; $('seat-depth').value = depth; price(); });
  }

  // ---------- placing the block in the hall ----------
  const text = el('span', { id: 'place-text', role: 'status' });
  const hint = el('small', { id: 'place-hint' });
  const ok = el('button', { id: 'place-ok', textContent: 'Burayı seç' });
  const cancel = el('button', { id: 'place-cancel', className: 'quiet', textContent: 'Vazgeç' });
  const bar = el('div', { className: 'place-bar', hidden: true }, text, hint, ok, cancel);
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
  // A finger only moves the block (the button chooses); a mouse click chooses where it points.
  const touch = () => Boolean(globalThis.matchMedia?.('(pointer: coarse)').matches);
  function setGhost(block, suggested = false) {
    ghost = { block, ok: canPlace(block, used) };
    amfi.setGhost(ghost);
    ok.disabled = !ghost.ok;
    const where = `${tierOf(block.ring).label}, ${block.ring - TIERS[tier].rings[0] + 1}. sıradan ${width * depth} koltuk · ${money(blockPrice(block))}.`;
    text.textContent = !ghost.ok ? 'Bu koltuklardan bazıları dolu. Bloğu boş bir yere götür.' : suggested ? `En iyi boş yer: ${where}` : where;
    hint.textContent = touch() ? "Başka bir yere dokun ya da Burayı seç'e bas." : "Tıkla ya da Enter'a bas.";
  }
  // On a phone the hall is drawn wider than the screen while placing (style.css), so a seat is big enough
  // to tap; it opens with the suggested block in the middle and scrolls sideways from there. Keys carry the
  // view along; a tap does not, so the hall stays still under the finger.
  function showGhost() {
    const stage = canvas.parentElement;
    if (!ghost || !(stage.scrollWidth > stage.clientWidth)) return;
    const G = geometry(), arc = blockArc(ghost.block), a = (arc.a1 + arc.a2) / 2 * Math.PI / 180;
    stage.scrollLeft = G.cx + Math.sin(a) * (arc.r1 + arc.r2) / 2 * G.R - stage.clientWidth / 2;
  }
  function startPlacing() {
    clampSize(); sold(); placing = true; chosen = null;
    document.body.classList.add('is-placing'); bar.hidden = false;
    setGhost(firstFree(), true);
    showGhost();
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
  // A move without movement is the hall sliding under a resting mouse (the panel closing, a phone's tap):
  // it would carry the block off the suggested place.
  canvas.addEventListener('pointermove', (event) => {
    if (!placing || event.pointerType === 'touch' || (!event.movementX && !event.movementY)) return;
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
    if (step) { event.preventDefault(); setGhost(blockAt(b.ring + step[0], b.col + Math.floor(width / 2) + step[1])); showGhost(); }
    else if (event.key === 'Enter') { event.preventDefault(); choose(); }
    else if (event.key === 'Escape') { event.preventDefault(); stopPlacing(); $('seats-title').focus(); }
  });

  // ---------- image, name, link, and how it will look ----------
  const previewHall = createAmfi();
  function preview() {
    if (!chosen) return;
    const mine = { id: 'onizleme', ...chosen, name: $('seat-name').value.trim() || 'Senin adın', link: null, image: null, drawable: image };
    closeUp($('seat-preview'), previewHall, [...amfi.holders(), mine], chosen);
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
  $('seat-pay').onclick = async () => {
    if (paying) return;
    const say = (text) => { $('seat-pay-status').textContent = text; };
    const name = $('seat-name').value.trim(), link = $('seat-link').value.trim();
    let url = null; try { url = new URL(link); } catch { url = null; }
    const problem = !chosen ? 'Önce salonda bir yer seç.' : !image ? 'Bir logo ya da profil resmi ekle.' : !name ? 'Görünecek adı yaz.'
      : !url || !['http:', 'https:'].includes(url.protocol) ? 'Link https:// ile başlayan bir adres olmalı.'
      : checkoutOpen && !$('seat-terms').checked ? 'Koltuk şartlarını okuyup kutuyu işaretle.' : '';
    if (problem) return say(problem);
    if (!checkoutOpen) return say('Ödeme henüz açık değil. Satış başladığında bu adımda ödeme sayfası açılacak. Seçtiğin yer ayrılmadı, hiçbir bilgi gönderilmedi.');
    paying = true; $('seat-pay').disabled = true;
    say('Ödeme sayfası hazırlanıyor…');
    try {
      const logo = await encode(image);
      if (!logo) return say('Tarayıcın bu resmi hazırlayamadı. Başka bir tarayıcı dene.');
      const res = await fetch('/api/seats/checkout', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ block: { ring: chosen.ring, col: chosen.col, width: chosen.width, depth: chosen.depth }, name, link: url.href, image: logo, terms: true }) });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.url) { say('Ödeme sayfasına gidiliyor…'); return go(data.url); }
      if (res.status === 409) dispatchEvent(new CustomEvent('seats-stale'));
      say(res.status === 409 ? 'Bu yer az önce başkası tarafından tutuldu. Başka bir yer seç.'
        : res.status === 429 ? 'Çok fazla deneme oldu. Birkaç dakika sonra yeniden dene.'
        : res.status === 400 && data.error === 'image' ? 'Resim kabul edilmedi. Başka bir resim dene.'
        : 'Ödeme sayfası açılamadı. Birazdan yeniden dene.');
    } catch { say('Ödeme sayfası açılamadı. Birazdan yeniden dene.'); }
    finally { paying = false; $('seat-pay').disabled = false; }
  };

  // Any view change ends a placing. Opening the view shows fresh counts; leaving it drops the chosen place, except
  // for the terms, which are read on the way to paying.
  addEventListener('view', (event) => {
    if (placing) stopPlacing();
    if (event.detail === 'seats') { drawTiers(); clampSize(); price(); }
    else if (event.detail !== 'terms') { chosen = null; amfi.setGhost(null); }
  });
  addEventListener('holders', () => { if (!$('panel').hidden) drawTiers(); });
  clampSize(); price();
  backFromStripe();
}

// The holders list in the panel: every sold block as a name and a link, for readers and search engines.
export function listHolders(holders) {
  const list = $('holders'); list.replaceChildren();
  const seatsSold = holders.reduce((n, h) => n + h.width * h.depth, 0);
  $('holders-lead').textContent = holders.length
    ? `${num(holders.length)} sahip, ${num(seatsSold)} koltuk. ${num(PLAN.count)} koltuğun ${num(PLAN.count - seatsSold)} tanesi boş.`
    : 'Henüz satılmış koltuk yok.';
  for (const h of [...holders].sort((a, b) => a.ring - b.ring || b.width * b.depth - a.width * a.depth)) {
    const a = el('a', { href: h.link, target: '_blank', rel: 'sponsored noopener noreferrer', textContent: h.name, translate: false });
    list.append(el('li', {}, a, el('small', { textContent: `${tierOf(h.ring).label} · ${h.width * h.depth} koltuk` })));
  }
}
