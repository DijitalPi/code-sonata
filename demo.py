#!/usr/bin/env python3
"""Zero-token orchestra demo: fake Claude sessions write transcript lines, the real listener plays them.

No model is called. Sessions join one by one (piano, strings, choir, ...), work with
pauses like a real turn (prompt, thinking, tools, long think, done) and leave.

    python3 demo.py                 # 8 sessions, ~70 s, its own listener
    python3 demo.py --sessions 3 --silent
    python3 demo.py --style 8bit    # the same with another arrangement
    python3 demo.py --live          # the music that is already on plays a scripted show (~85 s)

--live writes its fake sessions into a temporary folder under ~/.claude/projects, so the running
listener ("kod müziğini aç") hears them, and deletes that folder at the end.
"""
import argparse
import json
from pathlib import Path
import random
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time

ROOT = Path(__file__).resolve().parent
TOOLS = ("Edit", "Bash", "Read", "Grep", "Write", "Bash", "Read")
LIVE = Path.home() / ".claude/projects/-code-sonata-demo"
CACHE = Path.home() / "Library/Caches/code-sonata"


class Transcript:
    """One fake Claude Code session log, in the shapes the reader understands."""

    def __init__(self, path):
        self.path, self.calls, self.open = path, 0, True

    def write(self, entry):
        with self.path.open("a") as stream:
            stream.write(json.dumps(entry) + "\n")

    def prompt(self):
        self.write({"type": "user", "message": {"content": "demo"}})

    def think(self):
        self.write({"type": "assistant", "message": {"content": [{"type": "thinking"}], "stop_reason": None}})

    def tool(self, name, command=None, output="ok", error=False):
        self.calls += 1
        call = f"{self.path.stem}-{self.calls}"
        block = {"type": "tool_use", "name": name, "id": call}
        if command:
            block["input"] = {"command": command}
        self.write({"type": "assistant", "message": {"content": [block], "stop_reason": "tool_use"}})
        self.write({"type": "user", "message": {"content": [{"type": "tool_result", "tool_use_id": call, "is_error": error, "content": output}]}})

    def done(self):
        if self.open:
            self.open = False
            self.write({"type": "assistant", "message": {"content": [{"type": "text"}], "stop_reason": "end_turn"}})


def session(path, start, rng, stop):
    if stop.wait(start):
        return
    log = Transcript(path)
    log.prompt()
    for step in range(rng.randint(8, 14)):
        if stop.is_set():
            return
        if step % 3 == 0:
            log.think()
        else:
            log.tool(rng.choice(TOOLS))
        # Mostly quick steps, sometimes a long think (the music must not stop).
        if stop.wait(rng.choice((.8, 1.2, 1.5, 2, 6))):
            return
    log.done()


def show(stop, started, logs):
    """The --live script: six sessions join, a test passes, a test breaks, a commit lands, Claude
    waits for you, everyone speeds up to the climax, then they finish one by one."""
    rng = random.Random(3)
    clock = lambda: time.monotonic() - started
    say = lambda text: print(f"{int(clock()) // 60}:{int(clock()) % 60:02d}  {text}", flush=True)
    events = {16: (1, "pass"), 26: (2, "testfail"), 34: (3, "ship")}
    done_at = {i: 68 + 2.5 * i for i in range(6)}

    def player(i):
        if stop.wait(6 * i):
            return
        log = Transcript(LIVE / f"demo-{i}.jsonl")
        logs.append(log)
        log.prompt()
        say(f"{i + 1}. sahte oturum katıldı (sıradaki boş enstrümana oturur)")
        fired = set()
        while not stop.is_set() and clock() < done_at[i]:
            now = clock()
            for at, (who, kind) in events.items():
                if who == i and now >= at and at not in fired:
                    fired.add(at)
                    if kind == "pass":
                        log.tool("Bash", "pytest -q", "===== 34 passed in 1.2s =====")
                        say(f"{i + 1}. oturum: testler geçti, yükselen korno")
                    elif kind == "testfail":
                        log.tool("Bash", "npm test", "Tests: 2 failed, 30 passed", error=True)
                        say(f"{i + 1}. oturum: test kırıldı, kısa koyu akor")
                    else:
                        log.tool("Bash", "git commit -m demo", "[main 1a2b3c4] demo\n 1 file changed")
                        say(f"{i + 1}. oturum: commit başarılı, fanfar")
            roll = rng.random()
            if roll < .25:
                log.think()
            elif roll < .5:
                log.tool("Bash", "ls")
            else:
                log.tool(rng.choice(("Edit", "Read", "Grep", "Write")))
            fast = 45 <= now < 66   # everyone speeds up: the climax
            if stop.wait(rng.uniform(.18, .32) if fast else rng.uniform(.9, 1.6)):
                return
        log.done()
        say(f"{i + 1}. oturum bitirdi")

    threads = [threading.Thread(target=player, args=(i,), daemon=True) for i in range(6)]
    for thread in threads:
        thread.start()
    if not stop.wait(40):
        with (CACHE / "commands").open("a") as stream:
            stream.write("wait\n")   # what the Claude Code Notification hook sends
        say("Claude cevabını bekliyor, çan")
    if not stop.wait(5):
        say("herkes hızlanıyor: doruk geliyor")
    for thread in threads:
        while thread.is_alive() and not stop.wait(.2):
            pass
    say("son oturum bitti: kapanış akoru")


def live():
    try:
        status = json.loads((CACHE / "status.json").read_text())
        running = time.time() - status["updated"] < 5
    except (OSError, ValueError, KeyError):
        running = False
    if not running:
        print("Kod müziği kapalı. Önce aç (\"kod müziğini aç\" ya da control.py start), sonra yeniden dene.", file=sys.stderr)
        return 1
    if status.get("muted"):
        print("Not: kod müziği sessizde; menü çubuğundaki ♫ ile sesi aç.", flush=True)
    print("Canlı deneme: çalan dinleyiciye 6 sahte oturum, yaklaşık 85 sn. Durdurmak için Ctrl+C.", flush=True)
    LIVE.mkdir(parents=True, exist_ok=True)
    stop, logs = threading.Event(), []

    def interrupted(*_):
        raise KeyboardInterrupt
    for sig in (signal.SIGTERM, signal.SIGHUP):
        signal.signal(sig, interrupted)
    try:
        show(stop, time.monotonic(), logs)
        time.sleep(4)   # let the closing chord ring before the folder goes
    except KeyboardInterrupt:
        stop.set()
        print("Durduruldu.", flush=True)
    finally:
        # Stopped halfway, the fake sessions would look busy for two more minutes and keep the music
        # going: every one of them ends its turn before the folder goes.
        for log in logs:
            log.done()
        time.sleep(2.5)   # the listener reads the endings (it polls every 0.2 s, folders every 2 s)
        shutil.rmtree(LIVE, ignore_errors=True)
    return 0


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--sessions", type=int, default=8)
    parser.add_argument("--gap", type=float, default=5, help="Saniye: oturumlar arası katılım")
    parser.add_argument("--song", default="karisik")
    parser.add_argument("--style", help="klasik, 8bit, sinema, lofi, synthwave")
    parser.add_argument("--silent", action="store_true")
    parser.add_argument("--live", action="store_true", help="Açık olan kod müziğine sahte oturumlarla gösteri çal")
    args = parser.parse_args()
    if args.live:
        return live()
    rng = random.Random(7)
    with tempfile.TemporaryDirectory() as temp:
        root = Path(temp)
        duration = args.sessions * args.gap + 45
        command = [sys.executable, str(ROOT / "agents.py"), "--roots", str(root), "--song", args.song,
                   "--duration", str(duration)] + (["--silent"] if args.silent else []) + (["--style", args.style] if args.style else [])
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
