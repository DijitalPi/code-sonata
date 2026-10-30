"""The local tool and the site must play the same music: conductor.py against conductor.mjs."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import unittest

from conductor import DRUMS, Conductor, js_round
from melodies import FLOW, KEYS, METERS, PLANS, PLAYLIST, SONGS, STYLES

ROOT = Path(__file__).resolve().parent
# [duration ms, players per section, listeners, steps per 25 ms tick, featured sections]
PHASES = [
    [20_000, [1, 0, 0, 0, 0, 0, 0, 0, 0], 0, 0.2, []],
    [45_000, [1, 2, 1, 1, 1, 1, 1, 1, 1], 0, 3, [4]],
    [25_000, [1, 1, 0, 1, 0, 0, 1, 0, 1], 0, 0.1, [6, 8]],
    [10_000, [0] * 9, 1, 0, []],
    [8_000, [0] * 9, 0, 0, []],
    [70_000, [2, 1, 1, 1, 1, 1, 1, 1, 1], 0, 1.5, [2, 5, 7]],
    [12_000, [1, 0, 0, 0, 1, 0, 1, 0, 0], 0, 0.05, [4, 6]],
]
SIGNALS = [[5_000, "pass", 0], [30_000, "ship", 1], [62_000, "wait", 0], [70_000, "fail", 2],
           [96_000, "wait", 0], [130_000, "testfail", 3], [131_000, "testfail", 3], [150_000, "lead", 0],
           [158_000, "pass", 1]]
ACCENTS = ["bash", "read", "think"]
NODE = """
import { createConductor } from "./orchestra/web/conductor.mjs";
const S = JSON.parse(process.env.SCENARIO);
const notes = [], states = [];
let phase = 0, until = S.phases[0][0], steps = 0;
const c = createConductor({ population: () => {
  const [, active, listening, , featured] = S.phases[phase];
  return { working: active.reduce((a, b) => a + b, 0), total: 9, active, listening, featured };
}, ...S.options });
for (let t = 0, k = 0; phase < S.phases.length; t += S.tick, k++) {
  if (t >= until) { phase++; if (phase >= S.phases.length) break; until += S.phases[phase][0]; }
  steps += S.phases[phase][3]; const whole = Math.floor(steps); c.steps += whole; steps -= whole;
  for (const [at, kind, section] of S.signals) if (at === t) kind === "lead" ? c.cue(kind) : c.signal(kind, section, S.start + t);
  if (k % 28 === 0) c.accent(S.accents[(k / 28) % 3], k % 9);
  c.tick(S.start + t, S.tick);
  if (k % 40 === 0) states.push([c.song, c.position, c.lead, Math.round(c.intensity * 1e6), c.shift]);
  notes.push(...c.out.splice(0));
}
console.log(JSON.stringify({ notes, states }));
"""


def run_python(scenario):
    phases, state = scenario["phases"], {"phase": 0}

    def population(now, dt):
        _, active, listening, _, featured = phases[state["phase"]]
        return {"working": sum(active), "total": 9, "active": active, "listening": listening, "featured": featured}

    options = scenario["options"]
    c = Conductor(population, **{
        {"leadMs": "lead_ms", "errorCues": "error_cues", "signalGapMs": "signal_gap_ms"}.get(k, k): v
        for k, v in options.items()})
    notes, states, steps, until, t, k = [], [], 0.0, phases[0][0], 0, 0
    while state["phase"] < len(phases):
        if t >= until:
            state["phase"] += 1
            if state["phase"] >= len(phases):
                break
            until += phases[state["phase"]][0]
        steps += phases[state["phase"]][3]
        whole = int(steps // 1)
        c.steps += whole
        steps -= whole
        for at, kind, section in scenario["signals"]:
            if at == t:
                c.cue(kind) if kind == "lead" else c.signal(kind, section, scenario["start"] + t)
        if k % 28 == 0:
            c.accent(scenario["accents"][(k // 28) % 3], k % 9)
        c.tick(scenario["start"] + t, scenario["tick"])
        if k % 40 == 0:
            states.append([c.song, c.position, c.lead, int(c.intensity * 1e6 + .5), c.shift])
        notes.extend(c.out)
        c.out = []
        t += scenario["tick"]
        k += 1
    return {"notes": notes, "states": states}


@unittest.skipUnless(shutil.which("node"), "node is needed to compare with the site's conductor")
class ParityTests(unittest.TestCase):
    def compare(self, options):
        scenario = {"start": 1_700_000_000_000, "tick": 25, "phases": PHASES, "signals": SIGNALS,
                    "accents": ACCENTS, "options": options}
        js = subprocess.run(["node", "--input-type=module", "-e", NODE], cwd=ROOT, capture_output=True, text=True,
                            env=dict(os.environ, SCENARIO=json.dumps(scenario)), timeout=60)
        self.assertEqual(js.returncode, 0, js.stderr)
        site, local = json.loads(js.stdout), run_python(scenario)
        self.assertGreater(len(site["notes"]), 1000)
        self.assertEqual(local["states"], site["states"])
        for i, (a, b) in enumerate(zip(local["notes"], site["notes"])):
            self.assertEqual(a, b, f"note {i}")
        self.assertEqual(len(local["notes"]), len(site["notes"]))
        return site

    def test_site_defaults(self):
        site = self.compare({})
        self.assertGreater(len({s[0] for s in site["states"]}), 1)   # songs changed along the way

    def test_every_style_plays_the_same_on_both_sides(self):
        for style in STYLES:
            with self.subTest(style=style):
                site = self.compare({"style": style, "leadMs": 150, "errorCues": True, "signalGapMs": 2000})
                voices = {n[4] for n in site["notes"]}
                if STYLES[style]["drums"] != "climax":
                    self.assertIn(10, voices, style)   # groove, lo-fi and film styles play drums before the climax

    def test_local_tool_options(self):
        site = self.compare({"leadMs": 150, "errorCues": True, "signalGapMs": 2000, "song": "canon",
                             "songs": ["canon", "fur-elise", "mountain-king"]})
        self.assertTrue({s[0] for s in site["states"]} <= {"canon", "fur-elise", "mountain-king"})

    def test_flow_plays_the_same_on_both_sides(self):
        for style in STYLES:
            with self.subTest(style=style):
                site = self.compare({"flow": True, "style": style, "leadMs": 150, "errorCues": True, "signalGapMs": 2000})
                self.assertIn(10, {n[4] for n in site["notes"]}, style)   # every style has its beat in flow
        for melody in ("az", "cok"):
            with self.subTest(melody=melody):
                self.compare({"flow": True, "style": "lofi", "melody": melody, "leadMs": 150, "errorCues": True, "signalGapMs": 2000})

    def test_a_queue_favourites_and_less_melody_play_the_same_on_both_sides(self):
        site = self.compare({"leadMs": 150, "errorCues": True, "signalGapMs": 2000, "song": "air", "melody": "az",
                             "songs": ["air", "boss", "gymnopedie", "korobeiniki"], "ordered": True})
        order = [s[0] for i, s in enumerate(site["states"]) if i == 0 or s[0] != site["states"][i - 1][0]]
        self.assertEqual(order[:3], ["air", "boss", "gymnopedie"])
        self.compare({"favorites": ["air", "zafer"]})


class ArrangementTests(unittest.TestCase):
    def test_a_broken_test_suspends_the_harmony_until_one_passes(self):
        c = Conductor(lambda now, dt: {"working": 2, "total": 2, "active": [1, 1, 0, 0, 0, 0, 0, 0, 0], "listening": 0}, error_cues=True)
        c.tick(1_700_000_000_000, 25)
        plain = c.pad_chord(60)
        c.signal("testfail", 0, 1_700_000_000_000)
        for i in range(1, 400):
            c.tick(1_700_000_000_000 + i * 25, 25)
        self.assertTrue(c.tension)
        root = c.pad_chord(60)[0]
        self.assertEqual([p - root for p in c.pad_chord(60)], [0, 5, 7])
        c.signal("pass", 0, 1_700_000_020_000)
        for i in range(400, 800):
            c.tick(1_700_000_000_000 + i * 25, 25)
        self.assertFalse(c.tension)
        self.assertEqual(len(c.pad_chord(60)), len(plain))

    def test_the_last_test_result_wins_within_a_bar(self):
        c = Conductor(lambda now, dt: {"working": 1, "total": 1, "active": [1] + [0] * 8, "listening": 0}, error_cues=True, signal_gap_ms=0)
        c.tick(1_700_000_000_000, 25)
        for kind in ("testfail", "pass", "testfail"):
            c.signal(kind, 0, 1_700_000_000_010)
        for i in range(1, 400):
            c.tick(1_700_000_000_000 + i * 25, 25)
        self.assertTrue(c.tension)

    def test_every_song_of_a_mood_gets_its_turn(self):
        from melodies import MOODS
        c = Conductor(lambda now, dt: {"working": 1, "total": 1, "active": [1] + [0] * 8, "listening": 0})
        c.intensity, heard = .5, set()
        for _ in range(3 * len(MOODS["warm"])):
            c.song = c.pick_song()
            heard.add(c.song)
        self.assertEqual(heard, set(MOODS["warm"]))

    def test_a_half_beat_pickup_keeps_the_drums_on_the_bar(self):
        c = Conductor(lambda now, dt: {"working": 3, "total": 3, "active": [1, 1, 0, 1, 0, 0, 0, 1, 0], "listening": 0},
                      song="entertainer", songs=("entertainer",), style="8bit")
        notes = []
        for i in range(2000):
            c.steps += 2
            c.tick(1_700_000_000_000 + i * 25, 25)
            notes += c.out
            c.out = []
        drums = [n for n in notes if n[4] == 10]
        self.assertTrue(any(n[1] == 36 for n in drums) and any(n[1] == 38 for n in drums))   # kick and snare both play

    def test_styles_change_the_arrangement(self):
        def run(style):
            c = Conductor(lambda now, dt: {"working": 4, "total": 4, "active": [1, 1, 0, 1, 0, 0, 0, 1, 0], "listening": 0},
                          style=style, song="korobeiniki")
            notes = []
            for i in range(2400):
                c.steps += 1
                c.tick(1_700_000_000_000 + i * 25, 25)
                notes += c.out
                c.out = []
            return c, notes
        klasik, k_notes = run("klasik")
        chip, c_notes = run("8bit")
        lofi, l_notes = run("lofi")
        self.assertGreater(chip.bpm, klasik.bpm)                      # 8-bit runs faster
        self.assertLess(lofi.bpm, chip.bpm)
        pads = lambda notes: [n for n in notes if n[4] == 1]
        self.assertGreater(len(pads(c_notes)), 3 * len(pads(k_notes)))   # broken chords instead of held ones
        self.assertTrue(any(n[4] == 10 for n in l_notes))              # lo-fi always has a soft beat
        self.assertTrue(all(n[3] <= 2.6 for n in c_notes))

    def test_melody_changes_hands_only_where_a_phrase_starts(self):
        sections = [1, 1, 1, 0, 1, 0, 0, 0, 1]
        c = Conductor(lambda now, dt: {"working": 5, "total": 5, "active": sections, "listening": 0})
        c.intensity = .7
        changes = []
        for i in range(12_000):
            before = (c.song, c.position, c.lead)
            c.steps += 2
            c.tick(1_700_000_000_000 + i * 25, 25)
            if c.lead != before[2] and before[2] is not None and c.position:
                changes.append((c.song, c.position - 1))
        self.assertTrue(changes)
        for song, position in changes:
            self.assertTrue(PLANS[song][position]["phrase_start"], (song, position))

    def test_a_falling_pace_does_not_take_the_melody_mid_phrase(self):
        sections = [1, 1, 1, 0, 1, 0, 0, 0, 1]   # the flute sings only above a quarter of the intensity
        c = Conductor(lambda now, dt: {"working": 5, "total": 5, "active": sections, "listening": 0})
        changes = []
        for i in range(12_000):
            before = c.lead
            c.intensity = .9 if (i // 97) % 2 else .1   # the pace swings up and down, out of step with phrases
            c.tick(1_700_000_000_000 + i * 25, 25)
            if c.lead != before and before is not None and c.position:
                changes.append((c.song, c.position - 1))
        self.assertTrue(changes)
        for song, position in changes:
            self.assertTrue(PLANS[song][position]["phrase_start"], (song, position))

    def solo(self, style="klasik", **options):
        """One session at a calm pace: the style's band, nobody featured."""
        active = [0] * 9
        for s in STYLES[style]["ensemble"]:
            active[s] = 1
        return Conductor(lambda now, dt: {"working": 1, "total": 1, "active": active, "listening": 0}, style=style, **options)

    def test_a_song_is_heard_as_theme_variation_and_breath_then_the_next_begins(self):
        c = self.solo(songs=PLAYLIST)
        visits, turns = [], []
        for i in range(24_000):   # ten minutes
            c.tick(1_700_000_000_000 + i * 25, 25)
            c.out = []
            if not visits or visits[-1] != c.song:
                visits.append(c.song)
                turns.append([])
            if not turns[-1] or turns[-1][-1] != c.part():
                turns[-1].append(c.part())
        self.assertGreaterEqual(len(visits), 6)
        for form in turns[:-1]:
            self.assertEqual(form, ["tema", "varyasyon", "nefes"])   # each song: two melody turns, then a breath

    def test_the_breath_plays_the_accompaniment_without_the_tune(self):
        c = self.solo(song="ode-to-joy", songs=("ode-to-joy",))
        notes = []
        for i in range(2000):
            c.turn = 2
            c.tick(1_700_000_000_000 + i * 25, 25)
            notes += c.out
            c.out = []
            self.assertIsNone(c.lead)
        self.assertEqual(c.solo, 0)                      # no melody note was played
        self.assertGreater(len(notes), 100)              # the band goes on
        self.assertTrue(any(n[4] == 0 for n in notes))   # the piano's broken chord moves under the held pads

    def test_the_variation_hands_the_tune_to_another_voice_an_octave_up(self):
        c = self.solo(song="ode-to-joy", songs=("ode-to-joy",))
        first = SONGS["ode-to-joy"][0][0]
        notes = []
        for i in range(400):
            c.turn = 1
            c.tick(1_700_000_000_000 + i * 25, 25)
            notes += c.out
            c.out = []
        self.assertEqual(c.lead, 1)                                       # the strings, not the piano
        self.assertIn([1, first + 12], [[n[4], n[1]] for n in notes])
        self.assertTrue(any(n[4] == 0 and n[1] < first + 12 for n in notes))   # the piano answers below

    def test_a_song_comes_back_only_after_six_others(self):
        c = self.solo(songs=PLAYLIST)
        for intensity in (0, .5, .9):
            c.intensity, picks = intensity, []
            for _ in range(40):
                c.song = c.pick_song()
                picks.append(c.song)
            for i in range(len(picks)):
                self.assertNotIn(picks[i], picks[i + 1:i + 7], intensity)

    def test_a_calm_pace_has_more_than_a_handful_of_songs(self):
        from melodies import MOODS
        self.assertGreaterEqual(len(MOODS["calm"]), 8)
        c = self.solo(songs=PLAYLIST)
        picks = []
        for _ in range(8):
            c.song = c.pick_song()
            picks.append(c.song)
        self.assertEqual(len(set(picks)), 8)
        self.assertTrue(set(picks) <= set(MOODS["calm"]) | set(MOODS["warm"]))

    def test_less_melody_and_no_breath(self):
        for melody, parts in (("az", {"tema", "nefes"}), ("cok", {"tema", "varyasyon"})):
            c, seen = self.solo(songs=PLAYLIST, melody=melody), set()
            for i in range(12_000):
                c.tick(1_700_000_000_000 + i * 25, 25)
                c.out = []
                seen.add(c.part())
            self.assertEqual(seen, parts, melody)

    def test_each_song_keeps_its_own_tempo(self):
        c = self.solo(song="gymnopedie")
        c.intensity = .5
        slow = c.pace()
        c.song = "rondo-alla-turca"
        self.assertGreater(c.pace(), slow * 1.3)
        c.next_song(lambda base: base, 60_000 / c.bpm, KEYS[c.song])
        self.assertEqual(c.bpm, c.pace())   # a new song starts at its own tempo, no glide

    def test_the_last_bar_slows_before_the_close(self):
        c = self.solo(song="ode-to-joy", songs=("ode-to-joy",), melody="cok")
        c.tick(1_700_000_000_000, 25)
        c.turn, c.position = 1, len(SONGS["ode-to-joy"]) - 2          # the last bar of the last turn: D (1.5), C (.5), C (2)
        c.song_beat = PLANS["ode-to-joy"][-2]["start"]
        before, beat = c.clock, 60_000 / c.bpm
        c.note(c.clock)
        self.assertAlmostEqual(c.clock - before, .5 * beat * (1 + .25 * (1 - 2.5 / 4)), delta=.01)   # 2.5 of 4 beats left
        c.turn, c.position, c.song_beat = 0, 0, 0
        before = c.clock
        c.note(c.clock)
        self.assertAlmostEqual(c.clock - before, 60_000 / c.bpm, delta=.01)   # in the theme: strict time

    def test_a_dominant_seventh_leads_into_the_next_song(self):
        c = self.solo(song="ode-to-joy")
        c.tick(1_700_000_000_000, 25)
        c.out = []
        c.next_song(lambda base: base * 1.7, 500, KEYS["ode-to-joy"])
        tonic = KEYS[c.song][0]
        bridge = [n for n in c.out if n[0] >= c.clock - 1000 + c.lead_ms - 1]
        self.assertEqual({n[1] % 12 for n in bridge}, {(tonic + d) % 12 for d in (7, 11, 2, 5)})
        self.assertEqual(sorted(n[0] for n in c.out), [n[0] for n in c.out])   # chords rolled from the bottom up

    def test_the_next_song_is_in_another_key(self):
        c = self.solo(songs=PLAYLIST)
        for intensity in (0, .5):
            c.intensity = intensity
            for _ in range(16):
                before = c.song
                c.song = c.pick_song()
                self.assertNotEqual(KEYS[c.song], KEYS[before], intensity)

    def test_the_variation_writes_a_new_line_on_its_odd_phrases(self):
        song = "ode-to-joy"
        c = self.solo(song=song, songs=(song,))
        melody = []
        for i in range(2400):
            c.turn = 1
            c.tick(1_700_000_000_000 + i * 25, 25)
            melody += [n[1] - 12 for n in c.out if n[4] == 1]   # the strings sing the variation, an octave up
            c.out = []
        phrases = [i for i, step in enumerate(PLANS[song]) if step["phrase_start"]]
        theme = [p for p, _ in SONGS[song]]
        first, second = theme[:phrases[1]], theme[phrases[1]:phrases[2]]
        self.assertEqual(melody[:len(first)], first)                                  # phrase 0: the theme
        line = melody[len(first):len(first) + len(second)]
        self.assertEqual((line[0], line[-1]), (second[0], second[-1]))                 # starts and ends on the theme
        self.assertGreater(sum(a != b for a, b in zip(line, second)), len(second) // 2)   # a new line between
        pickup = METERS[song][1]
        for k, pitch in enumerate(line):
            step = PLANS[song][phrases[1] + k]
            root, intervals = step["chord"]
            if abs((step["start"] - pickup) % 1) < 1e-9:
                self.assertIn((pitch - root) % 12, intervals)                         # chord tones on the beat

    def test_a_phrase_swells_and_settles(self):
        c = self.solo(song="ode-to-joy", songs=("ode-to-joy",))
        notes = []
        for i in range(800):
            c.tick(1_700_000_000_000 + i * 25, 25)
            notes += [n for n in c.out if n[4] == 0 and n[2] >= 60]   # the piano's tune (accompaniment is softer)
            c.out = []
        velocities = [n[2] for n in notes[:8]]                        # the first phrase: eight quarter notes
        self.assertGreater(max(velocities[2:6]), velocities[0])
        self.assertLess(velocities[7], max(velocities))

    def test_a_queue_plays_in_its_order_and_a_favourite_comes_first(self):
        c = self.solo(song="air", songs=("air", "boss", "canon"), ordered=True)
        order = []
        for _ in range(4):
            c.song = c.pick_song()
            order.append(c.song)
        self.assertEqual(order, ["boss", "canon", "air", "boss"])
        c = self.solo(songs=PLAYLIST, favorites=["brahms-lullaby"])
        self.assertEqual(c.pick_song(), "brahms-lullaby")

    def test_every_phrase_list_fits_its_song(self):
        for song in PLAYLIST:
            starts = [i for i, step in enumerate(PLANS[song]) if step["phrase_start"]]
            self.assertEqual(starts[0], 0, song)
            self.assertTrue(all(i < len(SONGS[song]) for i in starts), song)



class FlowTests(unittest.TestCase):
    """Loops instead of songs: one grid, one chord loop per scene, layers in and out on bar lines."""
    START = 1_700_000_000_000

    def conductor(self, style="8bit", sessions=1, **options):
        look = STYLES[style]
        order = [0] + look["joiners"] + [s for s in look["ensemble"] if s != 0]
        self.crowd = {"n": sessions}

        def population(now, dt):
            active, featured = [0] * 9, []
            if self.crowd["n"]:
                for s in look["ensemble"]:
                    active[s] = 1
            for seat in range(1, self.crowd["n"]):
                active[order[seat]] += 1
                featured.append(order[seat])
            return {"working": self.crowd["n"], "total": self.crowd["n"], "active": active, "listening": 0, "featured": featured}
        return Conductor(population, style=style, lead_ms=150, error_cues=True, signal_gap_ms=2000, flow=True, **options)

    def run_for(self, c, seconds, start=0, pace=.02, each=None):
        notes = []
        for i in range(int(seconds * 40)):
            t = start + i * 25
            if (i * 7919) % 1000 < pace * 1000:
                c.steps += 1
            if each:
                each(c, t)
            c.tick(self.START + t, 25)
            notes += c.out
            c.out = []
        return notes

    def test_every_note_starts_on_the_sixteenth_grid(self):
        c = self.conductor("8bit")
        steps, step = [], c.flow_step

        def record(t):
            step(t)
            steps.append((t, 60_000 / c.bpm / 4))   # this sixteenth's length (a new scene's first one at its own tempo)
        c.flow_step = record
        notes = self.run_for(c, 180)
        onsets = {js_round(t + c.lead_ms) for t, _ in steps}
        self.assertTrue(all(n[0] in onsets for n in notes), "a note off the grid")   # 8-bit has no swing
        for (a, da), (b, _) in zip(steps, steps[1:]):
            self.assertAlmostEqual(b - a, da, delta=.01)                              # the grid never stretches
        self.assertGreater(len({n[4] for n in notes}), 4)

    def test_twenty_minutes_never_loop_one_hook(self):
        c, heard, scenes = self.conductor("klasik"), [], set()

        def listen(c, t):
            if c.flow.plan and c.flow.step == 1:
                scenes.add(c.flow.count)
                if c.flow.loop < len(FLOW["arc"]) and c.flow.plan["hook"]:
                    tune = tuple(tuple(n[1] for n in bar) for bar in c.flow.hooks[c.flow.plan["hook"]]["bars"])
                    if not heard or heard[-1][0] != (c.flow.count, c.flow.loop):
                        heard.append(((c.flow.count, c.flow.loop), tune))
        self.run_for(c, 20 * 60, each=listen)
        tunes = [tune for _, tune in heard]
        runs = [1]
        for a, b in zip(tunes, tunes[1:]):
            runs.append(runs[-1] + 1 if a == b else 1)
        self.assertGreaterEqual(len(scenes), 10)                    # a new scene every one or two minutes
        self.assertLessEqual(max(runs), 2)                          # a hook never plays three loops in a row
        self.assertLessEqual(max(tunes.count(t) for t in tunes), 4)   # nor more than four times in twenty minutes
        self.assertGreater(len(set(tunes)), len(tunes) / 3)

    def test_hooks_land_on_chord_tones(self):
        for style in STYLES:
            c = self.conductor(style)
            for _ in range(12):
                c.new_scene(self.START)
                for name, hook in c.flow.hooks.items():
                    for bar, line in enumerate(hook["bars"]):
                        root, intervals = c.flow.prog[bar]
                        lo, hi = STYLES[style]["flow"]["hook"]
                        for n, (s, p, length) in enumerate(line):
                            self.assertTrue(lo - 3 <= p <= hi + 3, (style, name, p))
                            if s % 4 == 0 or length >= 3 or n in (0, len(line) - 1):
                                self.assertIn((p - root) % 12, intervals, (style, name, bar, s))
                    self.assertTrue(all(s < 8 for s, _, _ in hook["bars"][1]))   # bar 2 leaves room for the answer

    def test_a_scene_builds_breaks_and_peaks(self):
        c, plans = self.conductor("synthwave", sessions=3), []

        def look(c, t):
            if c.flow.plan and c.flow.step == 1 and (not plans or plans[-1][0] != (c.flow.count, c.flow.loop)):
                plans.append(((c.flow.count, c.flow.loop), c.flow.plan["name"], c.flow.plan["beat"], c.flow.plan["hook"]))
        notes = self.run_for(c, 150, pace=.06, each=look)
        names = [p[1] for p in plans if p[0][0] == 1]
        self.assertEqual(names, [a["name"] for a in FLOW["arc"]])
        mola = next(p for p in plans if p[1] == "mola")
        self.assertEqual((mola[2], mola[3]), (None, None))          # the break: no beat, no hook
        self.assertTrue(any(n[1] == 49 and n[4] == DRUMS for n in notes))   # a crash at the peak and the next scene
        self.assertGreater(sum(p[0][0] == 2 for p in plans), 0)

    def test_a_newcomer_comes_in_on_a_bar_line_and_a_leaver_plays_its_loop_out(self):
        c = self.conductor("klasik")
        bars, step = [], c.flow_step

        def record(t):
            if c.flow.step % 16 == 0:
                bars.append((js_round(t + c.lead_ms), c.flow.step == 0 and not c.flow.skip))
            step(t)
        c.flow_step = record
        notes = self.run_for(c, 30)
        self.crowd["n"] = 2                                             # the flute's session joins mid-bar
        joined = self.run_for(c, 30, start=30_000)
        flute = [n for n in joined if n[4] == 4]
        self.assertTrue(flute)
        lines = [at for at, _ in bars]
        first_bar = next(at for at in lines if at >= flute[0][0] - 3000 and at <= flute[0][0])
        self.assertIn(first_bar, lines)
        self.assertFalse([n for n in notes if n[4] == 4])
        self.crowd["n"] = 1                                             # it finishes: its loop plays to the end
        left = self.run_for(c, 40, start=60_000)
        loop_starts = [at for at, start in bars if start and at > self.START + 60_000]
        last_flute = max((n[0] for n in left if n[4] == 4), default=0)
        if last_flute:
            self.assertLess(last_flute, loop_starts[0])

    def test_the_last_one_out_closes_on_a_bar_line_with_the_tonic(self):
        c = self.conductor("8bit")
        self.run_for(c, 20)
        self.crowd["n"] = 0
        end = self.run_for(c, 15, start=20_000)
        self.assertEqual(c.clock, 0)
        close = [n for n in end if end[-1][0] - n[0] < 100]
        tonic, minor = c.flow.key
        self.assertEqual({n[1] % 12 for n in close}, {(tonic + d) % 12 for d in ((0, 3, 7) if minor else (0, 4, 7))})
        self.assertLess(end[-1][0] - self.START - 20_000, 2 * 4 * 60_000 / c.bpm + 1000)   # two bars on at most
        self.assertEqual(self.run_for(c, 5, start=40_000), [])

    def test_a_commit_brings_the_peak_and_next_starts_a_scene(self):
        c = self.conductor("lofi")
        self.run_for(c, 15)
        c.signal("ship", 1, self.START + 15_000)
        names = []

        def look(c, t):
            if c.flow.plan and (not names or names[-1] != c.flow.plan["name"]):
                names.append(c.flow.plan["name"])
        self.run_for(c, 30, start=15_000, each=look)
        self.assertIn("doruk", names[:3])
        scene = c.flow.count
        c.skip()
        self.run_for(c, 4 * 60 / c.bpm + .2, start=45_000)
        self.assertEqual(c.flow.count, scene + 1)                    # the next scene, from the next bar line
        c.set_style("8bit")
        self.run_for(c, 4 * 60 / c.bpm + .2, start=60_000)
        self.assertEqual(c.flow.count, scene + 2)
        self.assertGreaterEqual(c.bpm, STYLES["8bit"]["flow"]["tempo"][0])

    def test_less_melody_and_more(self):
        for melody, loops in (("az", {"tema", "değişim", "doruk"}), ("cok", {a["name"] for a in FLOW["arc"]})):
            c, sung = self.conductor("klasik", melody=melody), set()

            def look(c, t):
                if c.flow.plan and c.flow.plan["hook"] and c.flow.count == 1:
                    sung.add(c.flow.plan["name"])
            self.run_for(c, 100, each=look)
            self.assertEqual(sung, loops, melody)

    def test_lofi_swings_the_offbeat_eighths(self):
        c = self.conductor("lofi")
        steps, step = [], c.flow_step

        def record(t):
            steps.append((t + c.lead_ms, c.flow.step % 4, 60_000 / c.bpm))
            step(t)
        c.flow_step = record
        notes = self.run_for(c, 40)
        hats = [n[0] for n in notes if n[4] == DRUMS and n[1] == 42]
        late = {js_round(at) for at, pos, beat in steps if pos == 2}
        swung = {js_round(at + STYLES["lofi"]["swing"] / 6 * beat) for at, pos, beat in steps if pos == 2}
        self.assertTrue(swung & set(hats))
        self.assertFalse(late & set(hats))

    def test_a_hook_never_plays_two_loops_in_a_row(self):
        # More melody fills the intro and the break; a commit's peak may follow the change (B): never the same hook twice.
        for melody, ship in [("cok", None)] + [(m, loop) for m in ("az", "orta", "cok") for loop in range(7)]:
            c, hooks = self.conductor("klasik", melody=melody), []

            def look(c, t):
                if ship is not None and c.flow.loop == ship and c.flow.step == 40 and c.flow.count == 1:
                    c.signal("ship", 1, self.START + t)
                if c.flow.plan and c.flow.step == 1 and (not hooks or hooks[-1][0] != (c.flow.count, c.flow.loop)):
                    hooks.append(((c.flow.count, c.flow.loop), c.flow.plan["hook"]))
            self.run_for(c, 240, each=look)
            names = [h for _, h in hooks]
            for a, b in zip(names, names[1:]):
                self.assertFalse(a and a == b, (melody, ship, names))

    def test_a_sessions_own_layer_rests_only_in_the_intro_and_the_break(self):
        c, heard = self.conductor("klasik", sessions=2), {}           # the second session plays the flute's answers
        for i in range(100 * 40):
            c.steps += i % 40 == 0
            c.tick(self.START + i * 25, 25)
            if c.flow.count == 1:
                heard.setdefault(c.flow.plan["name"], set()).update(n[4] for n in c.out)
            c.out = []
        self.assertNotIn(4, heard["giriş"] | heard["mola"])
        self.assertIn(4, heard["tema"])                                # the arc leaves it out there, the session keeps it

    def test_a_commit_on_the_last_bar_brings_the_peak_at_once(self):
        c, names = self.conductor("synthwave"), []

        def look(c, t):
            if c.flow.count == 1 and c.flow.loop == 1 and c.flow.step == 52:   # bar 4 of the theme
                c.signal("ship", 1, self.START + t)
            if c.flow.plan and c.flow.step == 1 and (not names or names[-1][0] != c.flow.loop):
                names.append((c.flow.loop, c.flow.plan["name"]))
        self.run_for(c, 40, each=look)
        self.assertEqual(dict(names)[2], "doruk")

    def test_a_broken_test_leaves_an_open_fifth_under_the_loops(self):
        c = self.conductor("lofi")
        c.flow.key, c.chord, c.tension = (9, True), [9, [0, 3, 7]], True
        self.assertEqual([p - c.pad_chord(60)[0] for p in c.pad_chord(60)], [0, 7])   # no fourth to rub against the riffs' thirds

    def test_loop_details_that_rub_or_drift(self):
        # One 4-minute lo-fi and klasik run each: step accents, the walking bass, the pads and the arpeggio.
        for style in ("lofi", "klasik"):
            c, bars, accents = self.conductor(style, sessions=1), [], []
            bar, flush = c.flow_bar, c.flush_accents

            def record_bar(t, beat_ms):
                bar(t, beat_ms)
                plan = c.flow.plan
                tune = c.flow.hooks[plan["hook"]]["bars"][c.flow.step // 16] if plan["hook"] else []   # [sixteenth, pitch, length]
                bars.append((t + c.lead_ms, [p % 12 for p in c.pad_chord(60)], c.flow.bar, tune))

            def record_accents(now):
                before = len(c.out)
                flush(now)
                accents.extend(c.out[before:])
            c.flow_bar, c.flush_accents = record_bar, record_accents
            for i in range(240 * 40):
                if i % 30 == 0:
                    c.accent(("bash", "read", "think")[i // 30 % 3], 0)
                c.steps += i % 40 == 0
                c.tick(self.START + i * 25, 25)
                c.out = []
            starts = [b[0] for b in bars]
            for at, p, v, d, voice in accents:                         # the chord of the bar it lands in, never past its end
                k = max(i for i, t in enumerate(starts) if t <= at + 1)
                self.assertIn(p % 12, bars[k][1], (style, at, p))
                if k + 1 < len(starts):
                    self.assertLessEqual(at + d * 1000, starts[k + 1] + 2)
            for _, pad, notes, tune in bars:
                strikes = {}
                for s_, p, v, d, voice, ms, hook in notes:
                    if voice == 1:
                        strikes.setdefault(s_, []).append(p)
                for chord in strikes.values():                         # no minor second inside a pad voicing
                    chord.sort()
                    self.assertFalse(any(b - a == 1 for a, b in zip(chord, chord[1:])), (style, chord))
                for s_, p, v, d, voice, ms, hook in notes:
                    if voice == 7:                                     # the arpeggio never on the hook's note
                        self.assertFalse(any(at <= s_ < at + n and abs(p - h) <= 2 for at, h, n in tune), (style, s_, p))

    def test_one_commit_peak_a_scene_and_a_new_key_signature_every_scene(self):
        c, peaks = self.conductor("8bit"), {}

        def look(c, t):
            if c.flow.step == 20:
                c.signal("ship", 1, self.START + t)                    # a commit in every loop
            if c.flow.plan and c.flow.step == 1 and c.flow.plan["name"] == "doruk":
                peaks.setdefault(c.flow.count, set()).add(c.flow.loop)
        self.run_for(c, 300, each=look)
        self.assertTrue(peaks)
        self.assertTrue(all(len(loops) <= 2 for loops in peaks.values()), peaks)   # its own peak and one commit
        signature = lambda key: (key[0] + (3 if key[1] else 0)) % 12
        last = c.flow.key
        for _ in range(200):
            c.new_scene(self.START)
            self.assertNotEqual(signature(c.flow.key), signature(last))
            last = c.flow.key

    def test_an_ending_stays_in_its_scene_and_a_stall_keeps_it(self):
        c = self.conductor("klasik")
        self.run_for(c, 5)
        scene, key = c.flow.count, c.flow.key
        c.tick(self.START + 5_000 + 800, 800)                         # a stall of 0.8 s
        self.assertEqual(c.flow.count, scene)
        c.flow.loop, c.flow.step = 7, 63                              # the last sixteenth of the scene
        self.crowd["n"] = 0
        end = self.run_for(c, 15, start=6_000)
        self.assertEqual((c.flow.count, c.clock), (scene, 0))
        close = [n for n in end if end[-1][0] - n[0] < 100]
        tonic, minor = key
        self.assertEqual({n[1] % 12 for n in close}, {(tonic + d) % 12 for d in ((0, 3, 7) if minor else (0, 4, 7))})

    def test_loops_switched_on_while_a_song_ends(self):
        c = Conductor(lambda now, dt: {"working": self.crowd["n"], "total": 1, "active": [self.crowd["n"]] + [0] * 8, "listening": 0}, lead_ms=150)
        self.crowd = {"n": 1}
        for i in range(200):
            c.tick(self.START + i * 25, 25)
        self.crowd["n"] = 0                                           # the last one leaves: the song plays to its close
        c.tick(self.START + 200 * 25, 25)
        c.set_flow(True)                                               # and loops are picked from the menu right then
        for i in range(201, 1200):
            c.tick(self.START + i * 25, 25)
        self.assertEqual(c.clock, 0)
        self.assertTrue(c.flow.prog)

    def test_the_climax_strikes_where_the_key_moves_up(self):
        c, loops = self.conductor("sinema"), []
        loop = c.flow_loop

        def record():
            loop()
            loops.append(c.clock + c.lead_ms)
        c.flow_loop = record
        self.run_for(c, 12)
        c.target_shift = 2
        c.cue("climax")
        notes = self.run_for(c, 20, start=12_000)
        cymbal = [n for n in notes if n[4] == DRUMS and n[1] == 49]   # the climax crash (the loops of this style crash on 57)
        self.assertTrue(cymbal)
        self.assertTrue(any(abs(cymbal[0][0] - at) <= 1 for at in loops), (cymbal[0][0], loops[-3:]))

    def test_without_a_cellist_the_piano_keeps_the_bass_low(self):
        c = self.conductor("klasik")
        self.crowd["n"] = 0
        c.population = lambda now, dt: {"working": 0, "total": 0, "active": [0] * 9, "listening": 1, "featured": []}
        notes = self.run_for(c, 40)
        self.assertTrue(notes)
        self.assertLess(min(n[1] for n in notes), 52)                # the house pianist's left hand below the chords

    def test_lofi_sevenths_come_from_the_key(self):
        c = self.conductor("lofi")
        c.flow.key = (9, True)                                       # A minor
        for root, intervals, seventh in ((7, [0, 4, 7], 10), (5, [0, 4, 7], 11), (0, [0, 4, 7], 11), (4, [0, 4, 7], 10), (9, [0, 3, 7], 10)):
            c.chord = [root, intervals]
            tones = c.pad_chord(60)
            self.assertEqual(tones[-1] - tones[0], seventh, (root, tones))   # G7 (not Gmaj7), Fmaj7, Cmaj7, E7, Am7

    def test_songs_and_flow_switch_while_playing(self):
        c = Conductor(lambda now, dt: {"working": 1, "total": 1, "active": [1, 1, 0, 1, 0, 0, 0, 1, 0], "listening": 0})
        for i in range(400):
            c.tick(self.START + i * 25, 25)
        c.set_flow(True)
        for i in range(400, 1200):
            c.tick(self.START + i * 25, 25)
        self.assertEqual(c.flow.count, 1)
        self.assertTrue(c.flow.prog)
        c.set_flow(False)
        self.assertIsNone(c.flow)
        for i in range(1200, 1600):
            c.tick(self.START + i * 25, 25)
        self.assertGreater(c.position, 0)


if __name__ == "__main__":
    unittest.main()
