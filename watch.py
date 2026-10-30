#!/usr/bin/env python3
"""Read-only project watcher: turn saved code changes into piano phrases."""
import argparse
from collections import deque
from dataclasses import dataclass
import math
import os
from pathlib import Path
import queue
import re
import select
import sys
import termios
import threading
import time
import tty

from sonata import Composer, Piano, stop_on_term
from melodies import CHOICES, SongComposer

EXTENSIONS = {".py", ".pyw", ".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs",
              ".swift", ".go", ".rs", ".c", ".h", ".cpp", ".hpp", ".cs", ".java",
              ".kt", ".kts", ".rb", ".php", ".dart", ".vue", ".svelte", ".html",
              ".css", ".scss", ".sql", ".sh", ".zsh", ".lua", ".ex", ".exs"}
EXCLUDED = {"node_modules", "vendor", "build", "dist", "target", "coverage", "venv",
            "env", "__pycache__", "Pods", "DerivedData", "sessions"}
MAX_BYTES = 256 * 1024


@dataclass
class Change:
    path: Path
    lines: list[str]
    count: int
    deleted: bool = False


def changed_lines(before, after):
    """Linear, bounded-cost comparison; sample large replaced blocks."""
    old, new = before.splitlines(), after.splitlines()
    start = 0
    while start < min(len(old), len(new)) and old[start] == new[start]:
        start += 1
    end_old, end_new = len(old), len(new)
    while end_old > start and end_new > start and old[end_old - 1] == new[end_new - 1]:
        end_old -= 1
        end_new -= 1
    count = max(end_old - start, end_new - start)
    lines = new[start:end_new] or old[start:end_old]
    if len(lines) > 24:
        lines = [lines[i * (len(lines) - 1) // 23] for i in range(24)]
    return lines, count


class ProjectWatcher:
    def __init__(self, root, settle=0.35, max_files=2000):
        self.root = root.resolve()
        self.settle = settle
        self.max_files = max_files
        self.baseline = {}
        self.pending = {}
        self.skipped = 0
        self.scan_error = ""
        for path, signature in self.inventory().items():
            text = self.read(path, signature)
            if text is not None:
                self.baseline[path] = (signature, text)

    def inventory(self):
        found = {}
        self.skipped = 0
        self.scan_error = ""
        if not self.root.is_dir():
            raise OSError(f"Proje klasörüne erişilemiyor: {self.root}")

        def onerror(error):
            self.scan_error = str(error)

        for folder, dirs, files in os.walk(self.root, followlinks=False, onerror=onerror):
            dirs[:] = sorted(d for d in dirs if not d.startswith(".") and d not in EXCLUDED
                             and not (Path(folder) / d).is_symlink())
            for name in sorted(files):
                path = Path(folder) / name
                if name.startswith(".") or path.suffix.lower() not in EXTENSIONS or name.endswith((".min.js", ".min.css", ".d.ts")):
                    continue
                try:
                    if path.is_symlink():
                        continue
                    stat = path.stat()
                    if not path.is_file() or stat.st_size > MAX_BYTES:
                        self.skipped += 1
                        continue
                    if len(found) >= self.max_files:
                        raise RuntimeError(f"{self.max_files} kod dosyası sınırı aşıldı. Daha dar bir proje klasörü seç.")
                    found[path] = (stat.st_mtime_ns, stat.st_ctime_ns, stat.st_size, stat.st_ino)
                except OSError as exc:
                    self.scan_error = str(exc)
        return found

    @staticmethod
    def read(path, signature):
        try:
            # Avoid following a symlink swapped in between scan and read.
            fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
            with os.fdopen(fd, "rb") as stream:
                stat = os.fstat(stream.fileno())
                if (stat.st_mtime_ns, stat.st_ctime_ns, stat.st_size, stat.st_ino) != signature:
                    return None
                data = stream.read(MAX_BYTES + 1)
            if len(data) > MAX_BYTES or b"\x00" in data:
                return None
            return data.decode("utf-8")
        except (OSError, UnicodeError):
            return None

    def poll(self, now):
        current = self.inventory()
        # Do not turn an unreadable directory into a musical mass deletion.
        if self.scan_error:
            return []
        changes = []
        for path in sorted(set(current) | set(self.baseline)):
            signature = current.get(path)
            previous, old = self.baseline.get(path, (None, ""))
            if signature == previous:
                self.pending.pop(path, None)
                continue
            pending = self.pending.get(path)
            if pending is None or pending[0] != signature:
                self.pending[path] = (signature, now)
                continue
            if now - pending[1] < self.settle:
                continue
            new = "" if signature is None else self.read(path, signature)
            if new is None:
                continue
            self.pending.pop(path, None)
            if signature is None:
                self.baseline.pop(path, None)
            else:
                self.baseline[path] = (signature, new)
            if new != old:
                lines, count = changed_lines(old, new)
                if count:
                    changes.append(Change(path.relative_to(self.root), lines, count, signature is None))
        return changes


def musical_line(line):
    """Normalize common language constructs for the shared composer."""
    line = line.strip()
    function = re.search(r"\b(?:def|func|fn|function)\s+([\w$]+)", line)
    arrow = re.search(r"\b(?:const|let|var)\s+([\w$]+)\s*=.*=>", line)
    if function or arrow:
        return "def " + (function or arrow).group(1)
    if re.match(r"(?:for|while|foreach|loop)\b", line):
        return "for item"
    if re.match(r"(?:if|else|elif|switch|case|match|when)\b", line):
        return "if condition"
    if re.match(r"(?:return|throw|raise|break|pass)\b", line):
        return "return"
    return line or "# blank"


class ChangeMusic:
    def __init__(self, song="original"):
        self.composer = Composer() if song == "original" else SongComposer(song)
        self.phrase = deque(maxlen=24)
        self.until = -1.0
        self.next_pulse = 0.0
        self.strength = 2

    def accept(self, changes, now):
        total = sum(c.count for c in changes)
        self.strength = min(9, 2 + int(math.log2(max(1, total))))
        self.until = now + min(8, 2.5 + math.log2(1 + total))
        # Replace stale queued material: a large patch never causes minutes of backlog.
        self.phrase.clear()
        for change in changes:
            if change.deleted:
                self.phrase.append("return")
            else:
                self.phrase.extend(musical_line(line) for line in change.lines)
        self.next_pulse = min(self.next_pulse, now)

    def tick(self, now):
        if now < self.until and now >= self.next_pulse:
            line = self.phrase.popleft() if self.phrase else "# continuation"
            for _ in range(self.strength):
                self.composer.typed(now, line, completed=True)
            self.next_pulse = now + .5
        return self.composer.tick(now)


def run(root, silent=False, duration=None, song="bella-ciao"):
    print(f"CODE SONATA · Proje dinleniyor\n{root}", flush=True)
    watcher = ProjectWatcher(root)
    print(f"{len(watcher.baseline)} kod dosyası hazır. İlk tarama sessizdir.\n"
          "Codex / Claude ile normal çalışabilirsin. Kaydedilen değişiklikler çalacak.\n"
          "G: sesi aç/kapat · Q veya Ctrl+C: durdur", flush=True)
    piano = None if silent else Piano()
    if piano and piano.error:
        print(f"Ses açılamadı: {piano.error}", file=sys.stderr)
        return 1
    stop_on_term()   # before "ready": control.py may stop the listener right after it
    print("Dinleme hazır.", flush=True)
    print(f"Melodi: {song}", flush=True)
    music = ChangeMusic(song)
    inbox = queue.Queue(maxsize=8)
    stop = threading.Event()

    def monitor():
        last_warning = ""
        try:
            while not stop.wait(.2):
                changes = watcher.poll(time.monotonic())
                warning = watcher.scan_error or (f"{watcher.skipped} büyük dosya atlandı." if watcher.skipped else "")
                if changes or warning != last_warning:
                    item = (changes, warning)
                    while not stop.is_set():
                        try:
                            inbox.put(item, timeout=.2)
                            break
                        except queue.Full:
                            continue
                    last_warning = warning
        except (OSError, RuntimeError) as exc:
            while not stop.is_set():
                try:
                    inbox.put(exc, timeout=.2)
                    return
                except queue.Full:
                    continue

    thread = threading.Thread(target=monitor, daemon=True)
    terminal = None
    muted = silent
    started = time.monotonic()
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
                    item = inbox.get_nowait()
                except queue.Empty:
                    break
                if isinstance(item, Exception):
                    print(str(item), file=sys.stderr)
                    result = 1
                    stop.set()
                    break
                changes, warning = item
                batch.extend(changes)
                if warning:
                    print(f"İzleme: {warning}", flush=True)
            if stop.is_set():
                break
            if batch:
                music.accept(batch, now)
                paths = ", ".join(str(c.path) for c in batch[:3])
                if len(batch) > 3:
                    paths += f" ve {len(batch) - 3} dosya"
                print(f"♫ {paths} · {sum(c.count for c in batch)} satırlık değişim", flush=True)
            notes = music.tick(now)
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
        if thread.ident is not None:
            thread.join(timeout=2)
        if piano:
            piano.close()
        if terminal:
            termios.tcsetattr(sys.stdin, termios.TCSADRAIN, terminal)
    print("Dinleme durdu. Proje dosyaları değiştirilmedi.", flush=True)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("project", nargs="?", type=Path, default=Path.cwd(), help="İzlenecek proje klasörü")
    parser.add_argument("--silent", action="store_true", help="Ses çıkarmadan değişiklikleri göster")
    parser.add_argument("--duration", type=float, help="Belirtilen saniye sonra dur (deneme için)")
    parser.add_argument("--song", choices=CHOICES, default="bella-ciao", help="Piyano melodisi")
    args = parser.parse_args()
    root = args.project.expanduser().resolve()
    if not root.is_dir():
        parser.error(f"Klasör bulunamadı: {root}")
    if root in (Path.home(), Path(root.anchor)):
        parser.error("Ana dizin yerine üzerinde çalıştığın proje klasörünü seç.")
    if args.duration is not None and args.duration <= 0:
        parser.error("Süre sıfırdan büyük olmalı.")
    try:
        return run(root, args.silent, args.duration, args.song)
    except (OSError, RuntimeError) as exc:
        print(f"İzleme başlatılamadı: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
