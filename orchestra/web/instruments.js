// The hall's instruments: sample banks, mix, stereo seats, reverb and the notes each voice needs.
// Shared by the live hall (app.js) and the moment renderer (experience.js).
export const SECTIONS = ["piano", "strings", "choir", "cello", "flute", "vibraphone", "horn", "harp", "accordion"];
// Engine voices by index (10 = drums, synthesized; 11 = accordion, section 8).
export const SOUNDFONT = ["acoustic_grand_piano", "string_ensemble_1", "choir_aahs", "cello", "flute", "vibraphone", "french_horn", "orchestral_harp", "timpani", "tremolo_strings", null, "accordion"];
// Stereo position from the real seating plan (violins left, cellos right).
const PAN = { strings: -.7, harp: -.6, piano: -.1, accordion: .15, flute: 0, horn: .1, choir: 0, vibraphone: .6, cello: .7 };
// Mix: the melody instruments sit in front, sustained pads further back.
const VOLUME = [100, 78, 72, 92, 92, 74, 82, 82, 88, 70, 0, 88];
// The notes the conductor can ask of each voice, two semitones to spare (test-moment checks this
// against the conductor). Only these samples are decoded: about half of every bank.
export const NOTE_RANGE = { 0: [36, 95], 1: [50, 95], 2: [60, 95], 3: [34, 62], 4: [58, 104], 5: [82, 106], 6: [46, 81], 7: [70, 106], 8: [34, 51], 9: [34, 67], 11: [55, 95] };
export const voiceOfSection = (s) => (s === 8 ? 11 : s);
const DRY = typeof location !== "undefined" && new URLSearchParams(location.search).has("dry");   // ?dry: compare without the hall

// smplr holds back notes more than 200 ms ahead and releases them from a JS timer. Our notes
// already carry exact times (the live hall gets them 0.9 s early; an offline render runs faster
// than real time, so the timer missed most of them), so every note goes straight to Web Audio.
const DIRECT = { schedule(event, play) { play(event); return () => {}; }, stop() {} };

export function loadInstrument(Soundfont, ctx, voice, destination, notes = range(voice)) {
  const section = voice === 11 ? "accordion" : SECTIONS[voice];
  return Soundfont(ctx, {
    instrumentUrl: `sounds/FluidR3_GM/${SOUNDFONT[voice]}-mp3.js`,   // FluidR3 GM, CC BY 3.0, checksummed by fetch-sounds.mjs
    destination, pan: PAN[section] ?? 0, volume: VOLUME[voice], scheduler: DIRECT,
    notesToLoad: { notes, fallback: "nearest" },
  });
}
function range(voice) {
  const [lo, hi] = NOTE_RANGE[voice] || [21, 108];
  return Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);
}

// A concert hall: the dry sound plus a reverb send. The send is high-passed so the bass stays
// clear, and the tail darkens as it decays. Built from noise in the page (no file, nothing the
// content policy blocks).
export function hall(ctx, destination) {
  const input = ctx.createGain();
  input.connect(destination);
  if (DRY) return input;
  const rate = ctx.sampleRate, length = Math.round(2.4 * rate), pre = Math.round(.02 * rate);
  const impulse = ctx.createBuffer(2, length, rate);
  for (let ch = 0; ch < 2; ch++) {
    const data = impulse.getChannelData(ch);
    let tone = 0;
    for (let i = pre; i < length; i++) {
      const t = (i - pre) / (length - pre);
      tone += (Math.random() * 2 - 1 - tone) * (.6 - .45 * t);
      data[i] = tone * (1 - t) ** 2 * Math.exp(-2.5 * t);
    }
  }
  const lowCut = ctx.createBiquadFilter(), reverb = ctx.createConvolver(), wet = ctx.createGain();
  lowCut.type = "highpass"; lowCut.frequency.value = 220;
  reverb.buffer = impulse; wet.gain.value = .2;
  input.connect(lowCut).connect(reverb).connect(wet).connect(destination);
  return input;
}

// Master chain: gentle bus compression, +9 dB makeup, then a limiter so a full orchestra never clips.
export function masterChain(ctx, level) {
  const master = ctx.createDynamicsCompressor();
  master.threshold.value = -20; master.knee.value = 12; master.ratio.value = 2.5;
  master.attack.value = .01; master.release.value = .25;
  const out = ctx.createGain(); out.gain.value = 2.4 * level;
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -3; limiter.knee.value = 0; limiter.ratio.value = 20;
  limiter.attack.value = .002; limiter.release.value = .1;
  master.connect(out).connect(limiter).connect(ctx.destination);
  return { master, out };
}

export function drumKit(ctx, out) {
  const noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
  const data = noise.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  const burst = (time, length, gain, type, freq) => {
    const src = ctx.createBufferSource(); src.buffer = noise;
    const filter = ctx.createBiquadFilter(); filter.type = type; filter.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, time); g.gain.exponentialRampToValueAtTime(.001, time + length);
    src.connect(filter).connect(g).connect(out); src.start(time); src.stop(time + length);
  };
  return (pitch, level, time) => {
    if (pitch === 36) {                   // kick: falling sine
      const osc = ctx.createOscillator(), g = ctx.createGain();
      osc.frequency.setValueAtTime(120, time); osc.frequency.exponentialRampToValueAtTime(42, time + .15);
      g.gain.setValueAtTime(level * 1.2, time); g.gain.exponentialRampToValueAtTime(.001, time + .35);
      osc.connect(g).connect(out); osc.start(time); osc.stop(time + .4);
    } else if (pitch === 45 || pitch === 50) {   // toms: a shorter, higher falling sine
      const osc = ctx.createOscillator(), g = ctx.createGain(), from = pitch === 45 ? 150 : 220;
      osc.frequency.setValueAtTime(from, time); osc.frequency.exponentialRampToValueAtTime(from * .6, time + .2);
      g.gain.setValueAtTime(level * .8, time); g.gain.exponentialRampToValueAtTime(.001, time + .3);
      osc.connect(g).connect(out); osc.start(time); osc.stop(time + .35);
    } else if (pitch === 38) burst(time, .18, level * .7, "bandpass", 1800);
    else if (pitch === 37) burst(time, .03, level * .5, "bandpass", 3200);                // rim: a short click
    else if (pitch === 39) [0, .012, .024].forEach((d, i) => burst(time + d, i === 2 ? .14 : .02, level * .45, "bandpass", 1300));   // clap: three quick hands
    else if (pitch === 42) burst(time, .04, level * .16, "highpass", 8000);
    else if (pitch === 46) burst(time, .16, level * .16, "highpass", 7000);
    else if (pitch === 49 || pitch === 57) burst(time, 2.2, level * .45, "highpass", 4500);
    else if (pitch === 54) burst(time, .12, level * .14, "highpass", 9000);               // tambourine
    else if (pitch === 70) burst(time, .05, level * .12, "highpass", 6000);               // shaker
  };
}

// A moment rendered offline with the hall's own samples and reverb, so the shared file sounds
// like the hall. Only the notes the moment plays are decoded. Returns channel data.
export async function renderWithSamples(notes, seconds = 12, rate = 44100) {
  const { Soundfont } = await import("./vendor/smplr-1.1.0.mjs");
  const ctx = new OfflineAudioContext(2, Math.round(seconds * rate), rate);
  const { master } = masterChain(ctx, .65);
  const bus = hall(ctx, master), drums = drumKit(ctx, bus);
  const used = new Map();
  for (const [, pitch, , , voice = 0] of notes) if (SOUNDFONT[voice]) (used.get(voice) || used.set(voice, new Set()).get(voice)).add(pitch);
  const voices = {};
  await Promise.all([...used].map(async ([voice, pitches]) => {
    const instrument = loadInstrument(Soundfont, ctx, voice, bus, [...pitches]);
    await instrument.ready;
    voices[voice] = instrument;
  }));
  for (const [at, pitch, velocity, duration, voice = 0] of notes) {
    const time = at / 1000;
    if (!(time >= 0 && time < seconds)) continue;
    if (voice === 10) drums(pitch, velocity / 127, time);
    else voices[voice]?.start({ note: pitch, velocity, time, duration });
  }
  const buffer = await ctx.startRendering();
  return Array.from({ length: buffer.numberOfChannels }, (_, ch) => buffer.getChannelData(ch));
}
