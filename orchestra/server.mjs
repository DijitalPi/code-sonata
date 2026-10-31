// Agent Orchestra: one conductor, every participating machine is a seat.
// Zero dependencies (node:http). Players POST step counts; listeners get notes
// stamped with server time over Server-Sent Events and play them in sync.
//
//   PORT=4480 node orchestra/server.mjs
import http from "node:http";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { TITLES } from "./web/music.mjs";
import { createConductor } from "./web/conductor.mjs";
import { cleanSeats } from "./web/seats.mjs";
import { loadGeo, country } from "./geo.mjs";

const PORT = Number(process.env.PORT || 4480);
const WEB = join(fileURLToPath(new URL(".", import.meta.url)), "web");
// The standalone reader (repo root, one file, Python 3 only) is served at /reader.py, so joining
// needs no copy of this repository.
const READER = join(fileURLToPath(new URL("..", import.meta.url)), "reader.py");
const publicURL = process.env.PUBLIC_URL ? new URL(process.env.PUBLIC_URL) : null;
if (publicURL && (!["http:", "https:"].includes(publicURL.protocol) || publicURL.username || publicURL.password)) throw new Error("PUBLIC_URL must be an http/https origin without credentials");
const PUBLIC_URL = publicURL?.origin || "";
const SECTIONS = ["piano", "strings", "choir", "cello", "flute", "vibraphone", "horn", "harp", "accordion"];
const PLAYER_TTL = 30_000;      // a machine that stops reporting leaves its seat
const MAX_PLAYERS = 2000;        // bounded local release candidate; 500 machines measured below this ceiling
// Fair play: one office may run many machines, one script may not run thousands.
// A machine that sleeps past PLAYER_TTL joins again as new, so the hourly allowance is twice the ceiling.
const MAX_MACHINES_PER_IP = 20, NEW_MACHINES_PER_IP_HOUR = 2 * MAX_MACHINES_PER_IP;
// An event link is for a room on one shared network: at a hackathon the whole venue is one address,
// so per-address limits rise for requests that carry a key from EVENT_KEYS (comma separated,
// 16-64 of [A-Za-z0-9_-]). Global ceilings stay. Without the variable there are no event links.
const EVENT_KEYS = new Set(String(process.env.EVENT_KEYS || "").split(",").map((k) => k.trim()).filter((k) => /^[A-Za-z0-9_-]{16,64}$/.test(k)));
const isEvent = (k) => typeof k === "string" && EVENT_KEYS.has(k);
const EVENT_PER_IP = 300;
const STEP_RATE = 12, STEP_BURST = 40;   // steps per second a machine can score, and its burst
// A team in one office shares one address: a pilot of 12 people must all hear the hall. One script still
// cannot take the whole hall (1000 seats) from one address.
const LISTENERS_PER_IP = 32, MAX_LISTENERS = 1000;
const TEAMS = ["claude", "codex", "other", "listen"];   // stadium stands
const TOOLS = ["claude", "codex", "other"];
try { console.log(`geo: ${loadGeo(join(fileURLToPath(new URL(".", import.meta.url)), "geo/dbip-country-ipv4.csv.gz"))} ranges`); }
catch (error) { console.log(`geo: disabled (${error.message})`); }

// Behind our own proxy (TRUST_PROXY=1) the real client is the last address the proxy appended
// to X-Forwarded-For; anything before it was written by the client and can be forged. Without a
// proxy, only the socket address counts.
const TRUST_PROXY = process.env.TRUST_PROXY === "1";
// Behind Cloudflare (TRUST_CF=1, origin reachable only from Cloudflare) the proxy's last hop is a Cloudflare
// edge, shared by thousands of people: the client is in Cloudflare's own header. Its country header is believed
// only then too; otherwise any client could write it.
const TRUST_CF = TRUST_PROXY && process.env.TRUST_CF === "1";
let warnedProxy = false;
function clientIp(req) {
  if (TRUST_CF) {
    const cf = String(req.headers["cf-connecting-ip"] || "").trim();
    if (/^[0-9a-fA-F.:]{2,45}$/.test(cf)) return cf;
  }
  if (TRUST_PROXY) {
    const chain = String(req.headers["x-forwarded-for"] || "").split(",").map((x) => x.trim()).filter(Boolean);
    if (chain.length) return chain[chain.length - 1];
  } else if (req.headers["x-forwarded-for"] && !warnedProxy) {
    warnedProxy = true;   // behind a proxy without TRUST_PROXY=1 every visitor shares the proxy's address and its limits
    console.log("warning: X-Forwarded-For arrives but TRUST_PROXY is not 1; all visitors count as one address");
  }
  return String(req.socket.remoteAddress || "");
}

// Rate limits need to recognise an address, not know it: a salted hash that changes every
// restart. The IP itself is never kept, not even in memory. One IPv6 subscriber gets a whole /64,
// so an IPv6 address counts by its first four groups.
const SALT = randomBytes(16);
function addressGroup(ip) {
  ip = ip.split("%")[0];
  if (/^::ffff:\d+\.\d+\.\d+\.\d+$/i.test(ip)) return ip.slice(7);
  if (!ip.includes(":")) return ip;
  const [head, tail = ""] = ip.split("::"), h = head ? head.split(":") : [], t = tail ? tail.split(":") : [];
  const groups = [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill("0"), ...t];
  return `${groups.slice(0, 4).map((g) => parseInt(g, 16).toString(16)).join(":")}::/64`;
}
const ipKey = (ip) => createHash("sha256").update(SALT).update(addressGroup(ip)).digest("base64url").slice(0, 16);

// Country from the request, then the IP is dropped.
// Test tools label their machines and listeners as simulated; production ignores the label so
// nobody can put "test hall" on every visitor's screen.
const ALLOW_SIMULATION = process.env.ALLOW_SIMULATION === "1";
function countryOf(req, ip) {
  const header = String(req.headers["cf-ipcountry"] || "").toUpperCase();
  if (TRUST_CF && /^[A-Z]{2}$/.test(header) && header !== "XX" && header !== "T1") return header;
  return country(ip);
}

// The hall's clock: the wall clock, except that it never steps back (an NTP correction would silence the hall
// for as long as the step). A step forward (the host woke up) is followed.
let anchor = Date.now() - performance.now();
function wall() {
  let t = anchor + performance.now();
  const d = Date.now();
  if (d > t + 1000) { anchor += d - t; t = d; }
  return Math.round(t);
}

// ---------- players ----------
const players = new Map();      // id -> {section, seat, last, working, sessions, energy, pulse}
// Secrets never enter the public stream. Pairing is opt-in and expires after an hour.
const pairs = new Map();
const PAIR_TTL = 3_600_000;
// One address cannot use up pairing for everyone, while an office (one address) pairs every person in it.
const MAX_PAIRS_PER_IP = 32;
setInterval(() => {
  const now = wall();
  for (const [token, pair] of pairs) if (now - pair.created > PAIR_TTL) pairs.delete(token);
  for (const [id, [, left]] of returning) { if (now - left < RETURN_MS) break; returning.delete(id); }   // oldest first
}, 1000).unref();
const ACTIVITY = ["edit", "bash", "read", "think", "done"];
const bounded = (value, max) => Number.isFinite(Number(value)) ? Math.max(0, Math.min(max, Math.floor(Number(value)))) : 0;

// A key that expired, was removed or belongs to another machine only ends the private view:
// the machine keeps its seat in the shared orchestra and the reader is told to drop the key.
function paired(body, now) {
  if (!body.pair) return { pair: null, state: null };
  const pair = pairs.get(body.pair);
  if (!pair || now - pair.created > PAIR_TTL) return { pair: null, state: "expired" };
  if (pair.id && pair.id !== body.id) return { pair: null, state: "used" };
  return { pair, state: "ok" };
}
const seatsTaken = SECTIONS.map(() => []);   // section -> array of ids (holes = null)
const changedSeats = new Set();   // "section:seat" to send as a delta (full list only on connect)
const markSeat = (section, seat) => changedSeats.add(`${section}:${seat}`);

// Real orchestra proportions: many strings, a few harps, one piano soloist row.
const SHARE = { piano: .03, strings: .26, choir: .16, cello: .16, flute: .1, vibraphone: .07, horn: .11, harp: .06, accordion: .05 };
const seated = SECTIONS.map(() => 0);

// The two soloist chairs (piano, accordion) go to whoever arrives while they are free, then every
// empty section, so each newcomer adds a layer of its own to the loops. After that everyone goes
// where the orchestra is thinnest for its proportions, so ten people from one country still make a
// whole orchestra. Compatriots share a section when that costs little (the hall also groups each
// country together inside a section).
const SOLOISTS = [SECTIONS.indexOf("piano"), SECTIONS.indexOf("accordion")];
const countrySeats = new Map();     // cc -> players per section
const HOME_TOLERANCE = 1.15;
// A machine that slept past PLAYER_TTL (a closed lid, a coffee break) gets its own instrument back for
// twenty minutes, unless that section has since grown much fuller than the one it would get instead.
const returning = new Map();        // id -> [section, left at]
const RETURN_MS = 20 * 60_000, RETURN_TOLERANCE = 1.5;

function seatFor(id, cc, now) {
  const back = returning.get(id);
  returning.delete(id);
  // An empty section a sleeper may come back to is the last empty one a newcomer gets.
  const kept = new Set();
  for (const [, [s, left]] of returning) if (now - left < RETURN_MS && seated[s] === 0) kept.add(s);
  const load = (s) => (seated[s] + 1) / SHARE[SECTIONS[s]];
  const lightest = (pick) => {
    let found = -1;
    for (let s = 0; s < SECTIONS.length; s++) if (!SOLOISTS.includes(s) && pick(s) && (found < 0 || load(s) < load(found))) found = s;
    return found;
  };
  let best = SOLOISTS.find((s) => seated[s] < 1 && !kept.has(s));
  if (best === undefined) {
    best = lightest((s) => seated[s] === 0 && !kept.has(s));
    if (best < 0) best = SOLOISTS.find((s) => seated[s] < 1) ?? lightest((s) => seated[s] === 0);
    if (best < 0) {
      best = lightest(() => true);
      const mine = cc && countrySeats.get(cc), home = mine ? lightest((s) => mine[s] > 0) : -1;
      if (home >= 0 && load(home) <= load(best) * HOME_TOLERANCE) best = home;
    }
  }
  // Back to its own section if that is still empty; into a shared one only when no section is empty.
  if (back && now - back[1] < RETURN_MS) {
    const s = back[0], anyEmpty = SECTIONS.some((_, x) => seated[x] === 0);
    if (seated[s] === 0 || (!SOLOISTS.includes(s) && !anyEmpty && load(s) <= load(best) * RETURN_TOLERANCE)) best = s;
  }
  if (cc) { const row = countrySeats.get(cc) || SECTIONS.map(() => 0); row[best]++; countrySeats.set(cc, row); }
  seated[best]++;
  const row = seatsTaken[best];
  let seat = row.indexOf(null);
  if (seat < 0) { seat = row.length; row.push(id); } else row[seat] = id;
  markSeat(best, seat);
  return { section: best, seat };
}

const ipMachines = new Map();     // ip key -> machines seated from it
const ipNew = new Map();          // ip key -> [window start, new machines in the last hour]

// A machine coming back from sleep (known within RETURN_MS) is not a new one: lunch breaks and meetings must
// not use up an office's hourly allowance. It still counts against the address's concurrent machines.
function admit(key, now, event, known = false) {
  const w = ipNew.get(key);
  if (!w || now - w[0] > 3_600_000) ipNew.set(key, [now, 0]);
  const most = event ? EVENT_PER_IP : MAX_MACHINES_PER_IP, newest = event ? EVENT_PER_IP : NEW_MACHINES_PER_IP_HOUR;
  if ((ipMachines.get(key) || 0) >= most || (!known && ipNew.get(key)[1] >= newest)) return false;
  if (!known) ipNew.get(key)[1]++;
  ipMachines.set(key, (ipMachines.get(key) || 0) + 1);
  if (ipNew.size > 200_000) ipNew.clear();
  return true;
}

function report(id, body, now, cc, key, pair, event) {
  let p = players.get(id);
  // The same machine from another address (a laptop moved from Wi-Fi to a phone's hotspot) takes its seat along
  // once the old address has gone quiet; two addresses at once is someone else using the id.
  if (p && p.key !== key) {
    if (now - p.last < 5000 || !admit(key, now, event, true)) return null;
    const left = (ipMachines.get(p.key) || 1) - 1;
    if (left > 0) ipMachines.set(p.key, left); else ipMachines.delete(p.key);
    p.key = key;
  }
  if (!p) {
    const back = returning.get(id), known = Boolean(back && now - back[1] < RETURN_MS);
    if (players.size >= MAX_PLAYERS || !admit(key, now, event, known)) return null;
    p = { ...seatFor(id, cc, now), simulation: body.simulation === true, energy: 0, pulse: 0, cc: cc || "", key, allow: STEP_BURST, allowAt: now };
    players.set(id, p);
    if (!p.simulation) count("machine", key, now);
  }
  // A machine scores at most STEP_RATE steps a second (burst STEP_BURST): a script cannot
  // flood the league, while a busy developer with many sessions never hits it.
  p.allow = Math.min(STEP_BURST, p.allow + ((now - p.allowAt) / 1000) * STEP_RATE);
  p.allowAt = now;
  const steps = Math.min(Math.floor(p.allow), bounded(body.steps, 200));
  p.allow -= steps;
  p.last = now;
  p.working = body.working === true;
  const sessions = bounded(body.sessions, 64);
  if (sessions !== p.sessions) { p.sessions = sessions; markSeat(p.section, p.seat); }
  const tools = body.tools && typeof body.tools === "object" ? body.tools : {};
  p.tools = Object.fromEntries(TOOLS.map((t) => [t, bounded(tools[t], 64)]));
  const tool = TOOLS.reduce((a, b) => (p.tools[b] > p.tools[a] ? b : a), "other");
  if (p.tool !== tool) { p.tool = tool; markSeat(p.section, p.seat); }
  p.energy = Math.min(6, p.energy + steps);
  if (steps) { p.pulse = now; conductor.steps += steps; score(p.cc, steps); }
  if (pair) {
    pair.id = id; pair.last = now; pair.steps += steps;
    pair.section = p.section; pair.seat = p.seat;
    pair.working = p.working; pair.sessions = sessions;
    let remaining = steps;
    for (const kind of ACTIVITY) {
      const count = Math.min(remaining, bounded(body.activity?.[kind], 200));
      pair.activity[kind] += count; remaining -= count;
    }
    pair.activity.think += remaining;
    if (steps) pair.lastActivity = now;
  }
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
      const row = p.cc && countrySeats.get(p.cc);
      if (row) { row[p.section] = Math.max(0, row[p.section] - 1); if (!row.some(Boolean)) countrySeats.delete(p.cc); }
      players.delete(id);
      returning.set(id, [p.section, now]);
      if (returning.size > 20_000) returning.delete(returning.keys().next().value);   // the longest gone first
    }
  }
}

// ---------- conductor ----------
// The music itself lives in web/conductor.mjs (the demo concert plays it in the browser too); the
// server tells it who is on stage: machines that stop reporting leave, energy fades. The hall plays
// loops (flow): a section with a real working machine is "featured" and plays its layer at any pace,
// so a person can hear their own part. HALL=songs plays the songs instead (START_SONG only for tests).
function population(now, dt) {
  expire(now);
  let working = 0, total = 0;
  const active = SECTIONS.map(() => 0), featured = new Set();
  for (const p of players.values()) {
    total++;
    p.energy *= Math.pow(.5, dt / 4000);
    if (p.working) { working++; active[p.section]++; if (!p.simulation) featured.add(p.section); }
  }
  return { working, total, active, listening: listeners.size, featured: [...featured] };
}
// Notes leave up to a frame (250 ms) after they are written and must still be early on a phone whose
// connection stalls for a second (a cell handover): 1.5 s ahead instead of the conductor's 0.9 s.
const conductor = createConductor({ population, flow: process.env.HALL !== "songs", song: process.env.START_SONG || "bella-ciao", leadMs: 1500 });
const title = () => (conductor.flow ? conductor.flowTitle() : TITLES[conductor.song]);

// ---------- listeners (SSE) = the audience ----------
const listeners = new Map();     // res -> {cc, team}

function sit(res, cc, team, simulation = false) { listeners.set(res, { cc, team, simulation }); }
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
    return p ? [p.sessions || 0, p.cc || "", p.tool || "other"] : 0;
  }));
}

function countries() {
  const count = new Map();
  for (const p of players.values()) if (p.cc) count.set(p.cc, (count.get(p.cc) || 0) + 1);
  for (const l of listeners.values()) if (l.cc) count.set(l.cc, (count.get(l.cc) || 0) + 1);
  return [...count].sort((a, b) => b[1] - a[1]);
}

function seatEntry(section, seat) {
  const id = seatsTaken[section][seat];
  const p = id && players.get(id);
  return p ? [p.sessions || 0, p.cc || "", p.tool || "other"] : 0;
}

// Every frame (4 a second): notes, who just played, one-off events. Once a second: counters,
// league, teams. Seats travel as changes only; the full list goes once, on connect. A frame is
// serialised once and the same bytes go to every listener.
const FRAME_MS = 250, META_MS = 1000, MAX_PULSES = 60;

// Counters: once a second in the stream. Countries, teams and the league go only when they changed
// (the page keeps the last ones); a new listener gets everything at once (`full`).
const sentGroups = {};
function meta(full = false) {
  countryList = countries();
  let claudes = 0, simulated = 0;
  for (const p of players.values()) { claudes += p.sessions; if (p.simulation) simulated++; }
  const out = {
    players: players.size, simulated, simulatedListeners: [...listeners.values()].filter(l => l.simulation).length, working: stats.working, claudes, listeners: listeners.size,
    bpm: Math.round(conductor.bpm), intensity: Math.round(conductor.intensity * 100) / 100,
    climax: Boolean(conductor.shift), song: title(),
    house: !stats.working && listeners.size > 0, lastActive: conductor.lastActive, peak: conductor.peak,
  };
  const groups = {
    countries: { countries: countryList.slice(0, 12), countryCount: countryList.length },
    teams: { teams: teamStats() },
    league: { league: { leader: league.leader, total: league.total.slice(0, 6), passion: league.passion.slice(0, 6) }, ranks: league.total.map((r) => r.cc) },
  };
  for (const [name, group] of Object.entries(groups)) {
    const text = JSON.stringify(group);
    if (full || text !== sentGroups[name]) Object.assign(out, group);
    if (full) delete sentGroups[name];   // the snapshot may already be stale by the next frame: send every group again then
    else sentGroups[name] = text;
  }
  return out;
}
let lastTick = wall(), leagueAt = lastTick, frameNotes = [], stats = { working: 0, total: 0 };
let countryList = [], metaAt = 0;
setInterval(() => {
  const now = wall();
  if (now - leagueAt >= 1000) { updateLeague(now, now - leagueAt); leagueAt = now; }   // once a second, not every tick
  // An empty hall: no music to make. `lastTick` stays, so the first tick after it covers the whole gap and the
  // conductor's sense of pace (its two-minute average) has forgotten the old crowd by then.
  if (!players.size && !listeners.size && !conductor.clock) return;
  stats = conductor.tick(now, now - lastTick);
  lastTick = now;
  frameNotes.push(...conductor.out.splice(0));
}, 25);

setInterval(() => {
  const now = wall();
  if (!listeners.size) {            // nobody to send to: drop this frame's news (a new listener gets a full snapshot)
    frameNotes.length = 0; changedSeats.clear(); cheers.clear(); conductor.solo = 0; league.announce = null;
    return;
  }
  let pulses = [];
  for (const p of players.values()) if (now - p.pulse < 2 * FRAME_MS) pulses.push([p.section, p.seat]);
  if (pulses.length > MAX_PULSES) {           // a crowd: a fair sample still looks alive
    for (let i = pulses.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [pulses[i], pulses[j]] = [pulses[j], pulses[i]]; }
    pulses = pulses.slice(0, MAX_PULSES);
  }
  // A note's time goes as milliseconds from the frame's own `t` (a few digits instead of thirteen).
  const frame = { t: now, notes: frameNotes.splice(0).map((n) => { n[0] -= now; return n; }), pulses };
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
  // A listener that stops reading (a phone asleep with the socket open) is cut once 64 KB wait here on top of
  // what the system's socket buffers (and a proxy) already hold: minutes, not seconds. Its page connects again
  // when it wakes, and a thousand stuck sockets hold at most 64 MB here.
  const line = `data: ${JSON.stringify(frame)}\n\n`;
  for (const res of listeners.keys()) {
    if (res.writableLength > 64 * 1024) res.destroy();
    else res.write(line);
  }
}, FRAME_MS);

// ---------- usage counts ----------
// Daily totals only: how many visits, listens, demos, moments, new machines, and roughly how many
// different addresses did each (the salted address key lives in memory for the day and is never
// written; a restart starts that day's "unique" again). No cookies, no identities. Read with
// METRICS_KEY; kept across restarts in METRICS_FILE when set. Sixty days are kept.
const METRIC_NAMES = new Set(["visit", "invited", "listen", "demo", "connection", "moment", "video", "invite", "brand"]);
const METRICS_KEY = process.env.METRICS_KEY || "", METRICS_FILE = process.env.METRICS_FILE || "";
let usage = {}, usageDay = "", usageDirty = false;
const seenToday = new Map();        // name -> Set(salted address key), today only
try { if (METRICS_FILE) usage = JSON.parse(readFileSync(METRICS_FILE, "utf8")).days || {}; } catch { /* first run */ }
function count(name, key, now) {
  const day = new Date(now).toISOString().slice(0, 10);
  if (day !== usageDay) {
    usageDay = day; seenToday.clear();
    for (const old of Object.keys(usage).sort().slice(0, -59)) delete usage[old];
  }
  const row = ((usage[day] ||= {})[name] ||= { count: 0, unique: 0 });
  row.count++;
  const seen = seenToday.get(name) || new Set();
  if (!seen.has(key) && seen.size < 200_000) { seen.add(key); row.unique++; seenToday.set(name, seen); }
  usageDirty = true;
}
function saveUsage() {
  if (!METRICS_FILE || !usageDirty) return;
  try {
    writeFileSync(`${METRICS_FILE}.tmp`, JSON.stringify({ days: usage })); renameSync(`${METRICS_FILE}.tmp`, METRICS_FILE);
    usageDirty = false;     // only after the file is really written; a failed write is retried
  } catch (error) { console.log(`metrics: not saved, will retry (${error.message})`); }
}
if (METRICS_FILE) {
  setInterval(saveUsage, 60_000).unref();
  for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => { saveUsage(); process.exit(0); });
}
const sameSecret = (given, secret) => { const a = Buffer.from(given), b = Buffer.from(secret); return a.length === b.length && timingSafeEqual(a, b); };

// ---------- seat holders ----------
// Sold seats live in SEATS_FILE (JSON, edited by hand until payment exists) and their images in SEATS_DIR.
// The file is read again within a minute of a change; anything malformed is left out (see web/seats.mjs).
const SEATS_FILE = process.env.SEATS_FILE || "", SEATS_DIR = process.env.SEATS_DIR || "";
let seatHolders = [], seatsRead = 0;
function loadSeats() {
  if (!SEATS_FILE) return;
  try {
    const changed = statSync(SEATS_FILE).mtimeMs;
    if (changed === seatsRead) return;
    seatHolders = cleanSeats(JSON.parse(readFileSync(SEATS_FILE, "utf8"))); seatsRead = changed;
  } catch (error) { console.log(`seats: not read (${error.message})`); }
}
loadSeats();
if (SEATS_FILE) setInterval(loadSeats, 60_000).unref();

// ---------- http ----------
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".json": "application/json", ".py": "text/plain; charset=utf-8", ".txt": "text/plain; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".woff2": "font/woff2", ".webp": "image/webp", ".jpg": "image/jpeg", ".jpeg": "image/jpeg" };
const hits = new Map();         // ip key -> [windowStart, count]: pages and pairing
const polls = new Map(), pollIPs = new Map();   // pairing / ip key -> [windowStart, count]: a page asking for its own view
const plays = new Map();        // ip key -> [windowStart, count]: machines reporting
const listenerIPs = new Map();

// Counts a request in its one-second window and returns how many came so far.
function tally(map, key, now) {
  const h = map.get(key) || [now, 0];
  if (now - h[0] > 1000) { h[0] = now; h[1] = 0; }
  h[1]++;
  map.set(key, h);
  if (map.size > 50_000) for (const [k, w] of map) if (now - w[0] > 1000) map.delete(k);   // many addresses: drop finished windows only
  return h[1];
}
const limited = (map, key, now, max) => tally(map, key, now) > max;
// Every request counts against its address before its body is read, broken and oversized ones too. Whether
// it carries an event key is known only after reading, so until then the event allowance applies, if any.
const anyEvent = EVENT_KEYS.size > 0;
// Each machine reports once a second, so one address may send as many reports as it may seat
// machines (twice that: a slow second can bunch two reports together).
const PAGE_RATE = 8, playRate = (event) => 2 * (event ? EVENT_PER_IP : MAX_MACHINES_PER_IP);

// Small JSON objects only: over 2 KiB, unreadable or not an object is answered here and gives null.
async function readJson(req, res, empty) {
  const chunks = [];
  let size = 0;     // real bytes: a character split across two chunks must not count twice
  try { for await (const chunk of req) { size += chunk.length; if (size > 2048) { json(res, 413, { error: "too big" }); return null; } chunks.push(chunk); } }
  catch { json(res, 400, { error: "body" }); return null; }
  const raw = Buffer.concat(chunks).toString("utf8");
  let body;
  try { body = JSON.parse(raw || empty); } catch { json(res, 400, { error: "json" }); return null; }
  if (!body || typeof body !== "object" || Array.isArray(body)) { json(res, 400, { error: "object" }); return null; }
  return body;
}

function json(res, code, data) {
  res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(data));
}

// Requests that dribble in (slowloris) are cut within a second of their 10 s limit, not after Node's default 30 s
// check. Idle connections stay longer than a proxy keeps its own (Traefik: 90 s), so the proxy never reuses one
// this server is closing.
const server = http.createServer({ connectionsCheckingInterval: 1000, requestTimeout: 10_000, headersTimeout: 10_000, keepAliveTimeout: 95_000 }, async (req, res) => {
  let url;
  try { url = new URL(req.url, "http://x"); }
  catch { return json(res, 400, { error: "url" }); }
  const now = wall();
  const ip = clientIp(req), key = ipKey(ip);
  // Requests another web site makes its visitors' browsers send (a page that seats fake machines or holds
  // listener seats from every visitor): a browser says where a request comes from, this site's own page is same-origin.
  const site = req.headers["sec-fetch-site"], origin = req.headers.origin;
  const foreign = (site && site !== "same-origin" && site !== "none")
    || (origin && origin !== `${TRUST_PROXY ? "https" : "http"}://${req.headers.host}` && origin !== `http://${req.headers.host}`);
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("referrer-policy", "no-referrer");
  res.setHeader("permissions-policy", "microphone=(), camera=(), geolocation=()");
  res.setHeader("x-frame-options", "DENY");
  // Code, fonts and sound come only from this site; blob: is for moments made in the browser.
  res.setHeader("content-security-policy", "default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
  if (req.method === "POST" && ["/api/pair", "/api/me", "/api/unpair"].includes(url.pathname)) {
    if (foreign) return json(res, 403, { error: "origin" });
    // Each page asks for its own pairing every two seconds: that poll is limited per pairing, so an office of
    // pages on one address never trips the address's page limit.
    const me = url.pathname === "/api/me", rate = (e) => e ? EVENT_PER_IP : me ? LISTENERS_PER_IP : PAGE_RATE;
    const seen = tally(me ? pollIPs : hits, key, now);
    if (seen > rate(anyEvent)) return json(res, 429, { error: "slow down" });
    const body = await readJson(req, res, "{}");
    if (!body) return;
    const event = isEvent(body.event);
    if (seen > rate(event) || (me && limited(polls, String(body.pair).slice(0, 64), now, 5))) return json(res, 429, { error: "slow down" });
    for (const [token, pair] of pairs) if (now - pair.created > PAIR_TTL) pairs.delete(token);
    if (url.pathname === "/api/pair") {
      if (pairs.size >= 5000) return json(res, 503, { error: "pair capacity" });
      let mine = 0;
      for (const pair of pairs.values()) if (pair.key === key) mine++;
      if (mine >= (event ? EVENT_PER_IP : MAX_PAIRS_PER_IP)) return json(res, 429, { error: "too many pairs" });
      const token = randomBytes(24).toString("hex");
      pairs.set(token, { key, created: now, last: 0, lastActivity: 0, steps: 0, activity: Object.fromEntries(ACTIVITY.map(k => [k, 0])) });
      return json(res, 201, { pair: token, expires: now + PAIR_TTL });
    }
    const pair = pairs.get(body.pair);
    if (!pair) return json(res, 404, { error: "pair expired" });
    if (url.pathname === "/api/unpair") { pairs.delete(body.pair); return json(res, 200, { ok: true }); }
    const connected = pair.last > 0 && now - pair.last <= PLAYER_TTL;
    return json(res, 200, { connected, waiting: !pair.last, steps: pair.steps, activity: pair.activity,
      lastActivity: pair.lastActivity, working: connected && pair.working, sessions: connected ? pair.sessions : 0,
      section: connected ? pair.section : null, seat: connected ? pair.seat : null, expires: pair.created + PAIR_TTL });
  }
  if (req.method === "POST" && url.pathname === "/api/play") {
    // Only the reader plays: it sends JSON and no browser headers. A browser cannot send that type to another
    // site without asking first, and this server never says yes.
    if (foreign || site || !/^application\/json\b/i.test(String(req.headers["content-type"] || ""))) return json(res, 403, { error: "reader only" });
    const seen = tally(plays, key, now);
    if (seen > playRate(anyEvent)) return json(res, 429, { error: "slow down" });
    const body = await readJson(req, res, "");
    if (!body) return;
    const event = isEvent(body.event);
    if (seen > playRate(event)) return json(res, 429, { error: "slow down" });
    if (typeof body.id !== "string" || !/^[a-f0-9]{16,64}$/.test(body.id)) return json(res, 400, { error: "id" });
    if (body.simulation === true && !ALLOW_SIMULATION) return json(res, 403, { error: "simulation disabled" });
    if (body.pair && (body.simulation || players.get(body.id)?.simulation)) return json(res, 403, { error: "simulation cannot pair" });
    const { pair, state } = paired(body, now);
    const p = report(body.id, body, now, players.has(body.id) ? null : countryOf(req, ip), key, pair, event);
    if (!p) return json(res, 429, { error: "too many machines from here" });
    return json(res, 200, { section: SECTIONS[p.section], seat: p.seat, players: players.size, ...(state && { pair: state }) });
  }
  if (req.method === "GET" && url.pathname === "/api/stream") {
    if (foreign) return json(res, 403, { error: "origin" });
    const event = isEvent(url.searchParams.get("event"));
    if (listeners.size >= MAX_LISTENERS || (listenerIPs.get(key) || 0) >= (event ? EVENT_PER_IP : LISTENERS_PER_IP)) return json(res, 429, { error: "too many listeners" });
    listenerIPs.set(key, (listenerIPs.get(key) || 0) + 1);
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive", "x-accel-buffering": "no" });
    const cc = countryOf(req, ip);
    const team = TEAMS.includes(url.searchParams.get("team")) ? url.searchParams.get("team") : "listen";
    sit(res, cc, team, ALLOW_SIMULATION && url.searchParams.get("simulation") === "1");
    res.write(`retry: 2000\n\ndata: ${JSON.stringify({ t: now, seats: seatsSnapshot(), you: { cc, team }, sections: SECTIONS, notes: [], pulses: [], ...meta(true) })}\n\n`);
    req.on("close", () => {
      leave(res);
      const count = (listenerIPs.get(key) || 1) - 1;
      if (count) listenerIPs.set(key, count); else listenerIPs.delete(key);
    });
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/metric") {
    if (foreign) return json(res, 403, { error: "origin" });
    if (limited(hits, key, now, PAGE_RATE)) return json(res, 429, { error: "slow down" });
    const body = await readJson(req, res, "");
    if (!body) return;
    if (!METRIC_NAMES.has(body.name)) return json(res, 400, { error: "name" });
    count(body.name, key, now);
    res.writeHead(204, { "cache-control": "no-store" });
    return res.end();
  }
  if (req.method === "GET" && url.pathname === "/api/metrics") {
    if (!METRICS_KEY || !sameSecret(String(req.headers.authorization || ""), `Bearer ${METRICS_KEY}`)) { res.writeHead(404); return res.end("not found"); }
    return json(res, 200, { days: usage });
  }
  // `now`: the hall's clock, so a page can tell how far behind the stream reaches it (see app.js).
  if (["GET", "HEAD"].includes(req.method) && url.pathname === "/api/health") return json(res, 200, { ok: true, players: players.size, listeners: listeners.size, now });
  if (req.method !== "GET" && req.method !== "HEAD") return json(res, 405, { error: "method" });   // HEAD: same headers, no body
  if (url.pathname === "/api/seats") return json(res, 200, { seats: seatHolders });
  if (url.pathname.startsWith("/seat-images/")) {
    const name = url.pathname.slice("/seat-images/".length);
    try {
      if (!SEATS_DIR || !/^[a-z0-9-]{1,40}\.(webp|png|jpe?g)$/.test(name)) throw new Error("no such image");
      const file = await readFile(join(SEATS_DIR, name));
      res.writeHead(200, { "content-type": TYPES[extname(name)], "cache-control": "public, max-age=86400" });
      return res.end(file);
    } catch { res.writeHead(404); return res.end("not found"); }
  }
  if (url.pathname === "/reader.py") {
    try {
      const file = await readFile(READER);
      res.writeHead(200, { "content-type": TYPES[".py"], "cache-control": "no-cache", "content-disposition": "inline; filename=reader.py" });
      return res.end(file);
    } catch { res.writeHead(404); return res.end("not found"); }
  }
  const path = normalize(url.pathname === "/" ? "/index.html" : url.pathname).replace(/^(\.\.[/\\])+/, "");
  try {
    const file = await readFile(join(WEB, path));
    // Page and code revalidate every load, so a new version shows up right away. The sound engine
    // and samples are pinned by version and checksum, so browsers keep them for a year.
    const pinned = /^[/\\](vendor|sounds)[/\\]/.test(path);
    const fresh = [".html", ".js", ".mjs", ".json", ".css"].includes(extname(path));
    res.writeHead(200, { "content-type": TYPES[extname(path)] || "application/octet-stream", "cache-control": pinned ? "public, max-age=31536000, immutable" : fresh ? "no-cache" : "public, max-age=3600" });
    const output = extname(path) === ".html" && PUBLIC_URL ? file.toString()
      .replaceAll('content="/og.png"', `content="${PUBLIC_URL}/og.png"`)
      .replace("</head>", `<meta property="og:url" content="${PUBLIC_URL}/"><link rel="canonical" href="${PUBLIC_URL}/"></head>`) : file;
    res.end(output);
  } catch {
    res.writeHead(404); res.end("not found");
  }
});

server.listen(PORT, process.env.HOST || "127.0.0.1", () => console.log(`Agent Orchestra · http://localhost:${PORT}`));
