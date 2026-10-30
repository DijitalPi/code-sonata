import { test } from 'node:test';
import assert from 'node:assert/strict';
import { personalNotes, liveNotes, deltaActivity, wavBytes, wavFromChannels, publicInvite, eventKey, momentLayout } from './web/moment.js';
import { SONGS, PLANS, METERS, PLAYLIST } from './web/music.mjs';
import { createConductor } from './web/conductor.mjs';
import { NOTE_RANGE, drumKit } from './web/instruments.js';
test('personal output requires activity and has bounded harmonious notes', () => {
  assert.deepEqual(personalNotes({}), []);
  const notes = personalNotes({ edit: 300, bash: 300, read: 300, think: 300, done: 300 });
  assert.equal(notes.length, 60); assert.ok(notes.at(-1)[0] < 12000);
  assert.ok(notes.every(n => [0, 4, 7, 9].includes(n[1] % 12)));
  assert.deepEqual(deltaActivity({ edit: 5, read: 2 }, { edit: 3, read: 9 }), { edit: 2, bash: 0, read: 0, think: 0, done: 0 });
});
test('WAV is valid mono PCM, audible and never clips under dense mix', () => {
  const bytes = wavBytes(Array.from({ length: 400 }, () => [0, 69, 127, 3, 0]));
  const view = new DataView(bytes); assert.equal(new TextDecoder().decode(bytes.slice(0,4)), 'RIFF'); assert.equal(view.getUint32(24,true), 22050); assert.equal(view.getUint32(40,true), 12*22050*2);
  let peak = 0; for(let i=44;i<bytes.byteLength;i+=2) peak=Math.max(peak,Math.abs(view.getInt16(i,true))); assert.ok(peak > 1000 && peak < 27000);
});
test('invite removes secrets and unrelated query data', () => {
  assert.equal(publicInvite('http://localhost:4480/?secret=hidden#pair=private'), 'http://localhost:4480/?from=invite');
});
test('every song plan covers notes and ends on complete bars', () => {
  for (const [song, notes] of Object.entries(SONGS)) {
    assert.equal(PLANS[song].length, notes.length, song);
    const total = notes.reduce((sum,n) => sum+n[1],0), [meter,pickup] = METERS[song];
    // Pickup is balanced by a shortened closing bar before the repeated pickup.
    assert.equal(total % meter, 0, song);
    assert.ok(pickup >= 0 && pickup < meter, song);
    assert.ok(notes.every(n => n[1] > 0 && (n[0] === null || n[0] >= 0 && n[0] <= 127)), song);
  }
});

test('live motifs fit inside a polling interval and represent every active kind', () => {
 const notes = liveNotes({edit:40,bash:40,read:40,think:40,done:40});
 assert.equal(notes.length,10); assert.ok(Math.max(...notes.map(n=>n[0]+n[3]*1000)) < 2000);
 assert.deepEqual(liveNotes({}),[]);
});
test('an event key comes only from a well-formed ?event= parameter', () => {
  assert.equal(eventKey('?event=event-test-key-0123456789'), 'event-test-key-0123456789');
  assert.equal(eventKey('?from=invite'), '');
  assert.equal(eventKey('?event=short'), '');
  assert.equal(eventKey('?event=has%20space-0123456789'), '');
});
test('every instrument the hall plays has a pinned, checksummed sample file', async () => {
  const { readFile } = await import('node:fs/promises');
  const app = await readFile(new URL('./web/instruments.js', import.meta.url), 'utf8');
  const names = JSON.parse(app.match(/const SOUNDFONT = (\[[^\]]*\])/)[1]).filter(Boolean);
  const manifest = JSON.parse(await readFile(new URL('./sounds.json', import.meta.url), 'utf8'));
  for (const name of names) assert.ok(manifest.files.some(f => f.path === `sounds/FluidR3_GM/${name}-mp3.js` && /^[a-f0-9]{64}$/.test(f.sha256)), name);
  assert.equal(app.includes('cdn.jsdelivr'), false);
});
test('the share image draws exactly the notes the sound plays, inside the staff', () => {
  const notes = personalNotes({ edit: 2, read: 0, bash: 1, think: 0, done: 0 });
  const box = { left: 64, right: 1136, top: 360, bottom: 470 };
  const marks = momentLayout(notes, box);
  assert.equal(marks.length, notes.length);
  for (const m of marks) assert.ok(m.x >= box.left && m.x <= box.right && m.y >= box.top && m.y <= box.bottom && m.length >= 0);
  for (let i = 1; i < marks.length; i++) assert.ok(marks[i].x >= marks[i - 1].x);
  assert.deepEqual(momentLayout([], box), []);
  // A kind with no activity adds no notes: no "read" pitches (81, 84, 88) appear.
  assert.equal(notes.some((n) => [81, 84, 88].includes(n[1])), false);
});

// The site's conductor never gets the local tool's own cues (waiting, errors, step accents).
test('only the notes the hall can play are decoded, and every one it plays is there', () => {
  // Every turn of the form: the theme, the variation (another voice, an octave up) and the breath.
  for (const song of PLAYLIST) for (const I of [0, .4, .7, .95]) for (const house of [false, true]) for (const turn of [0, 1, 2]) {
    const c = createConductor({ song, songs: [song], population: () => ({ working: house ? 0 : 9, total: 9, active: Array(9).fill(house ? 0 : 1), listening: 1 }) });
    for (let t = 0; t < 60000; t += 25) {
      c.intensity = I; c.turn = turn; if (I > .8) c.targetShift = 2;
      if (t % 4000 === 0) ['ship', 'lead', 'pass', 'climax'].forEach((k) => c.cue(k));
      c.tick(1.7e12 + t, 25);
      for (const [, pitch, , , voice] of c.out.splice(0)) {
        if (voice === 10) continue;
        const [lo, hi] = NOTE_RANGE[voice];
        assert.ok(pitch >= lo && pitch <= hi, `${song} voice ${voice} pitch ${pitch}`);
      }
    }
  }
});
// The hall plays loops (flow): every key and chord loop over many scenes, a full stage, a hall whose
// piano seat is empty (the flute or accordion takes the hook) and the house pianist alone.
test('every note the loops play is decoded, and every drum they play makes a sound', () => {
  const drums = new Set();
  for (let seed = 0; seed < 12; seed++) for (const I of [0, .5, .95]) for (const house of [false, true]) for (const gone of [-1, 0]) {
    const active = Array(9).fill(house ? 0 : 1).map((n, s) => (s === gone ? 0 : n));
    const c = createConductor({ flow: true, population: () => ({ working: house ? 0 : 8, total: 9, active, listening: 1, featured: house ? [] : [1, 2, 3, 4, 5, 6, 7, 8] }) });
    const start = 1.7e12 + seed * 7_777_000;
    for (let t = 0; t < 150_000; t += 25) {
      c.intensity = I; if (I > .8) c.targetShift = 2;
      if (t % 4000 === 0) ['ship', 'lead', 'pass', 'climax'].forEach((k) => c.cue(k));
      c.tick(start + t, 25);
      for (const [, pitch, , , voice] of c.out.splice(0)) {
        if (voice === 10) { drums.add(pitch); continue; }
        const [lo, hi] = NOTE_RANGE[voice];
        assert.ok(pitch >= lo && pitch <= hi, `flow voice ${voice} pitch ${pitch}`);
      }
    }
  }
  // The drums are synthesized: each pitch must start something (a fake audio context counts).
  let started = 0;
  const node = () => ({ connect: (next) => next, start() { started++; }, stop() {}, frequency: { value: 0, setValueAtTime() {}, exponentialRampToValueAtTime() {} }, gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} } });
  const ctx = { sampleRate: 100, createBuffer: () => ({ getChannelData: () => new Float32Array(100) }), createBufferSource: node, createBiquadFilter: node, createGain: node, createOscillator: node };
  const kit = drumKit(ctx, node());
  assert.ok(drums.size >= 3);
  for (const pitch of [...drums, 37, 39, 45, 50, 57]) { const before = started; kit(pitch, .5, 0); assert.ok(started > before, `drum ${pitch} is silent`); }
});
test('notes go straight to Web Audio, not through smplr\'s timer queue', async () => {
  // The timer queue missed most notes of an offline render (it finishes faster than real time).
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('./web/instruments.js', import.meta.url), 'utf8');
  assert.match(source, /scheduler: DIRECT/);
  assert.match(source, /schedule\(event, play\) \{ play\(event\);/);
});
test('rendered moments become valid stereo WAV without clipping', () => {
  const left = new Float32Array(44100).map((_, i) => Math.sin(i / 10) * 1.5), right = left.map((x) => -x);
  const bytes = wavFromChannels([left, right], 44100), view = new DataView(bytes);
  assert.equal(view.getUint16(22, true), 2); assert.equal(view.getUint32(24, true), 44100); assert.equal(view.getUint32(40, true), 44100 * 4);
  let peak = 0; for (let i = 44; i < bytes.byteLength; i += 2) peak = Math.max(peak, Math.abs(view.getInt16(i, true)));
  assert.ok(peak > 28000 && peak < 32767);
});
