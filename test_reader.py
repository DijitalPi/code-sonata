import json
import os
from pathlib import Path
import pty
import select
import signal
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import MagicMock, patch

import reader
from reader import AgentWatcher, Classifier, GlobalReporter, classify, codex_result


def claude(*blocks, stop=None):
    return {"type": "assistant", "message": {"content": list(blocks), "stop_reason": stop}}


def tool(name, call_id, command=None):
    block = {"type": "tool_use", "name": name, "id": call_id}
    if command is not None:
        block["input"] = {"command": command}
    return claude(block)


def result(call_id, text, error=False):
    return {"type": "user", "message": {"content": [{"type": "tool_result", "tool_use_id": call_id, "is_error": error, "content": text}]}}


# Gemini CLI writes one JSON object per line to ~/.gemini/tmp/<project>/chats/session-*.jsonl: the prompt as
# a "user" line, each model reply as a "gemini" line with its thoughts and tool calls (already carrying their
# status and result), tool results again as "user" functionResponse parts, and "$set" patches. Shapes as seen
# in 18,000 session files on the maintainer's Mac; the text here is made up.
def gemini(*calls, thoughts=True, text="ok"):
    entry = {"id": "m", "timestamp": "2026-10-31T00:00:00Z", "type": "gemini", "content": text, "model": "gemini-2.5-pro",
             "thoughts": [{"subject": "s", "description": "d", "timestamp": "t"}] if thoughts else [], "tokens": {"total": 1}}
    if calls:
        entry["toolCalls"] = [dict(call) for call in calls]
    return entry


def gcall(name, call_id, command=None, status="success", output=""):
    args = {"command": command} if command is not None else {"file_path": "x"}
    return {"id": call_id, "name": name, "args": args, "status": status, "timestamp": "t", "displayName": name,
            "description": "", "renderOutputAsMarkdown": True, "resultDisplay": output,
            "result": [{"functionResponse": {"id": call_id, "name": name, "response": {"error" if status == "error" else "output": output}}}]}


# Grok Build appends ACP session updates to ~/.grok/sessions/<cwd>/<session>/updates.jsonl, one envelope a line:
# chunks of the prompt, thoughts and reply (consecutive chunks are merged before writing), tool calls (the first
# line names the tool only in Grok's own _meta; an update without a status adds the ACP kind), their results (a
# command's exit code is in rawOutput; the status stays "completed" when it is not 0) and an xAI "turn_completed"
# when the turn ends. Shapes as written by Grok Build 1.0.70 on the maintainer's Mac; the text is made up.
def grok(update, method="session/update"):
    return {"timestamp": 1793577600, "method": method, "params": {"sessionId": "s", "update": update}}


def gtool(call_id, kind, command=None):
    update = {"sessionUpdate": "tool_call", "toolCallId": call_id, "title": "t",
              "_meta": {"x.ai/tool": {"version": 1, "name": "t", "kind": kind, "namespace": "grok_build"}}}
    if command is not None:
        update["rawInput"] = {"command": command, "description": "d"}
    return grok(update)


def gdone(call_id, output="", exit_code=None, status="completed"):
    update = {"sessionUpdate": "tool_call_update", "toolCallId": call_id, "status": status,
              "content": [{"type": "content", "content": {"type": "text", "text": output}}]}
    if exit_code is not None:
        update["rawOutput"] = {"type": "Bash", "output_for_prompt": output, "exit_code": exit_code, "command": "c",
                               "truncated": False, "signal": None, "timed_out": False}
    return grok(update)


class ClassifyTests(unittest.TestCase):
    def test_claude_steps(self):
        entry = claude({"type": "thinking"}, {"type": "tool_use", "name": "Edit"},
                       {"type": "tool_use", "name": "Bash"}, {"type": "tool_use", "name": "Grep"},
                       {"type": "tool_use", "name": "mcp__wise__create_task"})
        self.assertEqual(classify(entry), ["think", "edit", "bash", "read", "tool"])
        self.assertEqual(classify(claude({"type": "text"}, stop="end_turn")), ["text", "done"])

    def test_test_results_count_only_for_commands(self):
        session = Classifier()
        self.assertEqual(session(tool("Bash", "b1", "pytest")), ["bash"])
        self.assertEqual(session(result("b1", "===== 34 passed in 0.3s =====")), ["busy", "pass"])
        session(tool("Bash", "b2", "npm test"))
        self.assertEqual(session(result("b2", "Tests: 2 failed, 32 passed")), ["busy", "testfail"])
        session(tool("Read", "r1"))
        self.assertEqual(session(result("r1", "FAILED (failures=3)\n2 failed, 1 passed")), ["busy"])  # a log that was read
        for command, text in (("cargo test", "test result: ok. 10 passed; 0 failed"),
                              ("python3 -m unittest", "Ran 40 tests in 0.08s\n\nOK"), ("node --test", "ℹ pass 12\nℹ fail 0")):
            session(tool("Bash", "b3", command))
            self.assertEqual(session(result("b3", text)), ["busy", "pass"], text)
        for i, command in enumerate(("cat previous-test.log", "cat pytest.log", "tail -n 50 /tmp/unittest.log", "grep FAILED jest-output.txt",
                                     'echo "previous run (pytest): 3 failed"', "echo 'a; pytest'", 'git commit -m "fix (pytest)"',
                                     'echo ";" pytest "3 failed"', "printf '%s' '&&' pytest",
                                     "cat <<EOF > notes.md\npytest: 3 failed\nEOF", "python3 - <<'PY'\nimport pytest\nPY")):
            session(tool("Bash", f"c{i}", command))   # reading an old log runs no tests
            self.assertEqual(session(result(f"c{i}", "FAILED\n3 failed, 34 passed")), ["busy"], command)
        for i, command in enumerate(("cd app && npm test", "CI=1 npx vitest run", "uv run pytest -q", "python3.12 -m pytest", "npm run test:unit",
                                     "(cd api; pytest -x) | tail -20", "make build\npytest -q > out.log", 'CI="1" pytest',
                                     "cat <<EOF > notes.md\nold\nEOF\npytest -q")):
            session(tool("Bash", f"t{i}", command))
            self.assertEqual(session(result(f"t{i}", "3 failed, 34 passed")), ["busy", "testfail"], command)
        session(tool("Bash", "b4", "node --test"))
        self.assertEqual(session(result("b4", "ℹ pass 8\nℹ fail 3")), ["busy", "testfail"])
        session(tool("Bash", "b5", "ls /missing"))
        self.assertEqual(session(result("b5", "No such file", True)), ["busy", "fail"])
        self.assertEqual(session(result("unknown", "2 failed", True)), ["busy"])   # its call came before the reader started

    def test_commit_counts_only_when_git_reports_it(self):
        session = Classifier()
        self.assertEqual(session(tool("Bash", "c1", "git add -A && git commit -m x")), ["bash"])
        self.assertEqual(session(result("c1", "[main 1a2b3c4] x\n 1 file changed")), ["busy", "ship"])
        session(tool("Bash", "c2", "git commit -m x"))
        self.assertEqual(session(result("c2", "nothing to commit, working tree clean", True)), ["busy", "fail"])
        session(tool("Bash", "c3", "git commit -m x"))
        self.assertEqual(session(result("c3", "pre-commit hook failed", True)), ["busy", "fail"])
        session(tool("Bash", "p1", "git push"))
        self.assertEqual(session(result("p1", "To github.com:a/b.git\n   1a2b3c4..5d6e7f8  main -> main")), ["busy", "ship"])
        session(tool("Bash", "s1", "git status"))
        self.assertEqual(session(result("s1", "[main 1a2b3c4] old line in a log")), ["busy"])

    def test_codex_steps_and_results(self):
        self.assertEqual(classify({"type": "response_item", "payload": {"type": "custom_tool_call", "name": "exec"}}), ["bash"])
        self.assertEqual(classify({"type": "response_item", "payload": {"type": "function_call", "name": "apply_patch"}}), ["edit"])
        self.assertEqual(classify({"type": "response_item", "payload": {"type": "reasoning"}}), ["think"])
        self.assertEqual(classify({"type": "event_msg", "payload": {"type": "task_complete"}}), ["done"])
        self.assertEqual(classify({"type": "event_msg", "payload": {"type": "turn_aborted"}}), ["done"])
        session = Classifier()
        call = {"type": "response_item", "payload": {"type": "custom_tool_call", "name": "exec", "call_id": "x1",
                                                     "input": 'tools.exec_command({cmd: "git commit -m fix"})'}}
        self.assertEqual(session(call), ["bash"])
        report = json.dumps({"i": 0, "result": {"status": "fulfilled", "value": {"exit_code": 0, "output": "[main 9f8e7d6] fix\n 2 files changed"}}})
        output = {"type": "response_item", "payload": {"type": "custom_tool_call_output", "call_id": "x1",
                                                       "output": [{"type": "input_text", "text": "Script completed\nOutput:\n"}, {"type": "input_text", "text": report}]}}
        self.assertEqual(session(output), ["busy", "ship"])
        session({"type": "response_item", "payload": {"type": "function_call", "name": "exec_command", "call_id": "x2", "arguments": '{"cmd":"pytest"}'}})
        failed = {"type": "response_item", "payload": {"type": "function_call_output", "call_id": "x2", "output": "Exit code: 1\nOutput:\n3 failed, 9 passed"}}
        self.assertEqual(session(failed), ["busy", "testfail"])
        for i, source in enumerate(('tools.exec_command({cmd: "cat pytest.log"})', 'tools.exec_command({"cmd":"python3 -m unittest -q"})')):
            session({"type": "response_item", "payload": {"type": "custom_tool_call", "name": "exec", "call_id": f"y{i}", "input": source}})
            out = {"type": "response_item", "payload": {"type": "custom_tool_call_output", "call_id": f"y{i}", "output": "FAILED (failures=2)"}}
            self.assertEqual(session(out), ["busy"] + (["testfail"] if i else []), source)
        self.assertEqual(codex_result("Exit code: 2\nOutput:\nboom"), ("Exit code: 2\nOutput:\nboom", True))

    def test_interrupt_ends_the_turn_and_noise_is_ignored(self):
        stopped = {"type": "user", "message": {"content": [{"type": "text", "text": "[Request interrupted by user]"}]}}
        self.assertEqual(classify(stopped), ["done"])
        self.assertEqual(classify({"type": "user"}), ["busy"])
        self.assertEqual(classify({"type": "event_msg", "payload": {"type": "user_message"}}), ["busy"])
        for entry in ({"type": "attachment"}, {"type": "system"}, [], "x", {"type": "event_msg", "payload": {"type": "token_count"}}):
            self.assertEqual(classify(entry), [])


    def test_gemini_steps_results_and_end_of_turn(self):
        state = Classifier()
        self.assertEqual(classify({"kind": "main", "sessionId": "x", "projectHash": "h", "startTime": "t", "lastUpdated": "t"}, state), [])
        self.assertEqual(classify({"id": "u", "timestamp": "t", "type": "user", "content": [{"text": "fix it"}]}, state), ["busy"])
        self.assertEqual(classify(gemini(gcall("read_file", "r1"), gcall("replace", "e1"), gcall("update_topic", "t1")), state),
                         ["think", "text", "read", "edit", "tool"])
        self.assertEqual(classify(gemini(gcall("run_shell_command", "b1", "npm test", output="2 failed, 3 passed")), state),
                         ["think", "text", "bash", "testfail"])
        self.assertEqual(classify(gemini(gcall("run_shell_command", "b2", "git commit -m x", output="[main 1a2b3c4] x")), state),
                         ["think", "text", "bash", "ship"])
        self.assertEqual(classify(gemini(gcall("write_file", "w1", status="error", output="denied")), state), ["think", "text", "edit", "fail"])
        # The same results come back as functionResponse parts: the model is busy, nothing is counted twice.
        response = {"id": "u2", "timestamp": "t", "type": "user", "content": [{"functionResponse": {"id": "b1", "name": "run_shell_command", "response": {"output": "2 failed"}}}]}
        self.assertEqual(classify(response, state), ["busy"])
        self.assertEqual(classify(gemini(thoughts=False, text="All done."), state), ["text", "done"])
        self.assertEqual(classify({"$set": {"lastUpdated": "t"}}, state), [])

    def test_grok_steps_results_and_end_of_turn(self):
        state = Classifier()

        def chunk(kind):
            return grok({"sessionUpdate": kind, "content": {"type": "text", "text": "x"}})

        self.assertEqual(classify(chunk("user_message_chunk"), state), ["busy"])
        # A thought or a reply that arrives in several chunks is one step.
        self.assertEqual([classify(chunk(kind), state) for kind in ("agent_thought_chunk", "agent_thought_chunk",
                                                                     "agent_message_chunk", "agent_message_chunk")],
                         [["think"], [], ["text"], []])
        self.assertEqual([classify(gtool(i, kind), state) for i, kind in (("r1", "read"), ("l1", "list"), ("e1", "edit"), ("m1", "memory_get"))],
                         [["read"], ["read"], ["edit"], ["tool"]])
        self.assertEqual(classify(gtool("r1", "read"), state), [])   # the same call sent again is not a new step
        named = grok({"sessionUpdate": "tool_call_update", "toolCallId": "r1", "kind": "read", "title": "Read `x`"})
        self.assertEqual(classify(named, state), [])
        acp = grok({"sessionUpdate": "tool_call", "toolCallId": "a1", "kind": "search", "status": "pending"})
        self.assertEqual(classify(acp, state), ["read"])   # an ACP kind alone is enough
        self.assertEqual(classify(gtool("b1", "execute", "npm test"), state), ["bash"])
        progress = grok({"sessionUpdate": "tool_call_update", "toolCallId": "b1", "status": "in_progress", "rawOutput": {"exit_code": 0}})
        self.assertEqual(classify(progress, state), [])
        self.assertEqual(classify(gdone("b1", "2 failed, 3 passed", exit_code=1), state), ["testfail"])
        self.assertEqual(classify(gtool("b2", "execute", "git commit -m x"), state), ["bash"])
        self.assertEqual(classify(gdone("b2", "[main 1a2b3c4] x", exit_code=0), state), ["ship"])
        self.assertEqual(classify(gtool("b3", "execute", "ls yok"), state), ["bash"])
        self.assertEqual(classify(gdone("b3", "No such file", exit_code=2), state), ["fail"])   # "completed", exit code 2
        self.assertEqual(classify(gtool("b4", "execute", "pytest"), state), ["bash"])
        passed = gdone("b4", "===== 3 passed in 0.1s =====", exit_code=0)
        del passed["params"]["update"]["rawOutput"]["output_for_prompt"]   # the text is also in content
        self.assertEqual(classify(passed, state), ["pass"])
        self.assertEqual(classify(gdone("e1", "No match found", status="failed"), state), ["fail"])
        self.assertEqual(classify(gdone("r1", "1 FAILED"), state), [])   # a file that was read is not a test result
        self.assertEqual(classify(chunk("agent_message_chunk"), state), ["text"])   # a new reply after the tools
        end = grok({"sessionUpdate": "turn_completed", "prompt_id": "p", "stop_reason": "end_turn"}, "_x.ai/session/update")
        self.assertEqual(classify(end, state), ["done"])
        for noise in (grok({"sessionUpdate": "available_commands_update", "availableCommands": []}),
                      grok({"sessionUpdate": "auto_compact_started", "tokens_used": 1}, "_x.ai/session/update"),
                      grok({"sessionUpdate": "tool_call_update", "toolCallId": "b9", "status": "completed", "rawOutput": [1]}),
                      {"method": "session/update", "params": "x"}, {"method": "session/update", "params": {"update": []}}):
            self.assertEqual(classify(noise, state), [])
        odd = grok({"sessionUpdate": "tool_call", "toolCallId": ["x"], "kind": 3, "rawInput": "ls"})
        self.assertEqual(classify(odd, state), ["tool"])

    def test_odd_shapes_inside_a_line_are_ignored_not_raised(self):
        state = Classifier()
        odd = gemini({"id": "x", "name": "read_file", "result": [{"functionResponse": "unexpected"}]},
                     {"id": "y", "name": "run_shell_command", "result": [{"functionResponse": {"response": "no"}}]},
                     {"id": ["list"], "name": "glob", "args": ["x"], "result": "text"})
        self.assertEqual(classify(odd, state), ["think", "text", "read", "bash", "read"])
        self.assertEqual(classify(tool("Bash", {"a": 1}, "pytest"), state), ["bash"])
        self.assertEqual(classify(result(["b1"], "1 failed"), state), ["busy"])
        self.assertEqual(classify({"type": "response_item", "payload": {"type": "function_call_output", "call_id": {}, "output": "x"}}, state), ["busy"])


class WatcherTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / "proj").mkdir()
        self.log = self.root / "proj/s1.jsonl"
        self.log.write_text(json.dumps(claude({"type": "tool_use", "name": "Edit"})) + "\n")

    def append(self, path, *entries):
        with path.open("a") as stream:
            stream.write("".join(json.dumps(e) + "\n" for e in entries))

    def kinds(self, events):
        return [k for _, k in events]

    def test_history_is_silent_new_lines_play(self):
        watcher = AgentWatcher([self.root], rescan=0)
        self.assertEqual(watcher.poll(0), [])
        self.append(self.log, claude({"type": "tool_use", "name": "Bash"}))
        self.assertEqual(self.kinds(watcher.poll(1)), ["bash"])
        self.assertEqual(watcher.poll(2), [])

    def test_partial_line_waits_for_newline(self):
        watcher = AgentWatcher([self.root], rescan=0)
        raw = json.dumps(claude({"type": "tool_use", "name": "Read"}))
        with self.log.open("a") as stream:
            stream.write(raw[:20])
        self.assertEqual(watcher.poll(1), [])
        with self.log.open("a") as stream:
            stream.write(raw[20:] + "\n")
        self.assertEqual(self.kinds(watcher.poll(2)), ["read"])

    def test_new_session_and_new_folder_found_without_a_full_walk(self):
        watcher = AgentWatcher([self.root], rescan=0, full_scan=1e9)
        watcher.poll(0)
        other = self.root / "proj/s2.jsonl"
        self.append(other, claude({"type": "thinking"}))
        nested = self.root / "proj/s1/subagents"
        nested.mkdir(parents=True)
        self.append(nested / "agent-1.jsonl", claude({"type": "tool_use", "name": "Grep"}))
        self.append(self.log, claude({"type": "text"}, stop="end_turn"))
        events = watcher.poll(1)
        self.assertEqual(sorted(self.kinds(events)), ["done", "read", "text", "think"])
        self.assertEqual(len({p for p, _ in events}), 3)

    def test_old_session_waking_up_plays_only_what_is_new(self):
        old = self.root / "proj/old.jsonl"
        self.append(old, *[claude({"type": "tool_use", "name": "Bash"})] * 50)
        hour_ago = time.time() - 3600
        os.utime(old, (hour_ago, hour_ago))  # stale at start: not polled, but remembered
        watcher = AgentWatcher([self.root], rescan=0)
        self.assertNotIn(str(old), watcher.offsets)
        self.append(old, claude({"type": "tool_use", "name": "Edit"}))
        self.assertEqual(self.kinds(watcher.poll(1)), ["edit"])  # the wake-up is heard, history is not
        self.append(old, claude({"type": "tool_use", "name": "Read"}))
        self.assertEqual(self.kinds(watcher.poll(2)), ["read"])

    def test_a_log_quiet_for_weeks_is_forgotten_and_wakes_up_from_its_end(self):
        old = self.root / "proj/ancient.jsonl"
        self.append(old, *[claude({"type": "tool_use", "name": "Bash"})] * 50)
        os.utime(old, (0, 0))
        watcher = AgentWatcher([self.root], rescan=0)
        self.assertNotIn(str(old), watcher.resume)
        self.append(old, claude({"type": "tool_use", "name": "Edit"}))
        watcher.poll(1)                                     # found again: starts at its end
        self.append(old, claude({"type": "tool_use", "name": "Read"}))
        self.assertEqual(self.kinds(watcher.poll(2)), ["read"])

    def test_quiet_log_stops_being_polled_and_resumes_where_it_was(self):
        watcher = AgentWatcher([self.root], rescan=0, full_scan=1e9)
        watcher.poll(0)
        hour_ago = time.time() - 3600
        os.utime(self.log, (hour_ago, hour_ago))
        watcher.poll(1)
        self.assertNotIn(str(self.log), watcher.offsets)
        self.append(self.log, claude({"type": "tool_use", "name": "Bash"}))
        self.assertEqual(watcher.poll(2), [])            # not polled, and its folder did not change
        watcher.full_scan = 0
        self.assertEqual(self.kinds(watcher.poll(3)), ["bash"])   # the full walk finds it; nothing lost

    def test_missing_root_and_truncation(self):
        watcher = AgentWatcher([self.root / "yok", self.root], rescan=0)
        self.log.write_text("")
        self.assertEqual(watcher.poll(1), [])
        self.append(self.log, claude({"type": "tool_use", "name": "Write"}))
        self.assertEqual(self.kinds(watcher.poll(2)), ["edit"])

    def test_gemini_sessions_are_found_and_counted_as_gemini(self):
        chats = self.root / ".gemini/tmp/my-project/chats"
        chats.mkdir(parents=True)
        watcher = AgentWatcher([self.root / "proj", self.root / ".gemini/tmp"], rescan=0)
        log = chats / "session-2026-10-31T00-00-a2a-serv.jsonl"
        log.write_text("")
        watcher.poll(1.0)
        self.append(log, {"type": "user", "content": [{"text": "hi"}]}, gemini(gcall("glob", "g1")))
        events = watcher.poll(2.0)
        self.assertEqual(self.kinds(events), ["busy", "think", "text", "read"])
        activity = reader.Activity()
        for path, kind in events:
            activity.see(path, kind, 2.0)
        self.assertEqual(activity.tools(), {"gemini": 1})

    def test_grok_sessions_are_found_and_counted_with_other_agents(self):
        self.assertIn(Path.home() / ".grok/sessions", reader.ROOTS)
        session = self.root / ".grok/sessions/%2FUsers%2Fme%2Fproj/0199a0b0-0000-7000-8000-000000000001"
        session.mkdir(parents=True)
        watcher = AgentWatcher([self.root / "proj", self.root / ".grok/sessions"], rescan=0)
        log, chat = session / "updates.jsonl", session / "chat_history.jsonl"
        for path in (log, chat):
            path.write_text("")
        watcher.poll(1.0)
        # The same conversation as sent to the model: its "user" lines would read as Claude Code prompts.
        self.append(chat, {"type": "user", "content": "hi"}, {"type": "assistant", "content": "ok", "tool_calls": []})
        self.append(log, grok({"sessionUpdate": "user_message_chunk", "content": {"type": "text", "text": "hi"}}), gtool("g1", "search"))
        events = watcher.poll(2.0)
        self.assertEqual(self.kinds(events), ["busy", "read"])
        activity = reader.Activity()
        for path, kind in events:
            activity.see(path, kind, 2.0)
        self.assertEqual(activity.tools(), {"other": 1})

    def test_a_line_the_parser_chokes_on_is_skipped_and_the_rest_still_heard(self):
        watcher = AgentWatcher([self.root], rescan=0)
        watcher.poll(0)
        self.append(self.log, {"type": "boom"}, claude({"type": "tool_use", "name": "Edit"}))
        real = Classifier.__call__

        def choke(parser, entry):
            if entry.get("type") == "boom":
                raise ValueError("unexpected shape")
            return real(parser, entry)

        with patch.object(Classifier, "__call__", choke):
            self.assertEqual(self.kinds(watcher.poll(1)), ["edit"])

    def test_results_are_judged_per_session(self):
        watcher = AgentWatcher([self.root], rescan=0)
        self.append(self.log, tool("Read", "r1"))
        watcher.poll(1)
        self.append(self.log, result("r1", "12 failed"))
        self.assertEqual(self.kinds(watcher.poll(2)), ["busy"])


class ReporterTests(unittest.TestCase):
    def reporter(self, directory, url='http://localhost:4480/#pair=' + 'a' * 48):
        with patch.object(reader, 'CACHE', Path(directory)):
            return GlobalReporter(url, start=False)

    def test_pair_fragment_is_only_in_body_and_bad_urls_are_rejected(self):
        secret = 'a' * 48
        self.assertEqual(GlobalReporter.connection('http://localhost:4480/#pair=' + secret),
                         ('http://localhost:4480/api/play', secret))
        self.assertEqual(GlobalReporter.connection('https://example.test/base?ignored=x'),
                         ('https://example.test/base/api/play', None))
        for url in ('file:///private', 'https://user:password@example.test', 'http://', 'http://localhost/#pair=bad'):
            with self.assertRaises(ValueError):
                GlobalReporter.connection(url)

    def test_event_key_is_read_from_the_fragment_and_bad_keys_are_rejected(self):
        key = 'event-test-key-0123456789'
        self.assertEqual(GlobalReporter.event('https://orchestra.example/#pair=' + 'a' * 48 + '&event=' + key), key)
        self.assertIsNone(GlobalReporter.event('https://orchestra.example/'))
        for url in ('https://orchestra.example/#event=short', 'https://orchestra.example/#event=bad key with spaces!!'):
            with self.assertRaises(ValueError):
                GlobalReporter.event(url)

    def test_report_payload_contains_counts_without_paths_or_content(self):
        with tempfile.TemporaryDirectory() as directory:
            reporter = self.reporter(directory)
            reporter.add([(Path('/private/project/secret'), k) for k in ('edit', 'read', 'tool', 'text', 'done', 'ship')],
                         True, 1, {'codex': 1})
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
            self.assertEqual((payload['tools'], payload['sessions'], payload['working']), ({'codex': 1}, 1, True))
            self.assertEqual(payload['signals'], ['ship'])

    def test_expired_pair_is_dropped_and_machine_keeps_playing(self):
        with tempfile.TemporaryDirectory() as directory:
            reporter = self.reporter(directory)
            reporter.add([], True, 0, {})
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

    def test_sending_thread_never_touches_live_state(self):
        # Everything the loop sends comes from add(); a busy main thread cannot break it.
        with tempfile.TemporaryDirectory() as directory:
            reporter = self.reporter(directory)
            stop = threading.Event()

            def churn():
                for i in range(20000):
                    reporter.add([(f"s{i % 50}", "edit")], i % 2 == 0, i % 7, {"claude": i % 3})
                stop.set()
            worker = threading.Thread(target=churn)
            response = MagicMock()
            response.__enter__.return_value.read.return_value = b'{"section":"piano","seat":0,"players":1}'
            reporter.stop = MagicMock()
            reporter.stop.wait.side_effect = lambda _: stop.is_set()
            with patch.object(reporter.request, 'urlopen', return_value=response):
                worker.start()
                reporter.loop()
                worker.join()


READER = str(Path(__file__).with_name("reader.py"))


class BackgroundTests(unittest.TestCase):
    """Started from a terminal, the reader goes on after the terminal closes; --stop ends it."""
    URL = "http://127.0.0.1:9/"   # nothing listens there: the reader retries and nothing leaves the machine

    def setUp(self):
        self.home = tempfile.mkdtemp()
        self.env = {**os.environ, "HOME": self.home, "XDG_CACHE_HOME": os.path.join(self.home, "cache")}
        self.addCleanup(self.kill_left_over)

    def cache(self):
        return Path(self.home, "Library/Caches/code-sonata") if sys.platform == "darwin" else Path(self.home, "cache/code-sonata")

    def pid(self):
        try:
            return int((self.cache() / "reader.pid").read_text())
        except (OSError, ValueError):
            return None

    @staticmethod
    def alive(pid):
        try:
            os.kill(pid, 0)
            return True
        except OSError:
            return False

    def gone(self, pid):
        for _ in range(50):
            if not self.alive(pid):
                return True
            time.sleep(.1)
        return False

    def kill_left_over(self):
        pid = self.pid()
        if pid and self.alive(pid):
            os.kill(pid, signal.SIGKILL)

    def reader(self, *args):
        return subprocess.run([sys.executable, READER, *args], env=self.env, stdin=subprocess.DEVNULL,
                              capture_output=True, text=True, timeout=30)

    def test_the_reader_goes_on_after_its_terminal_closes(self):
        child, terminal = pty.fork()
        if child == 0:
            os.execve(sys.executable, [sys.executable, READER, self.URL], self.env)
        out, end = b"", time.monotonic() + 10
        while b"--stop" not in out and time.monotonic() < end:
            if select.select([terminal], [], [], .2)[0]:
                try:
                    out += os.read(terminal, 4096)
                except OSError:
                    break
        os.close(terminal)   # the tab is closed
        os.waitpid(child, 0)
        pid = self.pid()
        self.assertIsNotNone(pid, out.decode(errors="replace"))
        time.sleep(.5)
        self.assertTrue(self.alive(pid))

    def test_the_command_returns_at_once_and_stop_ends_the_reader(self):
        started = self.reader(self.URL)
        self.assertEqual(started.returncode, 0, started.stderr)
        self.assertIn("--stop", started.stdout)
        pid = self.pid()
        self.assertTrue(pid and self.alive(pid))
        stopped = self.reader("--stop")
        self.assertEqual(stopped.returncode, 0, stopped.stderr)
        self.assertIn("Okuyucu durdu", stopped.stdout)
        self.assertTrue(self.gone(pid))
        self.assertIsNone(self.pid())

    def test_a_new_command_replaces_the_running_reader(self):
        self.reader(self.URL)
        first = self.pid()
        self.reader(self.URL)
        second = self.pid()
        self.assertNotEqual(first, second)
        self.assertTrue(self.gone(first))
        self.assertTrue(self.alive(second))

    def test_stop_never_signals_a_program_that_is_not_the_reader(self):
        other = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"])
        self.addCleanup(other.wait)
        self.addCleanup(other.kill)
        self.cache().mkdir(parents=True)
        (self.cache() / "reader.pid").write_text(str(other.pid))
        stopped = self.reader("--stop")
        self.assertEqual(stopped.returncode, 0, stopped.stderr)
        self.assertIn("çalışan okuyucu yok", stopped.stdout)
        time.sleep(.3)
        self.assertIsNone(other.poll())


if __name__ == "__main__":
    unittest.main()
