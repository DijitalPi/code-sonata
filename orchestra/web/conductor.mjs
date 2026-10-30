// The conductor: one clock for everything. Notes sit on an ideal timeline (not "whenever the 25 ms
// timer fires"), and every part, drums included, comes from the same song beat grid. Shared by the
// server (real machines) and the browser's demo concert (simulated machines): `population(now, dt)`
// says how many are working in which section and how many are listening. conductor.py is a
// line-for-line port for the local macOS tool; test_conductor.py checks that both play the same notes.
// A style (styles.mjs) arranges the same score another way: tempo, swing, broken or held chords,
// bass and drums. The site plays "klasik".
// A song is heard in turns (FORMS) so its few bars never loop for minutes: the theme, then a
// variation (another voice, an octave up, the piano answering long notes), then a breath (the
// accompaniment alone, up to eight bars), and the next song begins. Played like a person would:
// each phrase swells and settles, the bar line leans, the last bar before a song closes slows, chords
// roll from the bottom, and a dominant seventh leads into the next song's key. Onsets stay on the grid.
// `flow` (the local tool's "akış" and the site's hall) plays loops instead of songs (flow.mjs): every part
// is a four-bar loop on one sixteenth grid, in one key and chord loop; a scene of eight loops builds,
// breaks and peaks, then the next scene brings a new chord loop, key, tempo and riffs.
import { SONGS, KEYS, PLANS, METERS, MOODS, PLAYLIST, TEMPOS, chordTones, chordsFor } from "./music.mjs";
import STYLES from "./styles.mjs";
import FLOW from "./flow.mjs";
export { STYLES, FLOW };

export const TIMPANI = 8, TREMOLO = 9, DRUMS = 10, ACCORDION = 11;   // engine voices; section 8 plays voice 11
export const LEAD_MS = 900;     // notes are scheduled this far ahead so every listener can play them on time
const LOOKAHEAD_MS = 150;
const eq = (a, b) => Math.abs(a - b) < 1e-9;
// Register of each section's own short accents (local tool: a step played by that session's instrument).
const ACCENT_OCTAVE = [48, 48, 60, 36, 72, 72, 48, 60, 48];
// How much melody: "az" theme and breath, "orta" (default) theme, variation and breath, "cok" no breath.
export const FORMS = { az: ["tema", "nefes"], orta: ["tema", "varyasyon", "nefes"], cok: ["tema", "varyasyon"] };
const BREATH_BARS = 8;
const RANGES = {};   // each song's lowest and highest note: the variation goes an octave up only below A6
const NOTE_NAMES = ["Do", "Do♯", "Re", "Mi♭", "Mi", "Fa", "Fa♯", "Sol", "La♭", "La", "Si♭", "Si"];
// Flow's state: the scene (key, chord loop, riffs), where the loop is, and what this loop and bar play.
const freshFlow = (skip) => ({ rng: 0, count: 0, key: [0, false], prog: [], progId: "", loop: 0, step: 0, skip, plan: null, bar: [],
  hooks: {}, counter: [], bass: "", comp: "", arp: "", stabs: "", bells: null, riff: null, voicing: null, stab: null,
  choir: null, recent: [], bonus: false, shipped: false, left: null });

// Options used only by the local tool: a shorter lead (no network), a fixed song list (`ordered`:
// played in its order, a queue), favourites picked first, error and waiting cues, and a shorter gap
// between repeated signals. The site keeps the defaults.
export function createConductor({ population, song = "bella-ciao", leadMs = LEAD_MS, songs = PLAYLIST,
  errorCues = false, signalGapMs = 10_000, style = "klasik", moods = MOODS, melody = "orta", ordered = false, favorites = [], flow = false }) {
  style = STYLES[style] ? style : "klasik";
  return {
    song: songs.includes(song) ? song : songs[0], songCount: 0, songs, leadMs, errorCues, signalGapMs, style, moods,
    melody: FORMS[melody] ? melody : "orta", turn: 0, ordered, favorites, anchor: null,
    history: [], position: 0, songBeat: 0, chord: null, nextChange: 0, lead: null, tension: false, tensionNext: false,
    bpm: STYLES[style].tempo[0], intensity: 0, shift: 0, targetShift: 0,
    clock: 0, steps: 0, short: 0, long: 0,
    peakSince: null, calmSince: null, climaxSince: 0, coolUntil: 0,
    active: [], working: 0, cues: [], accents: [], lastSignal: {}, solo: 0, out: [],
    // Who is on stage: a section comes in on a bar line and leaves where a phrase starts, so nobody
    // breaks into or out of the middle of a line. `featured`: sections a session plays itself
    // (local tool); they always have a part, whatever the pace.
    stage: null, featured: [], starring: [], ending: false, endBy: 0,
    noteStart: 0, noteBeatMs: 0, noteBeat: 0, notePickup: 0, leadPitch: -99,
    house: false, lastActive: 0, peak: 0, peakDay: "",
    flow: flow ? freshFlow(false) : null,

    // The next song follows the agents' pace: calm, warm or wild, or a neighbouring mood. The last
    // few songs heard (half the list, at most six) wait their turn whatever the mood, and among
    // the rest the one heard longest ago (or never) comes next: one mood never loops its few songs.
    // A favourite goes first, and a song in another key than the one just ended when there is a
    // choice. A queue (`ordered`) simply plays on in its order.
    pickSong() {
      const I = this.intensity;
      const mood = I >= .7 ? "wild" : I >= .35 ? "warm" : "calm";
      const near = mood === "warm" ? ["calm", "wild"] : ["warm"];
      this.history.push(this.song);
      if (this.history.length > 64) this.history.shift();
      if (this.ordered) return this.songs[(this.songs.indexOf(this.song) + 1) % this.songs.length];
      const pool = this.songs.filter((s) => s !== this.song);
      const wait = Math.min(6, Math.floor(this.songs.length / 2));
      const recent = wait ? this.history.slice(-wait) : [];
      const fresh = pool.filter((s) => !recent.includes(s));
      const key = KEYS[this.song];
      const apart = (list) => { const other = list.filter((s) => KEYS[s][0] !== key[0] || KEYS[s][1] !== key[1]); return other.length ? other : list; };
      const least = (list) => apart(list).reduce((best, s) => (best === null || this.history.lastIndexOf(s) < this.history.lastIndexOf(best) ? s : best), null);
      const best = (list) => least(list.filter((s) => this.favorites.includes(s))) ?? least(list);
      return best(fresh.filter((s) => this.moods[mood].includes(s)))
        ?? best(fresh.filter((s) => near.some((m) => this.moods[m].includes(s)))) ?? best(fresh) ?? best(pool) ?? this.song;
    },
    // The tempo the pace asks for: the style's range, times the song's own tempo.
    pace() { const [slow, fast] = STYLES[this.style].tempo; return (slow + (fast - slow) * this.intensity) * (TEMPOS[this.song] ?? 1); },
    // The beat where this visit of the song ends, if this turn is its last (the breath may stop early).
    endOfVisit() {
      const form = FORMS[this.melody], plan = PLANS[this.song];
      if (this.turn < form.length - 1) return null;
      const total = plan[plan.length - 1].start + SONGS[this.song][plan.length - 1][1];
      if (this.part() !== "nefes") return total;
      const cut = plan.find((step, i) => i && step.phraseStart && step.start >= BREATH_BARS * METERS[this.song][0] - 1e-9);
      return cut ? cut.start : total;
    },
    // A new line on the theme's rhythm and chords: the tune turned upside down around the phrase's
    // first note, landing on chord tones on the beat and on scale tones between, within the song's range.
    invert(pitch, step, pickup) {
      const [tonic, minor] = KEYS[this.song], [root, iv] = step.chord, [lo, hi] = RANGES[this.song];
      const chord = iv.map((i) => (root + i) % 12);
      const scale = (minor ? [0, 2, 3, 5, 7, 8, 10] : [0, 2, 4, 5, 7, 9, 11]).map((d) => (tonic + d) % 12);
      const strong = eq((((step.start - pickup) % 1) + 1) % 1, 0);
      const fits = (p) => p >= lo - 2 && p <= hi + 2 && (strong ? chord : [...scale, ...chord]).includes(((p % 12) + 12) % 12);
      let p = 2 * this.anchor - pitch;
      while (p > hi + 2) p -= 12;
      while (p < lo - 2) p += 12;
      for (let d = 0; d <= 6; d++) {
        if (fits(p - d)) return p - d;
        if (fits(p + d)) return p + d;
      }
      return pitch;
    },
    // How much melody from the next turn on (FORMS).
    setMelody(name) { if (FORMS[name]) this.melody = name; },
    part() { const form = FORMS[this.melody]; return form[Math.min(this.turn, form.length - 1)]; },
    // Another arrangement from the next note on; the tempo glides to the new style's range (flow: a new scene on the next bar line).
    setStyle(name) { if (STYLES[name]) { this.style = name; if (this.flow) this.flow.skip = true; } },
    // Loops or songs from the next bar line (a song from its first note).
    setFlow(on) {
      if (!on === !this.flow) return;
      this.flow = on ? freshFlow(true) : null;
      if (!on) { this.position = 0; this.songBeat = 0; this.turn = 0; this.lead = null; this.shift = 0; }
    },
    // Menu bar "next song": start the next one from its first note (flow: the next scene from the next bar line).
    skip() {
      if (this.flow) { this.flow.skip = true; return; }
      this.song = this.pickSong(); this.songCount++;
      this.position = 0; this.songBeat = 0; this.turn = 0; this.lead = null;
    },
    tonality() { return this.flow ? this.flow.key : KEYS[this.song]; },
    chordAt(octave) { return chordTones(this.chord, this.tonality(), octave); },
    band(p, lo) { while (p >= lo + 12) p -= 12; while (p < lo) p += 12; return p; },

    emit(at, p, v, d, i) {
      if (i !== DRUMS) p += this.shift;
      this.out.push([Math.round(at), Math.max(0, Math.min(127, p)), Math.max(1, Math.min(120, Math.round(v))), Math.round(d * 1000) / 1000, i]);
    },

    // Signals become cues that play on the next bar line, in key and in time.
    signal(kind, section, now) {
      if ((kind === "fail" || kind === "testfail") && !this.errorCues) return;   // no error chords on the site
      // The latest test result decides the harmony (from the next bar line), even if its sound is throttled.
      if (kind === "testfail" || kind === "pass") this.tensionNext = kind === "testfail";
      if (now - (this.lastSignal[kind] ?? -Infinity) < this.signalGapMs) return;
      this.lastSignal[kind] = now;
      this.cue(kind);
    },
    cue(kind) { if (!this.cues.includes(kind)) this.cues.push(kind); },
    // A step of one kind from one section: a short note of that section's instrument on the next half beat.
    accent(kind, section) {
      if (["bash", "read", "think"].includes(kind) && this.accents.length < 9 && !this.accents.some(([k, s]) => k === kind && s === section)) this.accents.push([kind, section]);
    },

    tick(now, dt) {
      const { working, total, active, listening, featured = [] } = population(now, dt);
      this.active = active; this.working = working; this.featured = featured;
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
      if (!this.flow) this.bpm += (this.pace() - this.bpm) * Math.min(1, dt / 2500);   // klasik: 66..116, times the song's tempo (flow: a tempo per scene)
      this.climax(now);
      // Nobody working but someone listening: the house pianist plays (piano only, calm, soft)
      // until the agents return. Never shown as a participant; the page says it is the house.
      if (working) this.lastActive = now;
      const day = new Date(now).toISOString().slice(0, 10);
      if (day !== this.peakDay) { this.peakDay = day; this.peak = 0; }
      this.peak = Math.max(this.peak, total);
      this.house = !working && listening > 0;
      if (this.flow) return this.flowTick(now, working, total);
      if (!working && !this.house) {
        const beatMs = 60_000 / this.bpm, vel = (base) => base * 1.7 * .85;
        // The last one out: the phrase plays to its end, or two bars on to a bar line, then a soft tonic.
        if (this.clock && this.clock >= now - 500) {
          if (!this.ending) { this.ending = true; this.endBy = this.songBeat + 8; }
          while (this.clock && this.clock <= now + LOOKAHEAD_MS) {
            const [meter, pickup] = METERS[this.song], inBar = (((this.songBeat - pickup) % meter) + meter) % meter;
            const over = this.songBeat >= this.endBy && (eq(inBar, 0) || this.songBeat >= this.endBy + meter);
            if (PLANS[this.song][this.position].phraseStart || over) {
              this.close(this.clock + this.leadMs, vel, beatMs);
              this.clock = 0;
            } else this.note(this.clock);
          }
        } else {                                                          // a stall (sleep): no late chord mid-ending
          if (this.clock && !this.ending) this.close(now + this.leadMs, vel, beatMs);
          this.clock = 0;
        }
        if (this.cues.length) this.playCues(now + this.leadMs, vel, beatMs);                 // a signal while all is quiet plays at once
        this.accents.length = 0;
        if (!this.clock) { this.ending = false; this.stage = null; this.starring = []; }
        return { working, total };
      }
      this.ending = false;
      if (!this.clock || this.clock < now - 500) this.clock = now;        // start, or recover from a stall
      while (this.clock <= now + LOOKAHEAD_MS) this.note(this.clock);
      if (this.accents.length) this.flushAccents(now);
      return { working, total };
    },

    // Steps are heard on the next half beat of the grid, not when the next melody note comes.
    flushAccents(now) {
      const beatMs = this.noteBeatMs, half = beatMs / 2, look = STYLES[this.style];
      const rel = this.noteBeat - this.notePickup, offset = ((rel % .5) + .5) % .5;   // the note may start between grid points
      const origin = this.noteStart - offset * beatMs, k = Math.max(0, Math.ceil((now - origin) / half - 1e-9));
      const pos = rel - offset + k * .5;
      const swing = look.swing && eq(((pos % 1) + 1) % 1, .5) ? (look.swing * beatMs) / 6 : 0;
      const crowd = .85 + .15 * Math.min(1, Math.log2(1 + this.working) / 6);
      // Loops: an accent takes the chord of the bar it lands in (past the loop: its first bar) and stops at that bar's end.
      let limit = Infinity;
      const held = this.chord;
      if (this.flow && this.flow.prog.length) {
        const F = this.flow, bar = Math.floor(pos / 4 + 1e-9);
        // Its bar belongs to a scene not written yet (the loop ends the scene, or a skip waits): no chord to take, no accent.
        if ((bar >= 4 && F.loop >= FLOW.arc.length) || (F.skip && bar !== Math.floor(this.noteBeat / 4 + 1e-9))) { this.accents.length = 0; return; }
        this.chord = F.prog[bar % 4];
        limit = (((bar + 1) * 4 - pos) * beatMs - swing) / 1000;   // a swung offbeat starts later, so it ends sooner
      }
      this.playAccents(origin + k * half + swing + this.leadMs, this.leadPitch, (base) => base * 1.7 * (1 + .25 * this.intensity) * crowd, beatMs, limit);
      this.chord = held;
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
      const score = SONGS[this.song], plan = PLANS[this.song], key = KEYS[this.song], look = STYLES[this.style];
      const [pitch, beats] = score[this.position];
      const step = plan[this.position];
      // Ritardando: over the last bar before the song closes, the beat stretches by up to a quarter.
      const end = this.ending ? null : this.endOfVisit(), meter = METERS[this.song][0];
      const left = end === null ? Infinity : end - this.songBeat;
      const beatMs = (60_000 / this.bpm) * (left <= meter + 1e-9 ? 1 + .25 * (1 - left / meter) : 1);
      const I = this.intensity, active = this.active;
      const at = t + this.leadMs;
      const crowd = this.house ? .7 : .85 + .15 * Math.min(1, Math.log2(1 + this.working) / 6);   // house: softer; a bigger orchestra, a bit fuller
      const vel = (base) => base * 1.7 * (1 + .25 * I) * crowd;
      const part = this.part(), varied = part === "varyasyon", breath = part === "nefes";
      // A breath lasts its bars, then the song closes where the next phrase would start.
      if (breath && step.phraseStart && this.position && !this.ending && this.songBeat >= BREATH_BARS * meter - 1e-9) {
        this.nextSong(vel, beatMs, key);
        return;
      }
      this.chord = step.chord;
      this.nextChange = step.nextChange;
      if (!this.stage) { this.stage = active.slice(); this.starring = [...this.featured]; }   // after a rest: everyone at once
      if (step.phraseStart) {                                             // leavers have finished their phrase
        for (let s = 0; s < this.stage.length; s++) if (!(active[s] > 0)) this.stage[s] = 0;
        this.starring = this.starring.filter((s) => this.featured.includes(s));
      }
      const on = (s, from) => this.stage[s] > 0 && (I >= from || this.starring.includes(s));
      // Swing: an offbeat eighth comes a little late (a full swing puts it on the last triplet).
      // Beats count from the first bar line: a half-beat pickup must not turn every offbeat around.
      const pickup = METERS[this.song][1];
      const swing = (beat) => (look.swing && eq((((beat - pickup) % 1) + 1) % 1, .5) ? (look.swing * beatMs) / 6 : 0);
      // Melody: one section per phrase, rotating among the sections on stage. It changes hands only
      // where a phrase starts or when its section leaves the stage, never because the pace dropped.
      // The variation hands it to another section on stage (the piano keeps it only when alone);
      // in a breath nobody sings and every accompanying part plays.
      const singers = [0, 8, 4, 1, 2].filter((s) => s === 0 || on(s, s === 2 ? .5 : s === 8 ? 0 : .25));
      const others = [8, 4, 1, 2].filter((s) => this.stage[s] > 0);
      const pool = varied && others.length ? others : singers;
      const stays = this.lead !== null && (this.lead === 0 || this.stage[this.lead] > 0);
      if (breath) this.lead = null;
      else if (step.phraseStart || !stays) this.lead = pool[(step.phrase + this.songCount) % pool.length];
      const lead = this.lead;
      if (!RANGES[this.song]) { const tune = score.map(([p]) => p).filter((p) => p !== null); RANGES[this.song] = [Math.min(...tune), Math.max(...tune)]; }
      const up = varied && lead !== 4 && RANGES[this.song][1] + 12 <= 93 ? 12 : 0;
      // The variation's odd phrases are a new line (invert); each phrase still starts and ends on the theme's notes.
      if (step.phraseStart || this.anchor === null) this.anchor = pitch;
      const tune = varied && pitch !== null && step.phrase % 2 === 1 && !step.last && this.anchor !== null ? this.invert(pitch, step, pickup) : pitch;
      const leadPitch = tune === null || breath ? -99 : tune + (lead === 4 ? 12 : 0) + up;   // flute an octave up; null = rest
      const ctx = { lead, leadPitch, on, vel, beatMs, breath };
      this.noteStart = t; this.noteBeatMs = beatMs; this.noteBeat = this.songBeat; this.notePickup = pickup; this.leadPitch = leadPitch;
      // The grid: the note's onset, then every half beat it covers (a note may start between them).
      // A flute of its own that is not leading doubles the tune softly, an octave up: decided at the
      // onset, so a newcomer starts on a bar line, never in the middle of a held note.
      let double = false;
      const first = Math.ceil((this.songBeat - pickup) * 2 - 1e-9) / 2 - (this.songBeat - pickup);
      for (let k = 0; k < beats - 1e-9; k = k === 0 && first > 1e-9 ? first : k + .5) {
        this.grid(at + k * beatMs + swing(this.songBeat + k), this.songBeat + k, step, ctx, k === 0);
        if (k === 0) double = lead !== 4 && this.starring.includes(4) && this.stage[4] > 0;
      }
      if (tune !== null && !breath) {
        this.solo = at;                                                   // the leading country glows on melody notes
        // A phrase swells toward its middle and settles on its last note; the bar line leans a little.
        const inBar = (((this.songBeat - pickup) % meter) + meter) % meter;
        const lean = eq(inBar, 0) ? 1.06 : eq((((this.songBeat - pickup) % 1) + 1) % 1, 0) ? 1 : .95;
        const shape = (.9 + .16 * step.arch) * (step.last ? .9 : 1) * lean;
        const onset = at + swing(this.songBeat);
        this.emit(onset, leadPitch, vel(lead === 0 ? 54 : 46) * shape, Math.min(2.6, (beats * beatMs) / 1000 * .92 * look.staccato), lead === 8 ? ACCORDION : lead);
        if (double) this.emit(onset, up ? tune : tune + 12, vel(20) * shape, Math.min(2.6, (beats * beatMs) / 1000 * .92 * look.staccato), 4);
        // The variation's answer: under a long note, the piano (free of the tune) climbs the chord.
        if (varied && lead !== 0 && beats >= 2) {
          const tones = [...this.chordAt(60), ...this.chordAt(72)].filter((p) => p < leadPitch - 2 && p >= leadPitch - 14).sort((a, b) => a - b);
          const fill = tones.slice(-Math.min(3, Math.floor((beats - 1) / .5 + 1e-9)));
          fill.forEach((p, i) => this.emit(at + (1 + i * .5) * beatMs + swing(this.songBeat + 1 + i * .5), p, vel(16), (beatMs / 1000) * .45, 0));
        }
      }
      this.songBeat += beats;
      this.clock = t + beats * beatMs;
      this.position++;
      if (this.position >= score.length) {
        this.position = 0; this.songBeat = 0; this.turn++;
        // The form over, the next song; when things heat up, a wild one at once (ending: the same song closes).
        const heatingUp = I >= .7 && this.songs.length > 1 && !this.moods.wild.includes(this.song);
        if (!this.ending && (this.turn >= FORMS[this.melody].length || heatingUp)) this.nextSong(vel, beatMs, key);
      }
    },

    // Close the song: the tonic rings for two beats, then the next song's dominant seventh for two
    // (a bridge into its key), and the next one begins at its own tempo.
    nextSong(vel, beatMs, key) {
      this.close(this.clock + this.leadMs, vel, beatMs, key);
      this.position = 0; this.songBeat = 0;
      this.song = this.pickSong(); this.songCount++; this.turn = 0; this.lead = null; this.tension = this.tensionNext = false;
      const root = (KEYS[this.song][0] + 7) % 12, at = this.clock + 2 * beatMs + this.leadMs;
      [this.band(36 + root, 36), ...[4, 7, 10].map((d) => this.band(48 + root + d, 55))]
        .forEach((p, i) => this.emit(at + i * 25, p, vel(20), (2 * beatMs) / 1000 * .9, 0));
      this.clock += 4 * beatMs;
      this.bpm = this.pace();
    },

    // A closing tonic chord, rolled from the bottom: at the end of a song, or when the last agent finishes.
    close(at, vel, beatMs, key = this.tonality()) {
      const tonic = chordTones(null, key, 48);
      [tonic[0] - 12, ...tonic.map((x) => x + 12)].forEach((p, i) => this.emit(at + i * 25, p, vel(30), (2 * beatMs) / 1000, 0));
    },

    grid(at, beat, step, { lead, leadPitch, on, vel, beatMs, breath }, onset) {
      const I = this.intensity, [meter, pickup] = METERS[this.song], look = STYLES[this.style];
      const inBar = (((beat - pickup) % meter) + meter) % meter, waltz = meter === 3;
      // Beats are counted from the first bar line, so a pickup does not shift the drums.
      const rel = beat - pickup, barLine = eq(inBar, 0), onBeat = eq(((rel % 1) + 1) % 1, 0), change = onset && step.change;
      const half = eq((((rel * 2) % 1) + 1) % 1, 0) || eq((((rel * 2) % 1) + 1) % 1, 1);   // on the half-beat grid
      if (barLine) {                                                      // key, suspension and newcomers change on a bar line only
        this.shift = this.targetShift; this.tension = this.tensionNext;
        this.active.forEach((n, s) => { if (n > 0) this.stage[s] = n; });
        for (const s of this.featured) if (!this.starring.includes(s)) this.starring.push(s);
      }
      if (barLine && this.cues.length) this.playCues(at, vel, beatMs);
      // Harmony is struck on a chord change and on each bar line, and lasts exactly until the
      // next of the two: two chords never ring on top of each other.
      if (change || barLine) {
        const until = Math.min(this.nextChange, beat + meter - inBar);
        // Samples ring ~0.3 s after release: stop early before a new chord so its tail is gone
        // when the next chord starts (no need when the same chord is struck again).
        const span = (Math.max(.25, until - beat) * beatMs) / 1000;
        const len = eq(until, this.nextChange) ? Math.max(span * .5, span - .25) : span * .94;
        this.harmony(at, len, lead, leadPitch, on, vel, beatMs);
      }
      // A driving bass: the root on every half beat ("octaves": root and octave in turn).
      if (half && look.bass !== "long") {
        const low = this.chordAt(36)[0], root = low < 40 ? low + 12 : low;
        this.emit(at, look.bass === "octaves" && !onBeat ? root + 12 : root, vel(24), (beatMs / 1000) * .45, on(3, 0) ? 3 : 0);
      }
      // The cello steps to the fifth halfway through a bar when the chord holds.
      if (look.bass === "long" && !waltz && eq(inBar, 2) && !change && on(3, .35) && this.nextChange - beat >= 2) {
        const fifth = this.chordAt(36)[2];
        this.emit(at, fifth >= 48 ? fifth - 12 : fifth, vel(26), (2 * beatMs) / 1000 * .9, 3);
      }
      // Film strings: root and fifth in eighths under the held chords.
      if (half && look.comp === "ostinato" && on(1, .3) && lead !== 1) {
        const c = this.chordAt(48);
        this.emit(at, this.band(onBeat ? c[0] : c[2], 48), vel(13), (beatMs / 1000) * .45, 1);
      }
      // Colour: one voice up high, on the beat: harp (every beat) or vibraphone (beats 1 and 3).
      if (onBeat && (I >= .25 || this.starring.includes(7) || this.starring.includes(5))) {
        const colour = [7, 5].filter((s) => on(s, s === 5 ? .45 : .25));
        const stars = colour.filter((s) => this.starring.includes(s));   // two sessions' own colours both play
        const players = stars.length > 1 ? stars : colour.length ? [colour[Math.floor(this.position / 8) % colour.length]] : [];
        for (const s of players) {
          if (s === 7 || eq(inBar, 0) || (!waltz && eq(inBar, 2))) {
            const p = this.chordAt(84)[Math.floor(beat) % 3];
            this.emit(at, p, vel(s === 7 ? 18 : 16), s === 7 ? (beatMs / 1000) * 1.2 : .45, s);
          }
        }
      }
      // Small orchestra, no pad yet, or a breath: the piano's left hand plays a flowing broken chord
      // (root, fifth, third, fifth; in three: root, fifth, third), like a pianist accompanying alone.
      if (onBeat && (breath || ![1, 6, 2].some((s) => s !== lead && on(s, s === 1 ? 0 : s === 6 ? .45 : .6))) && !barLine && !change) {
        const c = this.chordAt(60).map((p) => this.band(p, 55));        // above the muddy low register
        const pattern = waltz ? [c[0], c[2], c[1]] : [c[0], c[2], c[1], c[2]];
        let p = pattern[Math.floor(inBar + 1e-9) % pattern.length];
        if (Math.abs(p - leadPitch) <= 2) p = c.find((x) => Math.abs(x - leadPitch) > 2) ?? null;
        if (p !== null) this.emit(at, p, vel(15), (beatMs / 1000) * .95, 0);
      }
      // Accordion "pah" on beats 2 and 4 ("pah-pah" on 2 and 3 in a waltz) when it is not singing.
      if (onBeat && !barLine && (waltz || eq(inBar % 2, 1)) && lead !== 8 && on(8, .3)) {
        for (const p of this.mid(leadPitch)) this.emit(at, p, vel(14), (beatMs / 1000) * .3, ACCORDION);
      }
      this.drums(at, inBar, waltz, barLine, onBeat, half, vel, I);
    },

    // Drums by style. Classic and film: only at the climax (film adds timpani on bar lines from a
    // busy pace). Groove: kick, snare and offbeat hats once the pace picks up. Lo-fi: a soft swung beat.
    drums(at, inBar, waltz, barLine, onBeat, half, vel, I) {
      const kind = STYLES[this.style].drums;
      if (kind === "orchestral" && barLine && I >= .4) this.emit(at, this.chordAt(36)[0], vel(20), .8, TIMPANI);
      if (kind === "lofi") {
        if (half && (barLine || (!waltz && eq(inBar, 2.5)))) this.emit(at, 36, vel(18), .15, DRUMS);
        if (onBeat && !barLine && (waltz || eq(inBar % 2, 1))) this.emit(at, 38, vel(10), .15, DRUMS);
        if (half) this.emit(at, 42, vel(onBeat ? 7 : 5), .05, DRUMS);
        return;
      }
      if (!this.shift && !(kind === "groove" && I >= .3)) return;
      if (onBeat) {
        const kick = waltz ? barLine : eq(inBar % 2, 0);
        this.emit(at, kick ? 36 : 38, vel(kick ? 30 : waltz ? 16 : 22), .15, DRUMS);
      } else if (half && kind === "groove" && I >= .55) this.emit(at, 42, vel(9), .05, DRUMS);
    },

    // Bass plus one pad (two at a peak), each in its own register, never on the melody's note.
    // "arp" styles break the pad into sixteenths instead of holding it.
    harmony(at, len, lead, leadPitch, on, vel, beatMs) {
      const look = STYLES[this.style], low = this.chordAt(36)[0];
      if (look.bass === "long") {
        if (on(3, .2)) this.emit(at, low, vel(34), len, 3);                 // cello, 36-47
        else this.emit(at, low < 40 ? low + 12 : low, vel(26), len, 0);     // piano left hand
      }
      const pads = [1, 6, 2].filter((s) => s !== lead && on(s, s === 1 ? 0 : s === 6 ? .45 : .6));
      const room = this.intensity >= .75 ? 2 : 1;                       // a session's own pad always has room
      for (const s of pads.filter((s, i) => i < room || this.starring.includes(s))) {
        const notes = s === 6 ? this.horn() : this.mid(leadPitch, s === 2 ? 72 : 60);
        if (look.comp === "arp" && notes.length) {
          const tick = beatMs / 4, count = Math.max(1, Math.floor((len * 1000) / tick + 1e-9));
          const order = notes.length > 2 ? [...notes.keys(), ...[...notes.keys()].slice(1, -1).reverse()] : [...notes.keys()];
          for (let i = 0; i < count; i++) this.emit(at + i * tick, notes[order[i % order.length]], vel(12), (tick / 1000) * .9, s);
        } else for (const p of notes) this.emit(at, p, vel(s === 6 ? 20 : 16), len, s);
      }
    },
    mid(leadPitch, lo = 60) { return this.padChord(60).map((p) => this.band(p, lo)).filter((p) => Math.abs(p - leadPitch) > 2); },
    horn() { const h = this.chordAt(48); return [this.band(h[0], 48), this.band(h[2], 48)]; },
    // The held chord: a broken test suspends it (the third gives way to a fourth) until a test
    // passes; lo-fi adds the seventh (the dominant's is minor).
    padChord(octave) {
      const key = this.tonality(), [root, iv] = this.chord || chordsFor(key)[0];
      let tones = iv;
      if (this.tension) tones = this.flow ? [0, 7] : [0, 5, 7];   // loops: an open fifth, the riffs keep their thirds
      else if (STYLES[this.style].sevenths && iv.length === 3) {
        // The seventh the key's own scale has (natural minor in a minor key): a minor key's VII takes a
        // minor seventh. Outside the scale: a minor chord or the dominant a minor seventh, the rest a major one.
        const scale = (key[1] ? [0, 2, 3, 5, 7, 8, 10] : [0, 2, 4, 5, 7, 9, 11]).map((d) => (key[0] + d) % 12);
        const flat = scale.includes((root + 10) % 12), major = scale.includes((root + 11) % 12);
        tones = [...iv, flat !== major ? (flat ? 10 : 11) : iv[1] === 3 || (root - key[0] + 12) % 12 === 7 ? 10 : 11];
      }
      const base = octave - (octave % 12) + root;
      return tones.map((i) => base + i);
    },

    // Steps heard as short chord tones in each session's own instrument: a command low, a read
    // high and light, thinking a soft third. Never on the melody's note.
    playAccents(at, leadPitch, vel, beatMs, limit = Infinity) {
      for (const [kind, section] of this.accents.splice(0)) {
        const voice = section === 8 ? ACCORDION : section, c = this.chordAt(ACCENT_OCTAVE[section] + (kind === "read" ? 12 : 0));
        const notes = kind === "bash" ? [c[0]] : kind === "read" ? [c[2]] : [c[0], c[1]];
        for (const p of notes) if (Math.abs(p - leadPitch) > 2) this.emit(at, p, vel(kind === "bash" ? 20 : kind === "read" ? 12 : 10), Math.min(limit, (beatMs / 1000) * (kind === "think" ? 1.5 : .45)), voice);
      }
    },

    playCues(at, vel, beatMs) {
      const t = this.chordAt(60), base = this.band(t[0], 55), up = [0, t[1] - t[0], t[2] - t[0], 12];
      for (const kind of this.cues.splice(0)) {
        if (kind === "climax") { this.emit(at, 49, vel(40), 2.2, DRUMS); this.emit(at, this.chordAt(36)[0], vel(46), 1.2, TIMPANI); }
        else if (kind === "ship") for (const d of [0, up[2], 12]) this.emit(at, base + d, vel(24), (beatMs / 1000) * 2, 6);
        else if (kind === "wait") {                                       // your turn: a bell rising, one note after another
          up.forEach((d, i) => this.emit(at + (i * beatMs) / 2, base + 24 + d, vel(22), 1.4 - i * .2, i === 3 ? 7 : 5));
        } else if (kind === "fail" || kind === "testfail") {              // something broke: a dark low chord and a timpani stroke
          const low = this.chordAt(36)[0], w = kind === "testfail" ? 1.3 : 1;
          for (const d of [12, 15, 18]) this.emit(at, low + d, vel(18 * w), 1.4, TREMOLO);
          this.emit(at, low, vel(26 * w), 1, TIMPANI);
        } else up.forEach((d, i) => this.emit(at + (i * beatMs) / 2, base + d, vel(26), (beatMs / 1000) * .45, 6));   // lead / pass: rising call
      }
    },

    // ---- Flow: loops instead of songs (flow.mjs) ----
    // The agents working: one sixteenth after another. The last one out: the bar plays to its end (the
    // next one too when less than a beat is left), then a soft tonic. With listeners and nobody working
    // the house pianist plays the loops alone (house: piano only, no beat).
    flowTick(now, working, total) {
      const F = this.flow, vel = (base) => base * 1.7 * .85, beatMs = 60_000 / this.bpm;
      if (!working && !this.house) {
        if (this.clock && this.clock >= now - 500) {
          if (F.left === null) { F.left = 16 - (F.step % 16); if (F.left < 4) F.left += 16; }
          while (this.clock && this.clock <= now + LOOKAHEAD_MS) {
            if (F.left <= 0) { this.close(this.clock + this.leadMs, vel, beatMs); this.clock = 0; }
            else { this.flowStep(this.clock); F.left--; }
          }
        } else {                                                          // a stall (sleep): no late chord mid-ending
          if (this.clock && F.left === null) this.close(now + this.leadMs, vel, beatMs);
          this.clock = 0;
        }
        if (this.cues.length) this.playCues(now + this.leadMs, vel, beatMs);
        this.accents.length = 0;
        if (!this.clock) { F.left = null; this.stage = null; this.starring = []; }
        return { working, total };
      }
      F.left = null;
      if (!this.clock) { this.clock = now; this.newScene(now); }        // start
      else if (this.clock < now - 500) this.clock = now;                // a stall (sleep): the loop goes on where it was
      while (this.clock <= now + LOOKAHEAD_MS) this.flowStep(this.clock);
      if (this.accents.length) this.flushAccents(now);
      return { working, total };
    },

    // One sixteenth: a loop or a bar may begin, then every note that starts on it.
    flowStep(t) {
      const F = this.flow, ending = F.left !== null;
      if (F.step === 0 || (F.skip && !ending && F.step % 16 === 0)) {
        if (ending && F.loop >= FLOW.arc.length) F.loop = FLOW.arc.length - 1;   // the last one out ends in this scene's key
        else if (!F.prog.length || (!ending && (F.skip || F.loop >= FLOW.arc.length))) this.newScene(t);   // no scene yet: loops switched on mid-ending
        this.flowLoop();
      }
      const beatMs = 60_000 / this.bpm, s = F.step % 16;
      if (s === 0) this.flowBar(t, beatMs);
      const at = t + this.leadMs + this.flowSwing(s % 4) * beatMs;
      for (const [k, p, v, d, i, ms, hook] of F.bar) {
        if (k !== s) continue;
        this.emit(at + ms, p, v, d, i);
        if (hook) { this.solo = at; this.leadPitch = p; }
      }
      this.noteStart = t; this.noteBeatMs = beatMs; this.noteBeat = F.step / 4; this.notePickup = 0;
      this.clock = t + beatMs / 4;
      F.step++;
      if (F.step >= 64) { F.step = 0; F.loop++; }
    },
    // Swing in beats for the four sixteenths of a beat: the offbeat eighth comes late, the sixteenths around it halfway.
    flowSwing(pos) { const s = STYLES[this.style].swing / 6; return [0, s / 2, s, s / 2][pos]; },

    // What the loops play: "Akış · La minör · i-VI-III-VII" (the key as heard, a climax included).
    flowTitle() {
      const F = this.flow;
      return F.progId ? `Akış · ${NOTE_NAMES[(F.key[0] + this.shift) % 12]} ${F.key[1] ? "minör" : "majör"} · ${F.progId}` : "Akış";
    },
    // The same numbers here and in conductor.py (MINSTD): riffs are written, not looked up.
    rand() { const F = this.flow; F.rng = (F.rng * 48271) % 2147483647; return F.rng / 2147483647; },
    pick(list) { return list[Math.floor(this.rand() * list.length)]; },
    pickOther(list, last) { const other = list.filter((x) => x !== last); return this.pick(other.length ? other : list); },

    // A new scene: a chord loop not heard in the last three scenes, in a neighbouring key (the relative
    // key when the mode changes), at the tempo the pace asks for, with new riffs and patterns.
    newScene(now) {
      const F = this.flow, look = STYLES[this.style].flow;
      if (!F.rng) F.rng = (Math.floor(now / 1000) % 2147483646) + 1;
      const first = F.count === 0;
      F.count++; F.loop = 0; F.step = 0; F.skip = false; F.shipped = false;
      const fresh = look.progressions.filter((id) => !F.recent.includes(id));
      F.progId = this.pick(fresh.length ? fresh : look.progressions);
      F.recent.push(F.progId);
      while (F.recent.length > Math.min(3, look.progressions.length - 1)) F.recent.shift();
      const { minor, chords } = FLOW.progressions[F.progId], [tonic, wasMinor] = F.key;
      // Every scene a new key signature: a fourth, a fifth or a tone away, or the relative of a neighbouring key.
      const key = first ? this.pick(minor ? [9, 4, 2, 7, 0] : [0, 2, 5, 7, 9])
        : minor === wasMinor ? (tonic + this.pick([5, 7, 2, 10])) % 12 : (tonic + (minor ? 9 : 3) + this.pick([5, 7])) % 12;
      F.key = [key, minor];
      F.prog = chords.map(([d, iv]) => [(key + d) % 12, iv]);
      const [slow, fast] = look.tempo, pace = Math.round(slow + (fast - slow) * this.intensity);
      const glide = Math.max(this.bpm - 8, Math.min(this.bpm + 8, pace));   // at most 8 BPM a scene, within the style's range
      this.bpm = first || glide < slow || glide > fast ? pace : glide;
      F.bass = this.pickOther(look.basses, F.bass);
      F.comp = this.pickOther(look.comps, F.comp);
      F.arp = this.pickOther(look.arps, F.arp);
      F.stabs = this.pickOther(FLOW.stabs, F.stabs);
      F.bells = { rhythm: this.pickOther(FLOW.bells, F.bells && F.bells.rhythm), idx: [0, 1, 2, 3, 4, 5, 6, 7].map(() => Math.floor(this.rand() * 4)) };
      F.riff = { rhythm: this.pickOther(FLOW.riffs, F.riff && F.riff.rhythm), idx: [0, 1, 2, 3, 4, 5, 6, 7].map(() => Math.floor(this.rand() * 4)) };
      const A = this.makeHook(null, F.hooks.A ? F.hooks.A.call : null);
      F.hooks = { A, A2: this.makeHook(A, null), B: this.makeHook(null, A.call) };
      F.counter = this.makeCounter();
    },

    // A loop begins: who left has played out, the key moves up at a climax, and the arc says what plays.
    // A commit (ship) makes the next loop the peak. Less melody keeps the hook in three loops of eight, more adds it to the intro and the break.
    flowLoop() {
      const F = this.flow, I = this.intensity;
      if (this.stage) {
        for (let s = 0; s < this.stage.length; s++) if (!(this.active[s] > 0)) this.stage[s] = 0;
        this.starring = this.starring.filter((s) => this.featured.includes(s));
      }
      this.shift = this.targetShift;
      // A commit (one waiting for this bar line too) makes this loop the peak, once a scene: a busy crowd still hears the arc.
      const bonus = !F.shipped && (F.bonus || this.cues.includes("ship")), arc = FLOW.arc[bonus ? FLOW.peak : F.loop];
      if (bonus) F.shipped = true;
      F.bonus = false;
      const levels = ["light", "main", "busy"], cap = I < .2 ? 0 : I < .5 ? 1 : 2;   // a calm pace keeps the beat light
      const beat = levels.includes(arc.beat) ? levels[Math.min(levels.indexOf(arc.beat), cap)] : arc.beat;
      let hook = this.arcHook(arc);
      if (bonus && hook) {                                                // a commit's peak: never the hook of the loop before or after it
        const before = F.plan ? F.plan.hook : null, after = F.loop + 1 < FLOW.arc.length ? this.arcHook(FLOW.arc[F.loop + 1]) : null;
        if (hook === before || hook === after) hook = ["A", "B", "A2"].find((h) => h !== before && h !== after);
      }
      F.plan = { name: arc.name, beat, hook, allow: arc.allow, sparse: !!arc.sparse, fill: !!arc.fill, crash: !!arc.crash || (F.loop === 0 && F.count > 1),
        bass: arc.bass ?? null, comp: arc.comp ?? null };
    },

    // The hook a loop of the arc plays with this much melody.
    arcHook(arc) { return this.melody === "az" ? (arc.az ? arc.hook : null) : this.melody === "cok" ? (arc.hook ?? arc.cok ?? null) : arc.hook; },

    // A bar: newcomers step in, the bar's chord, then every layer's notes, played sixteenth by sixteenth.
    flowBar(t, beatMs) {
      const F = this.flow, I = this.intensity, look = STYLES[this.style].flow, plan = F.plan, R = { ...FLOW.registers, ...look.registers };
      const bar = Math.floor(F.step / 16), stepS = beatMs / 4000, staccato = STYLES[this.style].staccato;
      if (!this.stage) { this.stage = this.active.slice(); this.starring = [...this.featured]; }
      this.active.forEach((n, s) => { if (n > 0) this.stage[s] = n; });
      for (const s of this.featured) if (!this.starring.includes(s)) this.starring.push(s);
      if (this.house) { this.stage = this.stage.map((_, s) => (s === 0 ? 1 : 0)); this.starring = []; }   // the house pianist alone
      this.tension = this.tensionNext;
      this.chord = F.prog[bar];
      const crowd = this.house ? .7 : .85 + .15 * Math.min(1, Math.log2(1 + this.working) / 6);
      const vel = (base) => base * 1.7 * (1 + .25 * I) * crowd;
      if (this.cues.length) {
        const later = bar ? this.cues.filter((k) => k === "climax") : [];   // the climax waits for the loop, where the key moves up
        this.cues = this.cues.filter((k) => !later.includes(k));
        if (this.cues.includes("ship") && bar) F.bonus = true;
        if (this.cues.length) this.playCues(t + this.leadMs, vel, beatMs);
        this.cues.push(...later);
      }
      const notes = F.bar = [];
      const add = (s, p, v, d, voice, ms = 0, hook = false) => notes.push([s, p, vel(v), d, voice, ms, hook]);
      // A layer plays when its section is on stage and the arc allows it at this pace, or when a session plays it
      // (at any pace; in a sparse loop only if the arc allows that layer at all).
      const on = (s, layer) => {
        const allowed = plan.allow[layer] !== undefined;
        return this.stage[s] > 0 && ((allowed && I >= plan.allow[layer]) || (this.starring.includes(s) && (allowed || !plan.sparse)));
      };
      const tones = (pcs, lo, hi) => { const out = []; for (let p = lo; p <= hi; p++) if (pcs.includes(p % 12)) out.push(p); return out; };
      const triad = this.chord[1].map((i) => (this.chord[0] + i) % 12);
      const pad = this.padChord(60).map((p) => p % 12);                // the style's sevenths, a broken test's suspension
      if (plan.beat && !this.house) {
        const kit = FLOW.beats[look.beat][bar === 3 && plan.fill ? "fill" : plan.beat];
        for (const [name, hits] of Object.entries(kit)) {
          for (let s = 0; s < 16; s++) {
            if (hits[s] === ".") continue;
            const level = hits[s] === "X" ? 1 : hits[s] === "x" ? .75 : .45;
            if (name === "timp") add(s, this.band(this.chord[0], 36), FLOW.levels.timp * level, FLOW.lengths.timp, TIMPANI);
            else add(s, FLOW.drums[name], FLOW.levels[name] * level, FLOW.lengths[name], DRUMS);
          }
        }
        if (bar === 0 && plan.crash && look.crash !== null) add(0, look.crash, 26, 2.2, DRUMS);
      }
      // Bass from the bar's root ("a" steps into the next bar's root); the piano's left hand when nobody plays bass.
      if (plan.allow.bass !== undefined || this.starring.includes(3)) {
        const own = this.stage[3] > 0, root = this.band(this.chord[0], 40), up = this.band(F.prog[(bar + 1) % 4][0], 40);
        for (const [s, tone, len] of FLOW.basses[plan.bass ?? F.bass]) {
          const d = up > root ? -1 : 1, rubs = (x) => pad.some((pc) => [1, 11].includes((((x - pc) % 12) + 12) % 12));
          const into = [up + d, up - d, up + 2 * d, up - 2 * d].find((x) => !rubs(x));   // a step into the next root, clear of the chord
          const p = tone === "r" ? root : tone === "5" ? root + 7 : tone === "8" ? root + 12 : tone === "3" ? root + this.chord[1][1]
            : up === root || into === undefined ? root + 7 : into;
          add(s, p, (s % 4 === 0 ? 26 : 22) * (own ? 1 : .8), len * stepS * .9, own ? 3 : 0);
        }
      }
      // Chords, voice-led from the last bar: struck, broken into an arpeggio, or root and fifth in turn.
      if (plan.allow.chords !== undefined || this.starring.includes(1)) {
        const comp = FLOW.comps[plan.comp ?? F.comp], own = this.stage[1] > 0, voice = own ? 1 : 0, level = own ? 1 : .7;
        if (comp.pair) {
          const c = this.chordAt(48), pair = [this.band(c[0], 48), this.band(c[2], 48)];
          for (let s = 0, n = 0; s < 16; s += comp.rate, n++) add(s, pair[n % 2], 13 * level, comp.rate * stepS * .9, voice);
        } else {
          F.voicing = this.voiceLead(pad, R.pad, F.voicing);
          if (comp.hits) {
            for (const [s, len, l] of comp.hits) F.voicing.forEach((p, n) => add(s, p, (len >= 8 ? 15 : 16) * l * level, len * stepS * .94, voice, n * (comp.roll ?? 0)));
          } else {
            const up = [...F.voicing, F.voicing[0] + 12];
            for (let s = 0, n = 0; s < 16; s += comp.rate, n++) add(s, up[comp.order[n % comp.order.length] % up.length], 12 * level, comp.rate * stepS * .9, voice);
          }
        }
      }
      // Voices: a held two-part line, the top on the chord tone nearest the last one.
      if (on(2, "voices")) {
        const [lo, hi] = R.voices, line = tones(pad, lo, hi), target = F.choir ?? (lo + hi) / 2;
        const top = line.reduce((best, p) => (Math.abs(p - target) < Math.abs(best - target) ? p : best), line[0]);
        F.choir = top;
        const below = line.filter((p) => top - p >= 3 && top - p <= 9);
        for (const p of [top, ...below.slice(-1)]) add(0, p, plan.name === "mola" ? 18 : 14, 16 * stepS * .94, 2);
      }
      // The hook: the first session's voice (a joiner's when it has left), louder on the bar line, settling at its end.
      const hook = plan.hook ? F.hooks[plan.hook] : null;
      const singer = this.stage[0] > 0 ? 0 : this.stage[4] > 0 ? 4 : this.stage[8] > 0 ? 8 : 0;
      if (hook) {
        const line = hook.bars[bar], last = line.length - 1;
        line.forEach(([s, p, len], n) => {
          const shape = (s === 0 ? 1.06 : s % 4 === 0 ? 1 : .92) * (bar === 3 && n === last ? .9 : 1);
          add(s, p, (singer === 0 ? 42 : 38) * shape, Math.min(2.6, len * stepS * .92 * staccato), singer === 8 ? ACCORDION : singer, 0, true);
        });
      }
      // The counter-melody answers in bars 2 and 4.
      if (on(4, "counter") && singer !== 4) {
        for (const [b, line] of F.counter) if (b === bar) for (const [s, p, len] of line) add(s, p, 30, Math.min(2.6, len * stepS * .9 * staccato), 4);
      }
      if (on(5, "bells")) {
        const line = tones(triad, ...R.bells);
        this.onsets(F.bells.rhythm).forEach(([s], n) => add(s, line[F.bells.idx[(bar * 3 + n) % 8] % line.length], 14, .45, 5));
      }
      if (on(6, "stabs")) {
        F.stab = this.voiceLead(triad, R.stab, F.stab);
        for (const [s, len] of this.onsets(F.stabs)) for (const p of F.stab) add(s, p, 17, len * stepS * .8, 6);
      }
      if (on(7, "arp")) {
        const a = FLOW.arps[F.arp], line = tones(pad, ...R.arp).slice(0, 5), tune = hook ? hook.bars[bar] : [];
        const under = (s) => { const n = tune.find(([at, , len]) => at <= s && s < at + len); return n ? n[1] : null; };
        for (let s = 0, n = 0; s < 16; s += a.rate, n++) {
          let p = line[a.order[n % a.order.length] % line.length];
          const h = under(s);
          if (h !== null && Math.abs(p - h) <= 2) p += p + 12 <= R.arp[1] ? 12 : -12;   // never on the hook's note: an octave away
          add(s, p, 11, a.rate * stepS * .9, 7);
        }
      }
      if (on(8, "riff") && singer !== 8) {
        const line = tones(pad, ...R.riff);
        this.onsets(F.riff.rhythm).forEach(([s], n) => add(s, line[F.riff.idx[n % 8] % line.length], 16, Math.min(2.6, 2 * stepS * .85 * staccato), ACCORDION));
      }
    },

    // "x--x..": [sixteenth, length] of each note.
    onsets(rhythm) {
      const out = [];
      for (let s = 0; s < rhythm.length; s++) {
        if (rhythm[s] !== "x") continue;
        let len = 1;
        while (s + len < rhythm.length && rhythm[s + len] === "-") len++;
        out.push([s, len]);
      }
      return out;
    },
    // The chord stacked up from `lo` in each inversion; the one nearest the last voicing (or the lowest).
    // Inversions with a minor second between neighbouring voices (a maj7's seventh under its root) only when nothing else is left.
    voiceLead(pcs, lo, last) {
      const all = [];
      for (let k = 0; k < pcs.length; k++) {
        const v = [];
        let p = lo - 1;
        for (let j = 0; j < pcs.length; j++) { p += 1 + ((((pcs[(k + j) % pcs.length] - p - 1) % 12) + 12) % 12); v.push(p); }
        all.push(v);
      }
      const open = all.filter((v) => !v.some((x, j) => j && x - v[j - 1] === 1));
      let best = null, cost = Infinity;
      for (const v of open.length ? open : all) {
        const c = last ? v.reduce((sum, x) => sum + Math.min(...last.map((y) => Math.abs(x - y))), 0) : v[0] - lo;
        if (c < cost) { cost = c; best = v; }
      }
      return best;
    },
    // The key's scale for one bar: a chord tone outside it (a major V in minor, a flat VII in major)
    // replaces its neighbour, the seventh degree first, never the tonic.
    barScale(chord) {
      const [tonic, minor] = this.flow.key;
      const scale = (minor ? [0, 2, 3, 5, 7, 8, 10] : [0, 2, 4, 5, 7, 9, 11]).map((d) => (tonic + d) % 12);
      for (const i of chord[1]) {
        const pc = (chord[0] + i) % 12;
        if (scale.includes(pc)) continue;
        const near = [1, 2, 3, 4, 5, 6].filter((j) => (scale[j] - pc + 12) % 12 === 1 || (pc - scale[j] + 12) % 12 === 1);
        if (near.length) scale[near.includes(6) ? 6 : near[0]] = pc;
      }
      return scale;
    },
    degPitch(deg, scale, base) { const o = Math.floor(deg / 7), k = deg - 7 * o; return base + 12 * o + ((scale[k] - scale[0] + 12) % 12); },
    // On the beat, on a held note and at a phrase's ends a riff lands on the bar's chord: the nearest
    // tone, first the way the line moves, and not the note just played when the line moved. An eighth
    // a semitone off a chord tone lands too; only quick passing notes stay between.
    snapLine(raw, hits, chord, dLo, dHi) {
      const scale = this.barScale(chord), pcs = chord[1].map((i) => (chord[0] + i) % 12), out = [];
      raw.forEach((deg, n) => {
        const [s, len] = hits[n], pc = scale[((deg % 7) + 7) % 7];
        const rubs = len >= 2 && pcs.some((x) => (x - pc + 12) % 12 === 1 || (pc - x + 12) % 12 === 1);
        if (!(s % 4 === 0 || len >= 3 || n === 0 || n === hits.length - 1 || rubs)) { out.push(deg); return; }
        const moved = n > 0 && deg !== raw[n - 1], dir = n > 0 && deg < raw[n - 1] ? -1 : 1;
        const fits = (d) => d >= dLo - 1 && d <= dHi + 1 && pcs.includes(scale[((d % 7) + 7) % 7]);
        const options = [deg, deg + dir, deg - dir, deg + 2 * dir, deg - 2 * dir].filter(fits);
        const fresh = options.filter((d) => !(moved && d === out[n - 1]));
        out.push(fresh.length ? fresh[0] : options.length ? options[0] : deg);
      });
      return out;
    },
    // Scale degrees mostly by step, sometimes repeating or leaping (a leap turns back by a step), within dLo..dHi.
    walk(count, start, dLo, dHi, cont) {
      const out = [];
      let d = Math.max(dLo, Math.min(dHi, start)), dir = this.rand() < .5 ? 1 : -1, leapt = false;
      for (let i = 0; i < count; i++) {
        if (i > 0 || cont) {
          const r = this.rand();
          let size = r < .1 ? 0 : r < .6 ? 1 : r < .9 ? 2 : 3;
          if (leapt) { size = 1; dir = -dir; } else if (this.rand() < .3) dir = -dir;
          if (d + dir * size > dHi || d + dir * size < dLo) dir = -dir;
          d = Math.max(dLo, Math.min(dHi, d + dir * size));
          leapt = size >= 3;
        }
        out.push(d);
      }
      return out;
    },
    // A hook: a call (bar 1, again in bar 3 on its own chord), a short answer that leaves the second
    // half of bar 2 to the counter-melody, and a cadence on a long chord tone. `keep`: that hook with a new cadence.
    makeHook(keep, avoid) {
      const F = this.flow, [lo, hi] = STYLES[this.style].flow.hook, base = this.band(F.key[0], 60), first = this.barScale(F.prog[0]);
      let dLo = -7, dHi;
      while (this.degPitch(dLo, first, base) < lo) dLo++;
      for (dHi = dLo; this.degPitch(dHi + 1, first, base) <= hi; dHi++);
      const others = (n, last) => this.pickOther([...Array(n).keys()], last);
      const call = keep ? keep.call : others(FLOW.calls.length, avoid);
      const tail = keep ? keep.tail : Math.floor(this.rand() * FLOW.tails.length);
      const cadence = keep ? others(FLOW.cadences.length, keep.cadence) : Math.floor(this.rand() * FLOW.cadences.length);
      let raw;
      if (keep) raw = keep.raw.slice(0, 3);
      else {
        const one = this.walk(this.onsets(FLOW.calls[call]).length, Math.floor((dLo + dHi) / 2) + Math.floor(this.rand() * 5) - 2, dLo, dHi, false);
        raw = [one, this.walk(this.onsets(FLOW.tails[tail]).length, one[one.length - 1], dLo, dHi, true), one];
      }
      raw = [...raw, this.walk(this.onsets(FLOW.cadences[cadence]).length, raw[2][raw[2].length - 1], dLo, dHi, true)];
      const rhythms = [FLOW.calls[call], FLOW.tails[tail], FLOW.calls[call], FLOW.cadences[cadence]];
      const bars = rhythms.map((r, b) => {
        const hits = this.onsets(r), scale = this.barScale(F.prog[b]), line = this.snapLine(raw[b], hits, F.prog[b], dLo, dHi);
        return hits.map(([s, len], n) => [s, this.degPitch(line[n], scale, base), len]);
      });
      return { call, tail, cadence, raw, bars };
    },
    // The counter-melody: one rhythm and one walk over chord tones, answering in bars 2 and 4.
    makeCounter() {
      const F = this.flow, [lo, hi] = STYLES[this.style].flow.counter, hits = this.onsets(this.pick(FLOW.counters));
      const moves = hits.map(() => this.pick([1, 1, -1, -1, 2, -2, 0])), start = this.rand();
      return [1, 3].map((b) => {
        const chord = F.prog[b], line = [];
        for (let p = lo; p <= hi; p++) if (chord[1].some((i) => (chord[0] + i) % 12 === p % 12)) line.push(p);
        let k = Math.floor(start * line.length);
        return [b, hits.map(([s, len], n) => { if (n) k = Math.max(0, Math.min(line.length - 1, k + moves[n])); return [s, line[k], len]; })];
      });
    },
  };
}
