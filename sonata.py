#!/usr/bin/env python3
"""Code Sonata: a local, musical Python scratchpad for macOS."""
import argparse
from collections import deque
from datetime import datetime
import hashlib
import os
from pathlib import Path
import re
import select
import signal
import subprocess
import tempfile
import threading
import time

ROOT = Path(__file__).resolve().parent


class Composer:
    """A pentatonic melody over slow C / Am / F / G harmony."""

    CHORDS = ((48, 52, 55), (45, 48, 52), (41, 45, 48), (43, 47, 50))
    SCALE = (60, 62, 64, 67, 69, 72, 74, 76)

    def __init__(self):
        self.events = deque()
        self.bpm = 64.0
        self.last_tick = None
        self.last_input = -100.0
        self.next_note = 0.0
        self.step = 0
        self.mode = "melody"
        self.motif = 0
        self.cadence = False

    def typed(self, now, line, completed=False):
        self.events.append(now)
        self.last_input = now
        stripped = line.strip()
        match = re.match(r"(?:async\s+)?def\s+(\w+)", stripped)
        if match:
            self.motif = hashlib.sha256(match[1].encode()).digest()[0] % 5
            self.mode = "function"
        elif re.match(r"(for|while)\b", stripped):
            self.mode = "loop"
        elif re.match(r"(if|elif|else|match|case)\b", stripped):
            self.mode = "branch"
        elif stripped.startswith(("return", "pass", "raise")) or (completed and not stripped):
            if self.mode != "resolve":
                self.cadence = True
            self.mode = "resolve"
        elif completed:
            self.mode = "melody"

    # Notes go out this early, stamped with their exact time; the piano plays them on time, so
    # the 25 ms loop adds neither jitter nor drift.
    LOOKAHEAD = 0.06

    def due(self, now):
        """Follow the tempo; return the exact time of the next note when it is due, else None."""
        dt = min(0.2, max(0, now - self.last_tick)) if self.last_tick is not None else 0.03
        self.last_tick = now
        while self.events and self.events[0] < now - 4:
            self.events.popleft()
        target = min(140, 55 + len(self.events) / 4 * 11)
        self.bpm += (target - self.bpm) * (1 - pow(2.718281828, -dt / 1.7))
        if now - self.last_input > 1.6:
            self.next_note = now
            return None
        if self.next_note < now - 0.25:  # back from a pause: start on time, do not catch up
            self.next_note = now
        if now < self.next_note - self.LOOKAHEAD:
            return None
        return self.next_note

    def tick(self, now):
        at = self.due(now)
        if at is None:
            return []
        interval = 30 / self.bpm
        self.next_note = at + interval
        chord = self.CHORDS[(self.step // 16) % len(self.CHORDS)]
        fade = max(0.25, 1 - max(0, now - self.last_input - 0.35) / 1.5)
        velocity = int(53 * fade)
        notes = []
        if self.cadence:
            notes = [(48, 37, 1.6, 0, at), (64, 43, 1.4, 0, at), (72, 46, 1.8, 0, at)]
            self.cadence = False
            self.step = 0
            self.next_note = at + interval * 2
            return notes
        if self.step % 8 == 0:
            notes.append((chord[0] - 12, int(33 * fade), interval * 6, 0, at))
        if self.step % 2 == 0:
            notes.append((chord[(self.step // 2) % 3], int(34 * fade), interval * 2.2, 0, at))
        pattern = (0, 2, 1, 4, 2, 1, 3, 2)
        if self.mode == "loop":
            pitch = chord[self.step % 3] + 24
        else:
            index = (pattern[self.step % 8] + self.motif) % len(self.SCALE)
            if self.mode == "branch":
                index = len(self.SCALE) - 1 - index
            pitch = self.SCALE[index]
            if self.step % 4 == 0:
                pitch = chord[(self.step // 4) % 3] + 24
        notes.append((pitch, velocity, interval * 1.65, 0, at))
        self.step += 1
        return notes


def _interrupt(signum, frame):
    raise KeyboardInterrupt


def stop_on_term():
    """`launchctl bootout` stops a listener with SIGTERM, which ends Python without its cleanup (the
    menu bar status stayed behind, the last position was not saved). Treat it like Ctrl+C."""
    if threading.current_thread() is threading.main_thread():
        signal.signal(signal.SIGTERM, _interrupt)


class Piano:
    def __init__(self, soundfont=None, eco=False):
        self.process = None
        self.error = ""
        self.log = tempfile.TemporaryFile(mode="w+")
        env = dict(os.environ)
        if soundfont:  # an SF2/DLS bank instead of the system's General MIDI set
            env["SONATA_SOUNDFONT"] = str(soundfont)
        if eco:        # battery saver: no reverb
            env["SONATA_ECO"] = "1"
        try:
            # SONATA_PIANO: the background listener's engine, built outside protected folders (control.py).
            binary = os.environ.get("SONATA_PIANO") or str(ROOT / ".build/piano")
            self.process = subprocess.Popen([binary], stdin=subprocess.PIPE, env=env,
                                            stdout=subprocess.PIPE, stderr=self.log, text=True, bufsize=1)
            ready, _, _ = select.select([self.process.stdout], [], [], 8)
            if not ready or self.process.stdout.readline().strip() != "READY":
                self.log.seek(0)
                raise RuntimeError(self.log.read().strip() or "Ses motoru başlatılamadı")
        except (OSError, RuntimeError) as exc:
            self.error = str(exc)
            self.close()

    def send(self, command):
        if self.process:
            try:
                self.process.stdin.write(command + "\n")
                self.process.stdin.flush()
            except (BrokenPipeError, OSError):
                self.error = "Ses bağlantısı kapandı; metnini kaydedebilirsin."
                self.close()

    def play(self, notes):
        """Notes are (pitch, velocity, seconds[, voice[, at]]); `at` is a time.monotonic() moment
        the engine waits for, so notes sent a little early start exactly on the beat."""
        now = time.monotonic()
        for note in notes:
            pitch, velocity, duration = note[:3]
            voice = note[3] if len(note) > 3 else 0
            delay = max(0.0, (note[4] - now) * 1000) if len(note) > 4 else 0.0
            self.send(f"{pitch} {velocity} {duration:.3f} {voice} {delay:.1f}")

    def close(self):
        if self.process:
            try:
                self.process.stdin.close()
                self.process.wait(timeout=2)
            except (OSError, subprocess.TimeoutExpired):
                self.process.kill()
                self.process.wait()
            self.process = None


class Document:
    """The editor's text. curses is imported only by the editor, not by the listeners that share Piano."""

    def __init__(self, text=""):
        self.lines = text.split("\n")
        self.row = self.col = 0
        self.dirty = False
        self.history = deque(maxlen=250)

    def edit(self, key):
        import curses
        if key == "\x1a":
            if self.history:
                self.lines, self.row, self.col = self.history.pop()
                self.dirty = True
            return
        self.history.append((self.lines.copy(), self.row, self.col))
        line = self.lines[self.row]
        if key in ("\n", "\r"):
            indent = re.match(r" *", line).group()
            if line[:self.col].rstrip().endswith(":"):
                indent += "    "
            self.lines[self.row:self.row + 1] = [line[:self.col], indent + line[self.col:]]
            self.row += 1
            self.col = len(indent)
        elif key in (curses.KEY_BACKSPACE, "\x7f", "\b"):
            if self.col:
                self.lines[self.row] = line[:self.col - 1] + line[self.col:]
                self.col -= 1
            elif self.row:
                self.col = len(self.lines[self.row - 1])
                self.lines[self.row - 1:self.row + 1] = [self.lines[self.row - 1] + line]
                self.row -= 1
        elif key == curses.KEY_DC:
            if self.col < len(line):
                self.lines[self.row] = line[:self.col] + line[self.col + 1:]
            elif self.row < len(self.lines) - 1:
                self.lines[self.row:self.row + 2] = [line + self.lines[self.row + 1]]
        else:
            value = " " * (4 - self.col % 4) if key == "\t" else key
            self.lines[self.row] = line[:self.col] + value + line[self.col:]
            self.col += len(value)
        self.dirty = True

    def save(self, path):
        path.parent.mkdir(parents=True, exist_ok=True)
        fd, temp = tempfile.mkstemp(prefix=".sonata-", dir=path.parent)
        try:
            if path.exists():
                os.fchmod(fd, path.stat().st_mode & 0o777)
            with os.fdopen(fd, "w") as stream:
                stream.write("\n".join(self.lines))
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temp, path)
            self.dirty = False
        finally:
            if os.path.exists(temp):
                os.unlink(temp)


def editor(screen, doc, path, piano):
    import curses
    curses.raw()
    try:
        curses.curs_set(1)
    except curses.error:
        pass
    screen.timeout(25)
    screen.keypad(True)
    if curses.has_colors():
        curses.start_color()
        curses.use_default_colors()
        for i, color in enumerate((curses.COLOR_CYAN, curses.COLOR_YELLOW, curses.COLOR_GREEN), 1):
            curses.init_pair(i, color, -1)
    composer = Composer()
    muted = False
    message = "Yazmaya başla. Müziğin burada doğacak."
    top = left = 0

    def put(y, x, text, style=0):
        h, w = screen.getmaxyx()
        if 0 <= y < h and 0 <= x < w - 1:
            try:
                screen.addnstr(y, x, text, w - x - 1, style)
            except curses.error:
                pass

    while True:
        now = time.monotonic()
        notes = composer.tick(now)
        if not muted:
            piano.play(notes)
        h, w = screen.getmaxyx()
        screen.erase()
        if h < 9 or w < 48:
            put(0, 0, "Pencereyi büyüt · Ctrl+Q kaydet ve çık")
        else:
            visible = h - 7
            top = max(0, min(top, doc.row))
            if doc.row >= top + visible:
                top = doc.row - visible + 1
            width = w - 9
            left = max(0, min(left, doc.col))
            if doc.col >= left + width:
                left = doc.col - width + 1
            put(0, 2, "C O D E   S O N A T A", curses.A_BOLD | curses.color_pair(1))
            status = "SESSİZ" if muted else "PİYANO"
            put(1, 2, f"{status}   {composer.bpm:3.0f} BPM   ·   Do majör   ·   {composer.mode}")
            put(2, 2, "─" * (w - 5), curses.A_DIM)
            for y, idx in enumerate(range(top, min(len(doc.lines), top + visible)), 3):
                put(y, 1, f"{idx + 1:4} ", curses.A_DIM)
                line = doc.lines[idx]
                color = 3 if line.lstrip().startswith("#") else 2 if re.match(r"\s*(def|class|if|for|while|return)\b", line) else 0
                put(y, 7, line[left:left + width], curses.color_pair(color))
            put(h - 3, 2, piano.error or message, curses.color_pair(1))
            put(h - 2, 2, "^S Kaydet   ^Q Kaydet/Çık   ^G Ses   ^Z Geri al", curses.A_DIM)
            put(h - 1, 2, f"{'●' if doc.dirty else '○'} {path.name}   {doc.row + 1}:{doc.col + 1}", curses.A_DIM)
            screen.move(3 + doc.row - top, 7 + doc.col - left)
        screen.refresh()
        try:
            key = screen.get_wch()
        except curses.error:
            continue
        if key in ("\x13", "\x11", "\x03"):
            try:
                doc.save(path)
                message = f"Kaydedildi: {path.name}"
                if key in ("\x11", "\x03"):
                    return
            except OSError as exc:
                message = f"Kaydedilemedi: {exc}"
        elif key == "\x07":
            muted = not muted
            piano.send("quiet")
        elif key in (curses.KEY_UP, curses.KEY_DOWN):
            doc.row = max(0, min(len(doc.lines) - 1, doc.row + (1 if key == curses.KEY_DOWN else -1)))
            doc.col = min(doc.col, len(doc.lines[doc.row]))
        elif key == curses.KEY_LEFT:
            if doc.col:
                doc.col -= 1
            elif doc.row:
                doc.row -= 1
                doc.col = len(doc.lines[doc.row])
        elif key == curses.KEY_RIGHT:
            if doc.col < len(doc.lines[doc.row]):
                doc.col += 1
            elif doc.row < len(doc.lines) - 1:
                doc.row += 1
                doc.col = 0
        elif key in (curses.KEY_HOME, "\x01"):
            doc.col = 0
        elif key in (curses.KEY_END, "\x05"):
            doc.col = len(doc.lines[doc.row])
        elif key in (curses.KEY_BACKSPACE, curses.KEY_DC, "\x7f", "\b", "\t", "\n", "\r", "\x1a") or (isinstance(key, str) and key.isprintable()):
            old_line = doc.lines[doc.row]
            doc.edit(key)
            if key != "\x1a":
                completed = key in ("\n", "\r")
                composer.typed(now, old_line if completed else doc.lines[doc.row], completed)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("file", nargs="?", type=Path)
    parser.add_argument("--silent", action="store_true", help="Ses motoru olmadan aç")
    args = parser.parse_args()
    path = (args.file or ROOT / "sessions" / datetime.now().strftime("sonata-%Y%m%d-%H%M%S-%f.py")).resolve()
    doc = Document(path.read_text() if path.exists() else "")
    piano = Piano() if not args.silent else Piano.__new__(Piano)
    if args.silent:
        piano.process, piano.error = None, "Sessiz deneme modu"
    import curses
    try:
        curses.wrapper(editor, doc, path, piano)
    finally:
        piano.close()
        if doc.dirty:
            recovery = ROOT / "sessions" / datetime.now().strftime("recovery-%Y%m%d-%H%M%S-%f.py")
            doc.save(recovery)
            print(f"Kurtarma dosyası: {recovery}")
    print(f"Dosyan: {path}")


if __name__ == "__main__":
    main()
