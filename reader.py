#!/usr/bin/env python3
"""Agent Orchestra reader: your Claude Code, Codex, Gemini CLI and Grok Build steps join the shared orchestra.

    python3 reader.py 'https://orchestra.example/#pair=...'

Reads the session logs on this computer (~/.claude/projects, ~/.codex/sessions, ~/.gemini/tmp,
~/.grok/sessions; Grok sessions sit with the other agents) and sends only
counts once a second: how many steps of each kind, whether an agent is working, how many sessions
of each tool. Prompts, code, file paths and tool output never leave this computer; test and
commit results are read only as yes/no. Needs Python 3 and nothing else. Stop with Ctrl+C.

The local macOS tool (agents.py) imports this file for the same reading and reporting.
"""
import argparse
import json
import math
import os
from pathlib import Path
import re
import secrets
import shlex
import sys
import threading
import time
import urllib.parse

HOME = Path.home()
CACHE = HOME / "Library/Caches/code-sonata" if sys.platform == "darwin" else \
    Path(os.environ.get("XDG_CACHE_HOME") or HOME / ".cache") / "code-sonata"
ROOTS = (HOME / ".claude/projects", HOME / ".codex/sessions", HOME / ".gemini/tmp", HOME / ".grok/sessions")
EDIT_TOOLS = {"Edit", "Write", "MultiEdit", "NotebookEdit", "apply_patch", "write_file", "replace", "edit"}
BASH_TOOLS = {"Bash", "BashOutput", "exec", "exec_command", "shell", "local_shell", "container.exec", "run_shell_command"}
READ_TOOLS = {"Read", "Grep", "Glob", "LS", "WebFetch", "WebSearch", "ToolSearch",
              "read_file", "read_many_files", "list_directory", "glob", "grep_search", "search_file_content",
              "google_web_search", "web_fetch"}
MAX_CHUNK = 512 * 1024
FRESH = 15 * 60          # a log untouched this long is no longer polled; it resumes where it was
FULL_SCAN = 30.0         # seconds between walks of the whole tree (an old session waking up)
RESUME_AGE = 7 * 86400   # a log quiet for longer is not remembered (on this Mac 98% of ~8,000 logs)


def tool_kind(name):
    name = name or ""
    if name in EDIT_TOOLS:
        return "edit"
    if name in BASH_TOOLS:
        return "bash"
    if name in READ_TOOLS or name.startswith(("mcp__codebase-memory", "mcp__context7")):
        return "read"
    return "tool"


# Grok Build names a tool call by its ACP kind.
GROK_KINDS = {"execute": "bash", "edit": "edit", "delete": "edit", "move": "edit", "read": "read", "search": "read", "fetch": "read"}


def is_log(path, name):
    # Grok Build keeps several .jsonl files in a session folder; only updates.jsonl is the conversation.
    return name.endswith(".jsonl") and (name == "updates.jsonl" or "/.grok/" not in path)


# Yes/no checks on a command's output (never on a file that was read). Nothing is kept.
TEST_FAILED = re.compile(r"\b[1-9]\d* (?:failed|failing)\b|\bFAILED\b|^--- FAIL\b|^FAIL\b|^ℹ fail [1-9]", re.M)
TEST_PASSED = re.compile(r"\b[1-9]\d* (?:passed|passing)\b|^Ran \d+ tests? in [\d.]+s\s+OK\b|^ℹ pass [1-9]"
                         r"|^ok\s+\S+\s+[\d.]+s$", re.M)
SHIP = re.compile(r"\bgit\s+(?:commit|push)\b")
# A test run is a command whose program is a test runner: `pytest -q`, `cd app && npm test`,
# `python3 -m unittest`. `cat pytest.log` reads a file; its output means nothing.
TEST_RUNNER = re.compile(r"""\s*(?:\w+=\S*\s+)*(?:(?:sudo|time|nice|env)\s+)*
    (?:(?:npx|bunx|pnpx|uvx|uv\s+run|poetry\s+run|pipenv\s+run|hatch\s+run|(?:python|python3|py)(?:\.\d+)?\s+-m)\s+)?
    (?:pytest|py\.test|unittest|tox|nox|jest|vitest|mocha|ava|playwright\s+test|cypress\s+run|rspec|phpunit|ctest
     |(?:npm|pnpm|yarn|bun|deno|cargo|go|swift|mix|dotnet|gradle|\./gradlew|gradlew|mvn|make|rake|zig)\s+(?:run\s+)?test
     |node\s+--test|xcodebuild\b[^;&|\n]*\btest)(?![\w.-])""", re.X)
COMMAND_FIELD = re.compile(r"""\b(?:cmd|command)["']?\s*:\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')""")


def commands_in(source):
    """Shell commands inside a tool call: Claude's command string, a Codex exec call's JSON or JS."""
    try:
        data = json.loads(source)
    except ValueError:
        data = None
    if isinstance(data, dict):
        value = data.get("cmd") or data.get("command")
        if isinstance(value, list):
            return [" ".join(map(str, value)), str(value[-1]) if value else ""]
        if isinstance(value, str):
            return [value]
    found = [a or b for a, b in COMMAND_FIELD.findall(source)]
    return found or [source]


def runs_tests(source):
    """True when a command line starts a test runner. Split like a shell would, quotes kept:
    `echo "run (pytest) failed"` is one echo, `cd app && npm test` is two commands, and the
    body of a here-document (`cat <<EOF … EOF`) is text, not commands."""
    for command in commands_in(source):
        heredocs = []   # delimiters whose bodies come next
        for line in command.splitlines():
            if heredocs:
                if line.strip() == heredocs[0]:
                    heredocs.pop(0)
                continue
            lexer = shlex.shlex(line, posix=False, punctuation_chars=True)   # quotes stay on tokens: '";"' is a word
            lexer.whitespace_split = True
            try:
                tokens = list(lexer)
            except ValueError:   # unbalanced quotes: not a command we can read
                continue
            for i, token in enumerate(tokens[:-1]):
                if token in ("<<", "<<-"):
                    heredocs.append(tokens[i + 1].lstrip("-").strip("'\""))
            segment = []
            for token in tokens + [";"]:
                if token and set(token) <= set("();&|"):   # a redirection stays part of its command
                    if segment and TEST_RUNNER.match(" ".join(segment)):
                        return True
                    segment = []
                else:
                    segment.append(token)
    return False


# git's own success lines: "[main 1a2b3c4] message" (commit), "   1a2b3c4..5d6e7f8  main -> main" (push).
SHIPPED = re.compile(r"^\[[^\]\n]+ [0-9a-f]{7,40}\]|^\s*[+]?[0-9a-f]{7,40}\.\.\.?[0-9a-f]{7,40}\s+\S+ -> \S+"
                     r"|^\s*\* \[new (?:branch|tag)\]\s+\S+ -> \S+", re.M)
EXIT_CODE = re.compile(r'"exit_code"\s*:\s*(-?\d+)|^Exit code:?\s*(-?\d+)|Process exited with code (-?\d+)', re.M)
INTERRUPTED = "[Request interrupted by user"


def text_of(content):
    """Text of a tool result (string or list of parts), last 4000 characters."""
    if isinstance(content, list):
        content = " ".join(part.get("text", "") for part in content if isinstance(part, dict))
    return str(content or "")[-4000:]


def codex_result(output):
    """Output text and failure of a Codex tool result: plain text, a list of parts, or the exec
    tool's JSON reports (one per command, each with its own exit code)."""
    texts, codes = [], []

    def walk(value):
        if isinstance(value, dict):
            for key, item in value.items():
                if key == "exit_code" and isinstance(item, int):
                    codes.append(item)
                elif key in ("output", "stdout", "stderr", "aggregated_output") and isinstance(item, str):
                    texts.append(item)
                else:
                    walk(item)
        elif isinstance(value, list):
            for item in value:
                walk(item)

    for part in output if isinstance(output, list) else [output]:
        raw = part.get("text", "") if isinstance(part, dict) else part if isinstance(part, str) else json.dumps(part)
        for chunk in [raw] if raw.lstrip().startswith(("{", "[")) and "\n{" not in raw else raw.splitlines():
            try:
                walk(json.loads(chunk))
            except ValueError:
                texts.append(chunk)
                codes += [int(next(g for g in match if g)) for match in EXIT_CODE.findall(chunk)]
    return "\n".join(texts)[-4000:], any(codes)


def gemini_result(call):
    """The text a Gemini CLI tool call returned (read only to tell passed/failed tests and done commits)."""
    shown = call.get("resultDisplay")
    if isinstance(shown, str) and shown:
        return shown[:20000]
    parts = []
    for part in call.get("result") if isinstance(call.get("result"), list) else []:
        reply = part.get("functionResponse") if isinstance(part, dict) else None
        response = reply.get("response") if isinstance(reply, dict) else None
        if isinstance(response, dict):
            parts += [str(response.get(key)) for key in ("output", "error") if response.get(key)]
    return "\n".join(parts)[:20000]


def grok_result(update):
    """Output text and failure of a Grok Build tool call: a command that exits non-zero is still "completed"."""
    raw = update.get("rawOutput") if isinstance(update.get("rawOutput"), dict) else {}
    text = raw.get("output_for_prompt")
    if not isinstance(text, str) or not text:
        parts = update.get("content") if isinstance(update.get("content"), list) else []
        text = " ".join(str(part["content"].get("text", "")) for part in parts
                        if isinstance(part, dict) and isinstance(part.get("content"), dict))
    code = raw.get("exit_code")
    return text[-4000:], update.get("status") == "failed" or (isinstance(code, int) and code != 0)


class Classifier:
    """Step kinds of one session's log lines.

    It remembers that session's own tool calls by id, so a result is judged by what produced it:
    only a command's output can mean tests passed or failed (reading a log that says FAILED is
    not a failure), and a commit or push counts only when git reports it done.
    """

    def __init__(self):
        self.calls = {}
        self.streak = None   # Grok: the chunk kind being streamed, so one reply counts once

    def remember(self, call_id, kind, source=""):
        if call_id and isinstance(call_id, (str, int)):
            command = kind == "bash"
            self.calls[call_id] = (kind, command and bool(SHIP.search(source)), command and runs_tests(source))
            if len(self.calls) > 256:
                self.calls.pop(next(iter(self.calls)))

    def judge(self, call_id, text, error):
        # A result whose call this reader never saw (it came before the reader started) means nothing.
        if not isinstance(call_id, (str, int)) or call_id not in self.calls:
            return []
        kind, ship, tests = self.calls.pop(call_id)
        if kind != "bash":
            return ["fail"] if error else []
        if tests and TEST_FAILED.search(text):
            return ["testfail"]
        out = ["pass"] if tests and TEST_PASSED.search(text) else ["fail"] if error else []
        if ship and not error and SHIPPED.search(text):
            out.append("ship")
        return out

    def grok(self, params):
        """One Grok Build session update (ACP, or xAI's own for the end of a turn)."""
        update = params.get("update") if isinstance(params, dict) else None
        if not isinstance(update, dict):
            return []
        kind = update.get("sessionUpdate")
        if kind in ("agent_message_chunk", "agent_thought_chunk"):
            again, self.streak = self.streak == kind, kind
            return [] if again else ["text" if kind == "agent_message_chunk" else "think"]
        if kind in ("user_message_chunk", "tool_call", "turn_completed"):
            self.streak = None
        if kind == "user_message_chunk":
            return ["busy"]
        if kind == "turn_completed":
            return ["done"]
        call_id = update.get("toolCallId")
        if kind == "tool_call":
            if isinstance(call_id, str) and call_id in self.calls:
                return []
            step = GROK_KINDS.get(update.get("kind")) if isinstance(update.get("kind"), str) else None
            command = (update.get("rawInput") or {}).get("command") if isinstance(update.get("rawInput"), dict) else None
            self.remember(call_id, step or "tool", command[:2000] if isinstance(command, str) else "")
            return [step or "tool"]
        if kind == "tool_call_update" and update.get("status") in ("completed", "failed"):
            return self.judge(call_id, *grok_result(update))
        return []

    def __call__(self, entry):
        """One transcript line -> list of step kinds. Unknown shapes are ignored."""
        if not isinstance(entry, dict):
            return []
        if entry.get("method") in ("session/update", "_x.ai/session/update"):  # Grok Build
            return self.grok(entry.get("params"))
        kind = entry.get("type")
        if kind == "user":  # Claude Code: a prompt or a tool result -> the model is working now
            content = (entry.get("message") or {}).get("content")
            if INTERRUPTED in text_of(content)[:200]:
                return ["done"]  # stopped by the user: the turn is over
            kinds = ["busy"]
            for block in content if isinstance(content, list) else []:
                if isinstance(block, dict) and block.get("type") == "tool_result":
                    kinds += self.judge(block.get("tool_use_id"), text_of(block.get("content")), bool(block.get("is_error")))
            return kinds
        if kind == "assistant":  # Claude Code
            message = entry.get("message") or {}
            kinds = []
            for block in message.get("content") or []:
                if not isinstance(block, dict):
                    continue
                block_type = block.get("type")
                if block_type == "tool_use":
                    step = tool_kind(block.get("name"))
                    command = (block.get("input") or {}).get("command") if isinstance(block.get("input"), dict) else None
                    self.remember(block.get("id"), step, command[:2000] if isinstance(command, str) else "")
                    kinds.append(step)
                elif block_type in ("thinking", "redacted_thinking"):
                    kinds.append("think")
                elif block_type == "text":
                    kinds.append("text")
            if message.get("stop_reason") == "end_turn":
                kinds.append("done")
            return kinds
        if kind == "gemini":  # Gemini CLI: one reply, its thoughts, and its tool calls already finished
            kinds = (["think"] if entry.get("thoughts") else []) + (["text"] if entry.get("content") else [])
            calls = entry.get("toolCalls") if isinstance(entry.get("toolCalls"), list) else []
            for call in calls:
                if not isinstance(call, dict):
                    continue
                step = tool_kind(call.get("name"))
                command = (call.get("args") or {}).get("command") if isinstance(call.get("args"), dict) else None
                self.remember(call.get("id"), step, command[:2000] if isinstance(command, str) else "")
                kinds.append(step)
                kinds += self.judge(call.get("id"), gemini_result(call), call.get("status") == "error")
            if not calls:
                kinds.append("done")  # a reply that asks for no tool ends the turn
            return kinds
        payload = entry.get("payload")
        if not isinstance(payload, dict):
            return []
        inner = payload.get("type")
        if kind == "response_item":  # Codex
            if inner in ("function_call", "custom_tool_call", "local_shell_call"):
                name = payload.get("name") or "exec"
                source = str(payload.get("input") or payload.get("arguments") or payload.get("action") or "")
                if name in ("exec", "exec_command", "shell") and "apply_patch" in source[:400]:
                    name = "apply_patch"
                step = tool_kind(name)
                self.remember(payload.get("call_id"), step, source[:4000])
                return [step]
            if inner == "reasoning":
                return ["think"]
            if inner == "message" and payload.get("role") == "assistant":
                return ["text"]
            if inner in ("function_call_output", "custom_tool_call_output"):
                text, error = codex_result(payload.get("output"))
                return ["busy"] + self.judge(payload.get("call_id"), text, error)
        if kind == "event_msg" and inner == "user_message":
            return ["busy"]
        if kind == "event_msg" and inner in ("task_complete", "turn_aborted"):
            return ["done"]
        return []


def classify(entry, state=None):
    return (state or Classifier())(entry)


class AgentWatcher:
    """Tail session logs. Existing content is skipped; only new lines count.

    Cheap on a big history: every `rescan` seconds only the folders are checked (a new log changes
    its folder), the whole tree is walked every `full_scan` seconds (an old log that starts growing
    again), and only logs written in the last FRESH seconds are polled. A log that went quiet keeps
    its position, so when it wakes up nothing after that point is lost and nothing before it replays.
    """

    def __init__(self, roots=ROOTS, rescan=2.0, full_scan=FULL_SCAN):
        self.roots = [Path(r) for r in roots]
        self.rescan, self.full_scan = rescan, full_scan
        self.offsets = {}    # path -> read position, logs being polled
        self.partial = {}    # path -> unfinished last line
        self.parsers = {}    # path -> Classifier
        self.resume = {}     # path -> position of a quiet log (or its size when first seen)
        self.dirs = {}       # folder -> mtime
        self.last_scan = self.last_full = -math.inf
        self.started = time.time() - 1
        self.walk(time.time(), initial=True)

    def consider(self, path, stat, wall, initial):
        if path in self.offsets:
            return
        if wall - stat.st_mtime > FRESH:
            # A recent quiet log keeps its position, so its wake-up is heard in full; one quiet for
            # over a week is forgotten (if it wakes up, at most the steps before the next walk are missed).
            if wall - stat.st_mtime < RESUME_AGE:
                self.resume.setdefault(path, stat.st_size)
            else:
                self.resume.pop(path, None)
            return
        if path in self.resume:
            self.offsets[path] = min(self.resume.pop(path), stat.st_size)
            return
        # Only logs born after start are read from the beginning; one that already existed starts
        # at its end, so history never replays.
        born = getattr(stat, "st_birthtime", stat.st_ctime)
        self.offsets[path] = 0 if not initial and born >= self.started else stat.st_size

    def scan_folder(self, folder, wall, initial, deep):
        try:
            self.dirs[folder] = os.stat(folder).st_mtime_ns
            entries = list(os.scandir(folder))
        except OSError:
            self.dirs.pop(folder, None)
            return
        for entry in entries:
            try:
                if entry.is_dir(follow_symlinks=False):
                    if deep or entry.path not in self.dirs:
                        self.scan_folder(entry.path, wall, initial, True)
                elif is_log(entry.path, entry.name):
                    self.consider(entry.path, entry.stat(), wall, initial)
            except OSError:
                continue

    def walk(self, wall, initial=False):
        for root in self.roots:
            if root.is_dir():
                self.scan_folder(str(root), wall, initial, True)

    def discover(self, wall):
        """Folders whose mtime changed: new logs or new subfolders."""
        for folder, seen in list(self.dirs.items()):
            try:
                changed = os.stat(folder).st_mtime_ns != seen
            except OSError:
                self.dirs.pop(folder, None)
                continue
            if changed:
                self.scan_folder(folder, wall, False, False)
        for root in self.roots:
            if str(root) not in self.dirs and root.is_dir():
                self.scan_folder(str(root), wall, False, True)

    def poll(self, now, wall=None):
        """Return [(session_path, kind), ...] for lines appended since last poll."""
        wall = time.time() if wall is None else wall
        if now - self.last_full >= self.full_scan:
            self.last_full = self.last_scan = now
            self.walk(wall)
        elif now - self.last_scan >= self.rescan:
            self.last_scan = now
            self.discover(wall)
        events = []
        for path, offset in list(self.offsets.items()):
            try:
                stat = os.stat(path)
            except OSError:
                for table in (self.offsets, self.partial, self.parsers):
                    table.pop(path, None)
                continue
            size = stat.st_size
            if size < offset:  # rewritten / truncated
                offset = self.offsets[path] = 0
                self.partial.pop(path, None)
            if size == offset:
                if wall - stat.st_mtime > FRESH:  # quiet: stop polling, remember where it was
                    self.resume[path] = self.offsets.pop(path)
                continue
            try:
                with open(path, "rb") as stream:
                    stream.seek(offset)
                    data = stream.read(min(size - offset, MAX_CHUNK))
            except OSError:
                continue
            self.offsets[path] = offset + len(data)
            data = self.partial.pop(path, b"") + data
            lines = data.split(b"\n")
            if lines[-1]:
                self.partial[path] = lines[-1][-MAX_CHUNK:]
            parser = self.parsers.setdefault(path, Classifier())
            for raw in lines[:-1]:
                if not raw.strip():
                    continue
                try:
                    entry = json.loads(raw)
                    events.extend((path, kind) for kind in parser(entry))
                except Exception:  # one line in a shape nobody expected costs that step, not the reader
                    continue
        return events


class Activity:
    """Which sessions are around and which are mid-turn (between a prompt and its end)."""

    WORK_TIMEOUT = 120   # a turn with no writes for this long is treated as finished
    IDLE_SEAT = 20       # seconds a finished session stays around

    def __init__(self):
        self.sessions = {}   # path -> last write time
        self.working = {}    # path -> last write time, only while mid-turn

    def see(self, path, kind, now):
        self.sessions[path] = now
        if kind == "done":
            self.working.pop(path, None)
        else:
            self.working[path] = now

    def forget(self, path):
        """Called when a session leaves; subclasses free what they kept for it."""

    def active(self, now):
        for path, seen in list(self.sessions.items()):
            limit = self.WORK_TIMEOUT if path in self.working else self.IDLE_SEAT
            if now - seen > limit:
                self.sessions.pop(path, None)
                self.working.pop(path, None)
                self.forget(path)
        return len(self.sessions)

    def is_working(self, now):
        return any(now - seen <= self.WORK_TIMEOUT for seen in self.working.values())

    def tools(self):
        tools = {}
        for path in self.sessions:
            tool = "codex" if "/.codex/" in str(path) else "gemini" if "/.gemini/" in str(path) else \
                "other" if "/.grok/" in str(path) else "claude"
            tools[tool] = tools.get(tool, 0) + 1
        return tools


class GlobalReporter:
    """Opt-in: send step counts (never content) to an Agent Orchestra server once a second.

    The main thread hands over everything with add(); the sending thread reads only that copy.
    """

    STEPS = {"edit", "bash", "read", "tool", "think", "text", "done"}
    SECTION_NAMES = {"piano": "piyano", "strings": "yaylılar", "choir": "koro", "cello": "çello", "flute": "flüt",
                     "vibraphone": "vibrafon", "horn": "korno", "harp": "arp", "accordion": "akordeon"}

    @staticmethod
    def connection(url):
        parsed = urllib.parse.urlsplit(url)
        if parsed.scheme not in ("http", "https") or not parsed.hostname or parsed.username or parsed.password:
            raise ValueError("Orkestra adresi geçerli bir http/https URL olmalı.")
        pair = urllib.parse.parse_qs(parsed.fragment).get("pair", [None])[0]
        if pair and (len(pair) != 48 or any(c not in "0123456789abcdef" for c in pair)):
            raise ValueError("Eşleştirme anahtarı geçersiz; tarayıcıdan yeni bağlantı oluştur.")
        return urllib.parse.urlunsplit((parsed.scheme, parsed.netloc, parsed.path.rstrip("/") + "/api/play", "", "")), pair

    @staticmethod
    def event(url):
        # An event link (#event=<key>) lifts the venue's shared-address limits on the server.
        key = urllib.parse.parse_qs(urllib.parse.urlsplit(url).fragment).get("event", [None])[0]
        if key is not None and not re.fullmatch(r"[A-Za-z0-9_-]{16,64}", key):
            raise ValueError("Etkinlik anahtarı geçersiz; etkinlik bağlantısını yeniden kopyala.")
        return key

    def __init__(self, url, start=True):
        import urllib.request   # only a machine that joins a hall needs HTTP
        self.url, self.pair = self.connection(url)
        self.event_key = self.event(url)
        self.request = urllib.request
        id_file = CACHE / "global-id"
        try:
            self.id = id_file.read_text().strip()
            if not 16 <= len(self.id) <= 64 or any(c not in "0123456789abcdef" for c in self.id):
                raise OSError("invalid cached id")
        except OSError:
            self.id = secrets.token_hex(16)
            CACHE.mkdir(parents=True, exist_ok=True)
            id_file.write_text(self.id)
            id_file.chmod(0o600)
        self.lock = threading.Lock()
        self.steps, self.signals, self.seat = 0, [], None
        self.working, self.sessions, self.tools = False, 0, {}
        self.activity = {k: 0 for k in ("edit", "bash", "read", "think", "done")}
        self.failed = False
        self.stop = threading.Event()
        if start:
            threading.Thread(target=self.loop, daemon=True).start()

    def add(self, events, working, sessions, tools):
        """New steps plus a copy of the current state, from the main thread."""
        with self.lock:
            self.working, self.sessions, self.tools = bool(working), int(sessions), dict(tools)
            for _, kind in events:
                if kind in self.STEPS:
                    self.steps += 1
                    activity = kind if kind in self.activity else "think"
                    self.activity[activity] += 1
                elif kind in ("ship", "pass", "fail", "testfail") and len(self.signals) < 4:
                    self.signals.append("fail" if kind == "testfail" else kind)

    def loop(self):
        import urllib.error
        quiet = 0
        while not self.stop.wait(1):
            with self.lock:
                steps, signals, working, sessions, tools = self.steps, self.signals, self.working, self.sessions, self.tools
                self.steps, self.signals = 0, []
                activity, self.activity = self.activity, {k: 0 for k in self.activity}
            quiet = 0 if steps or working else quiet + 1
            if quiet and quiet % 10 and self.seat is not None:  # idle: heartbeat every 10 s keeps the seat
                continue
            body = json.dumps({"id": self.id, "steps": steps, "signals": signals, "working": working,
                               "sessions": sessions, "tools": tools, "activity": activity, "pair": self.pair,
                               **({"event": self.event_key} if self.event_key else {})}).encode()
            try:
                request = self.request.Request(self.url, data=body, headers={"content-type": "application/json"})
                with self.request.urlopen(request, timeout=3) as response:
                    seat = json.loads(response.read())
                # An expired or removed key ends only the browser view; keep playing anonymously.
                if self.pair and seat.get("pair") in ("expired", "used"):
                    self.pair = None
                    print("Kişisel eşleştirme sona erdi; ortak orkestrada anonim olarak devam ediyorsun. "
                          "Kendi sesini görmek için tarayıcıdan yeni komut oluştur.", flush=True)
                if seat.get("section") != (self.seat or {}).get("section"):
                    section = self.SECTION_NAMES.get(seat.get("section"), seat.get("section"))
                    print(f"Dünya orkestrası: {section} bölümü, {seat.get('seat', 0) + 1}. koltuk · "
                          f"{seat.get('players')} makine", flush=True)
                self.seat = seat
                self.failed = False
            except urllib.error.HTTPError as exc:
                if not self.failed:
                    print("Sunucu çok yoğun, yeniden denenecek." if exc.code == 429 else
                          f"Orkestra isteği reddetti ({exc.code}); yeniden denenecek.", flush=True)
                self.failed, self.seat = True, None
            except (OSError, ValueError):
                if not self.failed:
                    print("Orkestra bağlantısı kurulamadı. Sunucu adresini kontrol et; yeniden denenecek.", flush=True)
                self.failed, self.seat = True, None


def run(url, duration=None, roots=ROOTS):
    """Standalone reader: no sound here, the orchestra plays in the browser."""
    reporter = GlobalReporter(url)
    watcher = AgentWatcher(roots)
    activity = Activity()
    print("Agent Orchestra okuyucusu çalışıyor. Yalnız adım sayıları gönderilir; prompt, kod ve dosya yolu gönderilmez.\n"
          f"{len(watcher.offsets)} etkin oturum kaydı bulundu. Geçmiş sayılmaz, yeni adımlar orkestraya gider. "
          "Durdurmak için Ctrl+C.", flush=True)
    started, last_note, counted = time.monotonic(), time.monotonic(), 0
    try:
        while duration is None or time.monotonic() - started < duration:
            now = time.monotonic()
            events = watcher.poll(now)
            for path, kind in events:
                activity.see(path, kind, now)
            activity.active(now)
            reporter.add(events, activity.is_working(now), len(activity.sessions), activity.tools())
            counted += sum(1 for _, kind in events if kind in GlobalReporter.STEPS)
            if counted and now - last_note >= 30:
                print(f"♫ son 30 sn: {counted} adım · {len(activity.sessions)} oturum", flush=True)
                counted, last_note = 0, now
            time.sleep(.5)
    except KeyboardInterrupt:
        pass
    finally:
        reporter.stop.set()
    print("Okuyucu durdu.", flush=True)
    return 0


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("url", nargs="?", help="Tarayıcının verdiği orkestra adresi")
    parser.add_argument("--global", dest="global_url", metavar="URL", help=argparse.SUPPRESS)
    parser.add_argument("--duration", type=float, help=argparse.SUPPRESS)
    args = parser.parse_args()
    url = args.url or args.global_url
    if not url:
        parser.error("Orkestra adresini ver: python3 reader.py 'https://…/#pair=…'")
    try:
        GlobalReporter.connection(url)
        GlobalReporter.event(url)
    except ValueError as exc:
        parser.error(str(exc))
    return run(url, args.duration)


if __name__ == "__main__":
    sys.exit(main())
