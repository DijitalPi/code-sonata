import { receiveFrame, ownSeat, ownPulseAt, motionPaused, isPersonal, stopPersonalAudio, togglePersonalAudio, metric } from './experience.js';
// Agent Orchestra listener: draws the hall and plays the conductor's notes in sync.
const SECTIONS = ["piano", "strings", "choir", "cello", "flute", "vibraphone", "horn", "harp", "accordion"];
// Stereo position from the real seating plan (violins left, cellos right).
const PAN = { strings: -.7, harp: -.6, piano: -.1, accordion: .15, flute: 0, horn: .1, choir: 0, vibraphone: .6, cello: .7 };
// One warm family under stage light: distinguishable sections, no rainbow.
const COLORS = { piano: "#f3e9d6", strings: "#e6b45a", choir: "#c9a7d8", cello: "#d9785a", flute: "#8cc9b5", vibraphone: "#93b4d6", horn: "#f0cc7a", harp: "#e8a1a6", accordion: "#d96a5e" };
// Engine voices by index (10 = drums, synthesized; 11 = accordion, section 8).
const SOUNDFONT = ["acoustic_grand_piano", "string_ensemble_1", "choir_aahs", "cello", "flute", "vibraphone", "french_horn", "orchestral_harp", "timpani", "tremolo_strings", null, "accordion"];
const VOICE_SECTION = { 11: "accordion" };
const $ = (id) => document.getElementById(id);

// ---------- state from the server ----------
let seats = SECTIONS.map(() => []);      // section -> [[sessions, country] or 0]
let you = null;                          // {cc, team}
let leader = null, soloAt = 0, ranks = [];
const countryName = (() => { try { const d = new Intl.DisplayNames(["tr"], { type: "region" }); return (cc) => d.of(cc) || cc; } catch { return (cc) => cc; } })();
const flag = (cc) => (cc && cc.length === 2 ? String.fromCodePoint(...[...cc].map((c) => 0x1f1a5 + c.charCodeAt(0))) : "");
const glow = new Map();                  // "s:i" -> 0..1
let info = { bpm: 64, intensity: 0, climax: false, song: "", working: 0 };
const offsets = [];
let offset = 0;                          // serverTime - localTime (best estimate)

function showCountries(frame) {
  $("countries").textContent = (frame.countryCount || 0).toLocaleString();
}

function leagueList(id, rows, value) {
  const list = $(id);
  list.replaceChildren();
  if (!rows.length) {
    const li = document.createElement("li");
    li.textContent = "Henüz nota yok";
    list.append(li);
    return;
  }
  rows.forEach((r, i) => {
    const li = document.createElement("li");
    const name = document.createElement("span"), score = document.createElement("b");
    name.textContent = `${i + 1}. ${flag(r.cc)} ${countryName(r.cc)}`;
    score.textContent = value(r);
    if (you && you.cc === r.cc) li.className = "mine";
    li.append(name, score);
    list.append(li);
  });
}

let lastLeague = "";
function showLeague(lg) {
  const key = JSON.stringify([lg, you && you.cc, ranks.indexOf(you && you.cc)]);
  if (key === lastLeague) return;
  lastLeague = key;
  leagueList("total", lg.total, (r) => r.score.toLocaleString());
  leagueList("passion", lg.passion, (r) => r.perPlayer.toLocaleString());
  const mine = $("mine");
  if (you && you.cc) {
    const rank = ranks.indexOf(you.cc);
    mine.textContent = `Ülken: ${flag(you.cc)} ${rank >= 0 ? `#${rank + 1}` : "henüz notası yok"}`;
  } else mine.textContent = "";
}

let announceTimer = 0;
function announce({ cc }) {
  const box = $("announce");
  box.textContent = `${flag(cc)} ${countryName(cc)} öne geçti!`;
  box.classList.add("show");
  clearTimeout(announceTimer);
  announceTimer = setTimeout(() => box.classList.remove("show"), 4000);
}

function ago(t) {
  const min = Math.round((Date.now() + offset - t) / 60000);
  return min < 1 ? "az önce" : min < 60 ? `${min} dk önce` : `${Math.round(min / 60)} saat önce`;
}

let lastNow = "";
function showNow(frame) {
  const key = `${frame.working}|${frame.players}|${frame.song}|${frame.bpm}|${frame.climax}|${Math.round(frame.intensity * 20)}|${frame.house}|${frame.lastActive && ago(frame.lastActive)}|${frame.peak}`;
  if (key === lastNow) return;
  lastNow = key;
  const now = $("now");
  now.replaceChildren();
  if (!frame.working) {
    // Empty hall: the house pianist plays; say so plainly, with when an agent last played.
    const parts = [frame.house ? `Salon sakin. Salon piyanisti ${frame.song} çalıyor; gerçek ajan faaliyeti bekleniyor.` : "İlk ajan faaliyeti bekleniyor."];
    if (frame.lastActive) parts.push(`Son faaliyet ${ago(frame.lastActive)}.`);
    if (frame.peak) parts.push(`Bugünün zirvesi: ${frame.peak.toLocaleString()} makine.`);
    now.textContent = parts.join(" ");
    return;
  }
  const song = document.createElement("strong");
  song.textContent = frame.song;
  now.append("Şimdi ", song, ` · ${frame.bpm} BPM`);
  if (frame.climax) {
    const climax = document.createElement("strong");
    climax.textContent = "doruk";
    now.append(" · ", climax);
  }
  const heat = document.createElement("span"), bar = document.createElement("i");
  heat.className = "heat";
  bar.style.width = `${Math.round(frame.intensity * 100)}%`;
  heat.append(bar);
  now.append(heat);
}

const TEAM_NAMES = { claude: "Claude Code", codex: "Codex", other: "Diğer", listen: "Dinleyiciler" };
const TOOL_NAMES = { claude: "Claude Code", codex: "Codex", other: "other tools" };
let team = "listen";
try { team = localStorage.getItem("team") || "listen"; } catch {}
let teams = { agents: {}, fans: {} };
const waves = {};                        // team -> wave start (ms)
let stream = null;

function connect() {
  if (stream) stream.close();
  stream = new EventSource(`/api/stream?team=${encodeURIComponent(team)}`);
  stream.onmessage = onFrame;
  stream.onopen = () => { $("connection").textContent = "Canlı salona bağlı"; };
  stream.onerror = () => {
    $("connection").textContent = "Bağlantı kesildi · yeniden bağlanıyor…";
    for (const id of ["claudes", "players", "listeners", "countries"]) $(id).textContent = "—";
    $("now").textContent = "Canlı bilgi alınamıyor. Bağlantı geldiğinde salon güncellenecek.";
    lastNow = ""; offsets.length = 0;
    seats = SECTIONS.map(() => []); teams = { agents: {}, fans: {} }; glow.clear(); version++;
  };
}

function onFrame(event) {
  const frame = JSON.parse(event.data);
  receiveFrame(frame);
  offsets.push(frame.t - Date.now());
  if (offsets.length > 40) offsets.shift();
  offset = Math.max(...offsets);         // least delayed sample
  if (frame.seats) { seats = frame.seats; version++; }
  if (frame.seatDelta) {                  // only the seats that changed since the last frame
    for (const [s, i, entry] of frame.seatDelta) (seats[s] ||= [])[i] = entry;
    version++;
  }
  if (frame.you) you = frame.you;
  if (frame.countries) showCountries(frame);
  if (frame.teams) teams = frame.teams;
  if (frame.league) { leader = frame.league.leader; showLeague(frame.league); }
  if (frame.ranks) ranks = frame.ranks;
  if (frame.solo) soloAt = frame.solo;
  if (frame.announce) announce(frame.announce);
  for (const t of frame.cheers || []) waves[t] = performance.now();
  for (const [s, i] of frame.pulses || []) glow.set(`${s}:${i}`, 1);
  if (frame.players !== undefined) {
    info = frame;
    $("connection").textContent = frame.simulated || frame.simulatedListeners ? `Test salonu · ${frame.simulated} simülasyon makinesi / ${frame.simulatedListeners || 0} test dinleyicisi / ${frame.players - frame.simulated} gerçek makine` : "Canlı salona bağlı";
    $("claudes").textContent = frame.claudes.toLocaleString();
    $("players").textContent = frame.players.toLocaleString();
    $("listeners").textContent = frame.listeners.toLocaleString();
    showNow(frame);
  }
  if (frame.notes?.length) { scoreNotes.push(...frame.notes); if (scoreNotes.length > 900) scoreNotes.splice(0, scoreNotes.length - 900); }
  if (frame.players !== undefined) { document.body.classList.toggle("is-climax", Boolean(frame.climax)); }
  if (audio && !isPersonal()) for (const note of frame.notes || []) schedule(note);
}
connect();
if (location.hash === "#tv") $("enter").classList.add("hidden");   // wall display: watch only, no sound

// ---------- audio ----------
let audio = null;

// Mix: the melody instruments sit in front, sustained pads further back. Gentle bus
// compression only (hard compression made everything pump together).
const VOLUME = [100, 78, 72, 92, 92, 74, 82, 82, 88, 70, 0, 88];

// One tab plays at a time: a second tab that starts sound quiets the first.
const tabs = "BroadcastChannel" in window ? new BroadcastChannel("agent-orchestra-audio") : null;
const tabId = Math.random().toString(36).slice(2);
if (tabs) tabs.onmessage = (event) => {
  if (event.data?.playing && event.data.id !== tabId && audio && audio.ctx.state === "running") {
    audio.ctx.suspend();
    $("loading").textContent = "Ses başka sekmede. Burada dinlemek için tekrar başlat.";
    document.querySelectorAll("[data-team]").forEach((b) => { b.disabled = false; });
    $("enter").classList.remove("hidden");
  }
};

async function startAudio() {
  if (audio?.simple) { await audio.ctx.close(); audio = null; }
  if (audio?.ready) {                         // coming back from another tab
    await audio.ctx.resume();
    tabs?.postMessage({ playing: true, id: tabId });
    return;
  }
  const ctx = new AudioContext();
  const master = ctx.createDynamicsCompressor();
  master.threshold.value = -20; master.knee.value = 12; master.ratio.value = 2.5;
  master.attack.value = .01; master.release.value = .25;
  // Measured offline: the mix peaked at -17 dBFS (too quiet). +9 dB makeup, then a limiter
  // so a full orchestra can never clip.
  const out = ctx.createGain(); out.gain.value = 2.4 * Number($("volume").value) / 100;
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -3; limiter.knee.value = 0; limiter.ratio.value = 20;
  limiter.attack.value = .002; limiter.release.value = .1;
  master.connect(out).connect(limiter).connect(ctx.destination);
  tabs?.postMessage({ playing: true, id: tabId });
  audio = { ctx, master, out, ready: false, voices: [], drums: drumKit(ctx, master) };
  let Soundfont;
  try { ({ Soundfont } = await Promise.race([import("https://cdn.jsdelivr.net/npm/smplr@1.1.0/+esm"), new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 15000))])); }
  catch (error) { await ctx.close(); audio = null; throw error; }
  // Piano first so the hall is audible quickly; the rest load behind it.
  for (const [i, name] of SOUNDFONT.entries()) {
    if (!name) continue;
    const section = VOICE_SECTION[i] || (i < 8 ? SECTIONS[i] : null);
    const pan = PAN[section] ?? 0;
    const voice = Soundfont(ctx, { instrument: name, kit: "FluidR3_GM", destination: master, pan, volume: VOLUME[i] });
    audio.voices[i] = null;
    voice.ready.then(() => { audio.voices[i] = voice; }).catch(() => {});
    if (i === 0) { $("loading").textContent = "Piyano hazırlanıyor…"; await Promise.race([voice.ready, new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 15000))]); }
  }
  audio.ready = true;
}

async function startSimpleAudio() {
  if (audio) await audio.ctx.close();
  const ctx = new AudioContext(), master = ctx.createGain(), out = ctx.createGain();
  master.gain.value = .45; out.gain.value = 2.4 * Number($("volume").value) / 100;
  const limiter = ctx.createDynamicsCompressor(); limiter.threshold.value = -6; limiter.ratio.value = 12;
  master.connect(out).connect(limiter).connect(ctx.destination);
  const voices = SOUNDFONT.map(() => ({ start({ note, velocity, time, duration }) {
    const osc = ctx.createOscillator(), gain = ctx.createGain();
    osc.type = "triangle"; osc.frequency.value = 440 * 2 ** ((note - 69) / 12);
    const end = time + Math.min(3, duration);
    gain.gain.setValueAtTime(.0001, time); gain.gain.linearRampToValueAtTime(velocity / 127 * .13, time + .015);
    gain.gain.exponentialRampToValueAtTime(.0001, Math.max(time + .03, end));
    osc.connect(gain).connect(master); osc.start(time); osc.stop(end + .05);
    osc.onended = () => { osc.disconnect(); gain.disconnect(); };
  } }));
  audio = { ctx, master, out, voices, ready: true, simple: true, drums: drumKit(ctx, master) };
  await ctx.resume(); tabs?.postMessage({ playing: true, id: tabId });
}

function schedule([at, pitch, velocity, duration, voice]) {
  const { ctx } = audio;
  if (ctx.state !== "running") return;
  const delay = (at - offset - Date.now()) / 1000;
  if (delay < -.05) return;              // too late for this one
  const time = ctx.currentTime + Math.max(0, delay);
  if (voice === 10) return audio.drums(pitch, velocity / 127, time);
  const instrument = audio.voices[voice];
  if (instrument) instrument.start({ note: pitch, velocity, time, duration });
}

function drumKit(ctx, out) {
  const noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
  const data = noise.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  const burst = (time, length, gain, type, freq) => {
    const src = ctx.createBufferSource(); src.buffer = noise;
    const filter = ctx.createBiquadFilter(); filter.type = type; filter.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, time); g.gain.exponentialRampToValueAtTime(.001, time + length);
    src.connect(filter).connect(g).connect(out); src.start(time); src.stop(time + length);
  };
  return (pitch, level, time) => {
    if (pitch === 36) {                   // kick: falling sine
      const osc = ctx.createOscillator(), g = ctx.createGain();
      osc.frequency.setValueAtTime(120, time); osc.frequency.exponentialRampToValueAtTime(42, time + .15);
      g.gain.setValueAtTime(level * 1.2, time); g.gain.exponentialRampToValueAtTime(.001, time + .35);
      osc.connect(g).connect(out); osc.start(time); osc.stop(time + .4);
    } else if (pitch === 38) burst(time, .18, level * .7, "bandpass", 1800);
    else if (pitch === 42) burst(time, .04, level * .16, "highpass", 8000);
    else if (pitch === 46) burst(time, .16, level * .16, "highpass", 7000);
    else if (pitch === 49) burst(time, 2.2, level * .45, "highpass", 4500);
  };
}

for (const button of document.querySelectorAll("[data-team]")) {
  button.addEventListener("click", async () => {
    stopPersonalAudio(); $("mode").value = "common"; $("mode-status").textContent = "";
    team = button.dataset.team;
    try { localStorage.setItem("team", team); } catch {}
    connect();                            // take a seat in the chosen stand
    document.querySelectorAll("[data-team]").forEach((b) => { b.disabled = true; });
    $("simple-sound").disabled = true; $("demo").disabled = true; $("mode").disabled = true; $("sound").disabled = true;
    $("loading").textContent = "Ses yükleniyor…";
    try {
      await startAudio();
      $("loading").textContent = "Orkestra çalıyor. Ses ve hareketi aşağıdan kontrol edebilirsin.";
      $("sound").disabled = false; $("sound").textContent = "Sesi durdur";
      document.querySelectorAll("[data-team]").forEach(b => { b.disabled = false; b.textContent = "Orkestrayı dinle"; });
      metric("listen");
    } catch (error) {
      document.querySelectorAll("[data-team]").forEach((b) => { b.disabled = false; });
      if (audio) { await audio.ctx.close(); audio = null; }
      $("loading").textContent = "Ses yüklenemedi. İnternet bağlantını kontrol edip yeniden dene veya yerel örneği keşfet.";
    } finally {
      $("simple-sound").disabled = false; $("demo").disabled = false; $("mode").disabled = false;
    }
  });
}

// ---------- hall ----------
const canvas = $("hall"), g = canvas.getContext("2d");
let width = 0, height = 0, dpr = 1, version = 0, cached = null;
const flagCache = new Map();
function resize() {
  dpr = Math.min(2, devicePixelRatio || 1);
  width = canvas.clientWidth; height = canvas.clientHeight;
  canvas.width = width * dpr; canvas.height = height * dpr;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  cached = null;
  flagCache.clear();
}
addEventListener("resize", resize);
new ResizeObserver(resize).observe(canvas);
resize();

// Flag emoji rendered once per size into a small bitmap; drawing hundreds per frame stays cheap.
function flagImage(cc, px) {
  const size = Math.max(6, Math.round(px));
  const key = `${cc}:${size}`;
  let img = flagCache.get(key);
  if (!img) {
    img = document.createElement("canvas");
    img.width = img.height = size * dpr;
    const c = img.getContext("2d");
    c.scale(dpr, dpr); c.font = `${size * .9}px system-ui`; c.textAlign = "center"; c.textBaseline = "middle";
    c.fillText(flag(cc), size / 2, size / 2 + size * .06);
    if (flagCache.size > 3000) flagCache.clear();
    flagCache.set(key, img);
  }
  return img;
}

// A real symphony seating plan, seen from the audience. Angles in degrees: 0 = straight
// back, -90 = far left, +90 = far right. Bands are fractions of the stage radius.
const REGIONS = {
  piano:      { band: [.08, .28], arc: [-15, -1], label: "piyano" },
  accordion:  { band: [.08, .28], arc: [1, 15], label: "akordeon" },
  strings:    { band: [.16, .54], arc: [-86, -17], label: "yaylılar" },
  cello:      { band: [.16, .54], arc: [17, 86], label: "çello" },
  flute:      { band: [.56, .70], arc: [-30, 30], label: "flüt" },
  harp:       { band: [.56, .86], arc: [-86, -34], label: "arp" },
  vibraphone: { band: [.56, .86], arc: [34, 86], label: "perküsyon" },
  horn:       { band: [.72, .86], arc: [-30, 30], label: "korno" },
  choir:      { band: [.89, 1.0], arc: [-72, 72], label: "koro" },
};
// Teams in the strip under the stage, left to right.
const BLOCKS = ["claude", "listen", "codex", "other"];
const BLOCK_COLORS = { claude: "#d9785a", codex: "#6fb8a0", other: "#a99bd6", listen: "#e6b45a" };
const rad = (d) => (d * Math.PI) / 180;

// Fill a wedge row by row from the front; null if it does not fit at this spacing.
function fillWedge(n, r0, r1, a0, a1, spacing, point) {
  const out = [];
  for (let r = r0 + spacing / 2; out.length < n; r += spacing) {
    if (r > r1) return null;
    const perRow = Math.max(1, Math.floor((r * rad(a1 - a0)) / spacing));
    const take = Math.min(perRow, n - out.length);
    for (let k = 0; k < take; k++) {
      const along = (k + .5 + (perRow - take) / 2) / perRow;
      out.push({ ...point(r, a0 + (a1 - a0) * along), along });
    }
  }
  return out;
}

// Every chair of a wedge at a fixed spacing: the empty orchestra still shows its seating plan.
function wedgePoints(r0, r1, a0, a1, spacing, point) {
  const out = [];
  for (let r = r0 + spacing / 2; r <= r1; r += spacing) {
    const perRow = Math.max(1, Math.floor((r * rad(a1 - a0)) / spacing));
    for (let k = 0; k < perRow; k++) out.push(point(r, a0 + ((a1 - a0) * (k + .5)) / perRow));
  }
  return out;
}

function fit(build, start = 26) {
  for (let spacing = start; spacing > 2.4; spacing *= .92) {
    const result = build(spacing);
    if (result) return { ...result, spacing };
  }
  return { ...build(2.4, true), spacing: 2.4 };
}

function geometry() {
  if (cached && cached.version === version) return cached;
  const cx = width / 2, cy = height - Math.max(104, height * .14);   // the audience needs ~104 px below the stage
  const R = Math.min(width * .42, height * .6);
  const stagePoint = (r, a) => ({ x: cx + Math.sin(rad(a)) * r, y: cy - Math.cos(rad(a)) * r });
  // Each section fills its own region (a lone harpist gets a big chair, violins pack tight).
  // Few people: big flags. A crowd: they shrink to fit.
  const biggest = Math.max(18, Math.min(44, R * .075));
  const stage = { sections: {}, spacing: {} };
  for (const [name, reg] of Object.entries(REGIONS)) {
    const n = (seats[SECTIONS.indexOf(name)] || []).length;
    const one = fit((spacing, force) => {
      const pts = fillWedge(n, reg.band[0] * R, force ? 1e9 : reg.band[1] * R, reg.arc[0], reg.arc[1], spacing, stagePoint);
      return pts && { pts };
    }, biggest);
    stage.sections[name] = one.pts;
    stage.spacing[name] = one.spacing;
  }
  // Same country sits together inside each section: biggest delegation first.
  const order = {};
  for (const name of Object.keys(REGIONS)) {
    const list = seats[SECTIONS.indexOf(name)] || [];
    const size = new Map();
    for (const e of list) if (e) size.set(e[1], (size.get(e[1]) || 0) + 1);
    const idx = list.map((_, i) => i).sort((a, b) => {
      const ca = list[a] ? list[a][1] : "~", cb = list[b] ? list[b][1] : "~";
      return (size.get(cb) || 0) - (size.get(ca) || 0) || ca.localeCompare(cb) || a - b;
    });
    order[name] = []; idx.forEach((seat, pos) => { order[name][seat] = pos; });
  }
  const chairs = {}, chairSpacing = Math.max(11, R * .055);
  for (const [name, reg] of Object.entries(REGIONS)) chairs[name] = wedgePoints(reg.band[0] * R, reg.band[1] * R, reg.arc[0], reg.arc[1], chairSpacing, stagePoint);
  cached = { version, cx, cy, R, stage, order, chairs };
  return cached;
}

let last = performance.now();
function frame(now) {
  if (now - last < 32) { requestAnimationFrame(frame); return; }   // ~30 fps is plenty for this
  const dt = motionPaused ? 0 : Math.min(.1, (now - last) / 1000); last = now;
  const G = geometry();
  const { cx, cy, R } = G;
  g.clearRect(0, 0, width, height);
  // Stage: a quiet outline only (a full-screen gradient every frame was heavy and loud).
  g.fillStyle = "rgba(244, 234, 216, .025)";
  g.beginPath(); g.moveTo(cx, cy); g.arc(cx, cy, R * 1.05, rad(-182), rad(2)); g.closePath(); g.fill();
  g.strokeStyle = info.climax ? "rgba(232, 182, 90, .45)" : "rgba(244, 234, 216, .12)"; g.lineWidth = 1;
  g.beginPath(); g.arc(cx, cy, R * 1.05, rad(-182), rad(2)); g.stroke();
  // Risers between the rows, like the steps of a real stage.
  g.strokeStyle = "rgba(244, 234, 216, .05)"; g.lineWidth = 1;
  for (const f of [.55, .71, .875]) { g.beginPath(); g.arc(cx, cy, f * R, rad(-180), rad(0)); g.stroke(); }
  // Empty chairs: a section nobody plays in yet still shows where its players will sit.
  g.fillStyle = "rgba(232, 182, 90, .16)";
  for (const [name, pts] of Object.entries(G.chairs)) {
    if ((seats[SECTIONS.indexOf(name)] || []).some(Boolean) || (name === "piano" && info.house)) continue;
    for (const { x, y } of pts) { g.beginPath(); g.arc(x, y, 1.5, 0, Math.PI * 2); g.fill(); }
  }
  // Section names, quietly, at the front edge of each region.
  // Drawn under the musicians, and quieter once a section has players, so flags never sit on text.
  g.font = "italic 300 14px Fraunces, Georgia, serif"; g.textAlign = "center";
  for (const [name, reg] of Object.entries(REGIONS)) {
    if (name === "accordion") continue;        // piano and accordion share one label
    // On a small stage the three names around the podium cannot fit apart: name only the outer rows.
    if (R < 260 && reg.band[0] < .5) continue;
    const a = rad(name === "piano" ? 0 : (reg.arc[0] + reg.arc[1]) / 2), r = reg.band[0] * R - 7;
    g.fillStyle = (seats[SECTIONS.indexOf(name)] || []).some(Boolean) ? "rgba(230, 180, 90, .3)" : "rgba(230, 180, 90, .62)";
    if (name === "piano") { g.fillText("solistler", cx, cy - reg.band[1] * R - 9); continue; }
    g.fillText(reg.label, cx + Math.sin(a) * r, cy - Math.cos(a) * r);
  }
  // Musicians.
  const soloGlow = motionPaused ? 0 : Math.max(0, 1 - (Date.now() + offset - soloAt) / 500);
  for (const [name, pts] of Object.entries(G.stage.sections)) {
    const s = SECTIONS.indexOf(name), color = COLORS[name], sp = G.stage.spacing[name];
    const order = G.order[name];
    (seats[s] || []).forEach((entry, i) => {
      if (!entry || !pts[order[i]]) return;
      const { x, y } = pts[order[i]];
      const key = `${s}:${i}`;
      const personalPulse = ownSeat && ownSeat[0] === s && ownSeat[1] === i ? Math.max(0, 1 - (Date.now() + offset - ownPulseAt) / 2500) : 0;
      const lit = motionPaused ? 0 : Math.max(glow.get(key) || 0, personalPulse);
      if (lit) glow.set(key, Math.max(0, lit - dt * 1.6));
      // Each musician is a person: their country's flag, ringed in the section colour.
      const size = Math.max(2.2, sp * .42);
      if (lit > .02) {
        g.globalAlpha = lit * .45; g.strokeStyle = color; g.lineWidth = 1;
        g.beginPath(); g.arc(x, y, size * (1.15 + (1 - lit) * .5), 0, Math.PI * 2); g.stroke();
      }
      const cc = entry[1];
      const leading = cc && cc === leader;  // spotlight: thin gold ring, a soft flash on melody notes
      if (leading && soloGlow > .02) {      // brief, thin: a ring that brightens, not a blob
        g.globalAlpha = soloGlow * .7; g.strokeStyle = "#e8b65a"; g.lineWidth = 1.4;
        g.beginPath(); g.arc(x, y, size * 1.25, 0, Math.PI * 2); g.stroke();
      }
      if (cc && sp >= 7) {
        g.globalAlpha = .55 + lit * .45;
        g.drawImage(flagImage(cc, size * 2.1), x - size * 1.05, y - size * 1.05, size * 2.1, size * 2.1);
        g.globalAlpha = leading ? .9 : .5 + lit * .5; g.strokeStyle = leading ? "#e8b65a" : color; g.lineWidth = leading ? 1.6 : 1;
        g.beginPath(); g.arc(x, y, size * 1.02, 0, Math.PI * 2); g.stroke();
      } else {
        g.globalAlpha = .3 + lit * .7; g.fillStyle = color;
        g.beginPath(); g.arc(x, y, size * .7, 0, Math.PI * 2); g.fill();
      }
      g.globalAlpha = 1;
      if (ownSeat && ownSeat[0] === s && ownSeat[1] === i) {
        g.strokeStyle = "#f4ead8"; g.lineWidth = 2; g.beginPath(); g.arc(x, y, size * 1.7, 0, Math.PI * 2); g.stroke();
        g.fillStyle = "#f4ead8"; g.font = "bold 12px system-ui"; g.textAlign = "center"; g.fillText("SEN", x, y - size * 2 - 6);
      }
    });
  }
  if (info.house) {                       // the house pianist: a grand piano seen from above, glowing on each note
    const reg = REGIONS.piano, a = rad((reg.arc[0] + reg.arc[1]) / 2), r = ((reg.band[0] + reg.band[1]) / 2) * R;
    const s = Math.max(10, R * .04);
    g.save(); g.translate(cx + Math.sin(a) * r, cy - Math.cos(a) * r); g.rotate(a);
    if (soloGlow > .02) { g.globalAlpha = soloGlow * .35; g.strokeStyle = "#e8b65a"; g.lineWidth = 1; g.beginPath(); g.arc(0, -s * .3, s * 1.6, 0, Math.PI * 2); g.stroke(); }
    g.globalAlpha = .45 + soloGlow * .45; g.fillStyle = "#e8b65a";
    // Straight spine on the left, the curved bentside on the right, keyboard at the front.
    g.beginPath(); g.moveTo(-s * .6, s * .55); g.lineTo(s * .6, s * .55); g.lineTo(s * .6, s * .15);
    g.bezierCurveTo(s * .6, -s * .25, s * .05, -s * .3, -s * .05, -s * .9);
    g.quadraticCurveTo(-s * .18, -s * 1.4, -s * .45, -s * 1.35); g.quadraticCurveTo(-s * .6, -s * 1.3, -s * .6, -s * 1.05); g.closePath(); g.fill();
    g.fillStyle = "#0d0b09"; g.fillRect(-s * .52, s * .28, s * 1.04, s * .16);   // keyboard
    g.restore(); g.globalAlpha = 1;
  }
  // Conductor on the podium, baton keeping time.
  const beat = (Date.now() + offset) / (60000 / (info.bpm || 64));
  const swing = !motionPaused && info.working ? Math.sin(beat * Math.PI) * .5 : 0;
  g.fillStyle = "rgba(244, 234, 216, .07)"; g.beginPath(); g.arc(cx, cy + 4, 18, 0, Math.PI * 2); g.fill();
  g.strokeStyle = "rgba(244, 234, 216, .9)"; g.lineWidth = 2;
  g.beginPath(); g.moveTo(cx, cy - 2); g.lineTo(cx + Math.sin(swing) * 24, cy - 2 - Math.cos(swing) * 24); g.stroke();
  g.fillStyle = "#f4ead8"; g.beginPath(); g.arc(cx, cy + 4, 6, 0, Math.PI * 2); g.fill();
  drawTeams(G, now);
  if (!motionPaused) drawScore();
  document.body.classList.toggle("is-playing", audio?.ctx.state === "running");
  requestAnimationFrame(frame);
}

// The audience in front of the stage: four blocks of seats, one per team. A filled seat is an
// agent session (listeners: a listener); a block rises in a small wave when its agents ship.
const AUDIENCE_ROWS = 3, AUDIENCE_COLS = 8;
function drawTeams(G, now) {
  const gap = Math.min(230, (width - 24) / BLOCKS.length), step = Math.max(7, Math.min(11, gap / 12));
  const top = G.cy + 30;
  g.textAlign = "center"; g.textBaseline = "middle";
  BLOCKS.forEach((team, b) => {
    const mx = G.cx + (b - (BLOCKS.length - 1) / 2) * gap;
    const count = team === "listen" ? teams.fans?.[team] || 0 : teams.agents?.[team] || 0;
    const age = (now - (waves[team] || -1e9)) / 1000;
    for (let i = 0; i < AUDIENCE_ROWS * AUDIENCE_COLS; i++) {
      const col = i % AUDIENCE_COLS, row = Math.floor(i / AUDIENCE_COLS);
      const wave = !motionPaused && age < 1.4 ? Math.max(0, Math.sin((age * 1.6 - col / AUDIENCE_COLS * .7) * Math.PI)) * 4 : 0;
      const x = mx + (col - (AUDIENCE_COLS - 1) / 2) * step, y = top + row * step - wave;
      g.beginPath(); g.arc(x, y, step * .3, 0, Math.PI * 2);
      if (i < count) { g.fillStyle = BLOCK_COLORS[team]; g.fill(); }
      else { g.strokeStyle = "rgba(243, 233, 214, .15)"; g.lineWidth = 1; g.stroke(); }
    }
    const labelY = top + AUDIENCE_ROWS * step + 9;
    g.font = "600 10px 'Instrument Sans', system-ui, sans-serif"; g.fillStyle = "rgba(243, 233, 214, .9)";
    g.fillText(TEAM_NAMES[team].toLocaleUpperCase("tr"), mx, labelY);
    g.font = "italic 300 13px Fraunces, Georgia, serif"; g.fillStyle = "rgba(179, 165, 143, .95)";
    g.fillText(`${count.toLocaleString("tr")} ${team === "listen" ? "dinleyen" : "ajan"}`, mx, labelY + 15);
    if (you && you.team === team) {
      g.fillStyle = "#e6b45a"; g.font = "italic 400 12px Fraunces, Georgia, serif";
      g.fillText("sen buradasın", mx, top - 13);
    }
  });
  g.textBaseline = "alphabetic";
}

// ---------- live score ----------
// Every note the conductor sends crosses one staff under the hall: everyone's work as sheet
// music. Notes enter on the right before they sound, pass the playhead as they play, then fade.
const scoreCanvas = $("score"), sg = scoreCanvas.getContext("2d");
const scoreNotes = [];                    // [serverTime, pitch, velocity, duration, voice]
const VOICE_COLORS = [...SECTIONS.slice(0, 8).map((s) => COLORS[s]), COLORS.horn, COLORS.strings, null, COLORS.accordion];
let scoreW = 0, scoreH = 0;
function resizeScore() {
  scoreW = scoreCanvas.clientWidth; scoreH = scoreCanvas.clientHeight;
  scoreCanvas.width = scoreW * dpr; scoreCanvas.height = scoreH * dpr;
  sg.setTransform(dpr, 0, 0, dpr, 0, 0);
  drawScore();
}
new ResizeObserver(resizeScore).observe(scoreCanvas);

function drawScore() {
  if (!scoreW) return;
  const t = Date.now() + offset, play = scoreW * .76, speed = .085;   // px per ms
  const mid = scoreH / 2 + 7, gapY = Math.max(5, Math.min(8, scoreH / 11));
  sg.clearRect(0, 0, scoreW, scoreH);
  sg.strokeStyle = "rgba(230, 180, 90, .22)"; sg.lineWidth = 1;
  for (let l = -2; l <= 2; l++) { const y = Math.round(mid + l * gapY) + .5; sg.beginPath(); sg.moveTo(0, y); sg.lineTo(scoreW, y); sg.stroke(); }
  sg.strokeStyle = "rgba(243, 208, 140, .55)";
  sg.beginPath(); sg.moveTo(play + .5, mid - gapY * 3.4); sg.lineTo(play + .5, mid + gapY * 3.4); sg.stroke();
  while (scoreNotes.length && t - scoreNotes[0][0] > play / speed + 4000) scoreNotes.shift();
  for (const [at, pitch, velocity, duration, voice] of scoreNotes) {
    if (voice === 10) continue;           // drums keep time; they have no pitch on a staff
    const x = play - (t - at) * speed;
    if (x < -12 || x > scoreW + 12) continue;
    const y = Math.max(16, Math.min(scoreH - 6, mid - ((pitch - 66) / 24) * gapY * 3));
    const sounding = t >= at && t <= at + duration * 1000;
    const fade = x > play ? .45 : .2 + .75 * Math.max(0, x / play);
    sg.fillStyle = VOICE_COLORS[voice] || "#e6b45a";
    sg.globalAlpha = (sounding ? .7 : .3) * fade;
    sg.fillRect(x, y - 1, Math.min(duration * 1000 * speed, 140), 2);
    sg.globalAlpha = sounding ? 1 : fade;
    sg.beginPath(); sg.ellipse(x, y, sounding ? 5.4 : 4.4, sounding ? 3.9 : 3.2, -.35, 0, Math.PI * 2); sg.fill();
    if (sounding) { sg.globalAlpha = .25; sg.beginPath(); sg.arc(x, y, 9, 0, Math.PI * 2); sg.fill(); }
  }
  sg.globalAlpha = 1;
}

requestAnimationFrame(frame);

function pauseCommon() {
  if (audio?.ctx.state === "running") audio.ctx.suspend();
  $("sound").textContent = "Sesi başlat";
  $("loading").textContent = "Ortak ses durduruldu. Kontrollerden yeniden başlatabilirsin.";
}
$("simple-sound").onclick = async () => {
  stopPersonalAudio(); $("mode").value = "common";
  document.querySelectorAll("[data-team]").forEach(b => { b.disabled = true; }); $("simple-sound").disabled = true;
  try {
    await startSimpleAudio(); $("sound").disabled = false; $("sound").textContent = "Sesi durdur";
    $("loading").textContent = "Ortak orkestra sade tınıyla çalıyor. Bu seçenek ek ses örneği indirmez."; metric("listen");
  } catch { $("loading").textContent = "Ses başlatılamadı. Tarayıcının ses iznini kontrol et."; }
  finally { document.querySelectorAll("[data-team]").forEach(b => { b.disabled = false; }); $("simple-sound").disabled = false; }
};
document.addEventListener("orchestra-pause", pauseCommon);
$("sound").onclick = async () => {
  if (isPersonal()) { await togglePersonalAudio(); return; }
  stopPersonalAudio();
  if (audio?.ctx.state === "running") pauseCommon();
  else if (audio?.ready) {
    try {
      await audio.ctx.resume();
      tabs?.postMessage({ playing: true, id: tabId });
      $("sound").textContent = "Sesi durdur";
      $("loading").textContent = audio.simple ? "Ortak orkestra sade tınıyla çalıyor. Bu seçenek ek ses örneği indirmez." : "Orkestra çalıyor. Ses ve hareketi aşağıdan kontrol edebilirsin.";
    } catch { $("loading").textContent = "Ses başlatılamadı. Tarayıcının ses iznini kontrol et."; }
  }
};
$("volume").addEventListener("input", () => { if (audio) audio.out.gain.setTargetAtTime(2.4 * Number($("volume").value) / 100, audio.ctx.currentTime, .03); });
addEventListener("pagehide", () => { stream?.close(); audio?.ctx.close(); tabs?.close(); });
