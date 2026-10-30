// Themes and harmony shared by the conductor. The notes live in songs.mjs, which melodies.py
// (the local macOS tool) reads too, so both play the same score.
import DATA from "./songs.mjs";

export const PLAYLIST = Object.keys(DATA.songs);
const each = (field) => Object.fromEntries(PLAYLIST.map((s) => [s, DATA.songs[s][field]]));
export const SONGS = each("notes");          // [pitch or null for a rest, beats]
export const KEYS = each("key");             // [tonic pitch class, minor?]
export const TITLES = each("title");
// Each song's own pace against the style's tempo range (1 when not given): Gymnopédie is slower, Rondo faster.
export const TEMPOS = Object.fromEntries(PLAYLIST.map((s) => [s, DATA.songs[s].tempo ?? 1]));
// Meter: beats per bar, and how many beats come before the first bar line (pickup).
// Für Elise (3/8) and Greensleeves (3/4) are in three: drums and accompaniment follow it.
export const METERS = each("meter");
// Songs by mood: the pace of the agents picks the next song.
export const MOODS = { calm: [], warm: [], wild: [] };
for (const s of PLAYLIST) MOODS[DATA.songs[s].mood].push(s);

// Lead-sheet harmony: a chord starts at a melody note (index) and holds until the next one.
// Written like a fake book, so chords change once or twice a bar, not on every note.
const CHORD = DATA.chords;
export const CHORDS = each("chords");

// Per note: its chord, whether the chord changes there, where it starts on the song's beat
// grid, the beat where the next chord begins (so pads can last exactly that long), and which
// melodic phrase it belongs to (the melody changes hands only where a phrase starts).
export const PLANS = Object.fromEntries(PLAYLIST.map((song) => {
  const score = SONGS[song], marks = CHORDS[song], phrases = DATA.songs[song].phrases;
  let beat = 0, k = 0, phrase = -1;
  const plan = score.map(([, d], i) => {
    while (k + 1 < marks.length && marks[k + 1][0] <= i) k++;
    const phraseStart = phrases.includes(i);
    if (phraseStart) phrase++;
    const step = { chord: CHORD[marks[k][1]], name: marks[k][1], change: marks[k][0] === i, start: beat, phrase, phraseStart };
    beat += d;
    return step;
  });
  const end = beat;
  for (let i = plan.length - 1, next = end; i >= 0; i--) {
    plan[i].nextChange = next;
    if (plan[i].change) next = plan[i].start;
  }
  // Where a note sits in its phrase: `arch` is 0 at the phrase's start and end and 1 in its middle
  // (the melody swells and settles over it); `last` marks the phrase's final note.
  for (let i = 0; i < plan.length; i++) {
    let first = i, after = i + 1;
    while (!plan[first].phraseStart && first > 0) first--;
    while (after < plan.length && !plan[after].phraseStart) after++;
    const from = plan[first].start, to = after < plan.length ? plan[after].start : end;
    const x = to > from ? (plan[i].start - from) / (to - from) : 0;
    plan[i].arch = 4 * x * (1 - x);
    plan[i].last = after === i + 1;
  }
  return [song, plan];
}));

const MINOR = [[0, [0, 3, 7]], [7, [0, 4, 7]], [5, [0, 3, 7]], [3, [0, 4, 7]], [8, [0, 4, 7]], [10, [0, 4, 7]]];
const MAJOR = [[0, [0, 4, 7]], [7, [0, 4, 7]], [5, [0, 4, 7]], [9, [0, 3, 7]], [2, [0, 3, 7]], [4, [0, 3, 7]]];
const cache = new Map();

export function chordsFor([tonic, minor]) {
  const id = `${tonic}${minor}`;
  if (!cache.has(id)) cache.set(id, (minor ? MINOR : MAJOR).map(([d, iv]) => [(tonic + d) % 12, iv]));
  return cache.get(id);
}

export function chordTones(chord, key, octave) {
  const [root, iv] = chord || chordsFor(key)[0];
  const base = octave - (octave % 12) + root;
  return iv.map((i) => base + i);
}
