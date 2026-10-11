import json
from pathlib import Path
import tempfile
import unittest

from agents import AgentMusic, AgentWatcher, classify


def claude(*blocks, stop=None):
    return {"type": "assistant", "message": {"content": list(blocks), "stop_reason": stop}}


class ClassifyTests(unittest.TestCase):
    def test_claude_steps(self):
        entry = claude({"type": "thinking"}, {"type": "tool_use", "name": "Edit"},
                       {"type": "tool_use", "name": "Bash"}, {"type": "tool_use", "name": "Grep"},
                       {"type": "tool_use", "name": "mcp__wise__create_task"})
        self.assertEqual(classify(entry), ["think", "edit", "bash", "read", "tool"])
        self.assertEqual(classify(claude({"type": "text"}, stop="end_turn")), ["text", "done"])

    def test_signals_from_results_and_commands(self):
        def result(text, error=False):
            return {"type": "user", "message": {"content": [{"type": "tool_result", "is_error": error, "content": text}]}}
        self.assertEqual(classify(result("===== 34 passed in 0.3s =====")), ["busy", "pass"])
        self.assertEqual(classify(result("2 failed, 32 passed")), ["busy", "testfail"])
        self.assertEqual(classify(result([{"type": "text", "text": "command not found"}], True)), ["busy", "fail"])
        self.assertEqual(classify(result("ok")), ["busy"])
        commit = claude({"type": "tool_use", "name": "Bash", "input": {"command": "git add -A && git commit -m x"}})
        self.assertEqual(classify(commit), ["bash", "ship"])
        self.assertEqual(classify(claude({"type": "tool_use", "name": "Bash", "input": {"command": "git status"}})), ["bash"])

    def test_codex_steps(self):
        self.assertEqual(classify({"type": "response_item", "payload": {"type": "custom_tool_call", "name": "exec"}}), ["bash"])
        self.assertEqual(classify({"type": "response_item", "payload": {"type": "function_call", "name": "apply_patch"}}), ["edit"])
        self.assertEqual(classify({"type": "response_item", "payload": {"type": "reasoning"}}), ["think"])
        self.assertEqual(classify({"type": "event_msg", "payload": {"type": "task_complete"}}), ["done"])

    def test_noise_is_ignored(self):
        self.assertEqual(classify({"type": "user"}), ["busy"])  # prompt / tool result: working
        self.assertEqual(classify({"type": "event_msg", "payload": {"type": "user_message"}}), ["busy"])
        for entry in ({"type": "attachment"}, {"type": "system"}, [], "x",
                      {"type": "event_msg", "payload": {"type": "token_count"}}):
            self.assertEqual(classify(entry), [])


class WatcherTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / "proj").mkdir()
        self.log = self.root / "proj/s1.jsonl"
        self.log.write_text(json.dumps(claude({"type": "tool_use", "name": "Edit"})) + "\n")

    def append(self, path, *entries, newline=True):
        with path.open("a") as stream:
            stream.write("\n".join(json.dumps(e) for e in entries) + ("\n" if newline else ""))

    def test_history_is_silent_new_lines_play(self):
        watcher = AgentWatcher([self.root], rescan=0)
        self.assertEqual(watcher.poll(0), [])
        self.append(self.log, claude({"type": "tool_use", "name": "Bash"}))
        self.assertEqual([k for _, k in watcher.poll(1)], ["bash"])
        self.assertEqual(watcher.poll(2), [])

    def test_partial_line_waits_for_newline(self):
        watcher = AgentWatcher([self.root], rescan=0)
        raw = json.dumps(claude({"type": "tool_use", "name": "Read"}))
        with self.log.open("a") as stream:
            stream.write(raw[:20])
        self.assertEqual(watcher.poll(1), [])
        with self.log.open("a") as stream:
            stream.write(raw[20:] + "\n")
        self.assertEqual([k for _, k in watcher.poll(2)], ["read"])

    def test_new_session_and_separate_sessions(self):
        watcher = AgentWatcher([self.root], rescan=0)
        other = self.root / "proj/s2.jsonl"
        self.append(other, claude({"type": "thinking"}))
        self.append(self.log, claude({"type": "text"}, stop="end_turn"))
        events = watcher.poll(1)
        self.assertEqual(sorted(k for _, k in events), ["done", "text", "think"])
        self.assertEqual(len({p for p, _ in events}), 2)

    def test_old_session_waking_up_does_not_replay_history(self):
        import os
        old = self.root / "proj/old.jsonl"
        self.append(old, *[claude({"type": "tool_use", "name": "Bash"})] * 50)
        os.utime(old, (0, 0))  # stale at start: not tracked yet
        watcher = AgentWatcher([self.root], rescan=0)
        self.assertNotIn(str(old), watcher.offsets)
        self.append(old, claude({"type": "tool_use", "name": "Edit"}))
        watcher.poll(1)  # discovered now, positioned at the end
        self.append(old, claude({"type": "tool_use", "name": "Read"}))
        self.assertEqual([k for _, k in watcher.poll(2)], ["read"])

    def test_missing_root_and_truncation(self):
        watcher = AgentWatcher([self.root / "yok", self.root], rescan=0)
        self.log.write_text("")
        self.assertEqual(watcher.poll(1), [])
        self.append(self.log, claude({"type": "tool_use", "name": "Write"}))
        self.assertEqual([k for _, k in watcher.poll(2)], ["edit"])


class MusicTests(unittest.TestCase):
    def play(self, music, start, seconds):
        notes, self.times = [], []
        for i in range(int(seconds / .025)):
            now = start + i * .025
            out = music.tick(now)
            if out:
                self.times.append(now)
            notes.extend(out)
        return notes

    def test_silent_until_steps_then_fades(self):
        music = AgentMusic(seed=1)
        self.assertEqual(self.play(music, 0, 2), [])
        music.accept([("a", "edit")], 3)
        self.assertGreater(len(self.play(music, 3, 4)), 4)
        music.accept([("a", "done")], 7)
        self.play(music, 7, 2)
        self.assertEqual(self.play(music, 30, 3), [])

    def test_long_think_keeps_flowing_until_done(self):
        music = AgentMusic(seed=1)
        music.accept([("a", "busy")], 0)  # prompt sent, model thinking for a minute
        notes = self.play(music, 0, 60)
        self.assertGreater(len(notes), 30)
        gaps = [b - a for a, b in zip(self.times, self.times[1:])]
        self.assertLess(max(gaps), 4)  # no long silences mid-turn
        music.accept([("a", "done")], 60)
        self.play(music, 60, 4)
        self.assertEqual(self.play(music, 70, 3), [])

    def test_accents_fit_the_chord(self):
        music = AgentMusic(seed=1)
        music.accept([("a", "edit")], 0)
        self.play(music, 0, 1)
        chord = {p % 12 for p in music.chord(60)}
        music.accept([("a", "bash"), ("a", "read"), ("a", "think")], 1)
        self.assertTrue(all(p % 12 in chord for p, *_ in music.accents))

    def test_playlist_repeats_then_moves_on_calmly(self):
        from melodies import BELLA_CIAO
        music = AgentMusic(song="karisik", seed=1, position=(0, len(BELLA_CIAO) - 1))
        music.accept([("a", "busy")], 0)
        self.play(music, 0, 6)
        self.assertEqual(music.composer.song, "bella-ciao")  # too early: the song repeats
        music.composer.played = 500
        music.composer.position = len(BELLA_CIAO) - 1
        self.play(music, 6, 6)
        self.assertEqual(music.composer.song, "fur-elise")

    def test_no_song_change_while_excited(self):
        from melodies import BELLA_CIAO
        music = AgentMusic(song="karisik", seed=1)
        for i in range(1200):  # 30 s of hard work from 8 sessions
            now = i * .025
            if i % 4 == 0:
                music.accept([(f"s{i % 8}", "edit")], now)
            if i == 600:
                music.composer.played = 500
            music.tick(now)
        self.assertEqual(music.composer.song, "bella-ciao")

    def test_more_sessions_thicker(self):
        one, many = AgentMusic(seed=1), AgentMusic(seed=1)
        one.accept([("a", "edit")], 0)
        many.accept([(s, "edit") for s in "abcd"], 0)
        self.assertGreater(len(self.play(many, 0, 3)), len(self.play(one, 0, 3)))

    def test_burst_accents_are_bounded(self):
        music = AgentMusic(seed=1)
        music.accept([("s%d" % i, "bash") for i in range(200)], 0)
        self.assertLessEqual(len(music.accents), 8)  # one per voice at most
        self.assertLessEqual(music.until, 10)

    def test_choir_slots_piano_first_and_reuse(self):
        music = AgentMusic(seed=1)
        music.accept([("terminal1", "edit")], 0)
        music.accept([("terminal2", "bash"), ("subagent", "read")], 1)
        self.assertEqual(music.voices(), ["piyano", "yaylılar", "koro"])
        music.accept([("terminal2", "done")], 2)
        music.accept([("terminal1", "edit"), ("subagent", "edit")], 15)
        music.active(30)  # terminal2 finished and idle > 20 s: its strings seat frees up
        music.accept([("new", "think")], 30)
        self.assertEqual(music.slots["new"], 1)

    def test_each_voice_plays_its_own_instrument(self):
        music = AgentMusic(seed=1)
        music.accept([(f"s{i}", "edit") for i in range(8)], 0)
        voices = {n[3] for n in self.play(music, 0, 4) if len(n) > 3}
        self.assertTrue(set(range(8)) <= voices)

    def test_signal_motifs(self):
        from agents import CRASH, DRUMS, TIMPANI, TREMOLO
        music = AgentMusic(seed=1)
        music.accept([("a", "ship")], 0)
        notes = music.tick(0)
        self.assertIn((CRASH, DRUMS), {(n[0], n[3]) for n in notes})
        music.accept([("a", "testfail")], 5)
        self.assertTrue({TREMOLO, TIMPANI} <= {n[3] for n in music.tick(5)})
        music.accept([("a", "fail")], 5.5)  # throttled per kind, not across kinds
        self.assertTrue(music.tick(5.5))
        music.signal("wait", 9)
        self.assertTrue({5, 7} <= {n[3] for n in music.tick(9)})  # bell: vibraphone + harp
        music.signal("wait", 9.5)
        self.assertFalse(music.accents)  # no repeated bell within 2 s

    def test_calm_work_has_no_drums(self):
        from agents import DRUMS
        music = AgentMusic(seed=1)
        music.accept([("a", "busy")], 0)  # thinking, no steps: slow tempo
        notes = self.play(music, 0, 20)
        self.assertFalse([n for n in notes if n[3] == DRUMS])
        self.assertEqual(music.shift, 0)

    def test_fast_work_builds_drums_and_key_change_then_calms(self):
        from agents import DRUMS, KICK, SNARE, CRASH
        music = AgentMusic(seed=1)
        notes = []
        for i in range(400):  # 8 sessions stepping hard for 10 s
            now = i * .025
            if i % 4 == 0:
                music.accept([(f"s{i % 8}", "edit")], now)
            notes.extend(music.tick(now))
        drums = {n[0] for n in notes if n[3] == DRUMS}
        self.assertTrue({KICK, SNARE, CRASH} <= drums)
        self.assertEqual(music.shift, 2)  # climax: whole tone up
        self.assertGreater(max(n[1] for n in notes), 90)
        for i in range(8):
            music.accept([(f"s{i}", "done")], 10)
        self.play(music, 10, 30)
        self.assertEqual(music.shift, 0)
        self.assertLess(music.intensity, .1)

    def test_joining_session_continues_theme(self):
        from melodies import BELLA_CIAO
        music = AgentMusic(seed=1)
        music.accept([("a", "edit")], 0)
        self.play(music, 0, 2)
        before = music.composer.position
        self.assertGreater(before, 0)
        music.accept([("b", "edit")], 2)
        first = [n for n in music.tick(music.composer.next_note + .001) if n[3] == 0][0][0]
        self.assertEqual(first, BELLA_CIAO[before][0])  # no restart

    def test_position_survives_restart(self):
        import tempfile as tf
        from agents import load_position, save_position
        with tf.TemporaryDirectory() as d:
            state = Path(d) / "pos.json"
            self.assertEqual(load_position("bella-ciao", state), (0, 0))
            save_position("bella-ciao", 17, state)  # old format: a bare number still loads
            self.assertEqual(AgentMusic(position=load_position("bella-ciao", state)).composer.position, 17)
            save_position("karisik", [2, 5], state)
            music = AgentMusic(song="karisik", position=load_position("karisik", state))
            self.assertEqual((music.composer.song, music.composer.position), ("greensleeves", 5))


class ReporterTests(unittest.TestCase):
    def test_pair_fragment_is_only_in_body_and_bad_urls_are_rejected(self):
        from agents import GlobalReporter
        secret = 'a' * 48
        self.assertEqual(GlobalReporter.connection('http://localhost:4480/#pair=' + secret),
                         ('http://localhost:4480/api/play', secret))
        self.assertEqual(GlobalReporter.connection('https://example.test/base?ignored=x'),
                         ('https://example.test/base/api/play', None))
        for url in ('file:///private', 'https://user:password@example.test', 'http://', 'http://localhost/#pair=bad'):
            with self.assertRaises(ValueError):
                GlobalReporter.connection(url)

    def test_event_key_is_read_from_the_fragment_and_bad_keys_are_rejected(self):
        from agents import GlobalReporter
        key = 'event-test-key-0123456789'
        self.assertEqual(GlobalReporter.event('https://orchestra.example/#pair=' + 'a' * 48 + '&event=' + key), key)
        self.assertIsNone(GlobalReporter.event('https://orchestra.example/'))
        for url in ('https://orchestra.example/#event=short', 'https://orchestra.example/#event=bad key with spaces!!'):
            with self.assertRaises(ValueError):
                GlobalReporter.event(url)

    def test_report_payload_contains_counts_without_paths_or_content(self):
        from agents import GlobalReporter
        from unittest.mock import patch, MagicMock
        import agents
        import threading
        with tempfile.TemporaryDirectory() as directory, patch.object(agents, 'CACHE', Path(directory)), \
                patch.object(threading.Thread, 'start'):
            music = MagicMock()
            music.is_working.return_value = True
            music.sessions = {Path('/private/secret/.codex/session.jsonl'): 1}
            reporter = GlobalReporter('http://localhost:4480/#pair=' + 'a' * 48, music)
            reporter.add([(Path('/private/project/secret'), k) for k in ('edit', 'read', 'tool', 'text', 'done', 'ship')])
            self.assertEqual(reporter.steps, 5)
            self.assertEqual(reporter.activity, {'edit': 1, 'bash': 0, 'read': 1, 'think': 2, 'done': 1})
            reporter.stop = MagicMock()
            reporter.stop.wait.side_effect = [False, True]
            response = MagicMock()
            response.__enter__.return_value.read.return_value = b'{"section":"piano","seat":0,"players":1}'
            with patch.object(reporter.request, 'urlopen', return_value=response) as request:
                reporter.loop()
            payload = json.loads(request.call_args.args[0].data)
            self.assertEqual(set(payload), {'id', 'steps', 'signals', 'working', 'sessions', 'tools', 'activity', 'pair'})
            self.assertNotIn('/private', json.dumps(payload))
            self.assertEqual(payload['tools'], {'codex': 1})
            self.assertEqual(payload['signals'], ['ship'])

    def test_expired_pair_is_dropped_and_machine_keeps_playing(self):
        from agents import GlobalReporter
        from unittest.mock import patch, MagicMock
        import agents
        import threading
        with tempfile.TemporaryDirectory() as directory, patch.object(agents, 'CACHE', Path(directory)), \
                patch.object(threading.Thread, 'start'):
            music = MagicMock()
            music.is_working.return_value = True
            music.sessions = {}
            reporter = GlobalReporter('http://localhost:4480/#pair=' + 'a' * 48, music)
            reporter.stop = MagicMock()
            reporter.stop.wait.side_effect = [False, False, True]
            response = MagicMock()
            response.__enter__.return_value.read.return_value = b'{"section":"piano","seat":0,"players":1,"pair":"expired"}'
            with patch.object(reporter.request, 'urlopen', return_value=response) as request, \
                    patch('builtins.print') as printed:
                reporter.loop()
            first, second = (json.loads(call.args[0].data) for call in request.call_args_list)
            self.assertEqual(first['pair'], 'a' * 48)
            self.assertIsNone(second['pair'])
            self.assertIsNone(reporter.pair)
            self.assertIsNotNone(reporter.seat)
            self.assertTrue(any('anonim' in str(call.args[0]) for call in printed.call_args_list))


if __name__ == "__main__":
    unittest.main()
