// Zero-token crowd: N fake machines join one by one and report steps like real agents.
//   node orchestra/crowd.mjs [machines=200] [seconds=90] [url=http://localhost:4480]
// Machines arrive over the first third, work hard in the middle (climax), then calm down.
import { randomBytes } from "node:crypto";

const [machines = 200, seconds = 90, url = "http://localhost:4480"] = process.argv.slice(2).map((x, i) => (i < 2 ? Number(x) : x));
const start = Date.now();
const crowd = Array.from({ length: machines }, (_, i) => ({
  id: randomBytes(16).toString("hex"),
  ip: `10.${i >> 16 & 255}.${i >> 8 & 255}.${i & 255}`,
  joins: (i / machines) * seconds * 1000 / 3,
  sessions: 1 + Math.floor(Math.random() * 4),
}));

async function post(machine, body) {
  try {
    await fetch(`${url}/api/play`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": machine.ip },
      body: JSON.stringify({ id: machine.id, ...body }),
    });
  } catch { /* server not up yet */ }
}

const timer = setInterval(() => {
  const t = Date.now() - start;
  if (t > seconds * 1000) { clearInterval(timer); console.log("crowd done"); return; }
  const phase = t / (seconds * 1000);
  // Activity curve: warm up, peak around 55%, wind down.
  const busy = Math.max(.05, Math.sin(Math.min(1, phase * 1.15) * Math.PI));
  let joined = 0;
  for (const m of crowd) {
    if (t < m.joins) continue;
    joined++;
    const steps = Math.random() < busy ? 1 + Math.floor(Math.random() * 3 * busy) : 0;
    const signals = Math.random() < .002 ? ["ship"] : Math.random() < .002 ? ["fail"] : [];
    post(m, { steps, signals, working: phase < .9, sessions: m.sessions });
  }
  if (Math.round(t / 1000) % 10 === 0) console.log(`t=${Math.round(t / 1000)}s machines=${joined} busy=${busy.toFixed(2)}`);
}, 1000);
