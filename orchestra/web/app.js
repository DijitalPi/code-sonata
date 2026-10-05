// Agent Orchestra listener: draws the hall and plays the conductor's notes in sync.
const SECTIONS = ["piano", "strings", "choir", "cello", "flute", "vibraphone", "horn", "harp", "accordion"];
// Stereo position from the real seating plan (violins left, cellos right).
const PAN = { strings: -.7, harp: -.6, piano: -.1, accordion: .15, flute: 0, horn: .1, choir: 0, vibraphone: .6, cello: .7 };
const COLORS = { piano: "#f4ead8", strings: "#e8b65a", choir: "#c9a4ff", cello: "#d97a4a", flute: "#7fd1c7", vibraphone: "#8fb8ff", horn: "#f2d06b", harp: "#ff9fb2", accordion: "#ff7a7a" };
// Engine voices by index (10 = drums, synthesized; 11 = accordion, section 8).
const SOUNDFONT = ["acoustic_grand_piano", "string_ensemble_1", "choir_aahs", "cello", "flute", "vibraphone", "french_horn", "orchestral_harp", "timpani", "tremolo_strings", null, "accordion"];
const VOICE_SECTION = { 11: "accordion" };
const $ = (id) => document.getElementById(id);

// ---------- state from the server ----------
let seats = SECTIONS.map(() => []);      // section -> [[sessions, country] or 0]
let you = null;                          // {cc, team}
let leader = null, soloAt = 0, ranks = [];
const countryName = (() => { try { const d = new Intl.DisplayNames(["en"], { type: "region" }); return (cc) => d.of(cc) || cc; } catch { return (cc) => cc; } })();
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
    mine.textContent = `Your country: ${flag(you.cc)} ${rank >= 0 ? `#${rank + 1}` : "not on the board yet"}`;
  } else mine.textContent = "";
}

let announceTimer = 0;
function announce({ cc }) {
  const box = $("announce");
  box.textContent = `${flag(cc)} ${countryName(cc)} takes the lead!`;
  box.classList.add("show");
  clearTimeout(announceTimer);
  announceTimer = setTimeout(() => box.classList.remove("show"), 4000);
}

let lastNow = "";
function showNow(frame) {
  const key = `${frame.working}|${frame.players}|${frame.song}|${frame.bpm}|${frame.climax}|${Math.round(frame.intensity * 20)}`;
  if (key === lastNow) return;
  lastNow = key;
  const now = $("now");
  now.replaceChildren();
  if (!frame.working) {
    now.textContent = frame.players ? "The orchestra is resting. Music starts when an agent works." : "Waiting for the first agent";
    return;
  }
  const song = document.createElement("strong");
  song.textContent = frame.song;
  now.append("Now playing ", song, ` · ${frame.bpm} BPM`);
  if (frame.climax) {
    const climax = document.createElement("strong");
    climax.textContent = "climax";
    now.append(" · ", climax);
  }
  const heat = document.createElement("span"), bar = document.createElement("i");
  heat.className = "heat";
  bar.style.width = `${Math.round(frame.intensity * 100)}%`;
  heat.append(bar);
  now.append(heat);
}

const TEAM_NAMES = { claude: "Claude Code fans", codex: "Codex fans", other: "Other agents", listen: "Listeners" };
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
}

function onFrame(event) {
  const frame = JSON.parse(event.data);
  offsets.push(frame.t - Date.now());
  if (offsets.length > 40) offsets.shift();
  offset = Math.max(...offsets);         // least delayed sample
  if (frame.seats) { seats = frame.seats; version++; }
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
    $("claudes").textContent = frame.claudes.toLocaleString();
    $("players").textContent = frame.players.toLocaleString();
    $("listeners").textContent = frame.listeners.toLocaleString();
    showNow(frame);
  }
  if (audio) for (const note of frame.notes || []) schedule(note);
}
connect();
if (location.hash === "#tv") $("enter").classList.add("hidden");   // wall display: watch only, no sound

// ---------- audio ----------
let audio = null;

async function startAudio() {
  const ctx = new AudioContext();
  const master = ctx.createDynamicsCompressor();
  master.threshold.value = -14; master.ratio.value = 4;
  const out = ctx.createGain(); out.gain.value = .9;
  master.connect(out).connect(ctx.destination);
  audio = { ctx, master, voices: [], drums: drumKit(ctx, master) };
  const { Soundfont } = await import("https://cdn.jsdelivr.net/npm/smplr@1.1.0/+esm");
  // Piano first so the hall is audible quickly; the rest load behind it.
  for (const [i, name] of SOUNDFONT.entries()) {
    if (!name) continue;
    const section = VOICE_SECTION[i] || (i < 8 ? SECTIONS[i] : null);
    const pan = PAN[section] ?? 0;
    const voice = Soundfont(ctx, { instrument: name, kit: "FluidR3_GM", destination: master, pan, volume: 100 });
    audio.voices[i] = null;
    voice.ready.then(() => { audio.voices[i] = voice; }).catch(() => {});
    if (i === 0) { $("loading").textContent = "Tuning the piano"; await voice.ready; }
  }
}

function schedule([at, pitch, velocity, duration, voice]) {
  const { ctx } = audio;
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
    team = button.dataset.team;
    try { localStorage.setItem("team", team); } catch {}
    connect();                            // take a seat in the chosen stand
    document.querySelectorAll("[data-team]").forEach((b) => { b.disabled = true; });
    $("loading").textContent = "Opening the doors";
    try {
      await startAudio();
      $("enter").classList.add("hidden");
    } catch (error) {
      document.querySelectorAll("[data-team]").forEach((b) => { b.disabled = false; });
      $("loading").textContent = "Sound could not start in this browser.";
    }
  });
}

// ---------- hall ----------
const canvas = $("hall"), g = canvas.getContext("2d");
let width = 0, height = 0, dpr = 1, version = 0, cached = null;
const flagCache = new Map();
function resize() {
  dpr = Math.min(2, devicePixelRatio || 1);
  width = innerWidth; height = innerHeight;
  canvas.width = width * dpr; canvas.height = height * dpr;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  cached = null;
  flagCache.clear();
}
addEventListener("resize", resize);
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
  piano:      { band: [.08, .28], arc: [-15, -1], label: "piano" },
  accordion:  { band: [.08, .28], arc: [1, 15], label: "accordion" },
  strings:    { band: [.16, .54], arc: [-86, -17], label: "violins" },
  cello:      { band: [.16, .54], arc: [17, 86], label: "cellos" },
  flute:      { band: [.56, .70], arc: [-30, 30], label: "woodwinds" },
  harp:       { band: [.56, .86], arc: [-86, -34], label: "harp" },
  vibraphone: { band: [.56, .86], arc: [34, 86], label: "percussion" },
  horn:       { band: [.72, .86], arc: [-30, 30], label: "brass" },
  choir:      { band: [.89, 1.0], arc: [-72, 72], label: "choir" },
};
// Teams in the strip under the stage, left to right.
const BLOCKS = ["claude", "listen", "codex", "other"];
const BLOCK_COLORS = { claude: "#e0784f", codex: "#3fbf8a", other: "#9b7bff", listen: "#e8b65a" };
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

function fit(build, start = 26) {
  for (let spacing = start; spacing > 2.4; spacing *= .92) {
    const result = build(spacing);
    if (result) return { ...result, spacing };
  }
  return { ...build(2.4, true), spacing: 2.4 };
}

function geometry() {
  if (cached && cached.version === version) return cached;
  const cx = width / 2, cy = height * .8;
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
  cached = { version, cx, cy, R, stage, order };
  return cached;
}

// Original mascots (drawn here, not brand logos).
function mascot(team, x, y, r) {
  const color = BLOCK_COLORS[team];
  g.save(); g.translate(x, y);
  g.fillStyle = color;
  if (team === "codex") {                 // robot drummer
    g.beginPath(); g.roundRect(-r, -r, r * 2, r * 1.8, r * .35); g.fill();
    g.strokeStyle = color; g.lineWidth = 2;
    g.beginPath(); g.moveTo(0, -r); g.lineTo(0, -r * 1.45); g.stroke();
    g.beginPath(); g.arc(0, -r * 1.5, r * .16, 0, Math.PI * 2); g.fill();
    g.fillStyle = "#10201a"; g.beginPath(); g.roundRect(-r * .7, -r * .65, r * 1.4, r * .8, r * .2); g.fill();
    g.fillStyle = "#7dffc8"; g.fillRect(-r * .42, -r * .38, r * .22, r * .22); g.fillRect(r * .2, -r * .38, r * .22, r * .22);
    g.strokeStyle = "#f4ead8"; g.lineWidth = 1.5;
    g.beginPath(); g.moveTo(r * .9, r * .2); g.lineTo(r * 1.5, -r * .4); g.moveTo(-r * .9, r * .2); g.lineTo(-r * 1.5, -r * .4); g.stroke();
  } else {
    g.beginPath(); g.arc(0, 0, r, 0, Math.PI * 2); g.fill();
    if (team === "other") {               // cat with a violin
      g.beginPath(); g.moveTo(-r * .85, -r * .45); g.lineTo(-r * .55, -r * 1.25); g.lineTo(-r * .15, -r * .85); g.fill();
      g.beginPath(); g.moveTo(r * .85, -r * .45); g.lineTo(r * .55, -r * 1.25); g.lineTo(r * .15, -r * .85); g.fill();
      g.fillStyle = "#8a4b2a"; g.beginPath(); g.ellipse(r * .95, r * .45, r * .32, r * .2, -.5, 0, Math.PI * 2); g.fill();
    }
    if (team === "listen") {              // headphones
      g.strokeStyle = "#f4ead8"; g.lineWidth = 2.2;
      g.beginPath(); g.arc(0, -r * .1, r * 1.12, Math.PI * 1.1, Math.PI * 1.9); g.stroke();
      g.fillStyle = "#f4ead8"; g.fillRect(-r * 1.2, -r * .35, r * .3, r * .6); g.fillRect(r * .9, -r * .35, r * .3, r * .6);
    }
    g.fillStyle = "#1a120c";               // eyes and smile
    g.beginPath(); g.arc(-r * .35, -r * .15, r * .13, 0, Math.PI * 2); g.arc(r * .35, -r * .15, r * .13, 0, Math.PI * 2); g.fill();
    g.strokeStyle = "#1a120c"; g.lineWidth = 1.6;
    g.beginPath(); g.arc(0, r * .12, r * .32, .15 * Math.PI, .85 * Math.PI); g.stroke();
    if (team === "claude") {              // maestro: bow tie and baton
      g.fillStyle = "#1a120c";
      g.beginPath(); g.moveTo(0, r * .78); g.lineTo(-r * .38, r * .58); g.lineTo(-r * .38, r * .98); g.closePath();
      g.moveTo(0, r * .78); g.lineTo(r * .38, r * .58); g.lineTo(r * .38, r * .98); g.closePath(); g.fill();
      g.strokeStyle = "#f4ead8"; g.lineWidth = 1.5;
      g.beginPath(); g.moveTo(r * .9, r * .1); g.lineTo(r * 1.65, -r * .7); g.stroke();
    }
  }
  g.restore();
}

let last = performance.now();
function frame(now) {
  if (now - last < 32) { requestAnimationFrame(frame); return; }   // ~30 fps is plenty for this
  const dt = Math.min(.1, (now - last) / 1000); last = now;
  const G = geometry();
  const { cx, cy, R } = G;
  g.clearRect(0, 0, width, height);
  // Stage: a quiet outline only (a full-screen gradient every frame was heavy and loud).
  g.fillStyle = "rgba(244, 234, 216, .025)";
  g.beginPath(); g.moveTo(cx, cy); g.arc(cx, cy, R * 1.05, rad(-182), rad(2)); g.closePath(); g.fill();
  g.strokeStyle = info.climax ? "rgba(232, 182, 90, .45)" : "rgba(244, 234, 216, .12)"; g.lineWidth = 1;
  g.beginPath(); g.arc(cx, cy, R * 1.05, rad(-182), rad(2)); g.stroke();
  // Musicians.
  const soloGlow = Math.max(0, 1 - (Date.now() + offset - soloAt) / 500);
  for (const [name, pts] of Object.entries(G.stage.sections)) {
    const s = SECTIONS.indexOf(name), color = COLORS[name], sp = G.stage.spacing[name];
    const order = G.order[name];
    (seats[s] || []).forEach((entry, i) => {
      if (!entry || !pts[order[i]]) return;
      const { x, y } = pts[order[i]];
      const key = `${s}:${i}`;
      const lit = glow.get(key) || 0;
      if (lit) glow.set(key, Math.max(0, lit - dt * 1.6));
      // Each musician is a person: their country's flag, ringed in the section colour.
      const size = Math.max(2.2, sp * .42);
      if (lit > .02) {
        g.globalAlpha = lit * .6; g.strokeStyle = color; g.lineWidth = 1.2;
        g.beginPath(); g.arc(x, y, size * (1.25 + (1 - lit) * 1.4), 0, Math.PI * 2); g.stroke();
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
    });
  }
  // Section names, quietly, at the front edge of each region.
  g.font = "500 10px Inter, sans-serif"; g.textAlign = "center"; g.fillStyle = "rgba(163, 150, 132, .8)";
  for (const [name, reg] of Object.entries(REGIONS)) {
    if (name === "accordion") continue;        // piano and accordion share one label
    const a = rad(name === "piano" ? 0 : (reg.arc[0] + reg.arc[1]) / 2), r = reg.band[0] * R - 7;
    if (name === "piano") { g.fillText("SOLOISTS", cx, cy - r); continue; }
    g.fillText(reg.label.toUpperCase(), cx + Math.sin(a) * r, cy - Math.cos(a) * r);
  }
  // Conductor on the podium, baton keeping time.
  const beat = (Date.now() + offset) / (60000 / (info.bpm || 64));
  const swing = info.working ? Math.sin(beat * Math.PI) * .5 : 0;
  g.fillStyle = "rgba(244, 234, 216, .07)"; g.beginPath(); g.arc(cx, cy + 4, 18, 0, Math.PI * 2); g.fill();
  g.strokeStyle = "rgba(244, 234, 216, .9)"; g.lineWidth = 2;
  g.beginPath(); g.moveTo(cx, cy - 2); g.lineTo(cx + Math.sin(swing) * 24, cy - 2 - Math.cos(swing) * 24); g.stroke();
  g.fillStyle = "#f4ead8"; g.beginPath(); g.arc(cx, cy + 4, 6, 0, Math.PI * 2); g.fill();
  drawTeams(G, now);
  requestAnimationFrame(frame);
}

// Team strip in front of the stage: one mascot per team with its numbers; it jumps when
// that team's agents ship something.
function drawTeams(G, now) {
  const gap = Math.max(130, Math.min(220, (width - 80) / BLOCKS.length));
  g.textAlign = "center"; g.textBaseline = "middle";
  BLOCKS.forEach((team, b) => {
    const mx = G.cx + (b - (BLOCKS.length - 1) / 2) * gap, my = G.cy + 46;
    const age = (now - (waves[team] || -1e9)) / 1000;
    const jump = age < 1 ? Math.sin(age * Math.PI) * 12 : 0;
    const bob = info.working ? Math.abs(Math.sin(((Date.now() + offset) / (60000 / (info.bpm || 64))) * Math.PI)) * 3 : 0;
    mascot(team, mx, my - jump - bob, 15);
    const agents = team === "listen" ? null : teams.agents?.[team] || 0;
    const fans = teams.fans?.[team] || 0;
    const sub = agents === null ? `${fans.toLocaleString()} listening` : `${agents.toLocaleString()} agents · ${fans.toLocaleString()} fans`;
    g.font = "500 11px Inter, sans-serif";
    g.fillStyle = "rgba(244, 234, 216, .92)"; g.fillText(TEAM_NAMES[team], mx, my + 30);
    g.fillStyle = "rgba(163, 150, 132, .95)"; g.fillText(sub, mx, my + 44);
    if (you && you.team === team) {
      g.fillStyle = "#e8b65a"; g.font = "600 11px Inter, sans-serif";
      g.fillText("you", mx, my - 34 - jump);
    }
  });
  g.textBaseline = "alphabetic";
}
requestAnimationFrame(frame);
