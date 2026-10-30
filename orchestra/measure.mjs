// Zero-token mix check: record the live note stream and report how crowded / rough it is.
//   node orchestra/measure.mjs [seconds=15] [url=http://localhost:4480]
// Notes are judged while they actually ring (start .. end + a short release tail), which is
// what the ear hears, not only when they start.
import http from "node:http";

const seconds = Number(process.argv[2] || 15), url = process.argv[3] || "http://localhost:4480";
const TAIL = 300;                       // ms a sample keeps ringing after its duration
const notes = [];
let buffer = "";
const req = http.get(`${url}/api/stream`, (res) => res.on("data", (chunk) => {
  buffer += chunk;
  let i;
  while ((i = buffer.indexOf("\n\n")) >= 0) {
    const line = buffer.slice(0, i); buffer = buffer.slice(i + 2);
    if (!line.startsWith("data: ")) continue;
    const frame = JSON.parse(line.slice(6));
    notes.push(...(frame.notes || []).map(([at, ...rest]) => [at + frame.t, ...rest]));   // times come relative to the frame
  }
}));

setTimeout(() => {
  req.destroy();
  const pitched = notes.filter((n) => n[4] !== 10).map(([at, p, v, d, voice]) => ({ at, end: at + d * 1000 + TAIL, p, v, voice }));
  if (!pitched.length) return console.log(JSON.stringify({ notes: 0 }));
  const t0 = Math.min(...pitched.map((n) => n.at)), t1 = Math.max(...pitched.map((n) => n.at));
  let samples = 0, sounding = 0, peak = 0, rough = 0, mud = 0, loud = 0;
  for (let t = t0; t < t1; t += 50) {
    const now = pitched.filter((n) => n.at <= t && t < n.end);
    samples++; sounding += now.length; peak = Math.max(peak, now.length);
    loud += now.reduce((s, n) => s + n.v, 0);
    for (let a = 0; a < now.length; a++) for (let b = a + 1; b < now.length; b++) {
      const d = Math.abs(now[a].p - now[b].p);
      if (d % 12 === 1) rough++;                                        // minor 2nd / minor 9th: grinding
      if (now[a].p < 55 && now[b].p < 55 && d > 0 && d <= 4) mud++;      // close intervals down low: mud
    }
  }
  // Rhythm: how many note starts fall off a common grid (all starts should share one clock).
  const starts = [...new Set(pitched.map((n) => n.at))].sort((a, b) => a - b);
  // Each start against the one before it, in units of the smallest gap around it (two seconds each way): the
  // tempo may change between scenes, and starts are whole milliseconds, so one grid for the whole window drifts.
  const offGrid = starts.slice(1).filter((s, i) => {
    const near = starts.filter((x) => Math.abs(x - s) <= 2000);
    const unit = Math.min(...near.slice(1).map((x, j) => x - near[j]).filter((g) => g > 20));
    const r = ((s - starts[i]) / unit) % 1;
    return Number.isFinite(unit) && r > .08 && r < .92;
  }).length;
  console.log(JSON.stringify({
    notesPerSec: +(notes.length / seconds).toFixed(1),
    avgSounding: +(sounding / samples).toFixed(1), peakSounding: peak,
    roughPerSample: +(rough / samples).toFixed(2), mudPerSample: +(mud / samples).toFixed(2),
    loudness: Math.round(loud / samples), offGridStarts: `${offGrid}/${starts.length}`,
  }));
}, seconds * 1000);
