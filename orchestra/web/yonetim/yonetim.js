// The management panel: sign in with a named key, see what was sold, approve a waiting seat or refund it, take a
// live one down. Everything is built here into #yonetim; the server answers under /api/yonetim/ (shop.mjs).
// Only Turkish: it is used from the inside.
import { createAmfi, closeUp } from '../amfi.js';
import { tierOf } from '../seats.mjs';

const root = document.getElementById('yonetim');
const el = (tag, { role, ...props } = {}, ...children) => {
  const e = Object.assign(document.createElement(tag), props);
  if (role) e.setAttribute('role', role);
  e.append(...children.filter((c) => c != null && c !== false));
  return e;
};
const num = (n) => Number(n).toLocaleString('tr-TR');
const money = (cents) => `${num(cents / 100)} $`;
const when = (ms) => (ms ? new Date(ms).toLocaleString('tr-TR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');
const STATE = { held: 'Tutuluyor', paid: 'Onay bekliyor', problem: 'Sorunlu', live: 'Yayında', expired: 'Süresi doldu', refunded: 'İade edildi', removed: 'Kaldırıldı' };
const DONE = { held: 'yer tuttu', 'checkout-failed': 'ödeme sayfası açılamadı', paid: 'ödendi', problem: 'sorunlu ödeme', expired: 'süresi doldu',
  live: 'onayladı', refunded: 'iade etti', removed: 'kaldırdı', content: 'logosunu güncelledi' };
const PROBLEM = { amount: 'Tutar tutmuyor', taken: 'Yer artık dolu' };
const FILTERS = [['Tümü', () => true], ['Yayında', (o) => o.state === 'live'], ['Onay bekleyen', (o) => ['paid', 'problem'].includes(o.state)],
  ['Tutuluyor', (o) => o.state === 'held'], ['İade edildi', (o) => o.state === 'refunded' || o.refunded], ['Diğer', (o) => ['expired', 'removed'].includes(o.state)]];
const VIEWS = { '#genel': 'Genel bakış', '#bekleyen': 'Onay bekleyenler', '#koltuklar': 'Koltuklar', '#artirma': 'Açık artırma' };

let data = null, filter = 'Tümü';
const hall = createAmfi();

// ---------- sign in ----------
const keyInput = el('input', { id: 'key', type: 'password', autocomplete: 'current-password', required: true });
const loginStatus = el('p', { className: 'status', role: 'status' });
const loginForm = el('form', { className: 'login-form' },
  el('h1', {}, 'Agent Orchestra', el('span', {}, 'Yönetim')),
  el('label', { htmlFor: 'key' }, 'Anahtar'), keyInput,
  el('button', { type: 'submit' }, 'Giriş'), loginStatus);
const login = el('section', { className: 'login' }, loginForm);
loginForm.onsubmit = async (event) => {
  event.preventDefault();
  loginStatus.textContent = '';
  const res = await fetch('/api/yonetim/login', { method: 'POST', headers: { 'x-yonetim': '1', 'content-type': 'application/json' },
    body: JSON.stringify({ key: keyInput.value }) }).catch(() => null);
  if (res?.ok) { keyInput.value = ''; return load(); }
  loginStatus.textContent = res?.status === 429 ? 'Çok fazla deneme. Bir dakika sonra yeniden dene.' : res?.status === 401 ? 'Anahtar yanlış.' : 'Sunucuya ulaşılamadı.';
};

// ---------- the panel ----------
const status = el('p', { className: 'status', role: 'status' });
const me = el('span', { className: 'me' });
const menu = el('nav', { className: 'menu', ariaLabel: 'Bölümler' });
const view = el('main', { className: 'view' });
const refresh = el('button', { className: 'quiet', type: 'button' }, 'Yenile');
const logout = el('button', { className: 'quiet', type: 'button' }, 'Çıkış');
const app = el('div', { className: 'app', hidden: true },
  el('aside', { className: 'side' }, el('p', { className: 'brand' }, 'Agent Orchestra', el('span', {}, 'Yönetim')), menu,
    el('div', { className: 'who' }, me, refresh, logout)),
  el('div', { className: 'body' }, status, view));
root.replaceChildren(login, app);
refresh.onclick = () => load();
logout.onclick = async () => { await fetch('/api/yonetim/logout', { method: 'POST', headers: { 'x-yonetim': '1' } }).catch(() => null); showLogin(); };

function showLogin() { app.hidden = true; login.hidden = false; data = null; keyInput.focus?.(); }
const say = (text) => { status.textContent = text; };

async function load() {
  const res = await fetch('/api/yonetim/state', { headers: { 'x-yonetim': '1' }, cache: 'no-store' }).catch(() => null);
  if (res?.status === 401) return showLogin();
  if (!res?.ok) return say('Durum alınamadı. Yenile ile yeniden dene.');
  data = await res.json();
  login.hidden = true; app.hidden = false;
  render();
}

async function act(order, action, body, done) {
  const res = await fetch(`/api/yonetim/orders/${order.id}/${action}`, { method: 'POST',
    headers: { 'x-yonetim': '1', 'content-type': 'application/json' }, body: JSON.stringify(body || {}) }).catch(() => null);
  if (res?.status === 401) return showLogin();
  const why = res?.status === 409 ? (await res.json().catch(() => ({}))).error : null;
  const lost = res?.status === 502 && (await res.clone().json().catch(() => ({}))).error === 'unknown';
  // A refund whose answer was lost is finished by the same step: Reddet for a waiting order, Kaldır for a live one.
  const again = action === 'remove' ? 'Kaldır' : 'Reddet';
  say(res?.ok ? done : lost ? `Stripe'tan yanıt alınamadı; iade yapılmış olabilir. ${again} ile yeniden dene, aynı iade tamamlanır.`
    : res?.status === 502 ? 'Stripe iadeyi kabul etmedi. Biraz sonra yeniden dene.'
    : why === 'image' ? 'Logosu bulunamadı, onaylanamaz. Reddedip iade edebilirsin.'
    : why === 'taken' ? 'Bu yere sonradan elle koltuk eklenmiş. Önce onu kaldır ya da siparişi reddedip iade et.'
    : why === 'busy' ? 'Bu sipariş için başka bir işlem sürüyor. Biraz sonra yeniden dene.'
    : why === 'refunding' ? 'Bu siparişin iadesi başlamış, onaylanamaz. Reddet ile iadeyi tamamla.'
    : res?.status === 409 ? 'Bu sipariş artık o durumda değil. Liste yenilendi.' : 'Bir sorun oldu. Yeniden dene.');
  await load();
}

// ---------- the views ----------
const pending = () => data.orders.filter((o) => o.state === 'paid' || o.state === 'problem').sort((a, b) => a.paidAt - b.paidAt);
const nameOf = (id) => data.orders.find((o) => o.id === id)?.name || 'Sipariş';
const size = (o) => `${tierOf(o.ring).label} · ${o.width} × ${o.depth} = ${o.width * o.depth} koltuk`;

function render() {
  if (!data) return;
  const current = VIEWS[location.hash] ? location.hash : '#genel';
  me.textContent = data.me;
  menu.replaceChildren(...Object.entries(VIEWS).map(([hash, label]) => {
    const link = el('a', { href: hash }, hash === '#bekleyen' ? `${label} (${pending().length})` : label);
    if (hash === current) link.setAttribute('aria-current', 'page');
    return link;
  }));
  const closed = !data.checkout && el('p', { className: 'warn' }, 'Ödeme kapalı: Stripe ayarları eksik. Alıcılar şu an ödeme yapamaz.');
  view.replaceChildren(...[closed, ...({ '#genel': overview, '#bekleyen': waiting, '#koltuklar': seats, '#artirma': auctionTab }[current])()].filter(Boolean));
}
addEventListener('hashchange', render);

function overview() {
  const s = data.summary;
  const card = (label, value) => el('div', { className: 'card' }, el('span', {}, label), el('b', {}, value));
  return [
    el('h2', {}, 'Genel bakış'),
    el('div', { className: 'cards' }, card('Onay bekleyen', String(s.pending)), card('Yayındaki koltuk', `${num(s.liveSeats)} / ${num(data.seats)}`),
      card('Toplam gelir', money(s.revenue)), card('Bu ay', money(s.month))),
    el('h3', {}, 'Son hareketler'),
    data.events.length
      ? el('ol', { className: 'events' }, ...data.events.slice(-20).reverse().map((e) =>
        el('li', {}, el('time', {}, when(e.at)), ` ${nameOf(e.order)} · ${e.by ? `${e.by} ` : ''}${DONE[e.what] || e.what}`)))
      : el('p', { className: 'dim' }, 'Henüz hareket yok.'),
  ];
}

function waiting() {
  const list = pending();
  if (!list.length) return [el('h2', {}, 'Onay bekleyenler'), el('p', { className: 'dim' }, 'Onay bekleyen koltuk yok.')];
  const live = data.orders.filter((o) => o.state === 'live').map((o) => ({ ...o, image: `/seat-images/${o.id}.webp` }));
  return [el('h2', {}, 'Onay bekleyenler'), ...list.map((o) => {
    const canvas = el('canvas', { className: 'preview', width: 480, height: 240 });
    canvas.setAttribute('role', 'img'); canvas.setAttribute('aria-label', `${o.name} bloğunun salondaki yeri`);
    const logo = el('img', { alt: `${o.name} logosu`, src: `/api/yonetim/image/${o.id}` });
    logo.onload = () => closeUp(canvas, hall, [...live, { ...o, image: null, link: null, drawable: logo }], o);
    const reason = el('textarea', { rows: 2, maxLength: 300 });
    const ask = el('div', { className: 'ask', hidden: true },
      el('label', {}, 'Gerekçe (isteğe bağlı; alıcıya e-postayla sen iletirsin)', reason),
      el('div', { className: 'row' }, el('button', { type: 'button', className: 'danger', onclick: () => act(o, 'reject', { reason: reason.value.trim() }, `İade edildi: ${o.name}.`) }, 'Reddet ve iade et'),
        el('button', { type: 'button', className: 'quiet', onclick: () => { ask.hidden = true; } }, 'Vazgeç')));
    const link = el('a', { href: o.link, target: '_blank', rel: 'noopener noreferrer' }, `${o.link} ↗`);
    const stripe = o.payment && el('a', { href: `https://dashboard.stripe.com/payments/${encodeURIComponent(o.payment)}`, target: '_blank', rel: 'noopener noreferrer' }, 'Stripe\'ta gör ↗');
    return el('article', { className: 'order' }, canvas,
      el('div', { className: 'facts' }, logo,
        el('h3', {}, o.name), o.about && el('p', { className: 'about' }, o.about), o.city && el('p', { className: 'dim' }, o.city), link,
        el('p', {}, `${size(o)} · ${money(o.amount)}`),
        o.email && el('p', {}, el('a', { href: `mailto:${o.email}` }, o.email)),
        el('p', { className: 'dim' }, `Ödendi: ${when(o.paidAt)}`), stripe,
        o.state === 'problem' && el('p', { className: 'warn' }, `${PROBLEM[o.reason] || 'Sorunlu'}; iade edilmeli.`),
        o.refunding && el('p', { className: 'warn' }, 'İadesi başladı, kaydı tamamlanmadı. Reddet ile bitir.'),
        el('div', { className: 'row' },
          o.state === 'paid' && el('button', { type: 'button', onclick: () => act(o, 'approve', null, `Onaylandı: ${o.name} salonda.`) }, 'Onayla'),
          el('button', { type: 'button', className: 'quiet', onclick: () => { ask.hidden = false; reason.focus?.(); } }, 'Reddet')),
        ask));
  })];
}

function seats() {
  const pass = FILTERS.find(([label]) => label === filter)[1];
  const rows = data.orders.filter(pass).sort((a, b) => b.created - a.created).map((o) => {
    const action = el('td', {});
    if (o.state === 'live') {
      // A refund already started is owed: the server makes it whatever the box says, so the box says so too.
      const refund = el('input', { type: 'checkbox', checked: Boolean(o.refunding), disabled: Boolean(o.refunding) });
      const why = el('input', { type: 'text', placeholder: 'Gerekçe', maxLength: 300 });
      const ask = el('div', { className: 'ask', hidden: true }, el('label', { className: 'check' }, refund, 'Ücreti iade et'), why,
        el('div', { className: 'row' }, el('button', { type: 'button', className: 'danger', onclick: () => act(o, 'remove', { refund: refund.checked, reason: why.value.trim() }, `Kaldırıldı: ${o.name}.`) }, 'Kaldır'),
          el('button', { type: 'button', className: 'quiet', onclick: () => { ask.hidden = true; } }, 'Vazgeç')));
      action.append(el('button', { type: 'button', className: 'quiet', onclick: () => { ask.hidden = false; } }, 'Kaldır'), ask);
    }
    const note = o.refunding ? `, iadesi yarım kaldı: ${o.state === 'live' ? 'Kaldır' : 'Reddet'} ile bitir` : o.refunded && o.state !== 'refunded' ? ', iade' : '';
    return el('tr', {}, el('td', {}, o.name), el('td', {}, STATE[o.state] + note),
      el('td', {}, tierOf(o.ring).label), el('td', {}, String(o.width * o.depth)), el('td', {}, money(o.amount)), el('td', {}, when(o.paidAt || o.created)), action);
  });
  return [
    el('h2', {}, 'Koltuklar'),
    el('div', { className: 'filters', role: 'group' }, ...FILTERS.map(([label]) => {
      const chip = el('button', { type: 'button', className: label === filter ? 'chip on' : 'chip', onclick: () => { filter = label; render(); } }, label);
      chip.setAttribute('aria-pressed', String(label === filter));
      return chip;
    })),
    el('div', { className: 'table' }, el('table', {},
      el('thead', {}, el('tr', {}, ...['Ad', 'Durum', 'Sıra', 'Koltuk', 'Tutar', 'Tarih', ''].map((h) => el('th', {}, h)))),
      el('tbody', {}, ...rows))),
    rows.length ? null : el('p', { className: 'dim' }, 'Bu filtrede sipariş yok.'),
  ];
}

load();

// ---------- the front-block auction (auction.mjs) ----------
const AUCTION_STATE = { open: 'Sürüyor', capturing: 'Bitti, tahsil ediliyor', won: 'Kazanıldı', unsold: 'Teklifsiz bitti', failed: 'Tahsilat başarısız' };
const BID_STATE = { pending: 'Stripe sayfası açık', top: 'Önde', outbid: 'Geçildi', winner: 'Kazanan', late: 'Geç kaldı', expired: 'Vazgeçildi' };

async function auctionStep(step, done) {
  const res = await fetch(`/api/yonetim/auction/${step}`, { method: 'POST', headers: { 'x-yonetim': '1' } }).catch(() => null);
  if (res?.status === 401) return showLogin();
  const why = !res?.ok && (await res?.json().catch(() => ({})))?.error;
  say(res?.ok ? done : why === 'taken' ? 'Blokta satılmış ya da tutulan koltuk var; önce onu çöz.' : why === 'state' ? 'Açık artırma artık o durumda değil. Liste yenilendi.' : 'Bir sorun oldu. Yeniden dene.');
  await load();
}

function auctionTab() {
  const a = data.auction?.auction, bids = data.auction?.bids || [], old = data.auction?.old || [];
  const ask = el('div', { className: 'ask', hidden: true },
    el('p', {}, 'Sahnenin önündeki 96 koltuk açık artırmaya çıkar: 2.400 $\'dan başlar, en az +100 $, 5 gün sürer (son 10 dakikadaki teklif uzatır, en çok 6 gün). Blok bu sürede normal satışta dolu görünür.'),
    el('div', { className: 'row' }, el('button', { type: 'button', onclick: () => auctionStep('start', 'Açık artırma başladı.') }, 'Başlat'),
      el('button', { type: 'button', className: 'quiet', onclick: () => { ask.hidden = true; } }, 'Vazgeç')));
  const canStart = !a || ['unsold', 'failed'].includes(a.state) || (a.state === 'won' && ['refunded', 'removed'].includes(data.orders.find((o) => o.id === a.order)?.state));
  const top = bids.find((b) => b.id === a?.top);
  return [
    el('h2', {}, 'Açık artırma'),
    !a ? el('p', { className: 'dim' }, 'Açık artırma yok.')
      : el('p', {}, `${AUCTION_STATE[a.state]} · bitiş ${when(a.endsAt)}${top ? ` · en yüksek ${money(top.amount * 100)}` : ''}`),
    a?.state === 'won' && top && el('p', {}, `Kazanan: ${top.email || 'e-posta yok'} · ${a.order ? 'logo geldi, Onay bekleyenler\'de' : 'logo bekleniyor'}`),
    a?.state === 'capturing' && el('div', { className: 'row' }, el('button', { type: 'button', onclick: () => auctionStep('capture', 'Tahsilat yeniden denendi.') }, 'Tahsilatı yeniden dene')),
    a?.state === 'failed' && el('p', { className: 'warn' }, 'Tahsilat reddedildi; yeniden başlatabilir ya da bloğu satışa açabilirsin.'),
    a?.state === 'failed' && el('div', { className: 'row' }, el('button', { type: 'button', className: 'quiet', onclick: () => auctionStep('close', 'Blok normal satışa açıldı.') }, 'Satışa aç')),
    canStart && el('div', { className: 'row' }, el('button', { type: 'button', onclick: () => { ask.hidden = false; } }, 'Başlat')), ask,
    // Bids of the last auction appear while they may still hold money (a page open, a hold being let go).
    bids.length + old.length > 0 && el('table', {}, el('thead', {}, el('tr', {}, ...['Tutar', 'Durum', 'E-posta', 'Saat'].map((h) => el('th', {}, h)))),
      el('tbody', {}, ...[...[...bids].sort((x, y) => y.amount - x.amount), ...old].map((b) => el('tr', {}, el('td', {}, money(b.amount * 100)),
        el('td', {}, BID_STATE[b.state] + (b.releasing ? ', bloke kaldırılıyor' : '') + (old.includes(b) ? ' · önceki açık artırma' : '')),
        el('td', {}, b.email || ''), el('td', {}, when(b.settledAt || b.createdAt)))))),
  ];
}
