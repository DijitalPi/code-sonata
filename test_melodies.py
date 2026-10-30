from pathlib import Path
import unittest
from melodies import BELLA_CIAO, SongComposer


class MelodyTests(unittest.TestCase):
    def test_theme_order_is_preserved_across_code_changes(self):
        music = SongComposer('bella-ciao')
        now = 0
        for expected, _ in BELLA_CIAO:
            music.typed(now, 'return result')
            notes = music.tick(now)
            self.assertEqual(notes[0][0], expected)
            now = music.next_note + .001
        self.assertEqual(music.position, 0)

    def test_idle_is_silent_and_resume_continues_theme(self):
        music = SongComposer('bella-ciao')
        self.assertEqual(music.tick(0), [])
        music.typed(1, 'for item')
        self.assertEqual(music.tick(1)[0][0], 64)
        self.assertEqual(music.tick(10), [])
        music.typed(11, 'if condition')
        self.assertEqual(music.tick(11)[0][0], 69)

    def test_lead_sheet_chords_and_exact_timing(self):
        music = SongComposer('bella-ciao')
        now, changes, chord, onsets = 0, 0, None, []
        while len(onsets) < len(BELLA_CIAO):
            music.typed(now, 'x = 1')
            for note in music.tick(now):
                if note[0] == BELLA_CIAO[len(onsets) % len(BELLA_CIAO)][0] and note[2] < 3.01 and len(onsets) < len(BELLA_CIAO):
                    onsets.append(note[4])
            if music.chord != chord:
                changes, chord = changes + 1, music.chord
            now += .037   # an uneven loop does not move the notes
        self.assertLessEqual(changes, 5)   # Am, Dm, Am, E, Am: the lead sheet, not a chord per note
        self.assertEqual(sorted(onsets), onsets)


if __name__ == '__main__':
    unittest.main()


class InstallTests(unittest.TestCase):
    def test_the_copied_app_gets_every_data_module_the_tool_reads(self):
        # install.sh copies a short list of files when the repo sits in a protected folder; a module
        # melodies.py reads but the copy lacks would stop the listener at its first line.
        import re
        root = Path(__file__).resolve().parent
        read = set(re.findall(r'_module_json\("([a-z]+)\.mjs"\)', (root / "melodies.py").read_text()))
        copied = re.search(r'orchestra/web/\{([a-z,]+)\}\.mjs', (root / "install.sh").read_text()).group(1).split(",")
        self.assertTrue(read <= set(copied), read - set(copied))
