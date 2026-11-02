// Demo concert: a full hall played entirely in this browser, for a visitor who arrives while the
// real hall is quiet. The machines are simulated and labelled as such; nothing is sent to or
// counted by the server (the page closes its live connection while the demo plays). The music
// comes from the same conductor the server uses, playing tunes everyone knows (DEMO_SONGS).
import { createConductor } from './conductor.mjs';
import { TITLES } from './music.mjs';

// [section, country, tool] seated as a real symphony fills its chairs, compatriots together:
// 0 piano, 1 strings, 2 choir, 3 cello, 4 flute, 5 vibraphone, 6 horn, 7 harp, 8 accordion.
const PLAN = [
  [0, 'TR', 'claude'], [8, 'FR', 'codex'],
  [1, 'US', 'claude'], [1, 'US', 'codex'], [1, 'US', 'claude'], [1, 'GB', 'claude'], [1, 'GB', 'other'], [1, 'CA', 'codex'],
  [2, 'BR', 'codex'], [2, 'BR', 'claude'], [2, 'ES', 'claude'], [2, 'ES', 'other'],
  [3, 'DE', 'claude'], [3, 'DE', 'codex'], [3, 'DE', 'claude'], [3, 'NL', 'codex'],
  [4, 'JP', 'claude'], [4, 'JP', 'codex'], [5, 'KR', 'claude'], [5, 'KR', 'codex'],
  [6, 'IN', 'codex'], [6, 'IN', 'claude'], [7, 'TR', 'claude'], [7, 'TR', 'codex'],
];
export const DEMO_MACHINES = PLAN.length;
// The page's one listen button: while no agent works the live hall has only the house pianist, so the
// button plays this demo instead (a small link keeps the live hall). In the demo it leads back to the live hall.
export const demoFirst = (frame) => !frame.demo && !frame.working;
const SECTION_COUNT = 9, HALF_LIFE = 5 * 60_000;
// Tunes everyone knows, played in this order and round again, so a first-time listener hears a melody they
// recognise from the first note: Mozart opens, Bella Ciao follows. All in the score with their sources (songs.mjs).
export const DEMO_SONGS = ['nachtmusik', 'bella-ciao', 'fur-elise', 'ode-to-joy', 'korobeiniki', 'mountain-king'];

export function startDemo({ onFrame, tickMs = 25, frameMs = 250 }) {
  const seatsUsed = Array.from({ length: SECTION_COUNT }, () => 0);
  const machines = PLAN.map(([section, cc, tool], i) => ({
    section, seat: seatsUsed[section]++, cc, tool, sessions: 1 + (i % 3),
    rate: .6 + ((i * 7) % 10) / 6,      // steps per second when busy, 0.6 to 2.1
    working: true, pulse: 0,
  }));
  const conductor = createConductor({
    songs: DEMO_SONGS, song: DEMO_SONGS[0], ordered: true,
    population: () => {
      const active = Array(SECTION_COUNT).fill(0);
      let working = 0;
      for (const m of machines) if (m.working) { working++; active[m.section]++; }
      return { working, total: machines.length, active, listening: 1 };
    },
  });
  const scores = new Map(), cheers = new Set();
  const began = Date.now();
  let lastTick = began, lastFrame = began, first = true, nextShip = began + 9000;

  // Work comes in waves of about a minute and a quarter, so the hall breathes: calm, busy, a peak.
  function work(now, dt) {
    const wave = .35 + 1.9 * Math.max(0, Math.sin(((now - began) / 75_000) * Math.PI * 2 - Math.PI / 2) * .5 + .5);
    for (const m of machines) {
      if (Math.random() < dt / 20_000) m.working = !m.working || Math.random() < .7;   // a few rest now and then
      if (!m.working) continue;
      const expected = m.rate * wave * dt / 1000;
      const steps = Math.floor(expected) + (Math.random() < expected % 1 ? 1 : 0);
      if (!steps) continue;
      m.pulse = now; conductor.steps += steps;
      scores.set(m.cc, (scores.get(m.cc) || 0) + steps);
    }
    if (now >= nextShip) {
      const m = machines[Math.floor(Math.random() * machines.length)];
      conductor.signal('ship', m.section, now); cheers.add(m.tool);
      nextShip = now + 45_000 + Math.random() * 45_000;   // a commit every minute or so: each makes a peak
    }
    const decay = Math.pow(.5, dt / HALF_LIFE);
    for (const [cc, v] of scores) scores.set(cc, v * decay);
  }

  function frame(now) {
    const seats = Array.from({ length: SECTION_COUNT }, () => []);
    for (const m of machines) seats[m.section][m.seat] = [m.sessions, m.cc, m.tool];
    const members = new Map(), agents = { claude: 0, codex: 0, other: 0 };
    for (const m of machines) { members.set(m.cc, (members.get(m.cc) || 0) + 1); agents[m.tool] += m.sessions; }
    const total = [...scores].map(([cc, v]) => ({ cc, score: Math.round(v), players: members.get(cc) || 0 })).filter((r) => r.score > 0).sort((a, b) => b.score - a.score);
    const passion = total.filter((r) => r.players >= 3).map((r) => ({ ...r, perPlayer: Math.round((r.score / r.players) * 10) / 10 })).sort((a, b) => b.perPlayer - a.perPlayer);
    const working = machines.filter((m) => m.working).length;
    const out = {
      t: now, demo: true, notes: conductor.out.splice(0),
      pulses: machines.filter((m) => now - m.pulse < 2 * frameMs).map((m) => [m.section, m.seat]),
      players: machines.length, simulated: 0, simulatedListeners: 0, working, listeners: 1,
      claudes: machines.reduce((a, m) => a + m.sessions, 0),
      bpm: Math.round(conductor.bpm), intensity: Math.round(conductor.intensity * 100) / 100,
      climax: Boolean(conductor.shift), song: TITLES[conductor.song], house: false,
      lastActive: now, peak: machines.length,
      countries: [...members].sort((a, b) => b[1] - a[1]).slice(0, 12), countryCount: members.size,
      teams: { agents, fans: { claude: 0, codex: 0, other: 0, listen: 1 } },
      league: { leader: total[0]?.cc || null, total: total.slice(0, 6), passion: passion.slice(0, 6) },
      ranks: total.map((r) => r.cc),
    };
    if (first) { out.seats = seats; out.you = { cc: '', team: 'listen' }; first = false; }
    if (conductor.solo) { out.solo = conductor.solo; conductor.solo = 0; }
    if (cheers.size) { out.cheers = [...cheers]; cheers.clear(); }
    onFrame(out);
  }

  const ticker = setInterval(() => {
    const now = Date.now();
    conductor.tick(now, now - lastTick); lastTick = now;
  }, tickMs);
  const framer = setInterval(() => {
    const now = Date.now();
    work(now, now - lastFrame); lastFrame = now;
    frame(now);
  }, frameMs);
  return () => { clearInterval(ticker); clearInterval(framer); };
}
