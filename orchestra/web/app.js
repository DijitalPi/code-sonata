// Agent Orchestra listener: draws the hall and plays the conductor's notes in sync.
const SECTIONS = ["piano", "strings", "choir", "cello", "flute", "vibraphone", "horn", "harp"];
// Left to right across the stage, like a real orchestra (violins left, cellos right).
const STAGE = ["strings", "piano", "harp", "flute", "horn", "choir", "vibraphone", "cello"];
const COLORS = { piano: "#f4ead8", strings: "#e8b65a", choir: "#c9a4ff", cello: "#d97a4a", flute: "#7fd1c7", vibraphone: "#8fb8ff", horn: "#f2d06b", harp: "#ff9fb2" };
const SOUNDFONT = ["acoustic_grand_piano", "string_ensemble_1", "choir_aahs", "cello", "flute", "vibraphone", "french_horn", "orchestral_harp", "timpani", "tremolo_strings"];
const $ = (id) => document.getElementById(id);

// ---------- state from the server ----------
let seats = SECTIONS.map(() => []);      // section -> [sessions or 0]
const glow = new Map();                  // "s:i" -> 0..1
let info = { bpm: 64, intensity: 0, climax: false, song: "", working: 0 };
const offsets = [];
let offset = 0;                          // serverTime - localTime (best estimate)

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

const stream = new EventSource("/api/stream");
stream.onmessage = (event) => {
  const frame = JSON.parse(event.data);
  offsets.push(frame.t - Date.now());
  if (offsets.length > 40) offsets.shift();
  offset = Math.max(...offsets);         // least delayed sample
  if (frame.seats) seats = frame.seats;
  for (const [s, i] of frame.pulses || []) glow.set(`${s}:${i}`, 1);
  if (frame.players !== undefined) {
    info = frame;
    $("claudes").textContent = frame.claudes.toLocaleString();
    $("players").textContent = frame.players.toLocaleString();
    $("listeners").textContent = frame.listeners.toLocaleString();
    showNow(frame);
  }
  if (audio) for (const note of frame.notes || []) schedule(note);
};

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
    const pan = section ? (STAGE.indexOf(section) / (STAGE.length - 1) - .5) * 1.4 : 0;
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
    else if (pitch === 42) burst(time, .05, level * .35, "highpass", 7000);
    else if (pitch === 46) burst(time, .22, level * .35, "highpass", 6000);
    else if (pitch === 49) burst(time, 2.2, level * .45, "highpass", 4500);
  };
}

$("play").addEventListener("click", async () => {
  $("play").disabled = true;
  $("loading").textContent = "Opening the doors";
  try {
    await startAudio();
    $("enter").classList.add("hidden");
  } catch (error) {
    $("play").disabled = false;
    $("loading").textContent = "Sound could not start in this browser.";
  }
});

// ---------- hall ----------
const canvas = $("hall"), g = canvas.getContext("2d");
let width = 0, height = 0, dpr = 1;
function resize() {
  dpr = Math.min(2, devicePixelRatio || 1);
  width = innerWidth; height = innerHeight;
  canvas.width = width * dpr; canvas.height = height * dpr;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
}
addEventListener("resize", resize);
resize();

function layout() {
  const cx = width / 2, cy = height * .88;
  const r0 = Math.min(width, height) * .17, rMax = Math.min(width * .47, height * .66);
  const wedge = (Math.PI * .92) / STAGE.length, start = Math.PI * 1.04;
  const most = Math.max(1, ...seats.map((row) => row.length));
  const area = (wedge / 2) * (rMax * rMax - r0 * r0);
  const spacing = Math.max(3, Math.min(20, Math.sqrt(area / most) * .8));
  return { cx, cy, r0, rMax, wedge, start, spacing };
}

function seatPoint(L, column, index) {
  let r = L.r0, i = index;
  for (;;) {
    const perRow = Math.max(1, Math.floor((r * L.wedge * .9) / L.spacing));
    if (i < perRow) {
      const a = L.start + column * L.wedge + L.wedge * (.05 + .9 * (i + .5) / perRow);
      return [L.cx + Math.cos(a) * r, L.cy + Math.sin(a) * r];
    }
    i -= perRow; r += L.spacing;
  }
}

let last = performance.now();
function frame(now) {
  const dt = Math.min(.1, (now - last) / 1000); last = now;
  const L = layout();
  g.clearRect(0, 0, width, height);
  // Stage floor: warmer and wider with excitement.
  const heat = info.working ? info.intensity : 0;
  const floor = g.createRadialGradient(L.cx, L.cy, 0, L.cx, L.cy, L.rMax * (1 + heat * .25));
  floor.addColorStop(0, `rgba(232, 182, 90, ${.10 + heat * .14 + (info.climax ? .08 : 0)})`);
  floor.addColorStop(1, "rgba(232, 182, 90, 0)");
  g.fillStyle = floor; g.fillRect(0, 0, width, height);
  // Section labels and seats.
  g.font = "500 11px Inter, sans-serif"; g.textAlign = "center";
  STAGE.forEach((name, column) => {
    const s = SECTIONS.indexOf(name), color = COLORS[name];
    (seats[s] || []).forEach((sessions, i) => {
      if (!sessions) return;
      const [x, y] = seatPoint(L, column, i);
      const key = `${s}:${i}`;
      const lit = glow.get(key) || 0;
      if (lit) glow.set(key, Math.max(0, lit - dt * 1.6));
      const size = Math.max(1.2, L.spacing * (.16 + .035 * Math.min(4, sessions)));
      if (lit > .02) {          // thin expanding ring: readable even when the whole hall is lit
        g.globalAlpha = lit * .55;
        g.strokeStyle = color; g.lineWidth = 1;
        g.beginPath(); g.arc(x, y, size * (1.3 + (1 - lit) * 1.6), 0, Math.PI * 2); g.stroke();
      }
      g.globalAlpha = .28 + lit * .72;
      g.fillStyle = color;
      g.beginPath(); g.arc(x, y, size, 0, Math.PI * 2); g.fill();
      g.globalAlpha = 1;
    });
  });
  g.fillStyle = "rgba(163, 150, 132, .85)";
  STAGE.forEach((name, column) => {
    const a = L.start + (column + .5) * L.wedge, r = L.r0 - 16;
    g.fillText(name.toUpperCase(), L.cx + Math.cos(a) * r, L.cy + Math.sin(a) * r);
  });
  // Conductor's podium and a baton that keeps time.
  g.fillStyle = "rgba(244, 234, 216, .06)";
  g.beginPath(); g.arc(L.cx, L.cy, 22, 0, Math.PI * 2); g.fill();
  const beat = (Date.now() + offset) / (60000 / (info.bpm || 64));
  const swing = info.working ? Math.sin(beat * Math.PI) * .5 : 0;
  g.strokeStyle = "rgba(244, 234, 216, .9)"; g.lineWidth = 2;
  g.beginPath(); g.moveTo(L.cx, L.cy - 6); g.lineTo(L.cx + Math.sin(swing) * 26, L.cy - 6 - Math.cos(swing) * 26); g.stroke();
  g.fillStyle = "#f4ead8"; g.beginPath(); g.arc(L.cx, L.cy, 6, 0, Math.PI * 2); g.fill();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
