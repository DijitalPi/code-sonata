#!/usr/bin/env python3
"""Read-only agent listener: every Claude Code / Codex session on this Mac plays together.

Only the kind of each step (edit, command, read, thinking, done) is used.
Message text, code and tool input are never kept or sent to the piano.
"""
import argparse
from collections import deque
import json
import math
import os
from pathlib import Path
import queue
import random
import re
import select
import sys
import termios
import threading
import time
import tty

from sonata import Composer, Piano
from melodies import CHOICES, TITLES, SongComposer

CACHE = Path.home() / "Library/Caches/code-sonata"
STATE = CACHE / "position.json"
STATUS = CACHE / "status.json"
COMMANDS = CACHE / "commands"
ROOTS = (Path.home() / ".claude/projects", Path.home() / ".codex/sessions")
EDIT_TOOLS = {"Edit", "Write", "MultiEdit", "NotebookEdit", "apply_patch"}
BASH_TOOLS = {"Bash", "BashOutput", "exec", "exec_command", "shell", "local_shell", "container.exec"}
READ_TOOLS = {"Read", "Grep", "Glob", "LS", "WebFetch", "WebSearch", "ToolSearch"}
MAX_CHUNK = 512 * 1024
FRESH = 15 * 60


def tool_kind(name):
    name = name or ""
    if name in EDIT_TOOLS:
        return "edit"
    if name in BASH_TOOLS:
        return "bash"
    if name in READ_TOOLS or name.startswith(("mcp__codebase-memory", "mcp__context7")):
        return "read"
    return "tool"


PASSED = re.compile(r"\b\d+ (?:passed|passing)\b")
FAILED = re.compile(r"\b\d+ (?:failed|failing)\b|\bFAILED\b")
SHIP = re.compile(r"\bgit\s+(?:commit|push)\b")


def result_text(block):
    """Text of a tool_result, capped. Used only for yes/no checks, never kept."""
    content = block.get("content")
    if isinstance(content, list):
        content = " ".join(part.get("text", "") for part in content if isinstance(part, dict))
    return str(content or "")[-4000:]


def classify(entry):
    """One transcript line -> list of step kinds. Unknown shapes are ignored."""
    if not isinstance(entry, dict):
        return []
    kind = entry.get("type")
    if kind == "user":  # Claude Code: a prompt or a tool result -> the model is working now
        kinds = ["busy"]
        content = (entry.get("message") or {}).get("content")
        for block in content if isinstance(content, list) else []:
            if not isinstance(block, dict) or block.get("type") != "tool_result":
                continue
            text = result_text(block)
            if FAILED.search(text):
                kinds.append("testfail")
            elif PASSED.search(text):
                kinds.append("pass")
            elif block.get("is_error"):
                kinds.append("fail")
        return kinds
    if kind == "assistant":  # Claude Code
        message = entry.get("message") or {}
        kinds = []
        for block in message.get("content") or []:
            if not isinstance(block, dict):
                continue
            block_type = block.get("type")
            if block_type == "tool_use":
                kinds.append(tool_kind(block.get("name")))
                command = (block.get("input") or {}).get("command") if isinstance(block.get("input"), dict) else None
                if isinstance(command, str) and SHIP.search(command[:500]):
                    kinds.append("ship")
            elif block_type in ("thinking", "redacted_thinking"):
                kinds.append("think")
            elif block_type == "text":
                kinds.append("text")
        if message.get("stop_reason") == "end_turn":
            kinds.append("done")
        return kinds
    payload = entry.get("payload")
    if not isinstance(payload, dict):
        return []
    inner = payload.get("type")
    if kind == "response_item":  # Codex
        if inner in ("function_call", "custom_tool_call", "local_shell_call"):
            name = payload.get("name") or "exec"
            if name in ("exec", "exec_command", "shell") and "apply_patch" in str(payload.get("input") or payload.get("arguments") or "")[:200]:
                name = "apply_patch"
            return [tool_kind(name)]
        if inner == "reasoning":
            return ["think"]
        if inner == "message" and payload.get("role") == "assistant":
            return ["text"]
        if inner in ("function_call_output", "custom_tool_call_output"):
            return ["busy"]
    if kind == "event_msg" and inner == "user_message":
        return ["busy"]
    if kind == "event_msg" and inner == "task_complete":
        return ["done"]
    return []


class AgentWatcher:
    """Tail session logs. Existing content is skipped; only new lines count."""

    def __init__(self, roots=ROOTS, rescan=2.0):
        self.roots = [Path(r) for r in roots]
        self.rescan = rescan
        self.offsets = {}
        self.partial = {}
        self.last_scan = -math.inf
        self.started = time.time() - 1
        self.discover(time.time(), initial=True)

    def discover(self, wall, initial=False):
        for root in self.roots:
            if not root.is_dir():
                continue
            for folder, dirs, files in os.walk(root):
                for name in files:
                    if not name.endswith(".jsonl"):
                        continue
                    path = os.path.join(folder, name)
                    if path in self.offsets:
                        continue
                    try:
                        stat = os.stat(path)
                    except OSError:
                        continue
                    if wall - stat.st_mtime > FRESH:
                        continue
                    # Only sessions born after start are read from the beginning;
                    # an old session waking up must not replay its whole history.
                    born = getattr(stat, "st_birthtime", stat.st_ctime)
                    fresh = not initial and born >= self.started
                    self.offsets[path] = 0 if fresh else stat.st_size

    def poll(self, now, wall=None):
        """Return [(session_path, kind), ...] for lines appended since last poll."""
        wall = time.time() if wall is None else wall
        if now - self.last_scan >= self.rescan:
            self.last_scan = now
            self.discover(wall)
        events = []
        for path, offset in list(self.offsets.items()):
            try:
                size = os.stat(path).st_size
            except OSError:
                self.offsets.pop(path, None)
                self.partial.pop(path, None)
                continue
            if size < offset:  # rewritten / truncated
                offset = self.offsets[path] = 0
                self.partial.pop(path, None)
            if size == offset:
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
            for raw in lines[:-1]:
                if not raw.strip():
                    continue
                try:
                    entry = json.loads(raw)
                except ValueError:
                    continue
                events.extend((path, kind) for kind in classify(entry))
        return events


HINTS = {"edit": "def edit", "bash": "for item", "read": "if condition",
         "tool": "# tool", "think": "# think", "text": "# text", "done": "return", "busy": "# think",
         "fail": "# fail", "testfail": "# fail", "pass": "return", "ship": "return"}
SIGNALS = {"fail", "testfail", "pass", "ship", "wait"}  # one-off motifs, not working steps


GAIN = 1.7
TIMPANI, TREMOLO, DRUMS = 8, 9, 10           # extra engine voices, not choir seats
KICK, SNARE, HIHAT, OPEN_HAT, CRASH = 36, 38, 42, 46, 49
VOICES = ("piyano", "yaylılar", "koro", "çello", "flüt", "vibrafon", "korno", "arp")
TRIADS = {9: (0, 3, 7), 2: (0, 3, 7), 4: (0, 3, 7), 11: (0, 3, 7)}  # fallback for the original composer


class AgentMusic:
    """One conductor, one shared theme; every session (terminal or subagent) is a choir voice.

    The theme position is shared, so a new session joins mid-phrase instead of
    restarting. Slot 0 is the piano; later sessions get strings, choir, cello,
    flute, vibraphone, horn, harp. Each voice swells with its own session's steps.
    While any session is mid-turn (between a prompt and end_turn) the music keeps
    flowing softly, so long thinking does not cut it off.
    """

    WORK_TIMEOUT = 120   # a turn with no writes for this long is treated as finished
    IDLE_SEAT = 20       # seconds a finished session keeps its instrument

    def __init__(self, song="bella-ciao", seed=None, position=0):
        self.composer = Composer() if song == "original" else SongComposer(song)
        if hasattr(self.composer, "position"):
            index, pos = position if isinstance(position, (list, tuple)) else (0, position)
            if index % len(self.composer.playlist):
                self.composer.index = index % len(self.composer.playlist)
                self.composer.load()
            self.composer.position = pos % len(self.composer.score)
        self.random = random.Random(seed)
        self.sessions = {}   # path -> last write time
        self.working = {}    # path -> last write time, only while mid-turn
        self.slots = {}      # path -> voice index
        self.energy = {}     # path -> recent step weight
        self.accents = []
        self.last_accent = {}
        self.last_step = -100.0
        self.until = -1.0
        self.next_pulse = 0.0
        self.last_tick = None
        self.hint = "# think"
        self.root = 45
        self.arp = 0
        # Excitement: tempo drives rhythm, drums, tension and a key change at the top.
        self.intensity = 0.0
        self.next_drive = 0.0
        self.eighth = 0
        self.shift = 0
        self.peak_since = None
        self.calm_since = None
        self.bpm_history = deque(maxlen=200)

    def active(self, now):
        for path, seen in list(self.sessions.items()):
            limit = self.WORK_TIMEOUT if path in self.working else self.IDLE_SEAT
            if now - seen > limit:
                for table in (self.sessions, self.working, self.slots, self.energy):
                    table.pop(path, None)
        return len(self.sessions)

    def is_working(self, now):
        return any(now - seen <= self.WORK_TIMEOUT for seen in self.working.values())

    def voices(self):
        return [VOICES[v % len(VOICES)] for v in sorted(self.slots.values())]

    def join(self, path):
        if path not in self.slots:
            taken = set(self.slots.values())
            self.slots[path] = next(i for i in range(len(taken) + 1) if i not in taken)
        return self.slots[path] % len(VOICES)

    def chord(self, octave):
        """Current chord as MIDI notes in the octave starting at `octave` (36, 48, 60...)."""
        if hasattr(self.composer, "chord_tones"):
            return self.composer.chord_tones(octave)
        base = octave - octave % 12 + self.root % 12
        return [base + i for i in TRIADS.get(self.root % 12, (0, 4, 7))]

    def accept(self, events, now):
        if not events:
            return
        self.active(now)
        for path, kind in events:
            self.sessions[path] = now
            voice = self.join(path)
            if kind == "done":
                self.working.pop(path, None)
            else:
                self.working[path] = now
            if kind == "busy":
                continue  # a prompt or tool result: keeps the flow, no note of its own
            if kind in SIGNALS:
                self.signal(kind, now)
                continue
            self.last_step = now
            self.energy[path] = min(4.0, self.energy.get(path, 0) + 1)
            self.hint = HINTS[kind]
            self.composer.typed(now, self.hint, completed=True)
            if now - self.last_accent.get((voice, kind), -9) < .3:
                continue  # many steps at once: one accent per voice and kind per moment
            self.last_accent[(voice, kind)] = now
            high = 12 if voice in (4, 5, 7) else 0
            # Accents are always tones of the chord under the melody: no clashes.
            if kind == "bash":
                self.accents.append((self.chord(36)[0] + high, 38, .45, voice))
            elif kind == "read":
                self.accents.append((self.random.choice(self.chord(72) + self.chord(84)), 20, .18, voice))
            elif kind in ("think", "text"):
                self.accents.extend((p, 14, 1.2, voice) for p in self.chord(60))
            elif kind == "done":
                chord = self.chord(60)
                self.accents.extend((p, v, d, voice) for p, v, d in
                                    ((self.chord(48)[0], 36, 1.8), (chord[1], 38, 1.6), (chord[2], 38, 1.6), (self.chord(72)[0], 44, 2.0)))
        if self.last_step == now:
            # Agents pause while the model streams; keep the phrase alive meanwhile.
            self.until = max(self.until, now + min(10, 4 + math.log2(1 + len(events))))
            self.next_pulse = min(self.next_pulse, now)

    def signal(self, kind, now):
        """Short motifs that mean something: waiting for you, error, tests, shipped."""
        if now - self.last_accent.get(("signal", kind), -9) < 2:
            return
        self.last_accent[("signal", kind)] = now
        tonic = self.chord(60)
        if kind == "wait":  # gentle bell, rising: "your turn"
            self.accents += [(p, 46, 1.6 - i * .2, 5) for i, p in enumerate((tonic[0] + 24, tonic[1] + 24, tonic[2] + 24))]
            self.accents += [(tonic[0] + 36, 40, 1.8, 7)]
        elif kind in ("fail", "testfail"):  # dark: low diminished tremolo + timpani
            low = self.chord(36)[0]
            weight = 1.3 if kind == "testfail" else 1.0
            self.accents += [(p, int(40 * weight), 1.4, TREMOLO) for p in (low + 12, low + 15, low + 18)]
            self.accents += [(low, int(55 * weight), 1.0, TIMPANI)]
        elif kind == "pass":  # small victory: horn arpeggio up
            self.accents += [(p, 48, .5 + i * .2, 6) for i, p in enumerate(tonic + [tonic[0] + 12])]
        elif kind == "ship":  # fanfare: horn + strings chord, crash, timpani
            self.accents += [(p, 55, 1.6, 6) for p in tonic + [tonic[0] + 12]]
            self.accents += [(p, 40, 1.8, 1) for p in self.chord(48)]
            self.accents += [(CRASH, 85, 2.0, DRUMS), (self.chord(36)[0], 70, 1.2, TIMPANI)]

    def level(self, path, now=None):
        floor = .6 if path in self.working else .45
        return floor + (1 - floor) * min(1.0, self.energy.get(path, 0) / 2)

    def part(self, voice, melody, bass, scale):
        """Notes one choir voice adds to this beat of the shared theme."""
        pitch, vel, dur = melody
        v = lambda x: max(1, min(127, int(vel * x * scale)))
        if voice == 0:
            return []  # the piano plays the conductor's notes themselves
        if voice == 1:
            return [(p, v(.5), min(3, dur * 3), 1) for p in self.chord(60)] if bass else []
        if voice == 2:
            return [(pitch, v(.55), min(3, dur * 1.3), 2)]
        if voice == 3:
            low = self.chord(36)
            if bass:
                return [(low[0], v(.75), min(3, dur * 2), 3)]
            return [(low[2], v(.5), dur, 3)] if self.arp % 2 else []
        if voice == 4:
            return [(pitch + 12, v(.45), dur, 4)]
        if voice == 5:
            return [(self.chord(84)[self.arp % 3], v(.45), .4, 5)]
        if voice == 6:
            mid = self.chord(48)
            return [(p, v(.45), min(3, dur * 3), 6) for p in (mid[0], mid[2])] if bass else []
        return [(self.chord(60)[(self.arp + 1) % 3], v(.4), min(2, dur * 1.5), 7)]

    def excitement(self, now):
        """Rhythm section that grows with tempo; also sets intensity and key shift."""
        bpm = self.composer.bpm
        target = max(0.0, min(1.0, (bpm - 64) / (128 - 64)))
        if not (now < self.until or self.is_working(now)):
            target = 0.0
        self.intensity += (target - self.intensity) * .08
        level = self.intensity
        self.composer.hold = level > .5  # no song change in the middle of the excitement
        self.bpm_history.append((now, bpm))
        out = []
        # Climax: stay near the top for 3 s -> key up a whole tone, crash + timpani.
        if level > .8:
            self.calm_since = None
            self.peak_since = self.peak_since or now
            if self.shift == 0 and now - self.peak_since > 3:
                self.shift = 2
                out += [(CRASH, 100, 2.5, DRUMS), (self.chord(36)[0] + 2, 90, 1.5, TIMPANI)]
        else:
            self.peak_since = None
            if level < .5:
                self.calm_since = self.calm_since or now
                if self.shift and now - self.calm_since > 4:
                    self.shift = 0
        if level < .45 or now < self.next_drive:
            return out
        self.next_drive = now + 30 / bpm  # eighth notes
        e = self.eighth % 8
        self.eighth += 1
        vel = lambda base, span: int(base + span * level)
        # No ticking clock: a soft offbeat hat only when really excited.
        if level > .7 and e % 2:
            out.append((OPEN_HAT if level > .9 else HIHAT, vel(4, 22), .08, DRUMS))
        if level > .45 and e % 2 == 0:  # walking bass on the beat: root, fifth, octave, fifth
            low = self.chord(36)
            out.append(((low[0], low[2], low[0] + 12, low[2])[(e // 2) % 4], vel(22, 40), 30 / bpm * 1.8, 0))
        if level > .6 and e in (0, 4):
            out.append((KICK, vel(36, 50), .2, DRUMS))
        if level > .72 and e in (2, 6):
            out.append((SNARE, vel(30, 45), .15, DRUMS))
        if level > .6 and e == 0:  # tremolo strings: tension under the theme
            out += [(p, vel(15, 35), 30 / bpm * 8, TREMOLO) for p in self.chord(48)]
        if level > .7 and e == 0:
            out.append((self.chord(36)[0], vel(25, 50), .6, TIMPANI))
        # Rising fast? A short timpani roll into the next bar.
        then = [b for t, b in self.bpm_history if now - t <= 2]
        if then and bpm - then[0] > 10 and level > .45 and e >= 6:
            out += [(self.chord(36)[0], vel(30, 40), .12, TIMPANI)]
        return out

    def tick(self, now):
        dt = 0 if self.last_tick is None else max(0, now - self.last_tick)
        self.last_tick = now
        decay = 0.5 ** (dt / 4)
        for path in self.energy:
            self.energy[path] *= decay
        self.active(now)
        if self.is_working(now):
            self.until = max(self.until, now + 1)
        if now < self.until and now >= self.next_pulse:
            # Fresh steps pulse twice a second; a long think pulses calmly.
            calm = now - self.last_step > 5
            self.composer.typed(now, "# think" if calm else self.hint, completed=True)
            self.next_pulse = now + (1.2 if calm else .5)
        notes = self.composer.tick(now)
        accents, self.accents = self.accents, []
        drive = self.excitement(now)
        if not notes:
            return self.finish(accents + drive)
        song = hasattr(self.composer, "score")
        melody = notes[0] if song else notes[-1]
        others = [n for n in notes if n is not melody]
        bass = min(others, key=lambda n: n[0]) if others else None
        if bass:
            self.root = bass[0]
        owners = {voice % len(VOICES): path for path, voice in self.slots.items()}
        piano = owners.get(0)
        loudest = max((self.level(p) for p in self.slots), default=.6)
        scale = self.level(piano) if piano else loudest * .85
        out = [(p, max(1, int(v * scale)), d, 0) for p, v, d in notes]
        for voice, path in sorted(owners.items()):
            out.extend(self.part(voice, melody, bass, self.level(path)))
        self.arp += 1
        if self.intensity > .6:  # louder piano melody doubled an octave up
            out.append((melody[0] + 12, int(melody[1] * .5 * scale), melody[2], 0))
        return self.finish(out + accents + drive)

    def finish(self, notes):
        """Gain (louder when excited), key shift for pitched voices, MIDI range."""
        gain = GAIN * (1 + .35 * self.intensity)
        result = []
        for p, v, d, voice in notes:
            if voice != DRUMS:
                p += self.shift
            result.append((max(0, min(127, p)), min(120, max(1, int(v * gain))), d, voice))
        return result


def load_position(song, path=STATE):
    """(playlist index, note position) saved for this song choice."""
    try:
        value = json.loads(path.read_text()).get(song, 0)
        return (int(value[0]), int(value[1])) if isinstance(value, list) else (0, int(value))
    except (OSError, ValueError, AttributeError, TypeError, IndexError):
        return (0, 0)


def where(music):
    composer = music.composer
    return [composer.index, composer.position] if hasattr(composer, "position") else None


def write_status(music, now, muted, path=STATUS):
    """Small JSON for the menu bar indicator. Atomic replace; errors are ignored."""
    composer = music.composer
    data = {"pid": os.getpid(), "updated": time.time(), "muted": muted,
            "playing": now < music.until or music.is_working(now),
            "sessions": len(music.sessions), "working": sum(1 for _ in music.working),
            "voices": music.voices(), "bpm": round(composer.bpm),
            "intensity": round(music.intensity, 2), "climax": bool(music.shift),
            "song": TITLES.get(getattr(composer, "song", ""), "Özgün melodi")}
    try:
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps(data, ensure_ascii=False))
        tmp.replace(path)
    except OSError:
        pass


def read_commands(path=COMMANDS):
    """Commands dropped by the menu bar (one per line): mute, unmute, next."""
    try:
        text = path.read_text()
        path.unlink()
    except OSError:
        return []
    return [line.strip() for line in text.splitlines() if line.strip()]


def save_position(song, position, path=STATE):
    try:
        data = json.loads(path.read_text()) if path.exists() else {}
        data[song] = position
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(data))
    except (OSError, ValueError, TypeError):
        pass


class GlobalReporter:
    """Opt-in: send step counts (never content) to an Agent Orchestra server once a second."""

    STEPS = {"edit", "bash", "read", "tool", "think", "text", "done"}

    @staticmethod
    def connection(url):
        import urllib.parse
        parsed = urllib.parse.urlsplit(url)
        if parsed.scheme not in ("http", "https") or not parsed.hostname or parsed.username or parsed.password:
            raise ValueError("Orkestra adresi geçerli bir http/https URL olmalı.")
        pair = urllib.parse.parse_qs(parsed.fragment).get("pair", [None])[0]
        if pair and (len(pair) != 48 or any(c not in "0123456789abcdef" for c in pair)):
            raise ValueError("Eşleştirme anahtarı geçersiz; tarayıcıdan yeni bağlantı oluştur.")
        return urllib.parse.urlunsplit((parsed.scheme, parsed.netloc, parsed.path.rstrip("/") + "/api/play", "", "")), pair

    def __init__(self, url, music):
        import secrets
        import urllib.request
        self.url, self.pair = self.connection(url)
        self.request = urllib.request
        self.music = music
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
        self.activity = {k: 0 for k in ("edit", "bash", "read", "think", "done")}
        self.failed = False
        self.stop = threading.Event()
        threading.Thread(target=self.loop, daemon=True).start()

    @staticmethod
    def tool_of(path):
        return "codex" if "/.codex/" in str(path) else "claude"

    def add(self, events):
        with self.lock:
            for path, kind in events:
                if kind in self.STEPS:
                    self.steps += 1
                    activity = kind if kind in self.activity else "think"
                    self.activity[activity] += 1
                elif kind in ("ship", "pass", "fail", "testfail") and len(self.signals) < 4:
                    self.signals.append("fail" if kind == "testfail" else kind)

    def loop(self):
        quiet = 0
        while not self.stop.wait(1):
            now = time.monotonic()
            with self.lock:
                steps, signals = self.steps, self.signals
                self.steps, self.signals = 0, []
                activity, self.activity = self.activity, {k: 0 for k in self.activity}
            working = self.music.is_working(now)
            quiet = 0 if steps or working else quiet + 1
            if quiet and quiet % 10 and self.seat is not None:  # idle: heartbeat every 10 s keeps the seat
                continue
            tools = {}
            for path in list(self.music.sessions):
                tool = self.tool_of(path)
                tools[tool] = tools.get(tool, 0) + 1
            body = json.dumps({"id": self.id, "steps": steps, "signals": signals, "working": working,
                               "sessions": len(self.music.sessions), "tools": tools,
                               "activity": activity, "pair": self.pair}).encode()
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
                    print(f"Dünya orkestrası: {seat.get('section')} bölümü, {seat.get('seat', 0) + 1}. koltuk · "
                          f"{seat.get('players')} makine", flush=True)
                self.seat = seat
                self.failed = False
            except (OSError, ValueError) as exc:
                if not self.failed:
                    print("Orkestra bağlantısı kurulamadı. Sunucu adresini kontrol et; yeniden denenecek.", flush=True)
                self.failed = True
                self.seat = None


def run(silent=False, duration=None, song="karisik", roots=ROOTS, global_url=None):
    print("CODE SONATA · Bütün Claude / Codex oturumları dinleniyor", flush=True)
    watcher = AgentWatcher(roots)
    print(f"{len(watcher.offsets)} aktif oturum kaydı bulundu. Geçmiş sessiz, yeni adımlar çalacak.\n"
          "G: sesi aç/kapat · Q veya Ctrl+C: durdur", flush=True)
    piano = None if silent else Piano()
    if piano and piano.error:
        print(f"Ses açılamadı: {piano.error}", file=sys.stderr)
        return 1
    print("Dinleme hazır.", flush=True)
    print(f"Melodi: {song}", flush=True)
    real = tuple(map(Path, roots)) == tuple(ROOTS)  # demo/test runs never touch the real position or menu bar
    music = AgentMusic(song, position=load_position(song) if real else (0, 0))
    last_save = time.monotonic()
    reporter = GlobalReporter(global_url, music) if global_url else None
    inbox = queue.Queue(maxsize=64)
    stop = threading.Event()

    def monitor():
        while not stop.wait(.2):
            try:
                events = watcher.poll(time.monotonic())
            except OSError as exc:
                print(f"İzleme: {exc}", file=sys.stderr, flush=True)
                continue
            if events:
                try:
                    inbox.put_nowait(events)
                except queue.Full:
                    pass  # music is behind; dropping steps is fine

    thread = threading.Thread(target=monitor, daemon=True)
    terminal = None
    muted = silent
    started = time.monotonic()
    last_report = 0.0
    counts = {}
    result = 0
    try:
        if sys.stdin.isatty():
            terminal = termios.tcgetattr(sys.stdin)
            tty.setcbreak(sys.stdin.fileno())
        thread.start()
        while duration is None or time.monotonic() - started < duration:
            now = time.monotonic()
            if terminal and select.select([sys.stdin], [], [], 0)[0]:
                key = os.read(sys.stdin.fileno(), 1).lower()
                if key == b"q":
                    break
                if key == b"g":
                    muted = not muted
                    if piano:
                        piano.send("quiet")
                    print("Sessiz" if muted else "Piyano açık", flush=True)
            batch = []
            while True:
                try:
                    batch.extend(inbox.get_nowait())
                except queue.Empty:
                    break
            if batch:
                music.accept(batch, now)
                if reporter:
                    reporter.add(batch)
                for _, kind in batch:
                    counts[kind] = counts.get(kind, 0) + 1
            if counts and now - last_report >= 3:
                summary = " ".join(f"{k}:{v}" for k, v in sorted(counts.items()))
                title = TITLES.get(getattr(music.composer, "song", ""), "özgün")
                if music.shift:
                    title += " · DORUK (+1 ton)"
                elif music.intensity > .3:
                    title += f" · heyecan %{music.intensity * 100:.0f}"
                print(f"♫ {music.active(now)} oturum · {', '.join(music.voices())} · {title} · "
                      f"{music.composer.bpm:.0f} BPM · {summary}", flush=True)
                counts, last_report = {}, now
            notes = music.tick(now)
            if now - last_save > 1:
                for command in (read_commands() if real else []):
                    if command in ("mute", "unmute", "toggle"):
                        muted = {"mute": True, "unmute": False}.get(command, not muted)
                        if piano:
                            piano.send("quiet")
                    elif command == "wait":
                        music.signal("wait", now)
                    elif command == "next" and hasattr(music.composer, "next_song"):
                        music.composer.next_song()
                        print(f"Şarkı: {TITLES[music.composer.song]}", flush=True)
                if real:
                    write_status(music, now, muted)
                if real and where(music):
                    save_position(song, where(music))
                last_save = now
            if piano and not muted:
                piano.play(notes)
                if piano.error:
                    print(piano.error, file=sys.stderr)
                    result = 1
                    break
            time.sleep(.025)
    except KeyboardInterrupt:
        pass
    finally:
        stop.set()
        if reporter:
            reporter.stop.set()
        if real and where(music):
            save_position(song, where(music))
        if real:
            try:
                STATUS.unlink()
            except OSError:
                pass
        if thread.ident is not None:
            thread.join(timeout=2)
        if piano:
            piano.close()
        if terminal:
            termios.tcsetattr(sys.stdin, termios.TCSADRAIN, terminal)
    print("Dinleme durdu.", flush=True)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--silent", action="store_true", help="Ses çıkarmadan adımları göster")
    parser.add_argument("--duration", type=float, help="Belirtilen saniye sonra dur (deneme için)")
    parser.add_argument("--song", choices=CHOICES, default="karisik", help="Melodi (karisik: sırayla hepsi)")
    parser.add_argument("--roots", nargs="+", type=Path, default=ROOTS, help=argparse.SUPPRESS)
    parser.add_argument("--global", dest="global_url", metavar="URL",
                        help="Dünya orkestrasına katıl (yalnızca adım sayısı gönderilir)")
    args = parser.parse_args()
    if args.duration is not None and args.duration <= 0:
        parser.error("Süre sıfırdan büyük olmalı.")
    if args.global_url:
        try:
            GlobalReporter.connection(args.global_url)
        except ValueError as exc:
            parser.error(str(exc))
    CACHE.mkdir(parents=True, exist_ok=True)
    return run(args.silent, args.duration, args.song, args.roots, args.global_url)


if __name__ == "__main__":
    sys.exit(main())
