// Agent Orchestra listener: draws the hall and plays the conductor's notes in sync.
const SECTIONS = ["piano", "strings", "choir", "cello", "flute", "vibraphone", "horn", "harp"];
// Stereo position from the real seating plan (violins left, cellos right).
const PAN = { strings: -.7, harp: -.6, piano: 0, flute: 0, horn: .1, choir: 0, vibraphone: .6, cello: .7 };
const COLORS = { piano: "#f4ead8", strings: "#e8b65a", choir: "#c9a4ff", cello: "#d97a4a", flute: "#7fd1c7", vibraphone: "#8fb8ff", horn: "#f2d06b", harp: "#ff9fb2" };
const SOUNDFONT = ["acoustic_grand_piano", "string_ensemble_1", "choir_aahs", "cello", "flute", "vibraphone", "french_horn", "orchestral_harp", "timpani", "tremolo_strings"];
const $ = (id) => document.getElementById(id);

// ---------- state from the server ----------
let seats = SECTIONS.map(() => []);      // section -> [[sessions, country] or 0]
let audience = [];                       // seat -> country code, "" unknown, null empty
let you = null;                          // {seat, cc}
const flag = (cc) => (cc && cc.length === 2 ? String.fromCodePoint(...[...cc].map((c) => 0x1f1a5 + c.charCodeAt(0))) : "");
const glow = new Map();                  // "s:i" -> 0..1
let info = { bpm: 64, intensity: 0, climax: false, song: "", working: 0 };
const offsets = [];
let offset = 0;                          // serverTime - localTime (best estimate)

function showCountries(frame) {
  $("countries").textContent = (frame.countryCount || 0).toLocaleString();
  const legend = $("legend");
  legend.replaceChildren();
  for (const [cc, count] of frame.countries) {
    const item = document.createElement("span");
    item.textContent = `${flag(cc)} ${count}`;
    item.title = cc;
    legend.append(item);
  }
}

function showNow(frame) {
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
  if (frame.audience) { audience = frame.audience; version++; }
  if (frame.you) you = frame.you;
  if (frame.countries) showCountries(frame);
  if (frame.teams) teams = frame.teams;
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
    const section = SECTIONS[i];
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
function resize() {
  dpr = Math.min(2, devicePixelRatio || 1);
  width = innerWidth; height = innerHeight;
  canvas.width = width * dpr; canvas.height = height * dpr;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  cached = null;
}
addEventListener("resize", resize);
resize();

// A real symphony seating plan, seen from the audience. Angles in degrees: 0 = straight
// back, -90 = far left, +90 = far right. Bands are fractions of the stage radius.
const REGIONS = {
  piano:      { band: [.08, .28], arc: [-14, 14], label: "piano (soloist)" },
  strings:    { band: [.16, .54], arc: [-86, -17], label: "violins" },
  cello:      { band: [.16, .54], arc: [17, 86], label: "cellos" },
  flute:      { band: [.56, .70], arc: [-30, 30], label: "woodwinds" },
  harp:       { band: [.56, .86], arc: [-86, -34], label: "harp" },
  vibraphone: { band: [.56, .86], arc: [34, 86], label: "percussion" },
  horn:       { band: [.72, .86], arc: [-30, 30], label: "brass" },
  choir:      { band: [.89, 1.0], arc: [-72, 72], label: "choir" },
};
// Audience blocks in the stalls, left to right, split by aisles.
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

function fit(build) {
  for (let spacing = 26; spacing > 2.4; spacing *= .92) {
    const result = build(spacing);
    if (result) return { ...result, spacing };
  }
  return { ...build(2.4, true), spacing: 2.4 };
}

function geometry() {
  if (cached && cached.version === version) return cached;
  const cx = width / 2, cy = height * .55;
  const R = Math.min(width * .42, height * .41);
  const stagePoint = (r, a) => ({ x: cx + Math.sin(rad(a)) * r, y: cy - Math.cos(rad(a)) * r });
  // Each section fills its own region (a lone harpist gets a big chair, violins pack tight).
  const stage = { sections: {}, spacing: {} };
  for (const [name, reg] of Object.entries(REGIONS)) {
    const n = (seats[SECTIONS.indexOf(name)] || []).length;
    const one = fit((spacing, force) => {
      const pts = fillWedge(n, reg.band[0] * R, force ? 1e9 : reg.band[1] * R, reg.arc[0], reg.arc[1], Math.min(spacing, 20), stagePoint);
      return pts && { pts };
    });
    stage.sections[name] = one.pts;
    stage.spacing[name] = Math.min(one.spacing, 20);
  }
  // Stalls: rows are arcs around the stage front, squashed for perspective.
  const A0 = R * .42, A1 = Math.min(width / 2 - 16, R * 1.3);
  const aisleY = cy + 58;                 // mascots walk the front aisle
  const squash = Math.max(.3, (height - aisleY - 90) / (A1 - A0 * .9));
  const hallPoint = (r, a) => ({ x: cx + Math.sin(rad(a)) * r, y: aisleY + 44 + (Math.cos(rad(a)) * r - A0 * .9) * squash });
  const weights = BLOCKS.map((t) => 1.5 + Math.sqrt((audience[t] || []).length));
  const sum = weights.reduce((a, b) => a + b, 0), aisle = 2.5, span = 124 - aisle * (BLOCKS.length - 1);
  let a = -62;
  const ranges = BLOCKS.map((t, i) => { const w = (span * weights[i]) / sum; const r = [a, a + w]; a += w + aisle; return r; });
  const stalls = fit((spacing, force) => {
    const out = {};
    BLOCKS.forEach((t, i) => {
      if (out === null) return;
      const pts = fillWedge((audience[t] || []).length, A0, force ? 1e9 : A1, ranges[i][0], ranges[i][1], spacing, hallPoint);
      out[t] = pts;
    });
    return Object.values(out).some((v) => v === null) ? null : { blocks: out };
  });
  cached = { version, cx, cy, R, stage, stalls, ranges, A0, A1, aisleY, hallPoint };
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
  const dt = Math.min(.1, (now - last) / 1000); last = now;
  const G = geometry();
  const { cx, cy, R } = G;
  g.clearRect(0, 0, width, height);
  const heat = info.working ? info.intensity : 0;
  // Stage platform: a warm shell that brightens with excitement.
  const light = g.createRadialGradient(cx, cy, 0, cx, cy, R * (1.05 + heat * .2));
  light.addColorStop(0, `rgba(232, 182, 90, ${.12 + heat * .14 + (info.climax ? .08 : 0)})`);
  light.addColorStop(1, "rgba(232, 182, 90, .02)");
  g.fillStyle = light;
  g.beginPath(); g.moveTo(cx, cy); g.arc(cx, cy, R * 1.05, rad(-92 - 90), rad(92 - 90)); g.closePath(); g.fill();
  g.strokeStyle = "rgba(232, 182, 90, .25)"; g.lineWidth = 1;
  g.beginPath(); g.arc(cx, cy, R * 1.05, rad(-92 - 90), rad(92 - 90)); g.stroke();
  // Musicians.
  for (const [name, pts] of Object.entries(G.stage.sections)) {
    const s = SECTIONS.indexOf(name), color = COLORS[name], sp = G.stage.spacing[name];
    (seats[s] || []).forEach((entry, i) => {
      if (!entry || !pts[i]) return;
      const { x, y } = pts[i];
      const key = `${s}:${i}`;
      const lit = glow.get(key) || 0;
      if (lit) glow.set(key, Math.max(0, lit - dt * 1.6));
      const size = Math.max(1.1, sp * (.18 + .035 * Math.min(4, entry[0])));
      if (lit > .02) {
        g.globalAlpha = lit * .55; g.strokeStyle = color; g.lineWidth = 1;
        g.beginPath(); g.arc(x, y, size * (1.3 + (1 - lit) * 1.6), 0, Math.PI * 2); g.stroke();
      }
      g.globalAlpha = .3 + lit * .7; g.fillStyle = color;
      g.beginPath(); g.arc(x, y, size, 0, Math.PI * 2); g.fill();
      g.globalAlpha = 1;
    });
  }
  // Section names, quietly, at the front edge of each region.
  g.font = "500 10px Inter, sans-serif"; g.textAlign = "center"; g.fillStyle = "rgba(163, 150, 132, .8)";
  for (const reg of Object.values(REGIONS)) {
    const a = rad((reg.arc[0] + reg.arc[1]) / 2), r = reg.band[0] * R - 7;
    g.fillText(reg.label.toUpperCase(), cx + Math.sin(a) * r, cy - Math.cos(a) * r);
  }
  // Conductor on the podium, baton keeping time.
  const beat = (Date.now() + offset) / (60000 / (info.bpm || 64));
  const swing = info.working ? Math.sin(beat * Math.PI) * .5 : 0;
  g.fillStyle = "rgba(244, 234, 216, .07)"; g.beginPath(); g.arc(cx, cy + 4, 18, 0, Math.PI * 2); g.fill();
  g.strokeStyle = "rgba(244, 234, 216, .9)"; g.lineWidth = 2;
  g.beginPath(); g.moveTo(cx, cy - 2); g.lineTo(cx + Math.sin(swing) * 24, cy - 2 - Math.cos(swing) * 24); g.stroke();
  g.fillStyle = "#f4ead8"; g.beginPath(); g.arc(cx, cy + 4, 6, 0, Math.PI * 2); g.fill();
  drawStalls(G, now);
  requestAnimationFrame(frame);
}

function drawStalls(G, now) {
  const sp = G.stalls.spacing;
  g.textAlign = "center"; g.textBaseline = "middle";
  BLOCKS.forEach((team, b) => {
    const pts = G.stalls.blocks[team] || [], fans = audience[team] || [];
    const waveAge = (now - (waves[team] || -1e9)) / 1000;
    fans.forEach((cc, i) => {
      if (cc === null || !pts[i]) return;
      const { x, along } = pts[i];
      const lift = waveAge < 1.6 ? Math.exp(-Math.pow((waveAge / 1.4 - along) * 7, 2)) : 0;
      const y = pts[i].y - lift * sp * .8;
      const mine = you && you.team === team && you.seat === i;
      const w = sp * .82, h = sp * .66;
      g.fillStyle = mine ? "#e8b65a" : lift > .2 ? BLOCK_COLORS[team] : "rgba(244, 234, 216, .14)";
      g.beginPath(); g.roundRect(x - w / 2, y - h / 2, w, h, Math.min(4, sp * .2)); g.fill();
      if (cc && sp >= 10) { g.font = `${Math.round(sp * .62)}px system-ui`; g.fillText(flag(cc), x, y + 1); }
      if (mine) { g.font = "500 11px Inter, sans-serif"; g.fillStyle = "#e8b65a"; g.fillText("you", x, y - h / 2 - 9); }
    });
  });
  // Mascots last, so no seat ever covers a name plate.
  BLOCKS.forEach((team, b) => {
    const waveAge = (now - (waves[team] || -1e9)) / 1000;
    const mid = (G.ranges[b][0] + G.ranges[b][1]) / 2;
    const jump = waveAge < 1 ? Math.sin(waveAge * Math.PI) * 12 : 0;
    const bob = info.working ? Math.abs(Math.sin(((Date.now() + offset) / (60000 / (info.bpm || 64))) * Math.PI)) * 3 : 0;
    // Spread along the aisle in the direction of the block, never closer than a plate apart.
    const lane = (b - (BLOCKS.length - 1) / 2) * Math.max(150, Math.min(G.A1 * .55, 230));
    const mx = G.cx + (Math.abs(Math.sin(rad(mid))) > .01 ? lane : 0), my = G.aisleY - 16;
    mascot(team, mx, my - jump - bob, 15);
    const agents = team === "listen" ? null : teams.agents?.[team] || 0;
    const sub = agents === null ? `${(teams.fans?.listen || 0).toLocaleString()} listening` : `${agents.toLocaleString()} agents on stage`;
    g.font = "500 11px Inter, sans-serif";
    const plate = Math.max(g.measureText(TEAM_NAMES[team]).width, g.measureText(sub).width) + 16;
    g.fillStyle = "rgba(13, 11, 9, .8)";
    g.beginPath(); g.roundRect(mx - plate / 2, my + 18, plate, 30, 7); g.fill();
    g.fillStyle = "rgba(244, 234, 216, .92)"; g.fillText(TEAM_NAMES[team], mx, my + 26);
    g.fillStyle = "rgba(163, 150, 132, .95)"; g.fillText(sub, mx, my + 40);
  });
  g.textBaseline = "alphabetic";
}
requestAnimationFrame(frame);
