// Content-free activity -> a bounded 12-second musical interpretation.
export const KINDS = ['edit', 'bash', 'read', 'think', 'done'];
export function personalNotes(activity) {
  const scales = { edit: [69, 72, 76, 79], bash: [45, 52], read: [81, 84, 88], think: [57, 60, 64], done: [57, 64, 69] };
  const notes = [];
  for (const kind of KINDS) {
    const count = Math.min(12, Math.max(0, Math.floor(activity[kind] || 0)));
    for (let i = 0; i < count; i++) notes.push([0, scales[kind][i % scales[kind].length], kind === 'read' ? 38 : 58, kind === 'think' ? 1.4 : .5, kind === 'bash' ? 3 : 0]);
  }
  if (!notes.length) return [];
  // Repeat a small activity motif across the phrase; low activity still yields a full moment.
  const length = Math.max(20, notes.length), step = 10000 / length;
  return Array.from({ length }, (_, i) => [i * step, ...notes[i % notes.length].slice(1)]);
}
export function deltaActivity(current, previous = {}) {
  return Object.fromEntries(KINDS.map(k => [k, Math.max(0, (current[k] || 0) - (previous[k] || 0))]));
}
export function liveNotes(activity) {
  const pitches = { edit: [69, 72], bash: [45, 52], read: [81, 84], think: [57, 64], done: [64, 69] };
  const notes = [];
  for (const kind of KINDS) for (let i = 0; i < Math.min(2, activity[kind] || 0); i++) {
    notes.push([notes.length * 120, pitches[kind][i], kind === 'read' ? 38 : 58, kind === 'think' ? .75 : .35, kind === 'bash' ? 3 : 0]);
  }
  return notes;
}
export function wavBytes(notes, seconds = 12, rate = 22050) {
  const size = Math.round(seconds * rate), samples = new Float32Array(size);
  for (const [at, pitch, velocity, duration, voice] of notes.slice(0, 400)) {
    if (![at, pitch, velocity, duration, voice].every(Number.isFinite) || at < 0 || pitch < 0 || pitch > 127) continue;
    const start = Math.round(at / 1000 * rate), length = Math.min(Math.round(Math.min(duration, 3) * rate), size - start);
    const freq = 440 * 2 ** ((pitch - 69) / 12), gain = Math.min(120, Math.max(0, velocity)) / 127 * .12;
    for (let i = 0; i < length; i++) {
      const t = i / rate, envelope = Math.min(1, t / .012) * Math.exp(-t * 2.5) * Math.min(1, (length - i) / (rate * .06));
      const tone = voice === 10 ? Math.sin(2 * Math.PI * (70 + 30 * Math.exp(-t * 20)) * t) * Math.exp(-t * 12) : Math.sin(2 * Math.PI * freq * t) + .2 * Math.sin(4 * Math.PI * freq * t);
      samples[start + i] += tone * gain * envelope;
    }
  }
  let peak = 0; for (const x of samples) peak = Math.max(peak, Math.abs(x));
  const scale = peak > .8 ? .8 / peak : 1;
  const bytes = new ArrayBuffer(44 + size * 2), view = new DataView(bytes);
  const str = (offset, text) => [...text].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)));
  str(0, 'RIFF'); view.setUint32(4, 36 + size * 2, true); str(8, 'WAVE'); str(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true); str(36, 'data'); view.setUint32(40, size * 2, true);
  samples.forEach((x, i) => view.setInt16(44 + i * 2, Math.round(x * scale * 32767), true));
  return bytes;
}
export function publicInvite(location) {
  const url = new URL(location); url.hash = ''; url.search = '?from=invite'; return url.href;
}
// An event link (?event=<key>) opens a shared venue network; anything malformed is no key.
export function eventKey(search) {
  const key = new URLSearchParams(search).get('event') || '';
  return /^[A-Za-z0-9_-]{16,64}$/.test(key) ? key : '';
}
