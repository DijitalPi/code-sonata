// Zero-token mix check: record the live note stream and report how crowded it is.
//   node orchestra/measure.mjs [seconds=15] [url=http://localhost:4480]
import http from "node:http";
const seconds = Number(process.argv[2] || 15), url = process.argv[3] || "http://localhost:4480";
const notes = [];
let buffer = "";
const req = http.get(`${url}/api/stream`, (res) => res.on("data", (chunk) => {
  buffer += chunk;
  let i;
  while ((i = buffer.indexOf("\n\n")) >= 0) {
    const line = buffer.slice(0, i); buffer = buffer.slice(i + 2);
    if (line.startsWith("data: ")) notes.push(...(JSON.parse(line.slice(6)).notes || []));
  }
}));
setTimeout(() => {
  req.destroy();
  const pitched = notes.filter((n) => n[4] !== 10);
  // Notes sounding at once (sampled every 100 ms) and melody-range unisons.
  const ends = pitched.map(([at, , , d]) => [at, at + d * 1000]);
  const t0 = Math.min(...ends.map((e) => e[0])), t1 = Math.max(...ends.map((e) => e[0]));
  let peak = 0, sum = 0, samples = 0;
  for (let t = t0; t < t1; t += 100) { const n = ends.filter(([a, b]) => a <= t && t < b).length; peak = Math.max(peak, n); sum += n; samples++; }
  const byTime = new Map();
  for (const n of pitched) { const k = n[0]; byTime.set(k, [...(byTime.get(k) || []), n]); }   // drums excluded: their numbers are not pitches
  // True unison: the exact same pitch started together by different instruments (smears the mix).
  let doubled = 0, crowded = 0;
  for (const group of byTime.values()) {
    const keys = group.map((n) => n[1]);
    doubled += keys.length - new Set(keys).size;
    // Same register clash: two notes a semitone or whole tone apart, both in the middle octave.
    const mid = keys.filter((p) => p >= 55 && p < 72).sort((a, b) => a - b);
    for (let i = 1; i < mid.length; i++) if (mid[i] - mid[i - 1] > 0 && mid[i] - mid[i - 1] <= 2) crowded++;
  }
  const voices = new Set(pitched.map((n) => n[4]));
  const fanfares = notes.filter((n) => n[4] === 10 && n[1] === 49).length;
  console.log(JSON.stringify({ notesPerSec: +(notes.length / seconds).toFixed(1), avgSounding: +(sum / samples).toFixed(1), peakSounding: peak, unisons: doubled, clashes: crowded, voices: voices.size, crashes: fanfares }));
}, seconds * 1000);
