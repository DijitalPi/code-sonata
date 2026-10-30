import json
from pathlib import Path
import random
import tempfile
import unittest

from agents import AgentMusic, load_position, save_position, where
from conductor import ACCORDION, DRUMS, TIMPANI, TREMOLO, eq
from melodies import KEYS, METERS, PLANS, STYLES, chord_tones


class MusicTests(unittest.TestCase):
    def play(self, music, start, seconds, step=.025):
        notes, self.times = [], []
        for i in range(int(seconds / step)):
            now = start + i * step
            out = music.tick(now)
            if out:
                self.times.append(now)
            notes.extend(out)
        return notes

    def test_silent_until_steps_then_closes(self):
        music = AgentMusic()
        self.assertEqual(self.play(music, 0, 2), [])
        music.accept([("a", "edit")], 3)
        self.assertGreater(len(self.play(music, 3, 4)), 4)
        music.accept([("a", "done")], 7)
        closing = self.play(music, 7, 14)
        self.assertGreater(len(closing), 4)            # the phrase plays on to its end...
        last = [n for n in closing if closing[-1][4] - n[4] < .1]
        self.assertEqual((len(last), {n[3] for n in last}), (4, {0}))   # ...then a soft tonic chord, rolled
        self.assertLess(closing[-1][4] - 7, 12 * 60 / 66)               # two bars on at most
        self.assertEqual(self.play(music, 30, 3), [])

    def test_long_think_keeps_flowing_until_done(self):
        music = AgentMusic()
        music.accept([("a", "busy")], 0)  # prompt sent, model thinking for a minute
        notes = self.play(music, 0, 60)
        self.assertGreater(len(notes), 30)
        gaps = [b - a for a, b in zip(self.times, self.times[1:])]
        self.assertLess(max(gaps), 4)  # no long silences mid-turn
        music.accept([("a", "done")], 60)
        self.play(music, 60, 4)
        self.assertEqual(self.play(music, 70, 3), [])

    def test_notes_keep_exact_time_whatever_the_loop_does(self):
        music = AgentMusic(song="ode-to-joy")
        music.accept([("a", "busy")], 0)   # no steps: the tempo stays at 66
        rng, now, onsets = random.Random(3), 0.0, []
        while now < 20:
            onsets += [n[4] for n in music.tick(now) if n[3] == 0]
            now += rng.uniform(.01, .06)   # an uneven loop
        beat = 60 / 66
        start = onsets[0]
        for at in onsets:
            half_beats = (at - start) / (beat / 2)
            self.assertAlmostEqual(half_beats, round(half_beats), delta=.002)

    def test_steps_are_short_notes_in_the_sessions_own_instrument(self):
        music = AgentMusic()
        music.accept([("piano", "edit"), ("flute", "edit"), ("horn", "edit"), ("choir", "edit")], 0)
        self.play(music, 0, 2)
        c, accents = music.conductor, []
        original = c.play_accents

        def spy(*args):
            before = len(c.out)
            original(*args)
            accents.extend(c.out[before:])
        c.play_accents = spy
        music.accept([("choir", "bash"), ("choir", "read"), ("flute", "think")], 2)
        self.play(music, 2, .4)
        chord = {p % 12 for p in chord_tones(c.chord, KEYS[c.song], 60)}
        self.assertEqual({n[4] for n in accents}, {2, 4})   # choir and flute: the sessions' own seats
        self.assertTrue(all((n[1] - c.shift) % 12 in chord for n in accents))

    def test_more_sessions_more_instruments(self):
        one, many = AgentMusic(), AgentMusic()
        for t in range(0, 20):
            one.accept([("a", "edit")], t)
            many.accept([(s, "edit") for s in "abcdefgh"], t)
        voices = lambda music: {n[3] for n in self.play(music, 20, 6)}
        self.assertGreater(len(voices(many)), len(voices(one)))

    def test_seats_piano_first_and_reuse(self):
        music = AgentMusic()
        music.accept([("terminal1", "edit")], 0)
        music.accept([("terminal2", "bash"), ("subagent", "read")], 1)
        self.assertEqual(music.voices(), ["piyano", "flüt", "korno"])
        music.accept([("terminal2", "done")], 2)
        music.accept([("terminal1", "edit"), ("subagent", "edit")], 15)
        music.active(30)  # terminal2 finished and idle > 20 s: its strings seat frees up
        music.accept([("new", "think")], 30)
        self.assertEqual(music.slots["new"], 1)

    def test_every_session_adds_an_instrument_of_its_own(self):
        for style in ("klasik", "8bit", "lofi"):
            joiners, heard = STYLES[style]["joiners"], []
            for n in range(1, 5):
                music = AgentMusic(style=style)
                music.accept([(f"s{i}", "busy") for i in range(n)], 0)   # thinking, no steps: a calm pace
                heard.append({v for *_, v, _ in self.play(music, 0, 24)})
                if n > 1:
                    newcomer = joiners[n - 2]
                    self.assertIn(ACCORDION if newcomer == 8 else newcomer, heard[-1], (style, n))
                    self.assertLess(heard[-2], heard[-1], (style, n))   # a new timbre each time

    def spy_steps(self, music):
        """(onset in seconds, phrase start, bar line) of every melody step the conductor plays."""
        c, steps = music.conductor, []
        original = c.note

        def note(t):
            meter, pickup = METERS[c.song]
            steps.append(((t + c.lead_ms) / 1000, PLANS[c.song][c.position]["phrase_start"],
                          eq(((c.song_beat - pickup) % meter + meter) % meter, 0)))
            original(t)
        c.note = note
        return steps

    def test_a_newcomer_comes_in_on_a_bar_line(self):
        music = AgentMusic(song="greensleeves")
        music.accept([("a", "busy")], 0)
        self.play(music, 0, 10.3)
        steps = self.spy_steps(music)
        music.accept([("b", "busy")], 10.3)            # mid-bar
        flute = [n[4] for n in self.play(music, 10.3, 15) if n[3] == 4]
        bars = [round(at, 6) for at, _, bar in steps if bar]
        self.assertTrue(flute)
        self.assertAlmostEqual(flute[0], min(at for at in bars if at > 10.3), delta=.002)   # the next bar line

    def test_a_finished_session_leaves_where_a_phrase_starts(self):
        music = AgentMusic(song="greensleeves")
        music.accept([("a", "busy"), ("b", "busy")], 0)
        steps = self.spy_steps(music)
        self.play(music, 0, 13.7)
        music.accept([("b", "done")], 13.7)
        flute = [n[4] for n in self.play(music, 13.7, 25) if n[3] == 4]
        phrase = next(at for at, start, _ in steps if start and at > 13.7)
        self.assertTrue(all(at < phrase for at in flute))     # gone from the next phrase on
        if phrase - 13.7 > 1:
            self.assertTrue([at for at in flute if at > 13.7])   # but the phrase it was in plays to its end

    def test_signal_motifs(self):
        music = AgentMusic()
        music.accept([("a", "edit")], 0)
        self.play(music, 0, 1)
        music.accept([("a", "testfail")], 1)
        notes = self.play(music, 1, 4)
        self.assertTrue({TREMOLO, TIMPANI} <= {n[3] for n in notes})
        music.accept([("a", "done")], 5)
        self.play(music, 5, 3)
        music.signal("wait", 9)          # all quiet: the bell rings at once, one note after another
        bell = [n for n in music.tick(9) if n[3] in (5, 7)]
        self.assertEqual(len(bell), 4)
        self.assertEqual(len({n[4] for n in bell}), 4)
        music.signal("wait", 9.5)        # no repeated bell within 2 s
        self.assertFalse(music.tick(9.5))

    def test_ship_plays_on_the_next_bar(self):
        music = AgentMusic()
        music.accept([("a", "edit")], 0)
        self.play(music, 0, 1)
        music.accept([("a", "ship")], 1)
        self.assertIn(6, {n[3] for n in self.play(music, 1, 5)})

    def test_calm_work_has_no_drums(self):
        music = AgentMusic()
        music.accept([("a", "busy")], 0)  # thinking, no steps
        notes = self.play(music, 0, 20)
        self.assertFalse([n for n in notes if n[3] == DRUMS])
        self.assertEqual(music.conductor.shift, 0)

    def test_fast_work_builds_a_climax_then_calms(self):
        music = AgentMusic()
        notes, shifted = [], False
        for i in range(1600):  # 8 sessions stepping hard for 40 s
            now = i * .025
            if i % 2 == 0:
                music.accept([(f"s{i % 8}", "edit")], now)
            notes.extend(music.tick(now))
            shifted = shifted or music.conductor.shift == 2
        self.assertTrue({36, 38, 49} <= {n[0] for n in notes if n[3] == DRUMS})
        self.assertTrue(shifted)   # a whole tone up at the top
        for i in range(8):
            music.accept([(f"s{i}", "busy")], 40)
        self.play(music, 40, 30)   # still working, but no steps: the climax ends
        self.assertEqual(music.conductor.shift, 0)
        self.assertLess(music.conductor.intensity, .2)

    def test_position_survives_restart(self):
        with tempfile.TemporaryDirectory() as d:
            state = Path(d) / "pos.json"
            self.assertIsNone(load_position("karisik", state))
            save_position("karisik", 17, state)   # an old format is ignored
            self.assertIsNone(load_position("karisik", state))
            music = AgentMusic()
            music.conductor.song, music.conductor.position = "greensleeves", 5
            save_position("karisik", where(music), state)
            again = AgentMusic(position=load_position("karisik", state))
            self.assertEqual((again.conductor.song, again.conductor.position), ("greensleeves", 5))
            self.assertEqual(again.conductor.song_beat, 1 + 2 + 1 + 1.5 + .5)
            fixed = AgentMusic(song="canon", position=load_position("karisik", state))
            self.assertEqual(fixed.conductor.song, "canon")   # a saved song outside the choice is not used

    def test_one_session_alone_hears_the_whole_band_of_its_style(self):
        for style in ("klasik", "8bit", "lofi"):
            music = AgentMusic(style=style)
            for t in range(0, 30):
                music.accept([("only", "edit"), ("only", "bash")], t * .5)
            voices = {n[3] for n in self.play(music, 15, 12)}
            self.assertGreaterEqual(len(voices), 3, style)   # not just the piano

    def test_style_and_song_can_change_while_playing(self):
        from melodies import STYLES
        music = AgentMusic(style="8bit")
        self.assertEqual(dict(music.programs())[0], STYLES["8bit"]["programs"][0])
        self.assertEqual(dict(music.programs())[10], STYLES["8bit"]["kit"])   # voice 10 takes the drum kit
        music.choose("korobeiniki")
        self.assertEqual((music.choice, music.conductor.song, music.conductor.position), ("korobeiniki", "korobeiniki", 0))
        music.conductor.skip()
        self.assertEqual(music.conductor.song, "korobeiniki")   # one song chosen: it stays
        music.choose("karisik")
        music.conductor.skip()
        self.assertNotEqual(music.conductor.song, "korobeiniki")
        music.conductor.set_style("lofi")
        self.assertEqual(music.conductor.style, "lofi")
        music.conductor.set_style("yok")
        self.assertEqual(music.conductor.style, "lofi")

    def test_flow_plays_loops_and_switches_with_songs(self):
        from agents import write_status
        music = AgentMusic(song="akis", style="lofi")
        self.assertIsNotNone(music.conductor.flow)
        music.accept([("a", "edit")], 0)
        notes = self.play(music, 0, 20)
        self.assertIn(10, {n[3] for n in notes})                  # the beat
        self.assertTrue(music.title().startswith("Akış · "))
        self.assertIsNone(music.like())                           # no song to like, ban or queue
        self.assertFalse(music.ban())
        self.assertFalse(music.enqueue())
        self.assertEqual(music.prefs["liked"] + music.prefs["banned"] + music.prefs["queue"], [])
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "status.json"
            write_status(music, 20, False, path)
            status = json.loads(path.read_text())
        self.assertEqual((status["flow"], status["song_id"], status["choice"]), (True, None, "akis"))
        scene = (music.conductor.flow.count, music.conductor.flow.skip)
        music.apply_prefs({"banned": [music.conductor.song]})       # a ban from the command line while loops play
        self.assertEqual((music.conductor.flow.count, music.conductor.flow.skip), scene)   # the scene goes on
        self.assertIn(music.conductor.song, music.conductor.songs)
        music.choose("canon")
        self.assertIsNone(music.conductor.flow)
        self.assertEqual((music.choice, music.conductor.song), ("canon", "canon"))
        music.choose("akis")
        self.play(music, 20, 10)
        self.assertEqual(music.conductor.flow.count, 1)

    def test_loops_start_from_the_wall_clock(self):
        # time.monotonic counts from the process start: seeded from it, every listener opened on one chord loop.
        firsts = set()
        for clock in (1_000.4, 86_400.7, 3_600_000.2):
            music = AgentMusic(song="akis")
            music.seed_flow(lambda: clock)
            self.assertEqual(music.conductor.flow.rng, int(clock) + 1)
            music.conductor.new_scene(0)
            firsts.add((music.conductor.flow.prog_id, music.conductor.flow.key))
        self.assertGreater(len(firsts), 1)

    def test_melody_and_volume_are_remembered(self):
        from agents import level, load_choice, save_choice
        music = AgentMusic(melody="az")
        self.assertEqual(music.conductor.melody, "az")
        music.conductor.set_melody("yok")
        self.assertEqual(music.conductor.melody, "az")
        self.assertEqual((level("140"), level(-3), level("x", 70), level(None)), (100, 0, 70, 100))
        music.volume = 40
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "choice.json"
            save_choice(music, path)
            self.assertEqual({k: load_choice(path)[k] for k in ("melody", "volume")}, {"melody": "az", "volume": 40})

    def test_queue_likes_bans_and_quiet_signals(self):
        from agents import load_prefs, save_prefs
        music = AgentMusic(song="sira", prefs={"queue": ["air", "canon", "yok"], "banned": ["boss"]})
        c = music.conductor
        self.assertEqual((c.songs, c.ordered, c.song), (("air", "canon"), True, "air"))
        music.choose("karisik")
        self.assertNotIn("boss", c.songs)
        self.assertFalse(c.ordered)
        c.song = "zafer"
        self.assertTrue(music.like())
        self.assertEqual(c.favorites, ["zafer"])
        self.assertFalse(music.like())
        music.ban()
        self.assertNotEqual(c.song, "zafer")
        self.assertNotIn("zafer", c.songs)
        music.enqueue()
        self.assertEqual(music.prefs["queue"][-1], c.song)
        music.prefs["queue"] = ["air", "canon", "gymnopedie"]
        music.choose("sira")
        c.song = "canon"
        music.ban()                                   # in the queue: the song after it plays next
        self.assertEqual((c.song, c.songs, music.choice), ("gymnopedie", ("air", "gymnopedie"), "sira"))
        music.prefs["queue"] = ["gymnopedie"]
        music.ban()                                   # the queue emptied: the mix
        self.assertEqual(music.choice, "karisik")
        music.choose("korobeiniki")
        music.ban()                                   # the one song chosen: back to the mix without it
        self.assertEqual(music.choice, "karisik")
        self.assertFalse(music.quiet("adim"))
        music.accept([("s", "bash")] * 3, 1)
        self.assertEqual(c.accents, [])               # step notes off
        self.assertFalse(music.quiet("wait"))
        music.signal("wait", 2)
        self.assertNotIn("wait", c.cues)
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "prefs.json"
            save_prefs(music.prefs, path)
            self.assertEqual(load_prefs(path), music.prefs)
            path.write_text('{"queue": "air", "liked": [1, "air"]}')
            self.assertEqual(load_prefs(path), {"queue": [], "liked": ["air"], "banned": [], "quiet": []})

    def test_a_stop_from_launchctl_still_cleans_up(self):
        # launchctl bootout sends SIGTERM: the listener must still run its cleanup (status file, position).
        import signal, subprocess, sys, time
        with tempfile.TemporaryDirectory() as d:
            proc = subprocess.Popen([sys.executable, str(Path(__file__).with_name("agents.py")), "--silent", "--roots", d],
                                    stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
            deadline = time.monotonic() + 10
            seen = ""
            while "Dinleme hazır." not in seen and time.monotonic() < deadline:
                seen += proc.stdout.readline()
            proc.send_signal(signal.SIGTERM)
            out, _ = proc.communicate(timeout=10)
        self.assertIn("Dinleme durdu.", out)
        self.assertEqual(proc.returncode, 0)

    def test_next_song_command(self):
        music = AgentMusic()
        first = music.conductor.song
        music.conductor.skip()
        self.assertNotEqual(music.conductor.song, first)
        self.assertEqual(music.conductor.position, 0)


if __name__ == "__main__":
    unittest.main()
