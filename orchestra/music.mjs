// Themes and harmony shared by the conductor. Mirrors melodies.py (public domain / traditional).
export const SONGS = {
  "bella-ciao": [
    [64, .5], [69, .5], [71, .5], [72, .5], [69, 2],
    [64, .5], [69, .5], [71, .5], [72, .5], [69, 2],
    [64, .5], [69, .5], [71, .5], [72, 1.5], [71, .5], [69, .5],
    [72, 1], [71, .5], [69, .5], [76, 2],
    [76, .5], [76, .5], [74, .5], [76, .5], [77, 2],
    [77, .5], [76, .5], [74, .5], [77, .5], [76, 2],
    [76, .5], [74, .5], [72, .5], [71, .5], [76, 1], [72, 1],
    [71, 1], [69, 3],
  ],
  "fur-elise": [
    [76, .5], [75, .5], [76, .5], [75, .5], [76, .5], [71, .5], [74, .5], [72, .5], [69, 1.5],
    [60, .5], [64, .5], [69, .5], [71, 1.5],
    [64, .5], [68, .5], [71, .5], [72, 1.5],
    [64, .5], [76, .5], [75, .5], [76, .5], [75, .5], [76, .5], [71, .5], [74, .5], [72, .5], [69, 1.5],
    [60, .5], [64, .5], [69, .5], [71, 1.5],
    [64, .5], [72, .5], [71, .5], [69, 2],
  ],
  "greensleeves": [
    [69, 1], [72, 2], [74, 1], [76, 1.5], [77, .5], [76, 1], [74, 2], [71, 1],
    [67, 1.5], [69, .5], [71, 1], [72, 2], [69, 1], [69, 1.5], [68, .5], [69, 1],
    [71, 2], [68, 1], [64, 2],
    [69, 1], [72, 2], [74, 1], [76, 1.5], [77, .5], [76, 1], [74, 2], [71, 1],
    [67, 1.5], [69, .5], [71, 1], [72, 1.5], [71, .5], [69, 1], [68, 1.5], [66, .5], [68, 1],
    [69, 2],
  ],
  "ode-to-joy": [
    [64, 1], [64, 1], [65, 1], [67, 1], [67, 1], [65, 1], [64, 1], [62, 1],
    [60, 1], [60, 1], [62, 1], [64, 1], [64, 1.5], [62, .5], [62, 2],
    [64, 1], [64, 1], [65, 1], [67, 1], [67, 1], [65, 1], [64, 1], [62, 1],
    [60, 1], [60, 1], [62, 1], [64, 1], [62, 1.5], [60, .5], [60, 2],
  ],
};
// More well-known public-domain themes. null = rest.
// Pachelbel, Canon in D: the two descending lines, then the famous quarter-note variation.
SONGS["canon"] = [
  [78, 2], [76, 2], [74, 2], [73, 2], [71, 2], [69, 2], [71, 2], [73, 2],
  [74, 2], [73, 2], [71, 2], [69, 2], [67, 2], [66, 2], [67, 2], [64, 2],
  [74, 1], [78, 1], [81, 1], [79, 1], [78, 1], [74, 1], [78, 1], [76, 1],
  [74, 1], [71, 1], [74, 1], [69, 1], [67, 1], [71, 1], [69, 1], [67, 1],
];
// Grieg, In the Hall of the Mountain King: the theme that keeps speeding up (an octave up).
SONGS["mountain-king"] = [
  [71, .5], [73, .5], [74, .5], [76, .5], [78, .5], [74, .5], [78, 1],
  [77, .5], [73, .5], [77, 1], [76, .5], [72, .5], [76, 1],
  [71, .5], [73, .5], [74, .5], [76, .5], [78, .5], [74, .5], [78, .5], [83, .5],
  [81, .5], [78, .5], [74, .5], [78, .5], [81, 2],
];
// Mozart, Eine kleine Nachtmusik: the opening call.
SONGS["nachtmusik"] = [
  [67, 1], [null, .5], [62, .5], [67, 1], [null, .5], [62, .5],
  [67, .5], [62, .5], [67, .5], [71, .5], [74, 1], [null, 1],
  [72, 1], [null, .5], [69, .5], [72, 1], [null, .5], [69, .5],
  [72, .5], [69, .5], [66, .5], [69, .5], [62, 1], [null, 1],
];
export const KEYS = { "bella-ciao": [9, true], "fur-elise": [9, true], "greensleeves": [9, true], "ode-to-joy": [0, false],
  canon: [2, false], "mountain-king": [11, true], nachtmusik: [7, false] };
export const TITLES = { "bella-ciao": "Bella Ciao", "fur-elise": "Für Elise", "greensleeves": "Greensleeves", "ode-to-joy": "Ode to Joy",
  canon: "Canon in D", "mountain-king": "In the Hall of the Mountain King", nachtmusik: "Eine kleine Nachtmusik" };
export const PLAYLIST = ["bella-ciao", "fur-elise", "greensleeves", "ode-to-joy", "canon", "mountain-king", "nachtmusik"];
// Meter: beats per bar, and how many beats come before the first bar line (pickup).
// Für Elise (3/8) and Greensleeves (3/4) are in three: drums and accompaniment follow it.
export const METERS = {
  "bella-ciao": [4, 0], "fur-elise": [3, 1], greensleeves: [3, 1], "ode-to-joy": [4, 0],
  canon: [4, 0], "mountain-king": [4, 0], nachtmusik: [4, 0],
};
// Songs by mood: the pace of the agents picks the next song.
export const MOODS = {
  calm: ["fur-elise", "greensleeves", "canon"],
  warm: ["bella-ciao", "ode-to-joy", "nachtmusik"],
  wild: ["mountain-king"],
};

// Lead-sheet harmony: a chord starts at a melody note (index) and holds until the next one.
// Written like a fake book, so chords change once or twice a bar, not on every note.
const CHORD = { Am: [9, [0, 3, 7]], Dm: [2, [0, 3, 7]], E: [4, [0, 4, 7]], C: [0, [0, 4, 7]], G: [7, [0, 4, 7]], F: [5, [0, 4, 7]],
  D: [2, [0, 4, 7]], A: [9, [0, 4, 7]], Bm: [11, [0, 3, 7]], "F#m": [6, [0, 3, 7]], "C#": [1, [0, 4, 7]], D7: [2, [0, 4, 7, 10]] };
const CANON = ["D", "A", "Bm", "F#m", "G", "D", "G", "A"];
export const CHORDS = {
  "bella-ciao": [[0, "Am"], [20, "Dm"], [29, "Am"], [36, "E"], [37, "Am"]],
  "fur-elise": [[0, "Am"], [12, "E"], [16, "Am"], [30, "E"], [34, "Am"]],
  "greensleeves": [[0, "Am"], [3, "C"], [6, "G"], [11, "Am"], [13, "F"], [16, "E"], [19, "Am"], [22, "C"], [25, "G"], [30, "Am"], [33, "E"], [36, "Am"]],
  "ode-to-joy": [[0, "C"], [4, "G"], [8, "C"], [13, "G"], [15, "C"], [19, "G"], [23, "C"], [27, "G"], [28, "C"]],
  // The canon's eight chords: one per half note, then one per two quarter notes.
  canon: [...CANON.map((c, i) => [i, c]), ...CANON.map((c, i) => [8 + i, c]), ...CANON.map((c, i) => [16 + 2 * i, c])],
  "mountain-king": [[0, "Bm"], [7, "C#"], [10, "C"], [13, "Bm"], [21, "D"]],
  nachtmusik: [[0, "G"], [12, "D7"]],
};

// Per note: its chord, whether the chord changes there, where it starts on the song's beat
// grid, and the beat where the next chord begins (so pads can last exactly that long).
export const PLANS = Object.fromEntries(Object.entries(SONGS).map(([song, score]) => {
  const marks = CHORDS[song];
  let beat = 0, k = 0;
  const plan = score.map(([, d], i) => {
    while (k + 1 < marks.length && marks[k + 1][0] <= i) k++;
    const step = { chord: CHORD[marks[k][1]], name: marks[k][1], change: marks[k][0] === i, start: beat };
    beat += d;
    return step;
  });
  const end = beat;
  for (let i = plan.length - 1, next = end; i >= 0; i--) {
    plan[i].nextChange = next;
    if (plan[i].change) next = plan[i].start;
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

export function harmonize(pitch, key, previous) {
  const pc = pitch % 12;
  const fits = ([root, iv]) => iv.includes((pc - root + 12) % 12);
  if (previous && fits(previous)) return previous;
  return chordsFor(key).find(fits) || chordsFor(key)[0];
}

export function chordTones(chord, key, octave) {
  const [root, iv] = chord || chordsFor(key)[0];
  const base = octave - (octave % 12) + root;
  return iv.map((i) => base + i);
}
