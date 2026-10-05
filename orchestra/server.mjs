// Agent Orchestra: one conductor, every participating machine is a seat.
// Zero dependencies (node:http). Players POST step counts; listeners get notes
// stamped with server time over Server-Sent Events and play them in sync.
//
//   PORT=4480 node orchestra/server.mjs
import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { SONGS, KEYS, TITLES, PLAYLIST, harmonize, chordTones } from "./music.mjs";

const PORT = Number(process.env.PORT || 4480);
const WEB = join(fileURLToPath(new URL(".", import.meta.url)), "web");
const SECTIONS = ["piano", "strings", "choir", "cello", "flute", "vibraphone", "horn", "harp"];
const TIMPANI = 8, TREMOLO = 9, DRUMS = 10;
const LEAD_MS = 900;            // notes are scheduled this far ahead so every listener can play them on time
const PLAYER_TTL = 30_000;      // a machine that stops reporting leaves its seat
const MAX_PLAYERS = 100_000;
const MIN_SONG_MS = 120_000;

// ---------- players ----------
const players = new Map();      // id -> {section, seat, last, working, sessions, energy, pulse}
const seatsTaken = SECTIONS.map(() => []);   // section -> array of ids (holes = null)
let seatsVersion = 0;

function seatFor(id) {
  let best = 0;
  for (let s = 1; s < SECTIONS.length; s++) {
    const count = seatsTaken[s].filter(Boolean).length;
    if (count < seatsTaken[best].filter(Boolean).length) best = s;
  }
  const row = seatsTaken[best];
  let seat = row.indexOf(null);
  if (seat < 0) { seat = row.length; row.push(id); } else row[seat] = id;
  seatsVersion++;
  return { section: best, seat };
}

function report(id, body, now) {
  let p = players.get(id);
  if (!p) {
    if (players.size >= MAX_PLAYERS) return null;
    p = { ...seatFor(id), energy: 0, pulse: 0 };
    players.set(id, p);
  }
  const steps = Math.max(0, Math.min(200, Number(body.steps) || 0));
  p.last = now;
  p.working = Boolean(body.working);
  p.sessions = Math.max(1, Math.min(64, Number(body.sessions) || 1));
  p.energy = Math.min(6, p.energy + steps);
  if (steps) { p.pulse = now; conductor.steps += steps; }
  for (const signal of (Array.isArray(body.signals) ? body.signals.slice(0, 4) : [])) {
    if (["ship", "pass", "fail"].includes(signal)) conductor.signal(signal, p.section, now);
  }
  return p;
}

function expire(now) {
  for (const [id, p] of players) {
    if (now - p.last > PLAYER_TTL) {
      seatsTaken[p.section][p.seat] = null;
      players.delete(id);
      seatsVersion++;
    }
  }
}

// ---------- conductor ----------
const conductor = {
  index: 0, position: 0, chord: null, bpm: 64, intensity: 0, shift: 0,
  nextNote: 0, nextDrive: 0, eighth: 0, steps: 0, rate: 0, songMs: 0,
  peakSince: null, calmSince: null, out: [],

  get song() { return PLAYLIST[this.index % PLAYLIST.length]; },
  chordAt(octave) { return chordTones(this.chord, KEYS[this.song], octave); },

  emit(at, p, v, d, i) {
    if (i !== DRUMS) p += this.shift;
    this.out.push([Math.round(at), Math.max(0, Math.min(127, p)), Math.max(1, Math.min(120, Math.round(v))), Math.round(d * 1000) / 1000, i]);
  },

  signal(kind, section, now) {
    const at = now + LEAD_MS, t = this.chordAt(60);
    if (kind === "ship") {
      for (const p of [...t, t[0] + 12]) this.emit(at, p, 70, 1.6, 6);
      this.emit(at, 49, 80, 2, DRUMS);
    } else if (kind === "pass") {
      [...t, t[0] + 12].forEach((p, i) => this.emit(at + i * 110, p, 55, .5, 6));
    } else if (kind === "fail") {
      const low = this.chordAt(36)[0];
      for (const p of [low + 12, low + 15, low + 18]) this.emit(at, p, 40, 1.2, TREMOLO);
    }
  },

  tick(now, dt) {
    expire(now);
    let working = 0, total = 0;
    const active = SECTIONS.map(() => 0);
    for (const p of players.values()) {
      total++;
      p.energy *= Math.pow(0.5, dt / 4000);
      if (p.working) { working++; active[p.section] += 1 + Math.min(1, p.energy / 2); }
    }
    // Steps per second across the world, smoothed; tempo follows steps per working machine.
    this.rate += (this.steps / (dt / 1000) - this.rate) * Math.min(1, dt / 2000);
    this.steps = 0;
    const perMachine = working ? this.rate / working : 0;
    const crowd = Math.log2(1 + working) / 10;           // a bigger orchestra is a little more exciting
    const target = working ? Math.min(1, perMachine / 2.2 + crowd) : 0;
    this.intensity += (target - this.intensity) * Math.min(1, dt / 1200);
    this.bpm += (62 + 66 * this.intensity - this.bpm) * Math.min(1, dt / 1500);
    this.climax(now);
    if (!working) { this.nextNote = now; return { working, total }; }
    if (now >= this.nextNote) this.beat(now, active);
    if (this.intensity >= .3 && now >= this.nextDrive) this.drive(now);
    return { working, total };
  },

  climax(now) {
    if (this.intensity > .8) {
      this.calmSince = null;
      this.peakSince ??= now;
      if (!this.shift && now - this.peakSince > 3000) {
        this.shift = 2;
        this.emit(now + LEAD_MS, 49, 100, 2.5, DRUMS);
        this.emit(now + LEAD_MS, this.chordAt(36)[0], 90, 1.5, TIMPANI);
      }
    } else {
      this.peakSince = null;
      if (this.intensity < .5) {
        this.calmSince ??= now;
        if (this.shift && now - this.calmSince > 4000) this.shift = 0;
      }
    }
  },

  beat(now, active) {
    const score = SONGS[this.song], key = KEYS[this.song];
    const [pitch, beats] = score[this.position];
    const seconds = 60 / this.bpm * beats;
    this.nextNote = now + seconds * 1000;
    const at = now + LEAD_MS, d = Math.min(3, seconds * .9);
    const previous = this.chord;
    this.chord = harmonize(pitch, key, this.chord);
    const changed = this.chord !== previous || this.position % 4 === 0;
    const loud = 1 + .35 * this.intensity;
    const most = Math.max(1, ...active);
    const level = (s) => active[s] ? (.55 + .45 * Math.log2(1 + active[s]) / Math.log2(1 + most)) * loud : 0;
    const v = (base, s) => base * level(s) * 1.7;
    // Piano always carries the theme (quietly when its section is empty).
    this.emit(at, pitch, 54 * Math.max(level(0), .6 * loud) * 1.7, d, 0);
    const bass = this.chordAt(36)[0] < 40 ? this.chordAt(36)[0] + 12 : this.chordAt(36)[0];
    if (changed) this.emit(at, bass, 30 * 1.7 * loud, Math.min(3, seconds * 1.8), 0);
    if (active[1] && changed) for (const p of this.chordAt(60)) this.emit(at, p, v(27, 1), Math.min(3, seconds * 3), 1);
    if (active[2]) this.emit(at, pitch, v(30, 2), Math.min(3, seconds * 1.3), 2);
    if (active[3]) this.emit(at, changed ? this.chordAt(36)[0] : this.chordAt(36)[2], v(changed ? 40 : 27, 3), changed ? Math.min(3, seconds * 2) : d, 3);
    if (active[4]) this.emit(at, pitch + 12, v(24, 4), d, 4);
    if (active[5]) this.emit(at, this.chordAt(84)[this.position % 3], v(24, 5), .4, 5);
    if (active[6] && changed) { const m = this.chordAt(48); this.emit(at, m[0], v(24, 6), Math.min(3, seconds * 3), 6); this.emit(at, m[2], v(24, 6), Math.min(3, seconds * 3), 6); }
    if (active[7]) this.emit(at, this.chordAt(60)[(this.position + 1) % 3], v(22, 7), Math.min(2, seconds * 1.5), 7);
    if (this.intensity > .6) this.emit(at, pitch + 12, 27 * loud * 1.7, d, 0);
    this.songMs += seconds * 1000;
    this.position++;
    if (this.position >= score.length) {
      this.position = 0;
      if (this.songMs >= MIN_SONG_MS && this.intensity <= .5) {
        const tonic = chordTones(null, key, 48);
        for (const p of [tonic[0] - 12, ...tonic.map((x) => x + 12)]) this.emit(at + seconds * 900, p, 55, 2.5, 0);
        this.nextNote = now + seconds * 1000 + 2 * 60000 / this.bpm;
        this.index++; this.songMs = 0; this.chord = null;
      }
    }
  },

  drive(now) {
    const level = this.intensity, at = now + LEAD_MS;
    this.nextDrive = now + 30000 / this.bpm;
    const e = this.eighth++ % 8;
    const vel = (b, s) => (b + s * level) * 1.7 * (1 + .35 * level);
    this.emit(at, level > .85 && e % 2 ? 46 : 42, vel(18, 40), .1, DRUMS);
    if (level > .4) { const r = this.chordAt(36)[0]; this.emit(at, e % 2 ? r + 12 : r, vel(22, 45), .18, 0); }
    if (level > .5 && (e === 0 || e === 4 || (level > .8 && e % 2 === 0))) this.emit(at, 36, vel(40, 55), .2, DRUMS);
    if (level > .65 && (e === 2 || e === 6)) this.emit(at, 38, vel(35, 55), .15, DRUMS);
    if (level > .6 && e === 0) for (const p of this.chordAt(48)) this.emit(at, p, vel(15, 35), 30 / this.bpm * 8, TREMOLO);
    if (level > .7 && e === 0) this.emit(at, this.chordAt(36)[0], vel(25, 50), .6, TIMPANI);
  },
};

// ---------- listeners (SSE) ----------
const listeners = new Set();

function seatsSnapshot() {
  return SECTIONS.map((_, s) => seatsTaken[s].map((id) => (id ? players.get(id)?.sessions || 1 : 0)));
}

function send(res, data) { res.write(`data: ${JSON.stringify(data)}\n\n`); }

let lastSeats = -1, lastTick = Date.now(), frameNotes = [], stats = { working: 0, total: 0 };
setInterval(() => {
  const now = Date.now();
  stats = conductor.tick(now, now - lastTick);
  lastTick = now;
  frameNotes.push(...conductor.out.splice(0));
}, 25);

setInterval(() => {
  const now = Date.now();
  const pulses = [];
  for (const p of players.values()) if (now - p.pulse < 400) pulses.push([p.section, p.seat]);
  let claudes = 0;
  for (const p of players.values()) claudes += p.sessions;
  const frame = {
    t: now, notes: frameNotes.splice(0), pulses,
    players: stats.total, working: stats.working, claudes, listeners: listeners.size,
    bpm: Math.round(conductor.bpm), intensity: Math.round(conductor.intensity * 100) / 100,
    climax: Boolean(conductor.shift), song: TITLES[conductor.song],
  };
  if (seatsVersion !== lastSeats) { frame.seats = seatsSnapshot(); lastSeats = seatsVersion; }
  for (const res of listeners) send(res, frame);
}, 200);

// ---------- http ----------
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon" };
const hits = new Map();         // ip -> [windowStart, count]

function limited(ip, now) {
  const h = hits.get(ip) || [now, 0];
  if (now - h[0] > 1000) { h[0] = now; h[1] = 0; }
  h[1]++;
  hits.set(ip, h);
  if (hits.size > 50_000) hits.clear();
  return h[1] > 8;
}

function json(res, code, data) {
  res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(data));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const now = Date.now();
  const ip = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
  if (req.method === "POST" && url.pathname === "/api/play") {
    if (limited(ip, now)) return json(res, 429, { error: "slow down" });
    let raw = "";
    for await (const chunk of req) { raw += chunk; if (raw.length > 2048) return json(res, 413, { error: "too big" }); }
    let body;
    try { body = JSON.parse(raw); } catch { return json(res, 400, { error: "json" }); }
    if (typeof body.id !== "string" || !/^[a-f0-9]{16,64}$/.test(body.id)) return json(res, 400, { error: "id" });
    const p = report(body.id, body, now);
    if (!p) return json(res, 503, { error: "full" });
    return json(res, 200, { section: SECTIONS[p.section], seat: p.seat, players: players.size });
  }
  if (req.method === "GET" && url.pathname === "/api/stream") {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive", "x-accel-buffering": "no" });
    res.write("retry: 2000\n\n");
    listeners.add(res);
    send(res, { t: now, seats: seatsSnapshot(), sections: SECTIONS, notes: [], pulses: [] });
    req.on("close", () => listeners.delete(res));
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/health") return json(res, 200, { ok: true, players: players.size, listeners: listeners.size });
  if (req.method !== "GET") return json(res, 405, { error: "method" });
  const path = normalize(url.pathname === "/" ? "/index.html" : url.pathname).replace(/^(\.\.[/\\])+/, "");
  try {
    const file = await readFile(join(WEB, path));
    res.writeHead(200, { "content-type": TYPES[extname(path)] || "application/octet-stream", "cache-control": "public, max-age=300" });
    res.end(file);
  } catch {
    res.writeHead(404); res.end("not found");
  }
});

server.listen(PORT, () => console.log(`Agent Orchestra · http://localhost:${PORT}`));
