import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

import songbook
from melodies import CHORD, METERS, PLANS, PLAYLIST, SONGS

ROOT = Path(__file__).resolve().parent


def vlq(n):
    out = [n & 0x7F]
    while n > 0x7F:
        n >>= 7
        out.insert(0, (n & 0x7F) | 0x80)
    return bytes(out)


def midi_file(tracks, division=480, tempo=500000, meter=(4, 2)):
    """A format 1 MIDI file; each track is [(start beat, length beats, pitch)]."""
    chunks = []
    head = bytes([0, 0xFF, 0x51, 3]) + tempo.to_bytes(3, "big") + bytes([0, 0xFF, 0x58, 4, meter[0], meter[1], 24, 8])
    for i, notes in enumerate(tracks):
        events = []
        for start, length, pitch in notes:
            events.append((round(start * division), 0x90, pitch, 90))
            events.append((round((start + length) * division), 0x80, pitch, 0))
        events.sort(key=lambda e: (e[0], e[1] == 0x90))
        body, tick = (head if i == 0 else b""), 0
        for at, status, pitch, velocity in events:
            body += vlq(at - tick) + bytes([status, pitch, velocity])
            tick = at
        body += bytes([0, 0xFF, 0x2F, 0])
        chunks.append(b"MTrk" + len(body).to_bytes(4, "big") + body)
    return b"MThd" + (6).to_bytes(4, "big") + (1).to_bytes(2, "big") + len(tracks).to_bytes(2, "big") + division.to_bytes(2, "big") + b"".join(chunks)


# Three bars of a tune in C over C, G and C chords, with a chord track below.
TUNE = [(0, 1, 72), (1, 1, 76), (2, 1, 79), (3, .5, 76), (3.5, .5, 74),
        (4, 1, 71), (5, 1, 74), (6, 2, 79), (8, 2, 76), (10, 2, 72)]
CHORDS = [(0, 4, 48), (0, 4, 52), (0, 4, 55), (4, 4, 43), (4, 4, 47), (4, 4, 50), (8, 4, 48), (8, 4, 52), (8, 4, 55)]


class SongbookTests(unittest.TestCase):
    def test_melody_chords_meter_from_midi(self):
        midi = songbook.parse_midi(midi_file([TUNE + [(0, .25, 60)], CHORDS]))
        song = songbook.song_from_midi(midi, track=0)
        self.assertEqual(song["meter"], [4, 0])
        self.assertEqual([p for p, _ in song["notes"]], [72, 76, 79, 76, 74, 71, 74, 79, 76, 72])   # the top line, not the low C
        self.assertEqual(sum(d for _, d in song["notes"]), 12)
        self.assertEqual([c for _, c in song["chords"]], ["C", "G", "C"])
        self.assertIn(song["key"], ([0, False], [7, False], [4, True], [9, True]))   # a key whose scale holds the tune

    def test_bars_pickup_and_rests(self):
        tune = [(3.5, .5, 67)] + [(4 + i, 1, 72 + 2 * i) for i in range(3)] + [(8, 1, 79)]
        midi = songbook.parse_midi(midi_file([tune]))
        song = songbook.song_from_midi(midi, track=0, bars=(2, 2), pickup=.5)
        self.assertEqual(song["meter"], [4, .5])
        self.assertEqual(song["notes"][0], [67, .5])                      # the pickup leads in
        self.assertEqual(sum(d for _, d in song["notes"]), 4)             # and the end is shortened by it
        self.assertEqual(song["notes"][-1][0], None)                      # a rest fills the bar

    def test_import_list_remove_from_the_command_line(self):
        with tempfile.TemporaryDirectory() as folder:
            source = Path(folder) / "Benim Parcam.mid"
            source.write_bytes(midi_file([TUNE, CHORDS]))
            env = dict(os.environ, CODE_SONATA_SONGS=str(Path(folder) / "songs"))
            run = lambda *args: subprocess.run([sys.executable, str(ROOT / "songbook.py"), *args], capture_output=True, text=True, env=env)
            self.assertIn("iz  0", run("tracks", str(source)).stdout)
            added = run("import", str(source), "--title", "Benim parçam")
            self.assertEqual(added.returncode, 0, added.stderr)
            saved = json.loads((Path(folder) / "songs/benim-parcam.json").read_text())
            self.assertEqual(saved["title"], "Benim parçam")
            self.assertIn("benim-parcam", run("list").stdout)
            self.assertEqual(run("import", str(source), "--name", "Kötü Ad!").returncode, 1)
            self.assertEqual(run("remove", "benim-parcam").returncode, 0)
            self.assertNotIn("benim-parcam", run("list").stdout)

    def test_a_held_tune_note_is_not_cut_by_a_lower_note_under_it(self):
        song = songbook.song_from_midi(songbook.parse_midi(midi_file([[(0, 4, 84), (1, 1, 60), (2, 1, 62)]])), track=0)
        self.assertEqual(song["notes"], [[84, 4.0]])

    def test_a_chord_change_under_a_held_note_never_rewrites_the_first_chord(self):
        midi = songbook.parse_midi(midi_file([[(0, 8, 72)], CHORDS[:6]]))
        self.assertEqual(songbook.song_from_midi(midi, track=0)["chords"], [[0, "C"]])
        rests = songbook.song_from_midi(songbook.parse_midi(midi_file([[(0, 2, 72), (6, 2, 74)], CHORDS[:6]])), track=0)
        self.assertIn([2, "G"], rests["chords"])   # the rest is cut at the half bar where G begins

    def test_rests_split_on_the_shifted_bar_lines(self):
        # Bar lines moved by 1.5 beats (a pickup written as part of the first bar): the chord that
        # starts at beat 1.5 must start there, not at 2.
        tune = [(0, 1.5, 67), (5.5, 1, 72)]
        chords = [(0, 1.5, 43), (0, 1.5, 47), (0, 1.5, 50), (1.5, 4, 48), (1.5, 4, 52), (1.5, 4, 55)]
        song = songbook.song_from_midi(songbook.parse_midi(midi_file([tune, chords])), track=0, bars=(1, 2), upbeat=1.5)
        starts, beat = [], 0
        for _, d in song["notes"]:
            starts.append(beat)
            beat += d
        self.assertIn(1.5, [starts[i] for i, name in song["chords"] if name == "C"])

    def test_not_a_midi_file(self):
        with self.assertRaises(ValueError):
            songbook.parse_midi(b"RIFF0000WAVE")


class RepertoireTests(unittest.TestCase):
    def test_every_song_sits_on_its_chords(self):
        # A wrong note in a hand-entered tune shows up as a melody that leaves its harmony.
        for song in PLAYLIST:
            total = fit = 0.0
            for (pitch, beats), step in zip(SONGS[song], PLANS[song]):
                if pitch is None:
                    continue
                root, intervals = step["chord"]
                weight = beats * (2 if abs((step["start"] - METERS[song][1]) % 1) < 1e-9 else 1)
                total += weight
                fit += weight * ((pitch - root) % 12 in intervals)
            self.assertGreater(fit / total, .65, song)

    def test_every_chord_name_is_known(self):
        names = {"C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"}
        self.assertTrue({n + q for n in names for q in ("", "m")} <= set(CHORD))


if __name__ == "__main__":
    unittest.main()
