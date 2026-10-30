import tempfile
from pathlib import Path
import unittest
from sonata import Composer, Document


class SonataTests(unittest.TestCase):
    def test_silence_and_tempo_ramp(self):
        c = Composer()
        self.assertEqual(c.tick(0), [])
        for i in range(400):
            t = i * .025
            c.typed(t, "x = 1")
            c.tick(t)
        self.assertGreater(c.bpm, 130)
        self.assertLessEqual(c.bpm, 140)
        self.assertEqual(c.tick(12), [])
        for i in range(800):
            c.tick(12 + i * .025)
        self.assertLess(c.bpm, 56)

    def test_motif_repeat_and_note_range(self):
        a, b = Composer(), Composer()
        a.typed(0, "def hello():")
        b.typed(0, "def hello():")
        self.assertEqual(a.motif, b.motif)
        for i in range(300):
            t = i * .1
            a.typed(t, "for x in values:")
            for pitch, velocity, duration, *_ in a.tick(t):
                self.assertTrue(21 <= pitch <= 108)
                self.assertTrue(0 < velocity < 80)
                self.assertTrue(0 < duration < 10)

    def test_edit_undo_and_atomic_save(self):
        d = Document("def hello():")
        d.col = len(d.lines[0])
        d.edit("\n")
        self.assertEqual(d.lines, ["def hello():", "    "])
        d.edit("ş")
        d.edit("\x1a")
        self.assertEqual(d.lines[1], "    ")
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "nested" / "music.py"
            d.save(path)
            self.assertEqual(path.read_text(), "def hello():\n    ")
            self.assertFalse(d.dirty)

    def test_cadence_is_single_event(self):
        c = Composer()
        c.typed(0, "return result")
        self.assertEqual([n[0] for n in c.tick(0)], [48, 64, 72])
        self.assertFalse(c.cadence)
        c.typed(.01, "return result_value")
        self.assertFalse(c.cadence)
        self.assertEqual(c.tick(.01), [])


if __name__ == "__main__":
    unittest.main()
