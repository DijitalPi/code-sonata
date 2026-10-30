// Flow ("akış"): loop music instead of songs. Every part is a loop of four bars on one sixteenth-note
// grid, in one key and one chord loop, so any layer fits with any other and comes in on a bar line.
// A scene (a chord loop, a key, a tempo and freshly written riffs) lasts the eight loops of `arc`
// (giriş, tema, çeşitleme, değişim, mola, yükseliş, doruk, kapanış), then the next scene begins in a
// neighbouring key. The conductor (conductor.mjs and its Python port) reads this file; melodies.py
// reads the JSON object after `export default`, so keep it strict JSON.
// Patterns are sixteen sixteenths. Drums: "X" accent, "x" normal, "o" ghost, "." rest. Riffs: "x" a
// note, "-" it holds, "." rest. Bass: [sixteenth, tone, length] with tone "r" root, "5" fifth, "8"
// octave, "3" third, "a" a step into the next bar's root. Chords: "hits" [sixteenth, length, level]
// strike the whole voicing ("roll" ms between its notes), or "rate" + "order" break it into an arpeggio,
// or "pair" plays root and fifth in turn. Arcs: "beat" level (light, main, busy, half or none), "hook"
// (A, A2 or B), "allow" (a layer and the pace it needs; a session's own instrument always plays),
// "fill" (a drum fill in the last bar), "crash", "az" (the hook stays with less melody), "cok" (the
// hook added with more melody), "bass"/"comp" (a pattern for this loop only), "sparse" (only the layers it
// allows play, a session's own instrument too: a full hall still has an intro and a break).
export default {
  "registers": { "voices": [62, 77], "bells": [84, 100], "arp": [72, 96], "riff": [55, 72], "pad": 52, "stab": 52 },
  "drums": { "kick": 36, "snare": 38, "clap": 39, "rim": 37, "hat": 42, "open": 46, "shaker": 70, "tamb": 54, "tom": 45, "hitom": 50 },
  "levels": { "kick": 30, "snare": 24, "clap": 20, "rim": 14, "hat": 10, "open": 11, "shaker": 11, "tamb": 12, "tom": 20, "hitom": 18, "timp": 24 },
  "lengths": { "kick": 0.15, "snare": 0.15, "clap": 0.15, "rim": 0.1, "hat": 0.05, "open": 0.3, "shaker": 0.05, "tamb": 0.1, "tom": 0.2, "hitom": 0.2, "timp": 0.8 },
  "beats": {
    "chip": {
      "light": { "kick": "X.......X.......", "hat": "..o...o...o...o." },
      "main": { "kick": "X.......X.x.....", "snare": "....X.......X...", "hat": "x.o.x.o.x.o.x.o." },
      "busy": { "kick": "X.....x.X.x...x.", "snare": "....X.......X..o", "hat": "xoxoxoxoxoxoxo.o", "open": "..............x." },
      "half": { "kick": "X.........x.....", "snare": "........X.......", "hat": "x...x...x...x..." },
      "fill": { "kick": "X.......X.......", "snare": "....X...x.xoxxXX", "hat": "x.x.x.x.........", "tom": "............x...", "hitom": "..........x....." }
    },
    "four": {
      "light": { "kick": "X...x...x...x...", "hat": "..o...o...o...o." },
      "main": { "kick": "X...X...X...X...", "clap": "....X.......X...", "hat": "..x...x...x...x." },
      "busy": { "kick": "X...X...X...X...", "clap": "....X.......X...", "snare": "....x.......x...", "hat": "xoxoxoxoxoxoxoxo" },
      "half": { "kick": "X.......X.......", "snare": "........X.......", "hat": "x.x.x.x.x.x.x.x." },
      "fill": { "kick": "X...X...X...X...", "snare": "........xoxoxXXX", "clap": "....X..........." }
    },
    "lofi": {
      "light": { "kick": "X.........x.....", "rim": "....x.......x...", "hat": "x.o.x.o.x.o.x.o." },
      "main": { "kick": "X......x..X.....", "snare": "....X.......X...", "hat": "x.o.x.o.x.o.x.o.", "rim": "..........o....." },
      "busy": { "kick": "X......x.xX.....", "snare": "....X..o....X.o.", "hat": "xoxoxoxoxoxoxo..", "open": "..............x." },
      "half": { "kick": "X...............", "snare": "........X.......", "hat": "x...x...x...x..." },
      "fill": { "kick": "X......x..X.....", "snare": "....X.......Xoxx", "hat": "x.o.x.o.x.o....." }
    },
    "soft": {
      "light": { "shaker": "x.o.x.o.x.o.x.o." },
      "main": { "kick": "X.......x.......", "shaker": "x.o.x.o.x.o.x.o.", "tamb": "....x.......x..." },
      "busy": { "kick": "X.....x.X.......", "shaker": "xoxoxoxoxoxoxoxo", "tamb": "....X.......X...", "timp": "X..............." },
      "half": { "kick": "X...............", "shaker": "x...x...x...x..." },
      "fill": { "kick": "X.......X.......", "tamb": "....x.......xoxx", "shaker": "x.o.x.o.x.o.....", "timp": "........x.x.X..." }
    },
    "epic": {
      "light": { "timp": "X..............." },
      "main": { "kick": "X.......X.x.....", "snare": "....o.......o...", "timp": "X..............." },
      "busy": { "kick": "X..x..x.X.x.x...", "snare": "....X.......X.oo", "timp": "X.......X......." },
      "half": { "kick": "X.......x.......", "timp": "X..............." },
      "fill": { "kick": "X.......X.......", "snare": "o.o.o.o.xoxoxXXX", "timp": "X...........x.X." }
    }
  },
  "basses": {
    "held": [[0, "r", 16]],
    "halves": [[0, "r", 8], [8, "5", 8]],
    "walk": [[0, "r", 4], [4, "3", 4], [8, "5", 4], [12, "a", 4]],
    "boom": [[0, "r", 6], [7, "r", 3], [10, "5", 4], [14, "a", 2]],
    "syncop": [[0, "r", 3], [3, "r", 3], [6, "5", 2], [8, "8", 2], [10, "r", 2], [12, "5", 2], [14, "a", 2]],
    "octaves": [[0, "r", 2], [2, "8", 2], [4, "r", 2], [6, "8", 2], [8, "r", 2], [10, "8", 2], [12, "r", 2], [14, "8", 2]],
    "pulse": [[0, "r", 2], [2, "r", 2], [4, "r", 2], [6, "r", 2], [8, "r", 2], [10, "r", 2], [12, "5", 2], [14, "8", 2]]
  },
  "comps": {
    "pad": { "hits": [[0, 16, 1]] },
    "halfpad": { "hits": [[0, 8, 1], [8, 8, 0.85]] },
    "stabs": { "hits": [[2, 1, 1], [6, 1, 0.85], [10, 1, 1], [14, 1, 0.85]] },
    "push": { "hits": [[0, 3, 1], [3, 3, 0.9], [6, 4, 0.95], [10, 2, 0.85], [12, 4, 0.9]] },
    "pulse8": { "hits": [[0, 1, 1], [2, 1, 0.8], [4, 1, 0.9], [6, 1, 0.8], [8, 1, 1], [10, 1, 0.8], [12, 1, 0.9], [14, 1, 0.8]] },
    "strum": { "hits": [[0, 6, 1], [6, 2, 0.7], [10, 6, 0.9]], "roll": 18 },
    "arp16": { "rate": 1, "order": [0, 1, 2, 3, 2, 1] },
    "arp8": { "rate": 2, "order": [0, 1, 2, 3] },
    "ostinato": { "rate": 2, "pair": true }
  },
  "arps": {
    "up16": { "rate": 1, "order": [0, 1, 2, 3] },
    "updown16": { "rate": 1, "order": [0, 1, 2, 3, 4, 3, 2, 1] },
    "up8": { "rate": 2, "order": [0, 1, 2, 3] },
    "updown8": { "rate": 2, "order": [0, 1, 2, 3, 2, 1] },
    "broken8": { "rate": 2, "order": [0, 2, 1, 3] },
    "pick8": { "rate": 2, "order": [0, 2, 3, 2, 1, 2, 3, 2] }
  },
  "calls": ["x-x-x---x-x-x---", "x--x--x-x---x---", "x---x-x---x-x---", "x-xx-x--x-x-x---", "..x-x-x-x---x---",
            "x--x--x---x-x---", "x-x---x-x-x-x---", "x---x---x-x-x-x-", "x-x-x-x-x--x--x-", "x--x-x--x--x-x--"],
  "tails": ["x-x-x---........", "x--x--x-........", "x---x---........", "x-x-x-x-........", "x-------........", "x--x-x--........"],
  "cadences": ["x-x-x---x-------", "x--x--x-x-------", "x-x-x-x-x-------", "x---x---x-------", "x--x--x---------"],
  "counters": ["........x-x-x---", "........x--x--x-", "..........x-x-x-", "........x-x-x-x-", "............x-x-", "........x---x---"],
  "bells": ["x.....x.....x...", "....x.........x.", "..x.......x.....", "x..x..x.........", "x.......x......."],
  "riffs": ["x..x..x.x..x..x.", "x.x..x.x..x.x...", "x..x.x..x..x.x..", "x.x.x..x.x.x..x."],
  "stabs": ["..x...x...x...x.", "x..x..x.........", "x-....x-..x-....", "...x..x....x..x."],
  "progressions": {
    "I-V-vi-IV": { "minor": false, "chords": [[0, [0, 4, 7]], [7, [0, 4, 7]], [9, [0, 3, 7]], [5, [0, 4, 7]]] },
    "vi-IV-I-V": { "minor": false, "chords": [[9, [0, 3, 7]], [5, [0, 4, 7]], [0, [0, 4, 7]], [7, [0, 4, 7]]] },
    "I-vi-IV-V": { "minor": false, "chords": [[0, [0, 4, 7]], [9, [0, 3, 7]], [5, [0, 4, 7]], [7, [0, 4, 7]]] },
    "I-IV-vi-V": { "minor": false, "chords": [[0, [0, 4, 7]], [5, [0, 4, 7]], [9, [0, 3, 7]], [7, [0, 4, 7]]] },
    "I-iii-IV-V": { "minor": false, "chords": [[0, [0, 4, 7]], [4, [0, 3, 7]], [5, [0, 4, 7]], [7, [0, 4, 7]]] },
    "IV-V-iii-vi": { "minor": false, "chords": [[5, [0, 4, 7]], [7, [0, 4, 7]], [4, [0, 3, 7]], [9, [0, 3, 7]]] },
    "ii-V-I-vi": { "minor": false, "chords": [[2, [0, 3, 7]], [7, [0, 4, 7]], [0, [0, 4, 7]], [9, [0, 3, 7]]] },
    "I-bVII-IV-I": { "minor": false, "chords": [[0, [0, 4, 7]], [10, [0, 4, 7]], [5, [0, 4, 7]], [0, [0, 4, 7]]] },
    "i-VI-III-VII": { "minor": true, "chords": [[0, [0, 3, 7]], [8, [0, 4, 7]], [3, [0, 4, 7]], [10, [0, 4, 7]]] },
    "i-VII-VI-VII": { "minor": true, "chords": [[0, [0, 3, 7]], [10, [0, 4, 7]], [8, [0, 4, 7]], [10, [0, 4, 7]]] },
    "i-iv-VI-V": { "minor": true, "chords": [[0, [0, 3, 7]], [5, [0, 3, 7]], [8, [0, 4, 7]], [7, [0, 4, 7]]] },
    "i-VI-iv-V": { "minor": true, "chords": [[0, [0, 3, 7]], [8, [0, 4, 7]], [5, [0, 3, 7]], [7, [0, 4, 7]]] },
    "i-VII-VI-V": { "minor": true, "chords": [[0, [0, 3, 7]], [10, [0, 4, 7]], [8, [0, 4, 7]], [7, [0, 4, 7]]] },
    "i-iv-VII-III": { "minor": true, "chords": [[0, [0, 3, 7]], [5, [0, 3, 7]], [10, [0, 4, 7]], [3, [0, 4, 7]]] },
    "VI-VII-i-i": { "minor": true, "chords": [[8, [0, 4, 7]], [10, [0, 4, 7]], [0, [0, 3, 7]], [0, [0, 3, 7]]] }
  },
  "arc": [
    { "name": "giriş", "beat": "light", "hook": null, "cok": "B", "sparse": true, "allow": { "bass": 0, "chords": 0, "arp": 0.25, "bells": 0.45 } },
    { "name": "tema", "beat": "main", "hook": "A", "az": true, "allow": { "bass": 0, "chords": 0, "arp": 0.25, "riff": 0.3, "bells": 0.45 } },
    { "name": "çeşitleme", "beat": "main", "hook": "A2", "allow": { "bass": 0, "chords": 0, "arp": 0.25, "riff": 0.3, "counter": 0.3, "bells": 0.45, "voices": 0.5 } },
    { "name": "değişim", "beat": "busy", "hook": "B", "az": true, "allow": { "bass": 0, "chords": 0, "arp": 0.25, "riff": 0.3, "counter": 0.3, "bells": 0.45, "voices": 0.5, "stabs": 0.45 } },
    { "name": "mola", "beat": null, "hook": null, "cok": "A2", "sparse": true, "bass": "held", "comp": "pad", "allow": { "bass": 0, "chords": 0, "voices": 0, "bells": 0.25, "arp": 0.45 } },
    { "name": "yükseliş", "beat": "half", "hook": "A", "fill": true, "allow": { "bass": 0, "chords": 0, "arp": 0, "voices": 0.3, "counter": 0.3 } },
    { "name": "doruk", "beat": "busy", "hook": "B", "az": true, "crash": true, "allow": { "bass": 0, "chords": 0, "arp": 0, "riff": 0, "counter": 0, "bells": 0.25, "voices": 0.3, "stabs": 0.3 } },
    { "name": "kapanış", "beat": "main", "hook": "A2", "fill": true, "allow": { "bass": 0, "chords": 0, "arp": 0.25, "riff": 0.3, "counter": 0.3, "bells": 0.45 } }
  ],
  "peak": 6
};
