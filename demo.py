#!/usr/bin/env python3
"""Zero-token orchestra demo: fake Claude sessions write transcript lines, the real listener plays them.

No model is called. Sessions join one by one (piano, strings, choir, ...), work with
pauses like a real turn (prompt, thinking, tools, long think, done) and leave.

    python3 demo.py                 # 8 sessions, ~70 s, audible
    python3 demo.py --sessions 3 --silent
"""
import argparse
import json
from pathlib import Path
import random
import subprocess
import sys
import tempfile
import threading
import time

ROOT = Path(__file__).resolve().parent
TOOLS = ("Edit", "Bash", "Read", "Grep", "Write", "Bash", "Read")


def line(kind, name=None):
    if kind == "user":
        return {"type": "user", "message": {"content": "demo"}}
    if kind == "tool":
        return {"type": "assistant", "message": {"content": [{"type": "tool_use", "name": name}], "stop_reason": "tool_use"}}
    if kind == "think":
        return {"type": "assistant", "message": {"content": [{"type": "thinking"}], "stop_reason": None}}
    return {"type": "assistant", "message": {"content": [{"type": "text"}], "stop_reason": "end_turn"}}


def session(path, start, rng, stop):
    if stop.wait(start):
        return
    def write(entry):
        with path.open("a") as stream:
            stream.write(json.dumps(entry) + "\n")
    write(line("user"))
    for step in range(rng.randint(8, 14)):
        if stop.is_set():
            return
        write(line("think") if step % 3 == 0 else line("tool", rng.choice(TOOLS)))
        if step % 3 != 0:
            write(line("user"))  # tool result
        # Mostly quick steps, sometimes a long think (the music must not stop).
        if stop.wait(rng.choice((.8, 1.2, 1.5, 2, 6))):
            return
    write(line("done"))


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--sessions", type=int, default=8)
    parser.add_argument("--gap", type=float, default=5, help="Saniye: oturumlar arası katılım")
    parser.add_argument("--song", default="karisik")
    parser.add_argument("--silent", action="store_true")
    args = parser.parse_args()
    rng = random.Random(7)
    with tempfile.TemporaryDirectory() as temp:
        root = Path(temp)
        duration = args.sessions * args.gap + 45
        command = [sys.executable, str(ROOT / "agents.py"), "--roots", str(root), "--song", args.song,
                   "--duration", str(duration)] + (["--silent"] if args.silent else [])
        listener = subprocess.Popen(command, stdin=subprocess.DEVNULL)
        time.sleep(1.5)  # listener's first scan
        stop = threading.Event()
        threads = []
        for i in range(args.sessions):
            path = root / f"demo-{i}.jsonl"
            path.touch()
            thread = threading.Thread(target=session, args=(path, i * args.gap, rng, stop), daemon=True)
            thread.start()
            threads.append(thread)
        try:
            listener.wait()
        except KeyboardInterrupt:
            stop.set()
            listener.terminate()
            listener.wait()
    return 0


if __name__ == "__main__":
    sys.exit(main())
