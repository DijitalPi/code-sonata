import { KINDS, personalNotes, liveNotes, deltaActivity, wavBytes, wavFromChannels, publicInvite, eventKey, momentLayout, captureCommon } from './moment.js';
import { renderWithSamples } from './instruments.js';
import { t, num } from './i18n.js';
const EVENT = eventKey(location.search);
const $ = id => document.getElementById(id);
const labels = { edit: 'düzenleme', bash: 'komut', read: 'okuma', think: 'düşünme', done: 'bitiş' };
let token = null, me = null, baseline = {}, polling = false, recent = [], moment = null, revision = 0;
let demoPlaying = false;   // the demo concert plays alone: no private polling meanwhile
export function setDemoPlaying(on) { demoPlaying = on; }
let synth = null, nodes = [], demoTimer = null, recorder = null, recordingCleanup = null;
let personalEnabled = false, synthBus = null;
const soundTabs = 'BroadcastChannel' in window ? new BroadcastChannel('agent-orchestra-audio') : null;
const personalTab = `personal-${Math.random().toString(36).slice(2)}`;
if (soundTabs) soundTabs.onmessage = event => {
  if (event.data?.playing && event.data.id !== personalTab) {
    stopPersonalAudio(); personalEnabled = false;
    if (isPersonal()) { $('sound').textContent = 'Sesi başlat'; $('mode-status').textContent = 'Ses başka sekmede. Burada başlatabilirsin.'; }
  }
};
// iPhone: web audio otherwise follows the ring/silent switch, and a phone on silent plays nothing.
export function newAudioContext() {
  try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch {}
  return new AudioContext();
}
export let ownSeat = null;
export let ownPulseAt = 0;
export let motionPaused = matchMedia('(prefers-reduced-motion: reduce)').matches;
export function isPersonal() { return $('mode').value === 'personal'; }
// What each section plays in the hall's loops (piano, flute or accordion sings the tune when it leads).
const SECTION_NAMES = ['piyano', 'yaylılar', 'koro', 'çello', 'flüt', 'vibrafon', 'korno', 'arp', 'akordeon'];
const LAYERS = ['ana ezgi', 'akorlar', 'koro hattı', 'bas', 'karşı ezgi', 'çanlar', 'vuruşlar', 'arpej', 'riff'];
export const layerName = section => `${SECTION_NAMES[section]} · ${LAYERS[section]}`;
export function receiveFrame(frame) {
  // Every heard note keeps where it came from, so a moment can say if it holds simulated music.
  const source = frame.demo ? 'demo' : frame.simulated ? 'test' : 'live', cutoff = Date.now() - 12000;
  recent.push(...(frame.notes || []).map(n => ({ at: n[0] - frame.t + Date.now(), note: n.slice(1), source })));
  recent = recent.filter(h => h.at >= cutoff).slice(-400);
}
// The server keeps anonymous daily totals (no cookie, no identity); this device's own counters
// below stay opt-in and never leave the browser.
const SERVER_METRICS = new Set(['visit', 'invited', 'listen', 'demo', 'connection', 'moment', 'video', 'invite', 'brand']);
function serverMetric(name) { try { navigator.sendBeacon('/api/metric', JSON.stringify({ name })); } catch {} }
function metric(name) {
  if (SERVER_METRICS.has(name)) serverMetric(name);
  localMetric(name);
}
function localMetric(name) {
  if (!$('metrics-consent')?.checked) return;
  try { const counters = JSON.parse(localStorage.getItem('orchestra-metrics') || '{}'); counters[name] = (counters[name] || 0) + 1; localStorage.setItem('orchestra-metrics', JSON.stringify(counters)); showMetrics(); } catch {}
}
const metricLabels = { visit: 'ziyaret', return: 'tekrar ziyaret', listen: 'dinleme başlatma', connection: 'bağlantı', moment: 'an üretimi', video: 'video üretimi', invite: 'davet kopyalama', invited: 'davetle geliş', brand: 'DijitalPi’ye geçiş' };
function showMetrics() {
  try { const values = JSON.parse(localStorage.getItem('orchestra-metrics') || '{}'); $('metrics-values').textContent = Object.keys(values).length ? Object.entries(values).map(([k,v]) => `${metricLabels[k] || k}: ${v}`).join(' · ') : 'Henüz kayıtlı kullanım sayısı yok.'; }
  catch { $('metrics-values').textContent = 'Bu tarayıcı yerel saklamaya izin vermiyor.'; }
}
let countedVisit = false;
function countVisit() {
  if (countedVisit || !$('metrics-consent').checked) return;
  countedVisit = true;
  try { if (JSON.parse(localStorage.getItem('orchestra-metrics') || '{}').visit) localMetric('return'); } catch {}
  localMetric('visit'); if (new URLSearchParams(location.search).get('from') === 'invite') localMetric('invited');
}
serverMetric('visit'); if (new URLSearchParams(location.search).get('from') === 'invite') serverMetric('invited');
try { $('metrics-consent').checked = localStorage.getItem('orchestra-metrics-consent') === 'yes'; } catch {}
$('metrics-consent').onchange = () => {
  try { localStorage.setItem('orchestra-metrics-consent', $('metrics-consent').checked ? 'yes' : 'no'); } catch {}
  if ($('metrics-consent').checked) { countVisit(); showMetrics(); } else $('metrics-values').textContent = 'Ölçüm kapalı. Önceki sayıları aşağıdaki düğmeden silebilirsin.';
};
$('clear-metrics').onclick = () => { try { localStorage.removeItem('orchestra-metrics'); } catch {} showMetrics(); };
countVisit();
if ($('metrics-consent').checked) showMetrics();
export { metric };
async function api(path, body = {}) {
  let response;
  try { response = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(EVENT ? { ...body, event: EVENT } : body), signal: AbortSignal.timeout(5000) }); }
  catch { throw new Error('Sunucuya ulaşılamıyor. Yerel sunucuyu ve bağlantını kontrol et; otomatik yeniden denenecek.'); }
  if (!response.ok) {
    const reason = await response.json().then(data => data.error, () => '');
    const error = new Error(response.status === 404 ? 'Eşleştirme süresi doldu. Yeni komut oluştur.' : reason === 'too many pairs' ? 'Bu bağlantıdan çok sayıda açık eşleştirme var. Eskilerini kaldır veya bir saat içinde yeniden dene.' : response.status === 429 ? 'Çok hızlı deneme. Birkaç saniye sonra yeniden dene.' : `Bağlantı hatası (${response.status}). Yerel sunucuyu kontrol et.`);
    error.status = response.status; error.reason = reason;
    throw error;
  }
  return response.json();
}
async function clipboard(text, fallback) {
  try { await navigator.clipboard.writeText(text); return true; } catch { fallback.hidden = false; fallback.focus(); fallback.select(); return false; }
}
function clearAudioNodes() { for (const n of nodes) { try { n.stop(); } catch {} } nodes = []; }
async function playSynth(notes) {
  synth ||= newAudioContext(); await synth.resume(); clearAudioNodes();
  const bus = synth.createGain(); synthBus = bus; bus.gain.value = Number($('volume').value) / 100; bus.connect(synth.destination);
  for (const [at, pitch, velocity, duration] of notes.slice(0, 60)) {
    const osc = synth.createOscillator(), gain = synth.createGain(), start = synth.currentTime + .03 + at / 1000;
    osc.type = 'sine'; osc.frequency.value = 440 * 2 ** ((pitch - 69) / 12);
    gain.gain.setValueAtTime(0, start); gain.gain.linearRampToValueAtTime(velocity / 127 * .12, start + .015); gain.gain.exponentialRampToValueAtTime(.0001, start + duration);
    osc.connect(gain).connect(bus); osc.start(start); osc.stop(start + duration + .05); nodes.push(osc);
  }
  setTimeout(() => bus.disconnect(), 15000);
}
export function stopPersonalAudio() { personalEnabled = false; clearAudioNodes(); if (demoTimer) clearTimeout(demoTimer); demoTimer = null; $('demo').textContent = 'Örnek kişisel ses'; }
export async function togglePersonalAudio() {
  personalEnabled = !personalEnabled;
  if (!personalEnabled) stopPersonalAudio();
  else { synth ||= newAudioContext(); await synth.resume(); soundTabs?.postMessage({ playing: true, id: personalTab }); }
  $('sound').textContent = personalEnabled ? 'Sesi durdur' : 'Sesi başlat';
}
$('volume').addEventListener('input', () => { if (synthBus && synth) synthBus.gain.setTargetAtTime(Number($('volume').value) / 100, synth.currentTime, .03); });
$('demo').onclick = async () => {
  if (demoTimer) { stopPersonalAudio(); $('mode-status').textContent = ''; return; }
  document.dispatchEvent(new Event('orchestra-pause'));
  try {
    personalEnabled = false;
    soundTabs?.postMessage({ playing: true, id: personalTab });
    await playSynth(personalNotes({ edit: 7, bash: 3, read: 5, think: 2, done: 1 }));
    $('demo').textContent = 'Örneği durdur'; $('mode-status').textContent = 'Yerel örnek · gerçek katılımcı veya çalışma anı değildir.';
    demoTimer = setTimeout(() => { stopPersonalAudio(); $('mode-status').textContent = ''; }, 12000);
  } catch { $('mode-status').textContent = 'Ses başlatılamadı. Tarayıcının ses iznini kontrol et.'; }
};
$('motion').ariaPressed = String(motionPaused); $('motion').textContent = motionPaused ? 'Hareketi başlat' : 'Hareketi durdur';
$('motion').onclick = () => { motionPaused = !motionPaused; $('motion').ariaPressed = String(motionPaused); $('motion').textContent = motionPaused ? 'Hareketi başlat' : 'Hareketi durdur'; };
$('mode').onchange = async () => {
  stopPersonalAudio();
  if (isPersonal()) {
    document.dispatchEvent(new Event('orchestra-pause'));
    personalEnabled = true;
    $('sound').disabled = false; $('sound').textContent = 'Sesi durdur';
    soundTabs?.postMessage({ playing: true, id: personalTab });
    $('mode-status').textContent = me?.connected ? 'Yeni faaliyetler yalnız kendi motifinde duyulur.' : 'Önce ajanını bağla. Yeni faaliyet geldiğinde kendi sesin çalar.';
    // Unlock on the gesture, so polling can play subsequent activity.
    try { synth ||= newAudioContext(); await synth.resume(); } catch {}
  } else $('mode-status').textContent = $('mode').value === 'mine' && !ownSeat ? 'Önce ajanını bağla; bağlanınca kendi katmanın öne çıkar.' : 'Ortak ses için Orkestrayı dinle düğmesine bas.';
};
// The pairing outlives a reload of this tab (it lives an hour on the server: a new one on every reload would use
// up an office's share of pairings).
const SAVED_PAIR = 'orchestra-pair';
function savePair() { try { if (token) sessionStorage.setItem(SAVED_PAIR, JSON.stringify({ token, command: $('command').value })); else sessionStorage.removeItem(SAVED_PAIR); } catch {} }
// The reader is one file from this site (Python 3 only): no repository, no install.
const readerCommand = fragment => `curl -fsSL ${location.origin}/reader.py -o reader.py && python3 reader.py '${location.origin}/${fragment}'`;
$('pair').onclick = async () => {
  $('pair').disabled = true;
  try {
    if (token) { try { await api('/api/unpair', { pair: token }); } catch (error) { if (error.status !== 404) throw error; } }
    const data = await api('/api/pair'); token = data.pair; me = null; baseline = {}; ownSeat = null;
    $('command').value = readerCommand(`#pair=${token}${EVENT ? `&event=${EVENT}` : ''}`);
    savePair();
    $('setup').hidden = false; $('personal').hidden = true; $('pair').textContent = 'Yeni bağlantı oluştur';
    $('personal-status').textContent = 'Komut hazır. Okuyucunun bağlanmasını bekliyor…';
    poll();
  } catch (error) {
    if (error.reason !== 'too many pairs') { $('personal-status').textContent = error.message; return; }
    // Every personal link of this network is taken: joining the common orchestra needs none.
    token = null; savePair();
    $('command').value = readerCommand(EVENT ? `#event=${EVENT}` : '');
    $('setup').hidden = false; $('personal').hidden = true;
    $('personal-status').textContent = 'Bu ağdan çok sayıda kişisel bağlantı açık. Yukarıdaki komutla ortak orkestraya yine katılırsın; koltuğun ve kendi sesin bu sayfada görünmez.';
  } finally { $('pair').disabled = false; }
};
try {
  const saved = JSON.parse(sessionStorage.getItem(SAVED_PAIR) || 'null');
  if (saved?.token) { token = saved.token; $('command').value = saved.command; $('setup').hidden = false; $('pair').textContent = 'Yeni bağlantı oluştur'; }
} catch {}
$('copy-command').onclick = async () => { const ok = await clipboard($('command').value, $('command')); $('personal-status').textContent = ok ? 'Komut kopyalandı. Repo Terminal’inde çalıştır.' : 'Otomatik kopyalama olmadı. Seçili komutu elle kopyala.'; };
$('unpair').onclick = async () => {
  $('unpair').disabled = true;
  try { await api('/api/unpair', { pair: token }); token = null; savePair(); me = null; ownSeat = null; stopPersonalAudio(); $('setup').hidden = true; $('personal').hidden = true; $('command').value = ''; $('personal-status').textContent = 'Eşleştirme kaldırıldı. Ortak katılımı da durdurmak için Terminal’de Ctrl+C.'; }
  catch (error) { $('personal-status').textContent = error.message; }
  finally { $('unpair').disabled = false; }
};
async function poll() {
  if (polling || !token || demoPlaying) return; polling = true; const requested = token;
  try {
    const data = await api('/api/me', { pair: requested });
    if (requested !== token) return;
    const difference = deltaActivity(data.activity, me?.activity);
    if (data.connected && !me?.connected) metric('connection');
    me = data; ownSeat = data.connected ? [data.section, data.seat] : null; ownPulseAt = data.lastActivity;
    $('personal').hidden = !data.connected;
    $('personal-status').textContent = data.waiting ? 'Okuyucunun bağlanması bekleniyor. Komutu Terminal’de çalıştır.' : !data.connected ? 'Bağlantı kesildi. Okuyucu ve sunucuyu kontrol et; yeniden bağlanınca güncellenir.' : data.steps ? 'Bağlı · kendi faaliyetlerin alınıyor.' : 'Bağlı · ilk yeni faaliyetini bekliyor. Ajanınla çalışmaya başla.';
    $('my-steps').textContent = num(data.steps);
    $('seat-label').textContent = data.connected ? `Senin koltuğun: ${SECTION_NAMES[data.section]} · ${data.seat + 1}. koltuk · ${data.sessions} oturum. Salondaki katmanın: ${LAYERS[data.section]}.` : '';
    $('activity-label').textContent = KINDS.map(k => `${data.activity[k]} ${labels[k]}`).join(' · ');
    if (isPersonal() && personalEnabled && data.connected && Object.values(difference).some(Boolean)) await playSynth(liveNotes(difference));
  } catch (error) {
    if (requested !== token || error.status === 429) return;   // a busy second: keep what is shown, ask again in two seconds
    if (error.status === 404) { token = null; savePair(); }   // expired: stop asking
    ownSeat = null; if (me) me.connected = false; $('personal').hidden = true; $('personal-status').textContent = error.message;
  } finally { polling = false; }
}
setInterval(poll, 2000);
poll();
// The share image: the title and the moment's own notes on a staff, so the picture is the sound.
async function drawMoment(title, notes, { personal, showCount, total, label }) {
  try { await Promise.all([document.fonts.load('300 66px Fraunces', title), document.fonts.load('500 18px "Instrument Sans"', 'ĞÜŞİÖÇ')]); } catch {}
  const c = $('moment-canvas').getContext('2d'), W = 1200, H = 630;
  const light = c.createRadialGradient(W * .72, H * .78, 20, W * .72, H * .78, 640);
  light.addColorStop(0, '#2b1f10'); light.addColorStop(1, '#0b0907');
  c.fillStyle = light; c.fillRect(0, 0, W, H);
  c.fillStyle = '#e6b45a'; c.font = '600 16px "Instrument Sans", system-ui, sans-serif'; c.letterSpacing = '3px';
  c.fillText(`${t(personal ? 'KENDİ ÇALIŞMA ANIM' : label === 'DEMO' ? 'DEMO KONSERİNDEN BİR AN' : 'ORTAK ORKESTRADAN BİR AN')}  ·  AGENT ORCHESTRA`, 64, 84);
  c.letterSpacing = '0px';
  c.fillStyle = '#f3e9d6'; c.font = '300 66px Fraunces, Georgia, serif';
  const lines = []; let line = '';
  for (const word of title.split(' ')) { const next = line ? `${line} ${word}` : word; if (c.measureText(next).width > 1072 && line) { lines.push(line); line = word; } else line = next; }
  lines.push(line);
  lines.slice(0, 2).forEach((text, i) => c.fillText(text, 64, 182 + i * 74, 1072));
  const box = { left: 64, right: 1136, top: 352, bottom: 472 };
  c.strokeStyle = 'rgba(230, 180, 90, .28)'; c.lineWidth = 1;
  for (let i = 0; i < 5; i++) { const y = Math.round(box.top + 12 + i * ((box.bottom - box.top - 24) / 4)) + .5; c.beginPath(); c.moveTo(box.left, y); c.lineTo(box.right, y); c.stroke(); }
  c.fillStyle = '#e6b45a';
  for (const mark of momentLayout(notes, box)) {
    c.globalAlpha = .3 + .5 * mark.strength; c.fillRect(mark.x, mark.y - 1, mark.length, 2);
    c.globalAlpha = .55 + .45 * mark.strength; c.beginPath(); c.ellipse(mark.x, mark.y, 7, 5, -.35, 0, Math.PI * 2); c.fill();
  }
  c.globalAlpha = 1;
  c.fillStyle = '#b3a58f'; c.font = '400 20px "Instrument Sans", system-ui, sans-serif';
  c.fillText(t(personal ? (showCount ? `${total} gerçek adım · adım sayılarından üretilen müzik` : 'Gerçek adımlardan üretilen müzik') : label === 'DEMO' ? 'Demo konserinden 12 saniye · makineler simüle edilmiştir' : label === 'TEST' ? 'Test salonundan 12 saniye · simülasyon içerir' : 'Ortak orkestranın 12 saniyesi · anonim'), 64, 534);
  c.fillStyle = '#f3e9d6'; c.font = '400 24px Fraunces, Georgia, serif'; c.fillText('Agent Orchestra', 64, 588);
  c.textAlign = 'right'; c.fillStyle = '#b3a58f'; c.font = '400 17px "Instrument Sans", system-ui, sans-serif'; c.fillText(t('DijitalPi tarafından geliştirildi'), 1136, 588); c.textAlign = 'left';
}
function revokeMoment() {
  revision++; if (recordingCleanup) recordingCleanup(true);
  if (moment) for (const u of moment.urls) URL.revokeObjectURL(u);
  moment = null; $('moment-audio').pause(); $('moment-video').pause(); $('moment-audio').removeAttribute('src'); $('moment-audio').load(); $('moment-video').removeAttribute('src'); $('moment-video').load(); $('preview').hidden = true; $('moment-video').hidden = true; $('download-video').hidden = true;
}
$('create-moment').onclick = async () => {
  const personal = $('capture-kind').value === 'personal';
  const counts = deltaActivity(me?.activity || {}, baseline);
  if (personal && (!me?.connected || !Object.values(counts).some(Boolean))) { $('moment-status').textContent = 'Yeni gerçek faaliyet yok. Ajanını bağla ve son anından sonra yeni bir adım bekle.'; return; }
  const common = captureCommon(recent, Date.now());
  if (!personal && !common.notes.length) { $('moment-status').textContent = 'Ortak nota henüz alınmadı. Salona bağlan ve birkaç saniye bekle.'; return; }
  $('create-moment').disabled = true;
  try {
    revokeMoment(); const current = revision;
    const notes = personal ? personalNotes(counts) : common.notes;
    const label = personal ? '' : common.label, simulated = Boolean(label);
    // The hall's own samples and reverb, rendered here; the plain synthesis only when the listener
    // chose the simple timbre (no downloads) or the samples cannot load.
    let bytes = null, sampled = false;
    if (document.body.dataset.sound !== 'simple') {
      $('moment-status').textContent = 'Ses salonun örnekleriyle hazırlanıyor…';
      const slow = new Promise((_, reject) => setTimeout(() => reject(new Error('slow')), 20000));   // a slow network falls back
      try { bytes = wavFromChannels(await Promise.race([renderWithSamples(notes), slow]), 44100); sampled = true; } catch {}
      if (current !== revision) return;
    }
    bytes ||= wavBytes(notes);
    const wav = new Blob([bytes], { type: 'audio/wav' }), title = (simulated ? `${label} · ` : '') + ($('moment-title-input').value.trim() || t('Bugünkü çalışmanın sesi'));
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    await drawMoment(title, notes, { personal, showCount: $('show-count').checked, total, label });
    const png = await new Promise(resolve => $('moment-canvas').toBlob(resolve, 'image/png'));
    if (!png) throw new Error('Görsel oluşturulamadı. Yeniden dene.');
    if (current !== revision) return;
    const wavUrl = URL.createObjectURL(wav), pngUrl = URL.createObjectURL(png);
    moment = { bytes, notes, total, personal, simulated, label, urls: [wavUrl, pngUrl] };
    $('moment-audio').src = wavUrl; $('download-wav').href = wavUrl; $('download-png').href = pngUrl;
    $('visible-info').textContent = `Görünür bilgi: “${title}”, ${personal ? 'kişisel faaliyet yorumu' : simulated ? (label === 'DEMO' ? 'demo konserinden simüle an' : 'simülasyon içeren ortak test anı') : 'anonim ortak an'}, ${personal && $('show-count').checked ? 'faaliyet sayısı, ' : ''}DijitalPi imzası. Makine kimliği, anahtar, kod veya prompt yok.`;
    $('preview').hidden = false;
    $('moment-status').textContent = sampled ? 'Anın hazır. Ses salondaki enstrüman örnekleriyle üretildi.' : 'Anın hazır. Ses sade bir sentez yorumudur; salondaki örnekler kullanılmadı.';
    if (personal) baseline = { ...me.activity };
    metric('moment');
  } catch (error) { $('moment-status').textContent = error.message || 'An oluşturulamadı. Yeniden dene.'; }
  finally { $('create-moment').disabled = false; }
};
$('clear-moment').onclick = () => { revokeMoment(); $('moment-status').textContent = 'Tarayıcıdaki an silindi. Yeni bir an oluşturabilirsin.'; };
let previewRevision = 0;
async function refreshVisibleInfo() {
  if (!moment || recorder) return;
  const active = moment, current = ++previewRevision;
  const title = (active.simulated ? `${active.label} · ` : '') + ($('moment-title-input').value.trim() || t('Bugünkü çalışmanın sesi'));
  await drawMoment(title, active.notes, { personal: active.personal, showCount: $('show-count').checked, total: active.total, label: active.simulated ? active.label : '' });
  const png = await new Promise(resolve => $('moment-canvas').toBlob(resolve, 'image/png'));
  if (!png || current !== previewRevision || moment !== active) return;
  URL.revokeObjectURL(active.urls[1]); active.urls[1] = URL.createObjectURL(png); $('download-png').href = active.urls[1];
  $('visible-info').textContent = `Görünür bilgi: “${title}”, ${active.personal ? 'kişisel faaliyet yorumu' : active.simulated ? (active.label === 'DEMO' ? 'demo konserinden simüle an' : 'simülasyon içeren ortak test anı') : 'anonim ortak an'}, ${active.personal && $('show-count').checked ? 'faaliyet sayısı, ' : ''}DijitalPi imzası. Özel kimlik, anahtar, kod veya prompt yok.`;
  $('moment-video').pause(); $('moment-video').removeAttribute('src'); $('moment-video').hidden = true; $('download-video').hidden = true;
  for (const u of active.urls.splice(2)) URL.revokeObjectURL(u);
  $('moment-status').textContent = 'Görsel ve görünür bilgiler güncellendi. Ses aynı faaliyet anını koruyor; yeni video oluşturabilirsin.';
}
$('moment-title-input').addEventListener('change', refreshVisibleInfo);
$('show-count').addEventListener('change', refreshVisibleInfo);
$('video').onclick = async () => {
  if (!moment || recordingCleanup) return;
  if (window.VideoEncoder && window.AudioEncoder) {
    const active = moment, current = revision, controller = new AbortController();
    const cancel = () => { controller.abort(); $('moment-status').textContent = 'Video oluşturma iptal edildi. PNG ve WAV hazır.'; };
    recordingCleanup = cancel;
    for (const id of ['video', 'create-moment', 'moment-title-input', 'show-count', 'capture-kind']) $(id).disabled = true;
    $('cancel-video').hidden = false;
    try {
      const { encodeVideo } = await import('./video.js');
      const blob = await encodeVideo($('moment-canvas'), active.bytes, controller.signal, percent => { if (!controller.signal.aborted && moment === active) $('moment-status').textContent = `Sesli video oluşturuluyor · %${percent}`; });
      if (controller.signal.aborted || current !== revision || moment !== active) return;
      const url = URL.createObjectURL(blob); active.urls.push(url); $('moment-video').src = url; $('moment-video').hidden = false;
      $('download-video').href = url; $('download-video').download = 'calisma-anim.webm'; $('download-video').hidden = false;
      $('moment-status').textContent = 'Sesli video hazır. Önizleyip dosyayı indirebilirsin.'; metric('video');
    } catch (error) { if (!controller.signal.aborted) $('moment-status').textContent = error.message || 'Video oluşturulamadı. WAV ve PNG dosyaları hazır.'; }
    finally {
      if (recordingCleanup === cancel) recordingCleanup = null;
      for (const id of ['video', 'create-moment', 'moment-title-input', 'show-count', 'capture-kind']) $(id).disabled = false;
      $('cancel-video').hidden = true;
    }
    return;
  }
  if (!window.MediaRecorder || !$('moment-canvas').captureStream) { $('moment-status').textContent = 'Bu cihaz video oluşturmayı desteklemiyor. WAV ve PNG dosyalarını indir.'; return; }
  $('video').disabled = true; $('create-moment').disabled = true; $('cancel-video').hidden = false;
  for (const id of ['moment-title-input', 'show-count', 'capture-kind']) $(id).disabled = true;
  const current = revision, active = moment;
  let ctx, source, stream, timer, frames, localRecorder, cancelled = false, released = false;
  const release = () => {
    if (released) return; released = true;
    clearTimeout(timer); clearInterval(frames);
    try { source?.stop(); } catch {}
    stream?.getTracks().forEach(t => t.stop()); ctx?.close();
    if (recorder === localRecorder) recorder = null;
    if (recordingCleanup === cancel) {
      recordingCleanup = null; $('video').disabled = false; $('create-moment').disabled = false; $('cancel-video').hidden = true;
      for (const id of ['moment-title-input', 'show-count', 'capture-kind']) $(id).disabled = false;
    }
  };
  const cancel = () => {
    cancelled = true;
    if (localRecorder?.state === 'recording') localRecorder.stop();
    release();
    $('moment-status').textContent = 'Video oluşturma iptal edildi. PNG ve WAV hazır.';
  };
  recordingCleanup = cancel;
  try {
    document.dispatchEvent(new Event('orchestra-pause')); stopPersonalAudio(); $('moment-audio').pause();
    ctx = newAudioContext(); await ctx.resume();
    const buffer = await ctx.decodeAudioData(active.bytes.slice(0));
    if (cancelled || current !== revision || moment !== active) { release(); return; }
    const destination = ctx.createMediaStreamDestination(); source = ctx.createBufferSource(); source.buffer = buffer; source.connect(destination);
    stream = $('moment-canvas').captureStream(0);
    const track = stream.getVideoTracks()[0];
    if (!track?.requestFrame) throw new Error('Bu cihaz video karelerini kaydedemiyor. WAV ve PNG kullan.');
    destination.stream.getAudioTracks().forEach(t => stream.addTrack(t));
    const mime = ['video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4'].find(t => MediaRecorder.isTypeSupported(t));
    if (!mime) throw new Error('Bu cihazın video biçimi desteklenmiyor. WAV ve PNG kullan.');
    const chunks = [];
    localRecorder = new MediaRecorder(stream, { mimeType: mime }); recorder = localRecorder;
    localRecorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
    localRecorder.onerror = () => { cancelled = true; release(); $('moment-status').textContent = 'Video kaydı başarısız. WAV ve PNG hazır.'; };
    localRecorder.onstop = () => {
      release();
      if (cancelled || current !== revision || moment !== active) return;
      const blob = new Blob(chunks, { type: mime });
      if (blob.size < 2000) { $('moment-status').textContent = 'Video kareleri kaydedilemedi. WAV ve PNG dosyalarını kullan veya yeniden dene.'; return; }
      const url = URL.createObjectURL(blob); active.urls.push(url);
      $('moment-video').src = url; $('moment-video').hidden = false; $('download-video').href = url; $('download-video').download = mime.includes('mp4') ? 'calisma-anim.mp4' : 'calisma-anim.webm'; $('download-video').hidden = false;
      $('moment-status').textContent = 'Sesli video hazır. Önizleyip dosyayı indirebilirsin.'; metric('video');
    };
    localRecorder.start(250); track.requestFrame();
    frames = setInterval(() => track.requestFrame(), 100);
    source.start(); $('moment-status').textContent = '12 saniyelik sesli video oluşturuluyor…';
    timer = setTimeout(() => { if (localRecorder.state === 'recording') localRecorder.stop(); }, 12200);
  } catch (error) { cancelled = true; release(); $('moment-status').textContent = error.message || 'Video oluşturulamadı. WAV ve PNG dosyaları hazır.'; }
};
$('cancel-video').onclick = () => recordingCleanup?.(true);
$('invite').onclick = async () => { const url = publicInvite(location.href); $('invite-url').value = url; const copied = await clipboard(url, $('invite-url')); $('invite-status').textContent = copied ? 'Davet bağlantısı kopyalandı.' : 'Bağlantıyı aşağıdan elle kopyalayabilirsin.'; metric('invite'); };
$('contact').addEventListener('click', () => metric('brand'));
addEventListener('pagehide', () => { stopPersonalAudio(); revokeMoment(); soundTabs?.close(); synth?.close(); });
