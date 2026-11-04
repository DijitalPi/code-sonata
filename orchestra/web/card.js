// The card over the hall: who holds a sold block (big logo, name, their line and city, link, seats), or what the
// auction block is. It opens beside the point, above it or below when there is no room, never over the block it is
// about, and that block lights up in the hall while it is open. On its own so it can be tested without the page.
import { tierOf } from './seats.mjs';

// The link as the card writes it, at most 48 characters: the site always shows; a long address loses the end of
// its path, a long site name its front (the end of a name tells whose site it is).
function shortLink(link) {
  const u = new URL(link), site = u.host.replace(/^www\./, '');
  if (site.length > 48) return `…${site.slice(-47)}`;
  return `${site}${`${u.pathname}${u.search}${u.hash}`.replace(/\/$/, '')}`.slice(0, 48);
}

export function createCard({ stage, canvas, amfi }) {
  const card = document.createElement('div');
  card.className = 'seat-card'; card.hidden = true; card.setAttribute('role', 'status');
  stage.append(card);
  let shown = null, timer = 0;

  // The holder's picture as the hall draws it, at card size: at most 252 × 96, its own shape kept.
  function logo(holder) {
    const pic = amfi.picture(holder), w0 = pic?.naturalWidth || pic?.width, h0 = pic?.naturalHeight || pic?.height;
    if (!w0 || !h0) return null;
    const scale = Math.min(252 / w0, 96 / h0), w = Math.round(w0 * scale), h = Math.round(h0 * scale);
    const dpr = globalThis.devicePixelRatio || 1, c = document.createElement('canvas');
    c.className = 'seat-logo'; c.width = Math.round(w * dpr); c.height = Math.round(h * dpr);
    c.style.width = `${w}px`; c.style.height = `${h}px`; c.setAttribute('aria-hidden', 'true');
    const g = c.getContext('2d'); g.scale(dpr, dpr); g.drawImage(pic, 0, 0, w, h);
    return c;
  }

  // (x, y) is a point in the hall, as its hit test takes it; the card lives in the stage, which on a phone starts
  // above the hall (the title and the counts come first).
  function place(x, y) {
    card.hidden = false;
    const hall = canvas.getBoundingClientRect(), area = stage.getBoundingClientRect(), box = card.getBoundingClientRect();
    x += hall.left - area.left; y += hall.top - area.top;
    card.style.left = `${Math.min(Math.max(8, x + 14), area.width - box.width - 8)}px`;
    const above = y - box.height - 12;
    card.style.top = `${above >= 8 ? above : Math.max(8, Math.min(y + 18, area.height - box.height - 8))}px`;
  }

  function holder(h, x, y) {
    clearTimeout(timer);
    amfi.setHover(h);
    if (h !== shown) {
      shown = h;
      // Demo text is ours and is translated; a buyer's is shown as they wrote it.
      const own = (tag, text, className) => {
        const e = document.createElement(tag); e.textContent = text; e.translate = amfi.isDemo();
        if (className) e.className = className;
        return e;
      };
      card.replaceChildren();
      const picture = logo(h); if (picture) card.append(picture);
      card.append(own('b', h.name));
      if (h.about) card.append(own('p', h.about));
      if (h.city) card.append(own('span', h.city, 'city'));
      if (h.link) {
        const a = document.createElement('a'); a.href = h.link; a.target = '_blank'; a.rel = 'sponsored noopener'; a.referrerPolicy = 'origin'; a.translate = false;   // the holder sees the site, not the page
        a.textContent = `${shortLink(h.link)} ↗`; card.append(a);
      }
      const size = `${h.width * h.depth} koltuk · ${tierOf(h.ring).label}`;
      const meta = document.createElement('small'); meta.textContent = amfi.isDemo() ? `Demo örneği, gerçek alıcı değil · ${size}` : size; card.append(meta);
    }
    place(x, y);
  }

  // Anything else (the auction block while it takes bids): built fresh each time, no block lit.
  function other(nodes, x, y) {
    clearTimeout(timer);
    shown = 'other'; amfi.setHover(null);
    card.replaceChildren(...nodes);
    place(x, y);
  }

  function hide(later) {
    clearTimeout(timer);
    timer = setTimeout(() => { card.hidden = true; shown = null; amfi.setHover(null); }, later ? 350 : 0);
  }
  card.addEventListener('pointerenter', () => clearTimeout(timer));
  card.addEventListener('pointerleave', () => hide(true));

  return { holder, other, hide, open: () => shown !== null, element: card };
}
