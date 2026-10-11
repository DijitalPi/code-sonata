// The conductor: one clock for everything. Notes sit on an ideal timeline (not "whenever the 25 ms
// timer fires"), and every part, drums included, comes from the same song beat grid. Shared by the
// server (real machines) and the browser's demo concert (simulated machines): `population(now, dt)`
// says how many are working in which section and how many are listening.
import { SONGS, KEYS, PLANS, METERS, MOODS, chordTones } from "./music.mjs";

export const TIMPANI = 8, TREMOLO = 9, DRUMS = 10, ACCORDION = 11;   // engine voices; section 8 plays voice 11
export const LEAD_MS = 900;     // notes are scheduled this far ahead so every listener can play them on time
const LOOKAHEAD_MS = 150;
const eq = (a, b) => Math.abs(a - b) < 1e-9;

export function createConductor({ population, song = "bella-ciao", minSongMs = 120_000 }) {
  return {
    song, songCount: 0,
    history: [], position: 0, songBeat: 0, chord: null, nextChange: 0,
    bpm: 66, intensity: 0, shift: 0, targetShift: 0,
    clock: 0, steps: 0, short: 0, long: 0, songMs: 0,
    peakSince: null, calmSince: null, climaxSince: 0, coolUntil: 0,
    active: [], working: 0, cues: [], lastSignal: {}, solo: 0, out: [],
    house: false, lastActive: 0, peak: 0, peakDay: "",

    // The next song follows the agents' pace: calm, warm or wild. No repeats of the last two.
    pickSong() {
      const I = this.intensity;
      const mood = I >= .7 ? "wild" : I >= .35 ? "warm" : "calm";
      const pool = MOODS[mood].filter((s) => !this.history.slice(-2).includes(s) && s !== this.song);
      const next = pool[0] || MOODS[mood].find((s) => s !== this.song) || MOODS.warm.find((s) => s !== this.song);
      this.history.push(this.song);
      if (this.history.length > 6) this.history.shift();
      return next;
    },
    chordAt(octave) { return chordTones(this.chord, KEYS[this.song], octave); },
    band(p, lo) { while (p >= lo + 12) p -= 12; while (p < lo) p += 12; return p; },

    emit(at, p, v, d, i) {
      if (i !== DRUMS) p += this.shift;
      this.out.push([Math.round(at), Math.max(0, Math.min(127, p)), Math.max(1, Math.min(120, Math.round(v))), Math.round(d * 1000) / 1000, i]);
    },

    // Signals become cues that play on the next bar line, in key and in time.
    signal(kind, section, now) {
      if (kind === "fail" || now - (this.lastSignal[kind] || 0) < 10_000) return;   // no error chords on the site
      this.lastSignal[kind] = now;
      this.cue(kind);
    },
    cue(kind) { if (!this.cues.includes(kind)) this.cues.push(kind); },

    tick(now, dt) {
      const { working, total, active, listening } = population(now, dt);
      this.active = active; this.working = working;
      // Excitement follows a speed-up (pace now vs. the last two minutes) plus some absolute pace:
      // a steady crowd settles, a speed-up builds, a burst peaks.
      const rate = this.steps / Math.max(.001, dt / 1000);
      this.steps = 0;
      this.short += (rate - this.short) * Math.min(1, dt / 3000);
      this.long += (rate - this.long) * Math.min(1, dt / 120_000);
      const pace = working ? Math.min(1, this.short / working / 2) : 0;
      const surge = working ? Math.max(0, Math.min(1, (this.short / Math.max(this.long, .4 * working) - .9) / 1.2)) : 0;
      let target = working ? Math.min(1, .55 * pace + .45 * surge) : 0;
      if (now < this.coolUntil) target = Math.min(target, .6);            // after a climax, breathe
      this.intensity += (target - this.intensity) * Math.min(1, dt / 1500);
      this.bpm += (66 + 50 * this.intensity - this.bpm) * Math.min(1, dt / 2500);   // 66..116
      this.climax(now);
      // Nobody working but someone listening: the house pianist plays (piano only, calm, soft)
      // until the agents return. Never shown as a participant; the page says it is the house.
      if (working) this.lastActive = now;
      const day = new Date(now).toISOString().slice(0, 10);
      if (day !== this.peakDay) { this.peakDay = day; this.peak = 0; }
      this.peak = Math.max(this.peak, total);
      this.house = !working && listening > 0;
      if (!working && !this.house) { this.clock = 0; return { working, total }; }
      if (!this.clock || this.clock < now - 500) this.clock = now;        // start, or recover from a stall
      while (this.clock <= now + LOOKAHEAD_MS) this.note(this.clock);
      return { working, total };
    },

    // A climax is a moment, not a state: at most 20 s, then 30 s below it.
    climax(now) {
      if (this.intensity > .8 && now >= this.coolUntil) {
        this.calmSince = null;
        this.peakSince ??= now;
        if (!this.targetShift && now - this.peakSince > 3000) { this.targetShift = 2; this.climaxSince = now; this.cue("climax"); }
        if (this.targetShift && now - this.climaxSince > 20_000) { this.coolUntil = now + 30_000; this.targetShift = 0; }
      } else {
        this.peakSince = null;
        if (this.intensity < .55) {
          this.calmSince ??= now;
          if (this.targetShift && now - this.calmSince > 3000) this.targetShift = 0;
        }
      }
    },

    // One melody note, plus everything on the grid while it sounds.
    note(t) {
      const score = SONGS[this.song], plan = PLANS[this.song], key = KEYS[this.song];
      const [pitch, beats] = score[this.position];
      const step = plan[this.position];
      const beatMs = 60_000 / this.bpm, I = this.intensity, active = this.active;
      const at = t + LEAD_MS;
      this.chord = step.chord;
      this.nextChange = step.nextChange;
      const on = (s, from) => active[s] > 0 && I >= from;
      const crowd = this.house ? .7 : .85 + .15 * Math.min(1, Math.log2(1 + this.working) / 6);   // house: softer; a bigger orchestra, a bit fuller
      const vel = (base) => base * 1.7 * (1 + .25 * I) * crowd;
      // Melody: one section per phrase (8 notes), rotating among the sections on stage.
      const singers = [0, 8, 4, 1, 2].filter((s) => s === 0 || on(s, s === 2 ? .5 : s === 8 ? 0 : .25));
      const lead = singers[Math.floor(this.position / 8 + this.songCount) % singers.length];
      const leadPitch = pitch === null ? -99 : lead === 4 ? pitch + 12 : pitch;   // flute an octave up; null = rest
      const ctx = { lead, leadPitch, on, vel, beatMs };
      for (let k = 0; k < beats - 1e-9; k += .5) this.grid(at + k * beatMs, this.songBeat + k, step, ctx, k === 0);
      if (pitch !== null) {
        this.solo = at;                                                   // the leading country glows on melody notes
        this.emit(at, leadPitch, vel(lead === 0 ? 54 : 46), Math.min(2.6, (beats * beatMs) / 1000 * .92), lead === 8 ? ACCORDION : lead);
      }
      this.songMs += beats * beatMs;
      this.songBeat += beats;
      this.clock = t + beats * beatMs;
      this.position++;
      if (this.position >= score.length) {
        this.position = 0; this.songBeat = 0;
        // Change song only at a calm moment, or to move into the wild song when things heat up.
        const heatingUp = I >= .7 && !MOODS.wild.includes(this.song);
        if (this.songMs >= minSongMs && (I <= .5 || heatingUp)) {
          // Close the song: the tonic rings for two beats, then two beats of breath.
          const tonic = chordTones(null, key, 48), end = this.clock + LEAD_MS;
          for (const p of [tonic[0] - 12, ...tonic.map((x) => x + 12)]) this.emit(end, p, vel(30), (2 * beatMs) / 1000, 0);
          this.clock += 4 * beatMs;
          this.song = this.pickSong(); this.songCount++; this.songMs = 0;
        }
      }
    },

    grid(at, beat, step, { lead, leadPitch, on, vel, beatMs }, onset) {
      const I = this.intensity, [meter, pickup] = METERS[this.song];
      const inBar = (((beat - pickup) % meter) + meter) % meter, waltz = meter === 3;
      const barLine = eq(inBar, 0), onBeat = eq(beat % 1, 0), change = onset && step.change;
      if (barLine) this.shift = this.targetShift;                         // key changes on a bar line only
      if (barLine && this.cues.length) this.playCues(at, vel, beatMs);
      // Harmony is struck on a chord change and on each bar line, and lasts exactly until the
      // next of the two: two chords never ring on top of each other.
      if (change || barLine) {
        const until = Math.min(this.nextChange, beat + meter - inBar);
        // Samples ring ~0.3 s after release: stop early before a new chord so its tail is gone
        // when the next chord starts (no need when the same chord is struck again).
        const span = (Math.max(.25, until - beat) * beatMs) / 1000;
        const len = eq(until, this.nextChange) ? Math.max(span * .5, span - .25) : span * .94;
        this.harmony(at, len, lead, leadPitch, on, vel);
      }
      // The cello steps to the fifth halfway through a bar when the chord holds.
      if (!waltz && eq(inBar, 2) && !change && on(3, .35) && this.nextChange - beat >= 2) {
        const fifth = this.chordAt(36)[2];
        this.emit(at, fifth >= 48 ? fifth - 12 : fifth, vel(26), (2 * beatMs) / 1000 * .9, 3);
      }
      // Colour: one voice up high, on the beat: harp (every beat) or vibraphone (beats 1 and 3).
      if (onBeat && I >= .25) {
        const colour = [7, 5].filter((s) => on(s, s === 5 ? .45 : .25));
        if (colour.length) {
          const s = colour[Math.floor(this.position / 8) % colour.length];
          if (s === 7 || eq(inBar, 0) || (!waltz && eq(inBar, 2))) {
            const p = this.chordAt(84)[Math.floor(beat) % 3];
            this.emit(at, p, vel(s === 7 ? 18 : 16), s === 7 ? (beatMs / 1000) * 1.2 : .45, s);
          }
        }
      }
      // Small orchestra, no pad yet: the piano's left hand plays a flowing broken chord
      // (root, fifth, third, fifth; in three: root, fifth, third), like a pianist accompanying alone.
      if (onBeat && ![1, 6, 2].some((s) => s !== lead && on(s, s === 1 ? 0 : s === 6 ? .45 : .6)) && !barLine && !change) {
        const c = this.chordAt(60).map((p) => this.band(p, 55));        // above the muddy low register
        let p = (waltz ? [c[0], c[2], c[1]] : [c[0], c[2], c[1], c[2]])[Math.floor(inBar + 1e-9)];
        if (Math.abs(p - leadPitch) <= 2) p = c.find((x) => Math.abs(x - leadPitch) > 2) ?? null;
        if (p !== null) this.emit(at, p, vel(15), (beatMs / 1000) * .95, 0);
      }
      // Accordion "pah" on beats 2 and 4 ("pah-pah" on 2 and 3 in a waltz) when it is not singing.
      if (onBeat && !barLine && (waltz || eq(inBar % 2, 1)) && lead !== 8 && on(8, .3)) {
        for (const p of this.mid(leadPitch)) this.emit(at, p, vel(14), (beatMs / 1000) * .3, ACCORDION);
      }
      // Drums only at the climax: kick on 1 and 3, snare on 2 and 4 (waltz: kick on 1, light 2 and 3).
      if (onBeat && this.shift) {
        const kick = waltz ? barLine : eq(inBar % 2, 0);
        this.emit(at, kick ? 36 : 38, vel(kick ? 30 : waltz ? 16 : 22), .15, DRUMS);
      }
    },

    // Bass plus one pad (two at a peak), each in its own register, never on the melody's note.
    harmony(at, len, lead, leadPitch, on, vel) {
      const low = this.chordAt(36)[0];
      if (on(3, .2)) this.emit(at, low, vel(34), len, 3);                 // cello, 36-47
      else this.emit(at, low < 40 ? low + 12 : low, vel(26), len, 0);     // piano left hand
      const pads = [1, 6, 2].filter((s) => s !== lead && on(s, s === 1 ? 0 : s === 6 ? .45 : .6));
      for (const s of pads.slice(0, this.intensity >= .75 ? 2 : 1)) {
        const notes = s === 6 ? this.horn() : this.mid(leadPitch, s === 2 ? 72 : 60);
        for (const p of notes) this.emit(at, p, vel(s === 6 ? 20 : 16), len, s);
      }
    },
    mid(leadPitch, lo = 60) { return this.chordAt(60).map((p) => this.band(p, lo)).filter((p) => Math.abs(p - leadPitch) > 2); },
    horn() { const h = this.chordAt(48); return [this.band(h[0], 48), this.band(h[2], 48)]; },

    playCues(at, vel, beatMs) {
      const t = this.chordAt(60), base = this.band(t[0], 55), up = [0, t[1] - t[0], t[2] - t[0], 12];
      for (const kind of this.cues.splice(0)) {
        if (kind === "climax") { this.emit(at, 49, vel(40), 2.2, DRUMS); this.emit(at, this.chordAt(36)[0], vel(46), 1.2, TIMPANI); }
        else if (kind === "ship") for (const d of [0, up[2], 12]) this.emit(at, base + d, vel(24), (beatMs / 1000) * 2, 6);
        else up.forEach((d, i) => this.emit(at + (i * beatMs) / 2, base + d, vel(26), (beatMs / 1000) * .45, 6));   // lead / pass: rising call
      }
    },
  };
}
