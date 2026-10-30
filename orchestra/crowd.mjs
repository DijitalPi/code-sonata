// Zero-token crowd: N fake machines join one by one and report steps like real agents.
//   (server needs ALLOW_SIMULATION=1) node orchestra/crowd.mjs [machines=200] [seconds=90] [url=http://localhost:4480] [listeners=machines]
// Machines arrive over the first third, work hard in the middle (climax), then calm down.
import { randomBytes } from "node:crypto";
import http from "node:http";

const args = process.argv.slice(2);
const machines = Number(args[0] || 200), seconds = Number(args[1] || 90), url = args[2] || "http://localhost:4480";
const audienceSize = Number(args[3] ?? machines);

// Random public IPv4 (skips private, loopback, multicast) so the server resolves real countries.
function publicIp() {
  for (;;) {
    const a = 1 + Math.floor(Math.random() * 222), b = Math.floor(Math.random() * 256);
    if (a === 10 || a === 127 || (a === 172 && b >= 16 && b < 32) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b < 128)) continue;
    return `${a}.${b}.${Math.floor(Math.random() * 256)}.${1 + Math.floor(Math.random() * 254)}`;
  }
}
const pickTool = () => (Math.random() < .62 ? "claude" : Math.random() < .85 ? "codex" : "other");
const start = Date.now();
const crowd = Array.from({ length: machines }, (_, i) => ({
  id: randomBytes(16).toString("hex"),
  ip: publicIp(),
  joins: (i / machines) * seconds * 1000 / 3,
  sessions: 1 + Math.floor(Math.random() * 4),
  tool: pickTool(),
}));

// Listeners: open the live stream from different countries, each in a team's stand.
const streams = [];
for (let i = 0; i < audienceSize; i++) {
  setTimeout(() => {
    const team = ["claude", "codex", "other", "listen"][Math.floor(Math.random() * 4)];
    const req = http.get(`${url}/api/stream?team=${team}&simulation=1`, { headers: { "x-forwarded-for": publicIp() } }, (res) => res.resume());
    req.on("error", () => {});
    streams.push(req);
  }, (i / Math.max(1, audienceSize)) * seconds * 1000 / 3);
}

async function post(machine, body) {
  try {
    await fetch(`${url}/api/play`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": machine.ip },
      body: JSON.stringify({ id: machine.id, simulation: true, ...body }),
    });
  } catch { /* server not up yet */ }
}

const timer = setInterval(() => {
  const t = Date.now() - start;
  if (t > seconds * 1000) { clearInterval(timer); streams.forEach((r) => r.destroy()); console.log("crowd done"); return; }
  const phase = t / (seconds * 1000);
  // Activity curve: warm up, peak around 55%, wind down.
  const busy = Math.max(.05, Math.sin(Math.min(1, phase * 1.15) * Math.PI));
  let joined = 0;
  for (const m of crowd) {
    if (t < m.joins) continue;
    joined++;
    const steps = Math.random() < busy ? 1 + Math.floor(Math.random() * 3 * busy) : 0;
    const signals = Math.random() < .004 ? ["ship"] : Math.random() < .002 ? ["fail"] : [];
    post(m, { steps, signals, working: phase < .9, sessions: m.sessions, tools: { [m.tool]: m.sessions } });
  }
  if (Math.round(t / 1000) % 10 === 0) console.log(`t=${Math.round(t / 1000)}s machines=${joined} busy=${busy.toFixed(2)}`);
}, 1000);
