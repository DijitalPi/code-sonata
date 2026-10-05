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
import { loadGeo, country } from "./geo.mjs";

const PORT = Number(process.env.PORT || 4480);
const WEB = join(fileURLToPath(new URL(".", import.meta.url)), "web");
const SECTIONS = ["piano", "strings", "choir", "cello", "flute", "vibraphone", "horn", "harp", "accordion"];
const TIMPANI = 8, TREMOLO = 9, DRUMS = 10, ACCORDION = 11;   // engine voices; section 8 plays voice 11
const LEAD_MS = 900;            // notes are scheduled this far ahead so every listener can play them on time
const PLAYER_TTL = 30_000;      // a machine that stops reporting leaves its seat
const MAX_PLAYERS = 100_000;
const MIN_SONG_MS = 120_000;
const TEAMS = ["claude", "codex", "other", "listen"];   // stadium stands
const TOOLS = ["claude", "codex", "other"];
try { console.log(`geo: ${loadGeo(join(fileURLToPath(new URL(".", import.meta.url)), "geo/dbip-country-ipv4.csv.gz"))} ranges`); }
catch (error) { console.log(`geo: disabled (${error.message})`); }

// Country from the request; the IP itself is never stored. Cloudflare's header wins if present.
function countryOf(req) {
  const header = String(req.headers["cf-ipcountry"] || "").toUpperCase();
  if (/^[A-Z]{2}$/.test(header) && header !== "XX" && header !== "T1") return header;
  const ip = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
  return country(ip);
}

// ---------- players ----------
const players = new Map();      // id -> {section, seat, last, working, sessions, energy, pulse}
const seatsTaken = SECTIONS.map(() => []);   // section -> array of ids (holes = null)
let seatsVersion = 0;

// Real orchestra proportions: many strings, a few harps, one piano soloist row.
const SHARE = { piano: .03, strings: .26, choir: .16, cello: .16, flute: .1, vibraphone: .07, horn: .11, harp: .06, accordion: .05 };
const seated = SECTIONS.map(() => 0);

function seatFor(id) {
  let best = 0;
  for (let s = 1; s < SECTIONS.length; s++) {
    if ((seated[s] + 1) / SHARE[SECTIONS[s]] < (seated[best] + 1) / SHARE[SECTIONS[best]]) best = s;
  }
  seated[best]++;
  const row = seatsTaken[best];
  let seat = row.indexOf(null);
  if (seat < 0) { seat = row.length; row.push(id); } else row[seat] = id;
  seatsVersion++;
  return { section: best, seat };
}

function report(id, body, now, cc) {
  let p = players.get(id);
  if (!p) {
    if (players.size >= MAX_PLAYERS) return null;
    p = { ...seatFor(id), energy: 0, pulse: 0, cc: cc || "" };
    players.set(id, p);
  } else if (cc && p.cc !== cc) { p.cc = cc; seatsVersion++; }
  const steps = Math.max(0, Math.min(200, Number(body.steps) || 0));
  p.last = now;
  p.working = Boolean(body.working);
  p.sessions = Math.max(1, Math.min(64, Number(body.sessions) || 1));
  const tools = body.tools && typeof body.tools === "object" ? body.tools : {};
  p.tools = Object.fromEntries(TOOLS.map((t) => [t, Math.max(0, Math.min(64, Number(tools[t]) || 0))]));
  const tool = TOOLS.reduce((a, b) => (p.tools[b] > p.tools[a] ? b : a), "claude");
  if (p.tool !== tool) { p.tool = tool; seatsVersion++; }
  p.energy = Math.min(6, p.energy + steps);
  if (steps) { p.pulse = now; conductor.steps += steps; score(p.cc, steps); }
  for (const signal of (Array.isArray(body.signals) ? body.signals.slice(0, 4) : [])) {
    if (["ship", "pass", "fail"].includes(signal)) conductor.signal(signal, p.section, now);
    if (signal === "ship") cheers.add(p.tool || "claude");
  }
  return p;
}

const cheers = new Set();       // stands that start a wave this frame

// ---------- country league ----------
// Score = steps with a 5 minute half-life, so a country that falls behind can catch up.
const HALF_LIFE = 5 * 60_000, MIN_PASSION_PLAYERS = 3, LEAD_HOLD = 5_000, LEAD_FANFARE_GAP = 20_000;
const scores = new Map();       // cc -> score
const league = { leader: null, since: 0, candidate: null, fanfareAt: 0, announce: null, total: [], passion: [] };

function score(cc, steps) { if (cc && steps) scores.set(cc, (scores.get(cc) || 0) + steps); }

function updateLeague(now, dt) {
  const decay = Math.pow(.5, dt / HALF_LIFE);
  const members = new Map();
  for (const p of players.values()) if (p.cc) members.set(p.cc, (members.get(p.cc) || 0) + 1);
  for (const [cc, v] of scores) { const next = v * decay; if (next < .05 && !members.has(cc)) scores.delete(cc); else scores.set(cc, next); }
  const rows = [...scores].map(([cc, v]) => ({ cc, score: Math.round(v), players: members.get(cc) || 0 }));
  league.total = rows.filter((r) => r.score > 0).sort((a, b) => b.score - a.score);
  league.passion = rows.filter((r) => r.players >= MIN_PASSION_PLAYERS && r.score > 0)
    .map((r) => ({ ...r, perPlayer: Math.round((r.score / r.players) * 10) / 10 }))
    .sort((a, b) => b.perPlayer - a.perPlayer);
  // A new leader must hold first place for a few seconds before it is announced.
  const top = league.total[0]?.cc || null;
  if (top !== league.leader) {
    if (top !== league.candidate) { league.candidate = top; league.since = now; }
    else if (now - league.since > LEAD_HOLD) {
      const previous = league.leader;
      league.leader = top;
      if (previous && top && now - league.fanfareAt > LEAD_FANFARE_GAP) {
        league.fanfareAt = now;
        league.announce = { cc: top, previous };
        const t = conductor.chordAt(60), at = now + LEAD_MS;
        [t[0], t[1], t[2], t[0] + 12].forEach((p, i) => conductor.emit(at + i * 140, p, 62, .45 + i * .15, 6));
      }
    }
  } else league.candidate = top;
}

function expire(now) {
  for (const [id, p] of players) {
    if (now - p.last > PLAYER_TTL) {
      seatsTaken[p.section][p.seat] = null;
      seated[p.section]--;
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

  lastSignal: {},

  signal(kind, section, now) {
    // In a crowd these would never stop: one fanfare per 10 s, no error chords on the site.
    if (kind === "fail" || now - (this.lastSignal[kind] || 0) < 10_000) return;
    this.lastSignal[kind] = now;
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
    if (this.intensity >= .45 && now >= this.nextDrive) this.drive(now);
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

  // Arranged like an orchestra, not everyone at once: one voice carries the melody per
  // phrase, sections join as excitement grows, each in its own register.
  beat(now, active) {
    const score = SONGS[this.song], key = KEYS[this.song];
    const [pitch, beats] = score[this.position];
    const beat = 60 / this.bpm, seconds = beat * beats;
    this.nextNote = now + seconds * 1000;
    const at = now + LEAD_MS, I = this.intensity;
    const previous = this.chord;
    this.chord = harmonize(pitch, key, this.chord);
    const changed = this.chord !== previous || this.position % 8 === 0;
    const loud = (1 + .3 * I) * 1.7;
    const most = Math.max(1, ...active);
    const level = (s) => (.6 + .4 * Math.log2(1 + active[s]) / Math.log2(1 + most)) * loud;
    const on = (s, from) => active[s] > 0 && I >= from;
    const pad = Math.min(2.4, beat * 2.2);       // pads end before the next chord can clash
    // Melody: one voice per phrase, rotating among the sections that are playing.
    const singers = [0, 8, 4, 1, 2].filter((s) => s === 0 || on(s, s === 2 ? .55 : s === 8 ? 0 : .3));
    const lead = singers[Math.floor(this.position / 8 + this.index) % singers.length];
    const leadPitch = lead === 4 ? pitch + 12 : pitch;                    // flute an octave up
    const voiceOf = (s) => (s === 8 ? ACCORDION : s);
    this.solo = at;                              // the leading country's flags light up on melody notes
    this.emit(at, leadPitch, (lead === 0 ? 56 : 48) * (lead === 0 ? Math.max(.75, level(0) / loud) * loud : level(lead)), Math.min(2.6, seconds * .92), voiceOf(lead));
    if (this.shift) this.emit(at, leadPitch + 12, 22 * loud, Math.min(2.6, seconds * .9), 0);   // climax only
    // Accompaniment leaves the melody's note (and its neighbours) to the melody.
    const clear = (p) => (Math.abs(p - leadPitch) <= 2 ? null : p);
    // Bass, low register: cello once it has joined, otherwise the piano's left hand.
    const low = this.chordAt(36);
    if (changed) {
      if (on(3, .25)) this.emit(at, low[0], 40 * level(3), pad, 3);
      else this.emit(at, low[0] < 40 ? low[0] + 12 : low[0], 28 * loud, pad, 0);
    } else if (on(3, .45) && this.position % 2 === 0) this.emit(at, low[2], 26 * level(3), beat * .9, 3);
    // Middle: strings pad (unless they lead), horns and choir only when it builds.
    // Registers like a real score: bass 36-47, horns 48-59, strings 60-71, choir 72-83, harp/vibes 84+.
    const band = (p, lo) => { while (p >= lo + 12) p -= 12; while (p < lo) p += 12; return p; };
    const mid = this.chordAt(60).map((p) => band(p, 60));
    if (changed && lead !== 1 && on(1, 0)) for (const p of mid.map(clear).filter(Boolean)) this.emit(at, p, 20 * level(1), pad, 1);
    if (changed && on(6, .6)) { const h = this.chordAt(48); this.emit(at, band(h[0], 48), 24 * level(6), pad, 6); this.emit(at, band(h[2], 48), 22 * level(6), pad, 6); }
    if (changed && lead !== 2 && on(2, .75)) for (const p of mid.map((x) => clear(band(x, 72))).filter(Boolean)) this.emit(at, p, 16 * level(2), pad, 2);
    // Accordion "oom-pah": short off-beat chords when it is not singing the melody.
    if (lead !== 8 && on(8, .3) && this.position % 2 === 1) for (const p of mid.map(clear).filter(Boolean)) this.emit(at, p, 16 * level(8), beat * .35, ACCORDION);
    // Top: harp and vibraphone sparkle, sparse and high.
    const top = this.chordAt(84);
    if (on(7, .2) && this.position % 2 === 1) this.emit(at, band(top[this.position % 3], 84), 20 * level(7), beat * 1.2, 7);
    if (changed && on(5, .5) && this.position % 2 === 0) this.emit(at, band(top[1], 84), 18 * level(5), .5, 5);
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
    // No ticking clock: a soft offbeat hat only when really excited; walking bass on the beat.
    if (level > .7 && e % 2) this.emit(at, level > .9 ? 46 : 42, vel(4, 22), .08, DRUMS);
    if (level > .6 && (e === 0 || e === 4)) this.emit(at, 36, vel(36, 50), .2, DRUMS);
    if (level > .72 && (e === 2 || e === 6)) this.emit(at, 38, vel(30, 45), .15, DRUMS);
    if (level > .8 && e === 0) this.emit(at, this.chordAt(36)[0], vel(20, 40), .6, TIMPANI);
  },
};

// ---------- listeners (SSE) = the audience ----------
const listeners = new Map();     // res -> {cc, team}

function sit(res, cc, team) { listeners.set(res, { cc, team }); }
function leave(res) { listeners.delete(res); }

function teamStats() {
  const agents = Object.fromEntries(TOOLS.map((t) => [t, 0]));
  for (const p of players.values()) for (const t of TOOLS) agents[t] += p.tools?.[t] || 0;
  const fans = Object.fromEntries(TEAMS.map((t) => [t, 0]));
  for (const l of listeners.values()) fans[l.team]++;
  return { agents, fans };
}

function seatsSnapshot() {
  return SECTIONS.map((_, s) => seatsTaken[s].map((id) => {
    const p = id && players.get(id);
    return p ? [p.sessions || 1, p.cc || "", p.tool || "claude"] : 0;
  }));
}

function countries() {
  const count = new Map();
  for (const p of players.values()) if (p.cc) count.set(p.cc, (count.get(p.cc) || 0) + 1);
  for (const l of listeners.values()) if (l.cc) count.set(l.cc, (count.get(l.cc) || 0) + 1);
  return [...count].sort((a, b) => b[1] - a[1]);
}

function send(res, data) { res.write(`data: ${JSON.stringify(data)}\n\n`); }

let lastSeats = -1, lastTick = Date.now(), frameNotes = [], stats = { working: 0, total: 0 };
let countryList = [], countryAt = 0;
setInterval(() => {
  const now = Date.now();
  stats = conductor.tick(now, now - lastTick);
  updateLeague(now, now - lastTick);
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
  if (now - countryAt > 1000) { countryList = countries(); countryAt = now; frame.ranks = league.total.map((r) => r.cc); }
  frame.countries = countryList.slice(0, 12);
  frame.teams = teamStats();
  frame.league = { leader: league.leader, total: league.total.slice(0, 6), passion: league.passion.slice(0, 6) };
  if (conductor.solo) { frame.solo = conductor.solo; conductor.solo = 0; }
  if (league.announce) { frame.announce = league.announce; league.announce = null; }
  if (conductor.shift && Math.random() < .08) TEAMS.forEach((t) => cheers.add(t));   // climax: the whole stadium waves now and then
  if (cheers.size) frame.cheers = [...cheers];
  cheers.clear();
  frame.countryCount = countryList.length;
  for (const res of listeners.keys()) send(res, frame);
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
    const p = report(body.id, body, now, countryOf(req));
    if (!p) return json(res, 503, { error: "full" });
    return json(res, 200, { section: SECTIONS[p.section], seat: p.seat, players: players.size });
  }
  if (req.method === "GET" && url.pathname === "/api/stream") {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive", "x-accel-buffering": "no" });
    res.write("retry: 2000\n\n");
    const cc = countryOf(req);
    const team = TEAMS.includes(url.searchParams.get("team")) ? url.searchParams.get("team") : "listen";
    sit(res, cc, team);
    send(res, { t: now, seats: seatsSnapshot(), you: { cc, team }, sections: SECTIONS, notes: [], pulses: [] });
    req.on("close", () => leave(res));
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
