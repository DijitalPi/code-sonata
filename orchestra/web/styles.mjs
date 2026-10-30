// Styles: the same score arranged another way. Shared by the conductor (conductor.mjs and its
// Python port) and the local macOS engine; melodies.py reads the JSON object after `export
// default`, so keep it strict JSON.
// tempo: BPM at rest and at full pace. staccato: melody note length (1 = legato). swing: 0 straight,
// 1 full triplet swing. comp: "pad" held chords, "arp" fast broken chords, "ostinato" string
// eighths under the pads. bass: "long" held roots, "pulse" a root every half beat, "octaves"
// root and octave in turn. drums: "climax" only at the top, "groove" kick/snare/hat from a steady
// pace, "lofi" a soft swung beat all the time, "orchestral" timpani on bar lines. sevenths: pads
// and broken chords take the seventh.
// Local engine only: programs (General MIDI, 0-based, voices 0-11: lead, pad, high pad, bass,
// second lead, colour, brass pad, arpeggio/harp, timpani, tremolo, drums, third lead), kit
// (General MIDI drum kit), ensemble (sections that play even when one session works alone), joiners
// (the sections a second, third... session takes, each a new timbre) and names (sections 0-8).
// flow: the same style as loops (flow.mjs): drum kit pattern set, tempo range, crash cymbal (null: none),
// chord, bass and arpeggio patterns a scene picks from, the hook's and counter-melody's register, other
// registers that differ from flow.mjs, and the chord loops it plays.
export default {
  "klasik": {
    "title": "Klasik", "tempo": [66, 116], "staccato": 1, "swing": 0, "comp": "pad", "bass": "long", "drums": "climax", "sevenths": false,
    "programs": [0, 48, 52, 42, 73, 11, 60, 46, 47, 44, 0, 21], "kit": 0, "ensemble": [0, 1, 3, 7], "joiners": [4, 6, 2, 5, 8],
    "names": ["piyano", "yaylılar", "koro", "çello", "flüt", "vibrafon", "korno", "arp", "akordeon"],
    "flow": { "beat": "soft", "tempo": [84, 112], "crash": 49, "comps": ["pad", "halfpad", "push"], "basses": ["halves", "walk", "held"], "arps": ["updown8", "up8", "broken8"], "hook": [62, 84], "counter": [72, 91],
      "progressions": ["I-V-vi-IV", "I-vi-IV-V", "I-IV-vi-V", "I-iii-IV-V", "IV-V-iii-vi", "i-iv-VI-V", "i-VI-iv-V", "i-VII-VI-V", "i-iv-VII-III"] }
  },
  "8bit": {
    "title": "8-bit", "tempo": [100, 150], "staccato": 0.55, "swing": 0, "comp": "arp", "bass": "octaves", "drums": "groove", "sevenths": false,
    "programs": [80, 83, 82, 38, 81, 98, 62, 80, 118, 81, 0, 84], "kit": 25, "ensemble": [0, 1, 3, 7, 5], "joiners": [4, 6, 2, 8],
    "names": ["kare melodi", "parlak arpej", "kalliope", "synth bas", "testere melodi", "kristal", "synth brass", "arp arpej", "charang"],
    "flow": { "beat": "chip", "tempo": [112, 150], "crash": 49, "comps": ["arp16", "stabs", "arp8"], "basses": ["octaves", "syncop", "pulse"], "arps": ["up16", "updown16", "broken8"], "hook": [67, 86], "counter": [62, 81],
      "progressions": ["I-V-vi-IV", "vi-IV-I-V", "IV-V-iii-vi", "I-bVII-IV-I", "I-vi-IV-V", "i-VI-III-VII", "i-VII-VI-VII", "VI-VII-i-i"] }
  },
  "sinema": {
    "title": "Sinema", "tempo": [62, 104], "staccato": 1, "swing": 0, "comp": "ostinato", "bass": "long", "drums": "orchestral", "sevenths": false,
    "programs": [0, 48, 52, 43, 73, 8, 61, 46, 47, 44, 0, 56], "kit": 48, "ensemble": [0, 1, 2, 3, 6, 7], "joiners": [4, 8, 5],
    "names": ["piyano", "yaylılar", "koro", "kontrbas", "flüt", "çelesta", "brass", "arp", "trompet"],
    "flow": { "beat": "epic", "tempo": [80, 104], "crash": 57, "comps": ["ostinato", "pad", "push"], "basses": ["held", "halves", "pulse"], "arps": ["updown8", "up16", "broken8"], "hook": [60, 81], "counter": [69, 88],
      "progressions": ["i-VI-III-VII", "i-iv-VI-V", "i-VII-VI-V", "VI-VII-i-i", "i-iv-VII-III", "I-V-vi-IV", "IV-V-iii-vi"] }
  },
  "lofi": {
    "title": "Lo-fi", "tempo": [70, 86], "staccato": 0.8, "swing": 0.7, "comp": "pad", "bass": "long", "drums": "lofi", "sevenths": true,
    "programs": [4, 89, 52, 33, 73, 11, 66, 24, 47, 89, 0, 26], "kit": 0, "ensemble": [0, 1, 3, 5, 7], "joiners": [4, 6, 2, 8],
    "names": ["elektrik piyano", "sıcak pad", "koro pad", "bas", "flüt", "vibrafon", "tenor saksafon", "gitar", "caz gitar"],
    "flow": { "beat": "lofi", "tempo": [72, 88], "crash": null, "comps": ["pad", "strum", "halfpad"], "basses": ["boom", "walk", "held"], "arps": ["pick8", "broken8", "updown8"], "hook": [60, 79], "counter": [67, 86], "registers": { "arp": [55, 79] },
      "progressions": ["ii-V-I-vi", "I-vi-IV-V", "IV-V-iii-vi", "I-iii-IV-V", "i-iv-VII-III", "i-VI-iv-V"] }
  },
  "synthwave": {
    "title": "Synthwave", "tempo": [92, 118], "staccato": 0.85, "swing": 0, "comp": "arp", "bass": "pulse", "drums": "groove", "sevenths": false,
    "programs": [81, 89, 91, 38, 80, 98, 90, 86, 118, 89, 0, 87], "kit": 25, "ensemble": [0, 1, 3, 7], "joiners": [4, 6, 2, 5, 8],
    "names": ["testere melodi", "sıcak pad", "koro pad", "synth bas", "kare melodi", "kristal", "polysynth", "beşli arpej", "bas-melodi"],
    "flow": { "beat": "four", "tempo": [96, 118], "crash": 49, "comps": ["pad", "arp16", "halfpad"], "basses": ["pulse", "octaves", "syncop"], "arps": ["up16", "updown16", "up8"], "hook": [62, 81], "counter": [62, 81],
      "progressions": ["i-VI-III-VII", "i-VII-VI-VII", "VI-VII-i-i", "i-iv-VI-V", "vi-IV-I-V", "I-V-vi-IV"] }
  }
};
