// Agent Orchestra: one conductor, every participating machine is a seat.
// Zero dependencies (node:http). Players POST step counts; listeners get notes
// stamped with server time over Server-Sent Events and play them in sync.
//
//   PORT=4480 node orchestra/server.mjs
import http from "node:http";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { TITLES } from "./web/music.mjs";
import { createConductor } from "./web/conductor.mjs";
import { loadGeo, country } from "./geo.mjs";

const PORT = Number(process.env.PORT || 4480);
const WEB = join(fileURLToPath(new URL(".", import.meta.url)), "web");
const publicURL = process.env.PUBLIC_URL ? new URL(process.env.PUBLIC_URL) : null;
if (publicURL && (!["http:", "https:"].includes(publicURL.protocol) || publicURL.username || publicURL.password)) throw new Error("PUBLIC_URL must be an http/https origin without credentials");
const PUBLIC_URL = publicURL?.origin || "";
const SECTIONS = ["piano", "strings", "choir", "cello", "flute", "vibraphone", "horn", "harp", "accordion"];
const PLAYER_TTL = 30_000;      // a machine that stops reporting leaves its seat
const MAX_PLAYERS = 2000;        // bounded local release candidate; 500 machines measured below this ceiling
// Fair play: one office may run many machines, one script may not run thousands.
const MAX_MACHINES_PER_IP = 20, NEW_MACHINES_PER_IP_HOUR = 10;
// An event link is for a room on one shared network: at a hackathon the whole venue is one address,
// so per-address limits rise for requests that carry a key from EVENT_KEYS (comma separated,
// 16-64 of [A-Za-z0-9_-]). Global ceilings stay. Without the variable there are no event links.
const EVENT_KEYS = new Set(String(process.env.EVENT_KEYS || "").split(",").map((k) => k.trim()).filter((k) => /^[A-Za-z0-9_-]{16,64}$/.test(k)));
const isEvent = (k) => typeof k === "string" && EVENT_KEYS.has(k);
const EVENT_PER_IP = 300;
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

// Country from the request, then the IP is dropped. Cloudflare's country header is believed only
// when the site really sits behind Cloudflare (TRUST_CF=1); otherwise any client could write it.
const TRUST_CF = TRUST_PROXY && process.env.TRUST_CF === "1";
// Test tools label their machines and listeners as simulated; production ignores the label so
// nobody can put "test hall" on every visitor's screen.
const ALLOW_SIMULATION = process.env.ALLOW_SIMULATION === "1";
function countryOf(req, ip) {
  const header = String(req.headers["cf-ipcountry"] || "").toUpperCase();
  if (TRUST_CF && /^[A-Z]{2}$/.test(header) && header !== "XX" && header !== "T1") return header;
  return country(ip);
}

// ---------- players ----------
const players = new Map();      // id -> {section, seat, last, working, sessions, energy, pulse}
// Secrets never enter the public stream. Pairing is opt-in and expires after an hour.
const pairs = new Map();
const PAIR_TTL = 3_600_000;
const MAX_PAIRS_PER_IP = 5;     // one address cannot use up pairing for everyone
setInterval(() => {
  const now = Date.now();
  for (const [token, pair] of pairs) if (now - pair.created > PAIR_TTL) pairs.delete(token);
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

function admit(key, now, event) {
  const w = ipNew.get(key);
  if (!w || now - w[0] > 3_600_000) ipNew.set(key, [now, 0]);
  const most = event ? EVENT_PER_IP : MAX_MACHINES_PER_IP, newest = event ? EVENT_PER_IP : NEW_MACHINES_PER_IP_HOUR;
  if ((ipMachines.get(key) || 0) >= most || ipNew.get(key)[1] >= newest) return false;
  ipNew.get(key)[1]++;
  ipMachines.set(key, (ipMachines.get(key) || 0) + 1);
  if (ipNew.size > 200_000) ipNew.clear();
  return true;
}

function report(id, body, now, cc, key, pair, event) {
  let p = players.get(id);
  if (p && p.key !== key) return null;
  if (!p) {
    if (players.size >= MAX_PLAYERS || !admit(key, now, event)) return null;
    p = { ...seatFor(id, cc), simulation: body.simulation === true, energy: 0, pulse: 0, cc: cc || "", key, allow: STEP_BURST, allowAt: now };
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
// The music itself lives in web/conductor.mjs (the demo concert plays it in the browser too); the
// server tells it who is on stage: machines that stop reporting leave, energy fades.
function population(now, dt) {
  expire(now);
  let working = 0, total = 0;
  const active = SECTIONS.map(() => 0);
  for (const p of players.values()) {
    total++;
    p.energy *= Math.pow(.5, dt / 4000);
    if (p.working) { working++; active[p.section]++; }
  }
  return { working, total, active, listening: listeners.size };
}
const conductor = createConductor({ population, song: process.env.START_SONG || "bella-ciao", minSongMs: MIN_SONG_MS });   // START_SONG only for tests

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

function send(res, data) { res.write(`data: ${JSON.stringify(data)}\n\n`); }

function seatEntry(section, seat) {
  const id = seatsTaken[section][seat];
  const p = id && players.get(id);
  return p ? [p.sessions || 0, p.cc || "", p.tool || "other"] : 0;
}

// Every frame (4 a second): notes, who just played, one-off events. Once a second: counters,
// league, teams. Seats travel as changes only; the full list goes once, on connect. A frame is
// serialised once and the same bytes go to every listener.
const FRAME_MS = 250, META_MS = 1000, MAX_PULSES = 60;

// Counters, league and teams: once a second in the stream, and at once for a new listener.
function meta() {
  countryList = countries();
  let claudes = 0, simulated = 0;
  for (const p of players.values()) { claudes += p.sessions; if (p.simulation) simulated++; }
  return {
    players: players.size, simulated, simulatedListeners: [...listeners.values()].filter(l => l.simulation).length, working: stats.working, claudes, listeners: listeners.size,
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
  for (const res of listeners.keys()) {
    if (res.writableLength > 256 * 1024) res.destroy();
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
  usageDirty = false;
  try { writeFileSync(`${METRICS_FILE}.tmp`, JSON.stringify({ days: usage })); renameSync(`${METRICS_FILE}.tmp`, METRICS_FILE); }
  catch (error) { console.log(`metrics: not saved (${error.message})`); }
}
if (METRICS_FILE) {
  setInterval(saveUsage, 60_000).unref();
  for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => { saveUsage(); process.exit(0); });
}
const sameSecret = (given, secret) => { const a = Buffer.from(given), b = Buffer.from(secret); return a.length === b.length && timingSafeEqual(a, b); };

// ---------- http ----------
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".txt": "text/plain; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".woff2": "font/woff2" };
const hits = new Map();         // ip key -> [windowStart, count]
const listenerIPs = new Map();

function limited(key, now, event) {
  const h = hits.get(key) || [now, 0];
  if (now - h[0] > 1000) { h[0] = now; h[1] = 0; }
  h[1]++;
  hits.set(key, h);
  if (hits.size > 50_000) hits.clear();
  return h[1] > (event ? EVENT_PER_IP : 8);
}

// Small JSON objects only: over 2 KiB, unreadable or not an object is answered here and gives null.
async function readJson(req, res, empty) {
  let raw = "";
  try { for await (const chunk of req) { raw += chunk; if (Buffer.byteLength(raw) > 2048) { json(res, 413, { error: "too big" }); return null; } } }
  catch { json(res, 400, { error: "body" }); return null; }
  let body;
  try { body = JSON.parse(raw || empty); } catch { json(res, 400, { error: "json" }); return null; }
  if (!body || typeof body !== "object" || Array.isArray(body)) { json(res, 400, { error: "object" }); return null; }
  return body;
}

function json(res, code, data) {
  res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(data));
}

const server = http.createServer(async (req, res) => {
  let url;
  try { url = new URL(req.url, "http://x"); }
  catch { return json(res, 400, { error: "url" }); }
  const now = Date.now();
  const ip = clientIp(req), key = ipKey(ip);
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("referrer-policy", "no-referrer");
  res.setHeader("permissions-policy", "microphone=(), camera=(), geolocation=()");
  res.setHeader("x-frame-options", "DENY");
  // Code, fonts and sound come only from this site; blob: is for moments made in the browser.
  res.setHeader("content-security-policy", "default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
  if (req.method === "POST" && ["/api/pair", "/api/me", "/api/unpair"].includes(url.pathname)) {
    const origin = req.headers.origin;
    if (origin && origin !== `${TRUST_PROXY ? "https" : "http"}://${req.headers.host}` && origin !== `http://${req.headers.host}`) return json(res, 403, { error: "origin" });
    const body = await readJson(req, res, "{}");
    if (!body) return;
    const event = isEvent(body.event);
    if (limited(key, now, event)) return json(res, 429, { error: "slow down" });
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
    const body = await readJson(req, res, "");
    if (!body) return;
    const event = isEvent(body.event);
    if (limited(key, now, event)) return json(res, 429, { error: "slow down" });
    if (typeof body.id !== "string" || !/^[a-f0-9]{16,64}$/.test(body.id)) return json(res, 400, { error: "id" });
    if (body.simulation === true && !ALLOW_SIMULATION) return json(res, 403, { error: "simulation disabled" });
    if (body.pair && (body.simulation || players.get(body.id)?.simulation)) return json(res, 403, { error: "simulation cannot pair" });
    const { pair, state } = paired(body, now);
    const p = report(body.id, body, now, players.has(body.id) ? null : countryOf(req, ip), key, pair, event);
    if (!p) return json(res, 429, { error: "too many machines from here" });
    return json(res, 200, { section: SECTIONS[p.section], seat: p.seat, players: players.size, ...(state && { pair: state }) });
  }
  if (req.method === "GET" && url.pathname === "/api/stream") {
    const event = isEvent(url.searchParams.get("event"));
    if (listeners.size >= 1000 || (listenerIPs.get(key) || 0) >= (event ? EVENT_PER_IP : 8)) return json(res, 429, { error: "too many listeners" });
    listenerIPs.set(key, (listenerIPs.get(key) || 0) + 1);
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive", "x-accel-buffering": "no" });
    res.write("retry: 2000\n\n");
    const cc = countryOf(req, ip);
    const team = TEAMS.includes(url.searchParams.get("team")) ? url.searchParams.get("team") : "listen";
    sit(res, cc, team, ALLOW_SIMULATION && url.searchParams.get("simulation") === "1");
    send(res, { t: now, seats: seatsSnapshot(), you: { cc, team }, sections: SECTIONS, notes: [], pulses: [], ...meta() });
    req.on("close", () => {
      leave(res);
      const count = (listenerIPs.get(key) || 1) - 1;
      if (count) listenerIPs.set(key, count); else listenerIPs.delete(key);
    });
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/metric") {
    const body = await readJson(req, res, "");
    if (!body) return;
    if (limited(key, now)) return json(res, 429, { error: "slow down" });
    if (!METRIC_NAMES.has(body.name)) return json(res, 400, { error: "name" });
    count(body.name, key, now);
    res.writeHead(204, { "cache-control": "no-store" });
    return res.end();
  }
  if (req.method === "GET" && url.pathname === "/api/metrics") {
    if (!METRICS_KEY || !sameSecret(String(req.headers.authorization || ""), `Bearer ${METRICS_KEY}`)) { res.writeHead(404); return res.end("not found"); }
    return json(res, 200, { days: usage });
  }
  if (req.method === "GET" && url.pathname === "/api/health") return json(res, 200, { ok: true, players: players.size, listeners: listeners.size });
  if (req.method !== "GET") return json(res, 405, { error: "method" });
  const path = normalize(url.pathname === "/" ? "/index.html" : url.pathname).replace(/^(\.\.[/\\])+/, "");
  try {
    const file = await readFile(join(WEB, path));
    // Page and code revalidate every load, so a new version shows up right away. The sound engine
    // and samples are pinned by version and checksum, so browsers keep them for a year.
    const pinned = /^[/\\](vendor|sounds)[/\\]/.test(path);
    const fresh = [".html", ".js", ".css"].includes(extname(path));
    res.writeHead(200, { "content-type": TYPES[extname(path)] || "application/octet-stream", "cache-control": pinned ? "public, max-age=31536000, immutable" : fresh ? "no-cache" : "public, max-age=3600" });
    const output = extname(path) === ".html" && PUBLIC_URL ? file.toString()
      .replaceAll('content="/og.png"', `content="${PUBLIC_URL}/og.png"`)
      .replace("</head>", `<meta property="og:url" content="${PUBLIC_URL}/"><link rel="canonical" href="${PUBLIC_URL}/"></head>`) : file;
    res.end(output);
  } catch {
    res.writeHead(404); res.end("not found");
  }
});

server.requestTimeout = 10_000;
server.headersTimeout = 10_000;
server.listen(PORT, process.env.HOST || "127.0.0.1", () => console.log(`Agent Orchestra · http://localhost:${PORT}`));
