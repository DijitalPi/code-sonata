// Agent Orchestra: one conductor, every participating machine is a seat.
// Zero dependencies (node:http). Players POST step counts; listeners get notes
// stamped with server time over Server-Sent Events and play them in sync.
//
//   PORT=4480 node orchestra/server.mjs
import http from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { SONGS, KEYS, TITLES, PLANS, METERS, MOODS, chordTones } from "./music.mjs";
import { loadGeo, country } from "./geo.mjs";

const PORT = Number(process.env.PORT || 4480);
const WEB = join(fileURLToPath(new URL(".", import.meta.url)), "web");
const SECTIONS = ["piano", "strings", "choir", "cello", "flute", "vibraphone", "horn", "harp", "accordion"];
const TIMPANI = 8, TREMOLO = 9, DRUMS = 10, ACCORDION = 11;   // engine voices; section 8 plays voice 11
const LEAD_MS = 900;            // notes are scheduled this far ahead so every listener can play them on time
const PLAYER_TTL = 30_000;      // a machine that stops reporting leaves its seat
const MAX_PLAYERS = 100_000;
// Fair play: one office may run many machines, one script may not run thousands.
const MAX_MACHINES_PER_IP = 20, NEW_MACHINES_PER_IP_HOUR = 10;
const STEP_RATE = 12, STEP_BURST = 40;   // steps per second a machine can score, and its burst
const MIN_SONG_MS = Number(process.env.MIN_SONG_MS || 120_000);   // shorter only for tests
const TEAMS = ["claude", "codex", "other", "listen"];   // stadium stands
const TOOLS = ["claude", "codex", "other"];
try { console.log(`geo: ${loadGeo(join(fileURLToPath(new URL(".", import.meta.url)), "geo/dbip-country-ipv4.csv.gz"))} ranges`); }
catch (error) { console.log(`geo: disabled (${error.message})`); }

// Behind our own proxy (TRUST_PROXY=1) the real client is the last address the proxy appended
// to X-Forwarded-For; anything before it was written by the client and can be forged. Without a
// proxy, only the socket address counts.
const TRUST_PROXY = process.env.TRUST_PROXY === "1";
function clientIp(req) {
  if (TRUST_PROXY) {
    const chain = String(req.headers["x-forwarded-for"] || "").split(",").map((x) => x.trim()).filter(Boolean);
    if (chain.length) return chain[chain.length - 1];
  }
  return String(req.socket.remoteAddress || "");
}

// Rate limits need to recognise an address, not know it: a salted hash that changes every
// restart. The IP itself is never kept, not even in memory.
const SALT = randomBytes(16);
const ipKey = (ip) => createHash("sha256").update(SALT).update(ip).digest("base64url").slice(0, 16);

// Country from the request, then the IP is dropped. Cloudflare's header only behind our proxy.
function countryOf(req, ip) {
  const header = String(req.headers["cf-ipcountry"] || "").toUpperCase();
  if (TRUST_PROXY && /^[A-Z]{2}$/.test(header) && header !== "XX" && header !== "T1") return header;
  return country(ip);
}

// ---------- players ----------
const players = new Map();      // id -> {section, seat, last, working, sessions, energy, pulse}
const seatsTaken = SECTIONS.map(() => []);   // section -> array of ids (holes = null)
const changedSeats = new Set();   // "section:seat" to send as a delta (full list only on connect)
const markSeat = (section, seat) => changedSeats.add(`${section}:${seat}`);

// Real orchestra proportions: many strings, a few harps, one piano soloist row.
const SHARE = { piano: .03, strings: .26, choir: .16, cello: .16, flute: .1, vibraphone: .07, horn: .11, harp: .06, accordion: .05 };
const seated = SECTIONS.map(() => 0);

// Every country sits in one place: its delegation gets a section, later compatriots join it.
// The two soloist chairs (piano, accordion) go to whoever arrives while they are free.
const SOLOISTS = [SECTIONS.indexOf("piano"), SECTIONS.indexOf("accordion")];
const countrySection = new Map();   // cc -> section
const countryCount = new Map();     // cc -> players

function seatFor(id, cc) {
  let best = SOLOISTS.find((s) => seated[s] < 1);
  if (best === undefined && cc && countrySection.has(cc)) best = countrySection.get(cc);
  if (best === undefined) {
    best = -1;
    for (let s = 0; s < SECTIONS.length; s++) {
      if (SOLOISTS.includes(s)) continue;
      if (best < 0 || (seated[s] + 1) / SHARE[SECTIONS[s]] < (seated[best] + 1) / SHARE[SECTIONS[best]]) best = s;
    }
    if (cc) countrySection.set(cc, best);
  }
  if (cc) countryCount.set(cc, (countryCount.get(cc) || 0) + 1);
  seated[best]++;
  const row = seatsTaken[best];
  let seat = row.indexOf(null);
  if (seat < 0) { seat = row.length; row.push(id); } else row[seat] = id;
  markSeat(best, seat);
  return { section: best, seat };
}

const ipMachines = new Map();     // ip key -> machines seated from it
const ipNew = new Map();          // ip key -> [window start, new machines in the last hour]

function admit(key, now) {
  const w = ipNew.get(key);
  if (!w || now - w[0] > 3_600_000) ipNew.set(key, [now, 0]);
  if ((ipMachines.get(key) || 0) >= MAX_MACHINES_PER_IP || ipNew.get(key)[1] >= NEW_MACHINES_PER_IP_HOUR) return false;
  ipNew.get(key)[1]++;
  ipMachines.set(key, (ipMachines.get(key) || 0) + 1);
  if (ipNew.size > 200_000) ipNew.clear();
  return true;
}

function report(id, body, now, cc, key) {
  let p = players.get(id);
  if (!p) {
    if (players.size >= MAX_PLAYERS || !admit(key, now)) return null;
    p = { ...seatFor(id, cc), energy: 0, pulse: 0, cc: cc || "", key, allow: STEP_BURST, allowAt: now };
    players.set(id, p);
  }
  // A machine scores at most STEP_RATE steps a second (burst STEP_BURST): a script cannot
  // flood the league, while a busy developer with many sessions never hits it.
  p.allow = Math.min(STEP_BURST, p.allow + ((now - p.allowAt) / 1000) * STEP_RATE);
  p.allowAt = now;
  const steps = Math.min(Math.floor(p.allow), Math.max(0, Math.min(200, Number(body.steps) || 0)));
  p.allow -= steps;
  p.last = now;
  p.working = Boolean(body.working);
  const sessions = Math.max(1, Math.min(64, Number(body.sessions) || 1));
  if (sessions !== p.sessions) { p.sessions = sessions; markSeat(p.section, p.seat); }
  const tools = body.tools && typeof body.tools === "object" ? body.tools : {};
  p.tools = Object.fromEntries(TOOLS.map((t) => [t, Math.max(0, Math.min(64, Number(tools[t]) || 0))]));
  const tool = TOOLS.reduce((a, b) => (p.tools[b] > p.tools[a] ? b : a), "claude");
  if (p.tool !== tool) { p.tool = tool; markSeat(p.section, p.seat); }
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
        conductor.cue("lead");                  // a horn call on the next bar line
      }
    }
  } else league.candidate = top;
}

function expire(now) {
  for (const [id, p] of players) {
    if (now - p.last > PLAYER_TTL) {
      seatsTaken[p.section][p.seat] = null;
      seated[p.section]--;
      markSeat(p.section, p.seat);
      const fromIp = (ipMachines.get(p.key) || 1) - 1;
      if (fromIp > 0) ipMachines.set(p.key, fromIp); else ipMachines.delete(p.key);
      if (p.cc) {
        const left = (countryCount.get(p.cc) || 1) - 1;
        if (left > 0) countryCount.set(p.cc, left);
        else { countryCount.delete(p.cc); countrySection.delete(p.cc); }
      }
      players.delete(id);
    }
  }
}

// ---------- conductor ----------
// One clock for everything: notes sit on an ideal timeline (not "whenever the 25 ms timer
// fires"), and every part, drums included, comes from the same song beat grid.
const LOOKAHEAD_MS = 150;
const eq = (a, b) => Math.abs(a - b) < 1e-9;

const conductor = {
  song: process.env.START_SONG || "bella-ciao", songCount: 0,   // START_SONG only for tests
  history: [], position: 0, songBeat: 0, chord: null, nextChange: 0,
  bpm: 66, intensity: 0, shift: 0, targetShift: 0,
  clock: 0, steps: 0, short: 0, long: 0, songMs: 0,
  peakSince: null, calmSince: null, climaxSince: 0, coolUntil: 0,
  active: [], working: 0, cues: [], lastSignal: {}, solo: 0, out: [],
  house: false, lastActive: 0, peak: 0, peakDay: "",

  // The next song follows the agents' pace: calm, warm or wild. No repeats of the last two.
  pickSong() {
    const I = this.intensity;
    const mood = I >= .7 ? "wild" : I >= .35 ? "warm" : "calm";
    const pool = MOODS[mood].filter((s) => !this.history.slice(-2).includes(s) && s !== this.song);
    const next = pool[0] || MOODS[mood].find((s) => s !== this.song) || MOODS.warm.find((s) => s !== this.song);
    this.history.push(this.song);
    if (this.history.length > 6) this.history.shift();
    return next;
  },
  chordAt(octave) { return chordTones(this.chord, KEYS[this.song], octave); },
  band(p, lo) { while (p >= lo + 12) p -= 12; while (p < lo) p += 12; return p; },

  emit(at, p, v, d, i) {
    if (i !== DRUMS) p += this.shift;
    this.out.push([Math.round(at), Math.max(0, Math.min(127, p)), Math.max(1, Math.min(120, Math.round(v))), Math.round(d * 1000) / 1000, i]);
  },

  // Signals become cues that play on the next bar line, in key and in time.
  signal(kind, section, now) {
    if (kind === "fail" || now - (this.lastSignal[kind] || 0) < 10_000) return;   // no error chords on the site
    this.lastSignal[kind] = now;
    this.cue(kind);
  },
  cue(kind) { if (!this.cues.includes(kind)) this.cues.push(kind); },

  tick(now, dt) {
    expire(now);
    let working = 0, total = 0;
    const active = SECTIONS.map(() => 0);
    for (const p of players.values()) {
      total++;
      p.energy *= Math.pow(.5, dt / 4000);
      if (p.working) { working++; active[p.section]++; }
    }
    this.active = active; this.working = working;
    // Excitement follows a speed-up (pace now vs. the last two minutes) plus some absolute pace:
    // a steady crowd settles, a speed-up builds, a burst peaks.
    const rate = this.steps / Math.max(.001, dt / 1000);
    this.steps = 0;
    this.short += (rate - this.short) * Math.min(1, dt / 3000);
    this.long += (rate - this.long) * Math.min(1, dt / 120_000);
    const pace = working ? Math.min(1, this.short / working / 2) : 0;
    const surge = working ? Math.max(0, Math.min(1, (this.short / Math.max(this.long, .4 * working) - .9) / 1.2)) : 0;
    let target = working ? Math.min(1, .55 * pace + .45 * surge) : 0;
    if (now < this.coolUntil) target = Math.min(target, .6);            // after a climax, breathe
    this.intensity += (target - this.intensity) * Math.min(1, dt / 1500);
    this.bpm += (66 + 50 * this.intensity - this.bpm) * Math.min(1, dt / 2500);   // 66..116
    this.climax(now);
    // Nobody working but someone listening: the house pianist plays (piano only, calm, soft)
    // until the agents return. Never shown as a participant; the page says it is the house.
    if (working) this.lastActive = now;
    const day = new Date(now).toISOString().slice(0, 10);
    if (day !== this.peakDay) { this.peakDay = day; this.peak = 0; }
    this.peak = Math.max(this.peak, total);
    this.house = !working && listeners.size > 0;
    if (!working && !this.house) { this.clock = 0; return { working, total }; }
    if (!this.clock || this.clock < now - 500) this.clock = now;        // start, or recover from a stall
    while (this.clock <= now + LOOKAHEAD_MS) this.note(this.clock);
    return { working, total };
  },

  // A climax is a moment, not a state: at most 20 s, then 30 s below it.
  climax(now) {
    if (this.intensity > .8 && now >= this.coolUntil) {
      this.calmSince = null;
      this.peakSince ??= now;
      if (!this.targetShift && now - this.peakSince > 3000) { this.targetShift = 2; this.climaxSince = now; this.cue("climax"); }
      if (this.targetShift && now - this.climaxSince > 20_000) { this.coolUntil = now + 30_000; this.targetShift = 0; }
    } else {
      this.peakSince = null;
      if (this.intensity < .55) {
        this.calmSince ??= now;
        if (this.targetShift && now - this.calmSince > 3000) this.targetShift = 0;
      }
    }
  },

  // One melody note, plus everything on the grid while it sounds.
  note(t) {
    const score = SONGS[this.song], plan = PLANS[this.song], key = KEYS[this.song];
    const [pitch, beats] = score[this.position];
    const step = plan[this.position];
    const beatMs = 60_000 / this.bpm, I = this.intensity, active = this.active;
    const at = t + LEAD_MS;
    this.chord = step.chord;
    this.nextChange = step.nextChange;
    const on = (s, from) => active[s] > 0 && I >= from;
    const crowd = this.house ? .7 : .85 + .15 * Math.min(1, Math.log2(1 + this.working) / 6);   // house: softer; a bigger orchestra, a bit fuller
    const vel = (base) => base * 1.7 * (1 + .25 * I) * crowd;
    // Melody: one section per phrase (8 notes), rotating among the sections on stage.
    const singers = [0, 8, 4, 1, 2].filter((s) => s === 0 || on(s, s === 2 ? .5 : s === 8 ? 0 : .25));
    const lead = singers[Math.floor(this.position / 8 + this.songCount) % singers.length];
    const leadPitch = pitch === null ? -99 : lead === 4 ? pitch + 12 : pitch;   // flute an octave up; null = rest
    const ctx = { lead, leadPitch, on, vel, beatMs };
    for (let k = 0; k < beats - 1e-9; k += .5) this.grid(at + k * beatMs, this.songBeat + k, step, ctx, k === 0);
    if (pitch !== null) {
      this.solo = at;                                                   // the leading country glows on melody notes
      this.emit(at, leadPitch, vel(lead === 0 ? 54 : 46), Math.min(2.6, (beats * beatMs) / 1000 * .92), lead === 8 ? ACCORDION : lead);
    }
    this.songMs += beats * beatMs;
    this.songBeat += beats;
    this.clock = t + beats * beatMs;
    this.position++;
    if (this.position >= score.length) {
      this.position = 0; this.songBeat = 0;
      // Change song only at a calm moment, or to move into the wild song when things heat up.
      const heatingUp = I >= .7 && !MOODS.wild.includes(this.song);
      if (this.songMs >= MIN_SONG_MS && (I <= .5 || heatingUp)) {
        // Close the song: the tonic rings for two beats, then two beats of breath.
        const tonic = chordTones(null, key, 48), end = this.clock + LEAD_MS;
        for (const p of [tonic[0] - 12, ...tonic.map((x) => x + 12)]) this.emit(end, p, vel(30), (2 * beatMs) / 1000, 0);
        this.clock += 4 * beatMs;
        this.song = this.pickSong(); this.songCount++; this.songMs = 0;
      }
    }
  },

  grid(at, beat, step, { lead, leadPitch, on, vel, beatMs }, onset) {
    const I = this.intensity, [meter, pickup] = METERS[this.song];
    const inBar = (((beat - pickup) % meter) + meter) % meter, waltz = meter === 3;
    const barLine = eq(inBar, 0), onBeat = eq(beat % 1, 0), change = onset && step.change;
    if (barLine) this.shift = this.targetShift;                         // key changes on a bar line only
    if (barLine && this.cues.length) this.playCues(at, vel, beatMs);
    // Harmony is struck on a chord change and on each bar line, and lasts exactly until the
    // next of the two: two chords never ring on top of each other.
    if (change || barLine) {
      const until = Math.min(this.nextChange, beat + meter - inBar);
      // Samples ring ~0.3 s after release: stop early before a new chord so its tail is gone
      // when the next chord starts (no need when the same chord is struck again).
      const span = (Math.max(.25, until - beat) * beatMs) / 1000;
      const len = eq(until, this.nextChange) ? Math.max(span * .5, span - .25) : span * .94;
      this.harmony(at, len, lead, leadPitch, on, vel);
    }
    // The cello steps to the fifth halfway through a bar when the chord holds.
    if (!waltz && eq(inBar, 2) && !change && on(3, .35) && this.nextChange - beat >= 2) {
      const fifth = this.chordAt(36)[2];
      this.emit(at, fifth >= 48 ? fifth - 12 : fifth, vel(26), (2 * beatMs) / 1000 * .9, 3);
    }
    // Colour: one voice up high, on the beat: harp (every beat) or vibraphone (beats 1 and 3).
    if (onBeat && I >= .25) {
      const colour = [7, 5].filter((s) => on(s, s === 5 ? .45 : .25));
      if (colour.length) {
        const s = colour[Math.floor(this.position / 8) % colour.length];
        if (s === 7 || eq(inBar, 0) || (!waltz && eq(inBar, 2))) {
          const p = this.chordAt(84)[Math.floor(beat) % 3];
          this.emit(at, p, vel(s === 7 ? 18 : 16), s === 7 ? (beatMs / 1000) * 1.2 : .45, s);
        }
      }
    }
    // Small orchestra, no pad yet: the piano's left hand plays a flowing broken chord
    // (root, fifth, third, fifth; in three: root, fifth, third), like a pianist accompanying alone.
    if (onBeat && ![1, 6, 2].some((s) => s !== lead && on(s, s === 1 ? 0 : s === 6 ? .45 : .6)) && !barLine && !change) {
      const c = this.chordAt(60).map((p) => this.band(p, 55));        // above the muddy low register
      let p = (waltz ? [c[0], c[2], c[1]] : [c[0], c[2], c[1], c[2]])[Math.floor(inBar + 1e-9)];
      if (Math.abs(p - leadPitch) <= 2) p = c.find((x) => Math.abs(x - leadPitch) > 2) ?? null;
      if (p !== null) this.emit(at, p, vel(15), (beatMs / 1000) * .95, 0);
    }
    // Accordion "pah" on beats 2 and 4 ("pah-pah" on 2 and 3 in a waltz) when it is not singing.
    if (onBeat && !barLine && (waltz || eq(inBar % 2, 1)) && lead !== 8 && on(8, .3)) {
      for (const p of this.mid(leadPitch)) this.emit(at, p, vel(14), (beatMs / 1000) * .3, ACCORDION);
    }
    // Drums only at the climax: kick on 1 and 3, snare on 2 and 4 (waltz: kick on 1, light 2 and 3).
    if (onBeat && this.shift) {
      const kick = waltz ? barLine : eq(inBar % 2, 0);
      this.emit(at, kick ? 36 : 38, vel(kick ? 30 : waltz ? 16 : 22), .15, DRUMS);
    }
  },

  // Bass plus one pad (two at a peak), each in its own register, never on the melody's note.
  harmony(at, len, lead, leadPitch, on, vel) {
    const low = this.chordAt(36)[0];
    if (on(3, .2)) this.emit(at, low, vel(34), len, 3);                 // cello, 36-47
    else this.emit(at, low < 40 ? low + 12 : low, vel(26), len, 0);     // piano left hand
    const pads = [1, 6, 2].filter((s) => s !== lead && on(s, s === 1 ? 0 : s === 6 ? .45 : .6));
    for (const s of pads.slice(0, this.intensity >= .75 ? 2 : 1)) {
      const notes = s === 6 ? this.horn() : this.mid(leadPitch, s === 2 ? 72 : 60);
      for (const p of notes) this.emit(at, p, vel(s === 6 ? 20 : 16), len, s);
    }
  },
  mid(leadPitch, lo = 60) { return this.chordAt(60).map((p) => this.band(p, lo)).filter((p) => Math.abs(p - leadPitch) > 2); },
  horn() { const h = this.chordAt(48); return [this.band(h[0], 48), this.band(h[2], 48)]; },

  playCues(at, vel, beatMs) {
    const t = this.chordAt(60), base = this.band(t[0], 55), up = [0, t[1] - t[0], t[2] - t[0], 12];
    for (const kind of this.cues.splice(0)) {
      if (kind === "climax") { this.emit(at, 49, vel(40), 2.2, DRUMS); this.emit(at, this.chordAt(36)[0], vel(46), 1.2, TIMPANI); }
      else if (kind === "ship") for (const d of [0, up[2], 12]) this.emit(at, base + d, vel(24), (beatMs / 1000) * 2, 6);
      else up.forEach((d, i) => this.emit(at + (i * beatMs) / 2, base + d, vel(26), (beatMs / 1000) * .45, 6));   // lead / pass: rising call
    }
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

function seatEntry(section, seat) {
  const id = seatsTaken[section][seat];
  const p = id && players.get(id);
  return p ? [p.sessions || 1, p.cc || "", p.tool || "claude"] : 0;
}

// Every frame (4 a second): notes, who just played, one-off events. Once a second: counters,
// league, teams. Seats travel as changes only; the full list goes once, on connect. A frame is
// serialised once and the same bytes go to every listener.
const FRAME_MS = 250, META_MS = 1000, MAX_PULSES = 60;

// Counters, league and teams: once a second in the stream, and at once for a new listener.
function meta() {
  countryList = countries();
  let claudes = 0;
  for (const p of players.values()) claudes += p.sessions;
  return {
    players: stats.total, working: stats.working, claudes, listeners: listeners.size,
    bpm: Math.round(conductor.bpm), intensity: Math.round(conductor.intensity * 100) / 100,
    climax: Boolean(conductor.shift), song: TITLES[conductor.song],
    house: !stats.working && listeners.size > 0, lastActive: conductor.lastActive, peak: conductor.peak,
    countries: countryList.slice(0, 12), countryCount: countryList.length, teams: teamStats(),
    league: { leader: league.leader, total: league.total.slice(0, 6), passion: league.passion.slice(0, 6) },
    ranks: league.total.map((r) => r.cc),
  };
}
let lastTick = Date.now(), frameNotes = [], stats = { working: 0, total: 0 };
let countryList = [], metaAt = 0;
setInterval(() => {
  const now = Date.now();
  stats = conductor.tick(now, now - lastTick);
  updateLeague(now, now - lastTick);
  lastTick = now;
  frameNotes.push(...conductor.out.splice(0));
}, 25);

setInterval(() => {
  const now = Date.now();
  let pulses = [];
  for (const p of players.values()) if (now - p.pulse < 2 * FRAME_MS) pulses.push([p.section, p.seat]);
  if (pulses.length > MAX_PULSES) {           // a crowd: a fair sample still looks alive
    for (let i = pulses.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [pulses[i], pulses[j]] = [pulses[j], pulses[i]]; }
    pulses = pulses.slice(0, MAX_PULSES);
  }
  const frame = { t: now, notes: frameNotes.splice(0), pulses };
  if (changedSeats.size) {
    frame.seatDelta = [...changedSeats].map((k) => { const [s, i] = k.split(":").map(Number); return [s, i, seatEntry(s, i)]; });
    changedSeats.clear();
  }
  if (conductor.solo) { frame.solo = conductor.solo; conductor.solo = 0; }
  if (league.announce) { frame.announce = league.announce; league.announce = null; }
  if (conductor.shift && Math.random() < .02) TEAMS.forEach((t) => cheers.add(t));   // climax: the whole hall waves now and then
  if (cheers.size) { frame.cheers = [...cheers]; cheers.clear(); }
  if (now - metaAt >= META_MS) {
    metaAt = now;
    Object.assign(frame, meta());
  }
  const line = `data: ${JSON.stringify(frame)}\n\n`;
  for (const res of listeners.keys()) res.write(line);
}, FRAME_MS);

// ---------- http ----------
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon" };
const hits = new Map();         // ip key -> [windowStart, count]

function limited(key, now) {
  const h = hits.get(key) || [now, 0];
  if (now - h[0] > 1000) { h[0] = now; h[1] = 0; }
  h[1]++;
  hits.set(key, h);
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
  const ip = clientIp(req), key = ipKey(ip);
  if (req.method === "POST" && url.pathname === "/api/play") {
    if (limited(key, now)) return json(res, 429, { error: "slow down" });
    let raw = "";
    for await (const chunk of req) { raw += chunk; if (raw.length > 2048) return json(res, 413, { error: "too big" }); }
    let body;
    try { body = JSON.parse(raw); } catch { return json(res, 400, { error: "json" }); }
    if (typeof body.id !== "string" || !/^[a-f0-9]{16,64}$/.test(body.id)) return json(res, 400, { error: "id" });
    const p = report(body.id, body, now, players.has(body.id) ? null : countryOf(req, ip), key);
    if (!p) return json(res, 429, { error: "too many machines from here" });
    return json(res, 200, { section: SECTIONS[p.section], seat: p.seat, players: players.size });
  }
  if (req.method === "GET" && url.pathname === "/api/stream") {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive", "x-accel-buffering": "no" });
    res.write("retry: 2000\n\n");
    const cc = countryOf(req, ip);
    const team = TEAMS.includes(url.searchParams.get("team")) ? url.searchParams.get("team") : "listen";
    sit(res, cc, team);
    send(res, { t: now, seats: seatsSnapshot(), you: { cc, team }, sections: SECTIONS, notes: [], pulses: [], ...meta() });
    req.on("close", () => leave(res));
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/health") return json(res, 200, { ok: true, players: players.size, listeners: listeners.size });
  if (req.method !== "GET") return json(res, 405, { error: "method" });
  const path = normalize(url.pathname === "/" ? "/index.html" : url.pathname).replace(/^(\.\.[/\\])+/, "");
  try {
    const file = await readFile(join(WEB, path));
    // Page and code revalidate every load, so a new version shows up right away.
    const fresh = [".html", ".js", ".css"].includes(extname(path));
    res.writeHead(200, { "content-type": TYPES[extname(path)] || "application/octet-stream", "cache-control": fresh ? "no-cache" : "public, max-age=3600" });
    res.end(file);
  } catch {
    res.writeHead(404); res.end("not found");
  }
});

server.listen(PORT, () => console.log(`Agent Orchestra · http://localhost:${PORT}`));
