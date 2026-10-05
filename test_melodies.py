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


if __name__ == '__main__':
    unittest.main()
