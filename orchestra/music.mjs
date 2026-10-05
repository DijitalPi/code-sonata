// Themes and harmony shared by the conductor. Mirrors melodies.py (public domain / traditional).
export const SONGS = {
  "bella-ciao": [
    [64, .5], [69, .5], [71, .5], [72, .5], [69, 2],
    [64, .5], [69, .5], [71, .5], [72, .5], [69, 2],
    [64, .5], [69, .5], [71, .5], [72, 1], [71, .5], [69, .5],
    [72, 1], [71, .5], [69, .5], [76, 1],
    [76, .5], [76, .5], [74, .5], [76, .5], [77, 2],
    [77, .5], [76, .5], [74, .5], [77, .5], [76, 2],
    [76, .5], [74, .5], [72, .5], [71, 1], [76, 1], [72, 1],
    [71, 1], [69, 2.5],
  ],
  "fur-elise": [
    [76, .5], [75, .5], [76, .5], [75, .5], [76, .5], [71, .5], [74, .5], [72, .5], [69, 1.5],
    [60, .5], [64, .5], [69, .5], [71, 1.5],
    [64, .5], [68, .5], [71, .5], [72, 1.5],
    [64, .5], [76, .5], [75, .5], [76, .5], [75, .5], [76, .5], [71, .5], [74, .5], [72, .5], [69, 1.5],
    [60, .5], [64, .5], [69, .5], [71, 1.5],
    [64, .5], [72, .5], [71, .5], [69, 2.5],
  ],
  "greensleeves": [
    [69, 1], [72, 2], [74, 1], [76, 1.5], [77, .5], [76, 1], [74, 2], [71, 1],
    [67, 1.5], [69, .5], [71, 1], [72, 2], [69, 1], [69, 1.5], [68, .5], [69, 1],
    [71, 2], [68, 1], [64, 2],
    [69, 1], [72, 2], [74, 1], [76, 1.5], [77, .5], [76, 1], [74, 2], [71, 1],
    [67, 1.5], [69, .5], [71, 1], [72, 1.5], [71, .5], [69, 1], [68, 1.5], [66, .5], [68, 1],
    [69, 3],
  ],
  "ode-to-joy": [
    [64, 1], [64, 1], [65, 1], [67, 1], [67, 1], [65, 1], [64, 1], [62, 1],
    [60, 1], [60, 1], [62, 1], [64, 1], [64, 1.5], [62, .5], [62, 2],
    [64, 1], [64, 1], [65, 1], [67, 1], [67, 1], [65, 1], [64, 1], [62, 1],
    [60, 1], [60, 1], [62, 1], [64, 1], [62, 1.5], [60, .5], [60, 2],
  ],
};
export const KEYS = { "bella-ciao": [9, true], "fur-elise": [9, true], "greensleeves": [9, true], "ode-to-joy": [0, false] };
export const TITLES = { "bella-ciao": "Bella Ciao", "fur-elise": "Für Elise", "greensleeves": "Greensleeves", "ode-to-joy": "Ode to Joy" };
export const PLAYLIST = ["bella-ciao", "fur-elise", "greensleeves", "ode-to-joy"];

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
