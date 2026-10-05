"""Traditional/classical themes with our own simple piano accompaniment.

All themes are public domain or traditional, independently entered (no recording
or third-party arrangement used). Durations are quarter-note beats.
- Bella Ciao: traditional (https://www.8notes.com/scores/bella_ciao_trad_.asp)
- Für Elise: Beethoven, opening theme
- Greensleeves: traditional English
- Ode to Joy: Beethoven, opening theme, in C major
"""
from sonata import Composer


BELLA_CIAO = (
    (64, .5), (69, .5), (71, .5), (72, .5), (69, 2),
    (64, .5), (69, .5), (71, .5), (72, .5), (69, 2),
    (64, .5), (69, .5), (71, .5), (72, 1), (71, .5), (69, .5),
    (72, 1), (71, .5), (69, .5), (76, 1),
    (76, .5), (76, .5), (74, .5), (76, .5), (77, 2),
    (77, .5), (76, .5), (74, .5), (77, .5), (76, 2),
    (76, .5), (74, .5), (72, .5), (71, 1), (76, 1), (72, 1),
    (71, 1), (69, 2.5),
)
ODE_TO_JOY = (
    (64, 1), (64, 1), (65, 1), (67, 1), (67, 1), (65, 1), (64, 1), (62, 1),
    (60, 1), (60, 1), (62, 1), (64, 1), (64, 1.5), (62, .5), (62, 2),
    (64, 1), (64, 1), (65, 1), (67, 1), (67, 1), (65, 1), (64, 1), (62, 1),
    (60, 1), (60, 1), (62, 1), (64, 1), (62, 1.5), (60, .5), (60, 2),
)
FUR_ELISE = (
    (76, .5), (75, .5), (76, .5), (75, .5), (76, .5), (71, .5), (74, .5), (72, .5), (69, 1.5),
    (60, .5), (64, .5), (69, .5), (71, 1.5),
    (64, .5), (68, .5), (71, .5), (72, 1.5),
    (64, .5), (76, .5), (75, .5), (76, .5), (75, .5), (76, .5), (71, .5), (74, .5), (72, .5), (69, 1.5),
    (60, .5), (64, .5), (69, .5), (71, 1.5),
    (64, .5), (72, .5), (71, .5), (69, 2.5),
)
GREENSLEEVES = (
    (69, 1), (72, 2), (74, 1), (76, 1.5), (77, .5), (76, 1), (74, 2), (71, 1),
    (67, 1.5), (69, .5), (71, 1), (72, 2), (69, 1), (69, 1.5), (68, .5), (69, 1),
    (71, 2), (68, 1), (64, 2),
    (69, 1), (72, 2), (74, 1), (76, 1.5), (77, .5), (76, 1), (74, 2), (71, 1),
    (67, 1.5), (69, .5), (71, 1), (72, 1.5), (71, .5), (69, 1), (68, 1.5), (66, .5), (68, 1),
    (69, 3),
)
SONGS = {'bella-ciao': BELLA_CIAO, 'fur-elise': FUR_ELISE,
         'greensleeves': GREENSLEEVES, 'ode-to-joy': ODE_TO_JOY}
# Key: (tonic pitch class, minor?). Used to pick chords that fit the melody.
KEYS = {'bella-ciao': (9, True), 'fur-elise': (9, True), 'greensleeves': (9, True), 'ode-to-joy': (0, False)}
TITLES = {'bella-ciao': 'Bella Ciao', 'fur-elise': 'Für Elise',
          'greensleeves': 'Greensleeves', 'ode-to-joy': 'Neşeye Övgü'}
PLAYLIST = ('bella-ciao', 'fur-elise', 'greensleeves', 'ode-to-joy')
CHOICES = ('karisik',) + PLAYLIST + ('original',)


def chords_for(key):
    """Diatonic triads (root pc, intervals) in order of preference."""
    tonic, minor = key
    if minor:  # i, V (harmonic minor), iv, III, VI, VII
        degrees = ((0, (0, 3, 7)), (7, (0, 4, 7)), (5, (0, 3, 7)), (3, (0, 4, 7)), (8, (0, 4, 7)), (10, (0, 4, 7)))
    else:      # I, V, IV, vi, ii, iii
        degrees = ((0, (0, 4, 7)), (7, (0, 4, 7)), (5, (0, 4, 7)), (9, (0, 3, 7)), (2, (0, 3, 7)), (4, (0, 3, 7)))
    return [((tonic + d) % 12, intervals) for d, intervals in degrees]


def harmonize(pitch, key, previous=None):
    """Chord (root pc, intervals) that contains the melody note; keep the previous one if it fits."""
    pc = pitch % 12
    fits = lambda chord: (pc - chord[0]) % 12 in chord[1]
    if previous and fits(previous):
        return previous
    for chord in chords_for(key):
        if fits(chord):
            return chord
    return chords_for(key)[0]


class SongComposer(Composer):
    """Plays a theme (or the whole playlist) in order; code activity sets tempo and colour."""

    MIN_SONG_SECONDS = 120   # a song repeats until it has played this long

    def __init__(self, song):
        super().__init__()
        self.playlist = PLAYLIST if song == 'karisik' else (song,)
        self.index = 0
        self.position = 0
        self.chord = None
        self.played = 0.0    # seconds of music on the current song
        self.hold = False    # set by the conductor while excited: never switch then
        self.load()

    def load(self):
        self.song = self.playlist[self.index % len(self.playlist)]
        self.score = SONGS[self.song]
        self.key = KEYS[self.song]
        self.chord = None

    def next_song(self):
        self.index = (self.index + 1) % len(self.playlist)
        self.position = 0
        self.played = 0.0
        self.load()

    def cadence_notes(self, seconds, fade):
        """Held tonic chord that closes a song before the next one breathes in."""
        tonic = chords_for(self.key)[0]
        root = 45 - 45 % 12 + tonic[0]
        root = root if root >= 40 else root + 12
        return [(root - 12, int(34 * fade), seconds), (root, int(30 * fade), seconds)] + \
               [(root + 12 + i, int(36 * fade), seconds) for i in tonic[1][1:]]

    def chord_tones(self, octave_root):
        """Current chord as MIDI notes around `octave_root` (e.g. 48 for C3 octave)."""
        root, intervals = self.chord or chords_for(self.key)[0]
        base = octave_root - octave_root % 12 + root
        return [base + i for i in intervals]

    def tick(self, now):
        # Keep the shared smooth tempo and inactivity handling. Code changes
        # vary the accompaniment, while the recognizable melody stays intact.
        self.cadence = False
        trigger = super().tick(now)
        if not trigger:
            return []
        pitch, beats = self.score[self.position]
        seconds = 60 / self.bpm * beats
        self.next_note = now + seconds
        fade = max(.25, 1 - max(0, now - self.last_input - .35) / 1.5)
        notes = [(pitch, int(54 * fade), min(3, seconds * .9))]
        changed = self.chord
        self.chord = harmonize(pitch, self.key, self.chord)
        if self.position % 4 == 0 or self.chord != changed:
            bass = self.chord_tones(36)[0]
            if bass < 40:
                bass += 12
            notes.append((bass, int(30 * fade), min(3, seconds * 1.8)))
            if self.mode == 'loop':
                notes.append((bass + 7, int(25 * fade), min(2, seconds)))
        self.played += seconds
        self.position += 1
        if self.position >= len(self.score):
            self.position = 0
            if len(self.playlist) > 1 and self.played >= self.MIN_SONG_SECONDS and not self.hold:
                # Let the last note ring, add a held closing chord and two beats of breath.
                beat = 60 / self.bpm
                notes += self.cadence_notes(min(3, beat * 3), fade)
                self.next_note = now + seconds + beat * 2
                self.next_song()
        return notes
