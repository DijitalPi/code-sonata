// The front-block auction in the seat panel: the price now, the time left, a bid (a card hold on Stripe), and what
// became of this visitor's bids. The server keeps the auction (shop.mjs, auction.mjs); this only shows and asks.
import { num } from './i18n.js';

const $ = (id) => document.getElementById(id);
// A message about this visitor's bid shows the box even when no auction takes bids (back from Stripe after the end).
let told = false;
const say = (text) => { $('auction-status').textContent = text; told = Boolean(text); if (told) $('auction').hidden = false; };
const SAVED = 'teklifler', BID = /^b-[0-9a-f]{24}$/;
const saved = () => { try { return (JSON.parse(localStorage.getItem(SAVED) || '[]') || []).filter((id) => BID.test(id)); } catch { return []; } };
const remember = (id) => { try { localStorage.setItem(SAVED, JSON.stringify([...new Set([...saved(), id])].slice(-10))); } catch { /* private mode */ } };
const SAID = {
  top: 'Teklifin kartında bloke edildi. Şu an öndesin.',
  outbid: 'Daha yüksek bir teklif geldi; blokesi kaldırıldı.',
  late: 'Teklifin geçerli olmadı (açık artırma bitmişti ya da fiyat yükselmişti); blokesi kaldırıldı.',
  expired: 'Teklif verilmedi. Kartından bir şey bloke edilmedi.',
  winner: 'Kazandın! Logonu, adını ve linkini gönder; onaylanınca blok salonda görünür.',
};

export function left(ms) {
  if (ms <= 0) return 'bitti';
  const d = Math.floor(ms / 86_400_000), h = Math.floor(ms / 3_600_000) % 24, m = Math.floor(ms / 60_000) % 60, s = Math.floor(ms / 1000) % 60;
  return d ? `${d} g ${h} sa` : h ? `${h} sa ${m} dk` : `${m} dk ${String(s).padStart(2, '0')} sn`;
}

// What became of one bid: false while it is not known yet.
async function follow(id, { cancelled = false, wait = 3000, tries = 20 } = {}) {
  if (cancelled) {
    const res = await fetch(`/api/auction/bid/${id}/cancel`, { method: 'POST' }).catch(() => null);
    if (res?.ok) { say(SAID.expired); return true; }
  }
  say('Teklifin kontrol ediliyor…');
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(`/api/auction/bid/${id}`, { cache: 'no-store' });
      if (res.status === 404) { say('Bu teklif bulunamadı.'); return true; }
      if (res.ok) { const v = await res.json(); if (SAID[v.state]) { say(SAID[v.state]); return true; } }
    } catch { /* asked again below */ }
    await new Promise((resolve) => setTimeout(resolve, wait));
  }
  say('Stripe henüz bildirmedi. Birkaç dakika sonra sayfayı yenile.');
  return false;
}

// Back from a bid's Stripe page (?teklif=…): the bid leaves the address once its outcome is known.
export async function backFromBid(options) {
  const id = new URLSearchParams(location.search).get('teklif');
  if (!BID.test(id || '')) return;
  remember(id);
  document.querySelector('[data-open="seats"]')?.click();
  if (!(await follow(id, { cancelled: new URLSearchParams(location.search).has('iptal'), ...options }))) return;
  const params = new URLSearchParams(location.search);
  params.delete('teklif'); params.delete('iptal');
  history.replaceState(null, '', `${location.pathname}${[...params].length ? `?${params}` : ''}${location.hash}`);
}

export function setupAuction({ go = (url) => location.assign(url), startWinner, now = () => Date.now() }) {
  let view = null, timer = 0, winning = null;
  const tick = () => {
    if (view?.state !== 'open') return;
    const ms = view.endsAt - now();
    $('auction-left').textContent = ms > 0 ? `· bitişe ${left(ms)}` : '· bitti';
  };
  function show(v) {
    view = v;
    const open = v?.state === 'open';
    $('auction').hidden = !open && !winning && !told;
    $('auction-form').hidden = !open;
    if (open) {
      $('auction-price').textContent = v.current ? `Şu an ${num(v.current)} $` : `Açılış ${num(v.min)} $`;
      $('auction-min').textContent = `En az ${num(v.min)} $`;
      const amount = $('auction-amount');
      amount.min = String(v.min);
      if (!(Number(amount.value) >= v.min)) amount.value = String(v.min);
      tick();
      timer ||= setInterval(tick, 1000);
    } else { clearInterval(timer); timer = 0; }
  }
  $('auction-bid').onclick = async () => {
    const amount = Math.round(Number($('auction-amount').value));
    if (!$('auction-terms').checked) return say('Teklif vermek için koltuk şartlarını okuyup kutuyu işaretle.');
    if (!view || !(amount >= view.min)) return say(`En az ${num(view?.min ?? 0)} $ teklif verebilirsin.`);
    if (amount > 100_000) return say('En fazla 100.000 $ teklif verebilirsin.');
    $('auction-bid').disabled = true;
    say('Teklif sayfası hazırlanıyor…');
    try {
      const res = await fetch('/api/auction/bid', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ amount, terms: true }) });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.url) { remember(data.id); say('Stripe sayfasına gidiliyor…'); return go(data.url); }
      if (res.status === 400 && data.error === 'amount' && data.min) { show({ ...view, min: data.min }); return say(`Bu arada fiyat yükseldi: en az ${num(data.min)} $.`); }
      say(res.status === 409 ? 'Açık artırma bitti.' : res.status === 429 ? 'Çok fazla deneme oldu. Birkaç dakika sonra yeniden dene.' : 'Teklif sayfası açılamadı. Birazdan yeniden dene.');
    } catch { say('Teklif sayfası açılamadı. Birazdan yeniden dene.'); }
    finally { $('auction-bid').disabled = false; }
  };
  $('auction-win').onclick = () => { if (winning) startWinner(winning); };
  // Bids made earlier on this device: while the auction runs, the newest says whether it leads; a winner who has
  // not sent the logo yet gets the button.
  async function remembered() {
    for (const id of saved()) {
      const res = await fetch(`/api/auction/bid/${id}`, { cache: 'no-store' }).catch(() => null);
      const v = res?.ok ? await res.json().catch(() => null) : null;
      if (v?.state === 'winner' && (v.editable ?? !v.content)) {
        winning = id; $('auction-win').hidden = false;
        say(v.content ? 'Logon onay bekliyor. Değiştirmek istersen yeniden gönderebilirsin.' : SAID.winner);
      }
      else if (v?.auction === 'open' && ['top', 'outbid'].includes(v.state)) say(SAID[v.state]);
    }
  }
  return { show, remembered, stop: () => { clearInterval(timer); timer = 0; } };
}
