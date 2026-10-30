"""Themes shared with the Agent Orchestra site, and the folder/editor-mode song player.

The score lives in orchestra/web/songs.mjs (public domain or traditional themes, entered by
hand): melody, lead-sheet chords, meter and phrases. It is a JavaScript module whose body is
strict JSON, so browsers import it and this file parses it. The site's conductor reads the same file,
so the local tool and the site play the same notes. Durations are quarter-note beats.
"""
import json
from pathlib import Path

from sonata import Composer
from songbook import personal_songs

def _module_json(name):
    """The JSON object inside one of the site's data modules (`export default {...};`)."""
    source = (Path(__file__).resolve().parent / "orchestra/web" / name).read_text(encoding="utf-8")
    return json.loads(source[source.index("{"):source.rindex("}") + 1])


DATA = _module_json("songs.mjs")
STYLES = _module_json("styles.mjs")
FLOW = _module_json("flow.mjs")                      # loop music ("akış"): patterns, chord loops, the arc of a scene
PLAYLIST = tuple(DATA["songs"])                     # the shared repertoire (the site plays these)
# Songs this Mac's user imported from MIDI (songbook.py): played only here, never by the site.
PERSONAL = {name: entry for name, entry in personal_songs().items()
            if name not in DATA["songs"] and all(chord in DATA["chords"] for _, chord in entry["chords"])}
ENTRIES = {**DATA["songs"], **PERSONAL}
LIBRARY = PLAYLIST + tuple(PERSONAL)
SONGS = {s: tuple(tuple(n) for n in ENTRIES[s]["notes"]) for s in LIBRARY}
KEYS = {s: tuple(ENTRIES[s]["key"]) for s in LIBRARY}            # (tonic pitch class, minor?)
TITLES = {s: ENTRIES[s]["title"] for s in LIBRARY}
TEMPOS = {s: ENTRIES[s].get("tempo", 1) for s in LIBRARY}       # the song's own pace against the style's range
METERS = {s: tuple(ENTRIES[s]["meter"]) for s in LIBRARY}        # (beats per bar, pickup beats)
MOODS = {"calm": [], "warm": [], "wild": []}
for _song in PLAYLIST:
    MOODS[ENTRIES[_song]["mood"]].append(_song)
MOODS_ALL = {mood: songs + [s for s in PERSONAL if PERSONAL[s].get("mood", "warm") == mood] for mood, songs in MOODS.items()}
CHORD = {name: (root, tuple(intervals)) for name, (root, intervals) in DATA["chords"].items()}
CHORDS = {s: [tuple(mark) for mark in ENTRIES[s]["chords"]] for s in LIBRARY}
BELLA_CIAO = SONGS["bella-ciao"]
CHOICES = ("karisik",) + LIBRARY + ("original",)


def _plan(song):
    """Per note: chord, chord change, start beat, beat of the next chord change, phrase."""
    marks, phrases = CHORDS[song], ENTRIES[song]["phrases"]
    beat, k, phrase, plan = 0, 0, -1, []
    for i, (_, beats) in enumerate(SONGS[song]):
        while k + 1 < len(marks) and marks[k + 1][0] <= i:
            k += 1
        start = i in phrases
        phrase += start
        plan.append({"chord": CHORD[marks[k][1]], "name": marks[k][1], "change": marks[k][0] == i,
                     "start": beat, "phrase": phrase, "phrase_start": start})
        beat += beats
    following = beat
    for step in reversed(plan):
        step["next_change"] = following
        if step["change"]:
            following = step["start"]
    # Where a note sits in its phrase: `arch` 0 at its start and end, 1 in its middle; `last` its final note.
    for i, step in enumerate(plan):
        first, after = i, i + 1
        while not plan[first]["phrase_start"] and first > 0:
            first -= 1
        while after < len(plan) and not plan[after]["phrase_start"]:
            after += 1
        start, end = plan[first]["start"], plan[after]["start"] if after < len(plan) else beat
        x = (step["start"] - start) / (end - start) if end > start else 0
        step["arch"] = 4 * x * (1 - x)
        step["last"] = after == i + 1
    return plan


PLANS = {s: _plan(s) for s in LIBRARY}


def chords_for(key):
    """Diatonic triads (root pc, intervals) in order of preference."""
    tonic, minor = key
    if minor:  # i, V (harmonic minor), iv, III, VI, VII
        degrees = ((0, (0, 3, 7)), (7, (0, 4, 7)), (5, (0, 3, 7)), (3, (0, 4, 7)), (8, (0, 4, 7)), (10, (0, 4, 7)))
    else:      # I, V, IV, vi, ii, iii
        degrees = ((0, (0, 4, 7)), (7, (0, 4, 7)), (5, (0, 4, 7)), (9, (0, 3, 7)), (2, (0, 3, 7)), (4, (0, 3, 7)))
    return [((tonic + d) % 12, intervals) for d, intervals in degrees]


def chord_tones(chord, key, octave):
    """Chord (root pc, intervals) as MIDI notes in the octave starting at `octave` (36, 48, 60...)."""
    root, intervals = chord or chords_for(key)[0]
    base = octave - octave % 12 + root
    return [base + i for i in intervals]


class SongComposer(Composer):
    """Plays a theme (or the whole playlist) in order; code activity sets tempo and colour.

    Folder and editor mode. The agent listener uses conductor.py, the site's full arrangement.
    """

    TURNS = 2   # a song plays twice, then the next one: a few bars never loop for minutes

    def __init__(self, song):
        super().__init__()
        self.playlist = LIBRARY if song == "karisik" else (song,)
        self.index = 0
        self.position = 0
        self.chord = None
        self.turns = 0       # times the current song has been played through
        self.hold = False    # set while excited: never switch then
        self.load()

    def load(self):
        self.song = self.playlist[self.index % len(self.playlist)]
        self.score = SONGS[self.song]
        self.plan = PLANS[self.song]
        self.key = KEYS[self.song]
        self.chord = None

    def next_song(self):
        self.index = (self.index + 1) % len(self.playlist)
        self.position = 0
        self.turns = 0
        self.load()

    def cadence_notes(self, seconds, fade, at):
        """Held tonic chord that closes a song before the next one breathes in."""
        tonic = chords_for(self.key)[0]
        root = 45 - 45 % 12 + tonic[0]
        root = root if root >= 40 else root + 12
        return [(root - 12, int(34 * fade), seconds, 0, at), (root, int(30 * fade), seconds, 0, at)] + \
               [(root + 12 + i, int(36 * fade), seconds, 0, at) for i in tonic[1][1:]]

    def chord_tones(self, octave_root):
        """Current chord as MIDI notes around `octave_root` (e.g. 48 for C3 octave)."""
        return chord_tones(self.chord, self.key, octave_root)

    def tick(self, now):
        # Keep the shared smooth tempo and inactivity handling. Code changes vary the
        # accompaniment, while the recognizable melody stays intact. Notes carry their exact
        # time (`at`), so the loop's own timing never shakes the rhythm.
        self.cadence = False
        at = self.due(now)
        if at is None:
            return []
        pitch, beats = self.score[self.position]
        step = self.plan[self.position]
        seconds = 60 / self.bpm * beats
        self.next_note = at + seconds
        fade = max(.25, 1 - max(0, now - self.last_input - .35) / 1.5)
        notes = [] if pitch is None else [(pitch, int(54 * fade), min(3, seconds * .9), 0, at)]
        self.chord = step["chord"]
        meter, pickup = METERS[self.song]
        if step["change"] or (step["start"] - pickup) % meter == 0:
            # Bass on a chord change and on each bar line, from the lead sheet.
            bass = self.chord_tones(36)[0]
            if bass < 40:
                bass += 12
            notes.append((bass, int(30 * fade), min(3, seconds * 1.8), 0, at))
            if self.mode == "loop":
                notes.append((bass + 7, int(25 * fade), min(2, seconds), 0, at))
        self.position += 1
        if self.position >= len(self.score):
            self.position = 0
            self.turns += 1
            if len(self.playlist) > 1 and self.turns >= self.TURNS and not self.hold:
                # Let the last note ring, add a held closing chord and two beats of breath.
                beat = 60 / self.bpm
                notes += self.cadence_notes(min(3, beat * 3), fade, at)
                self.next_note = at + seconds + beat * 2
                self.next_song()
        return notes
