#!/usr/bin/env python3
"""Read-only agent listener: every Claude Code / Codex session on this Mac plays together.

Only the kind of each step (edit, command, read, thinking, done) is used.
Message text, code and tool input are never kept or sent to the piano.
"""
import argparse
import json
import os
from pathlib import Path
import queue
import select
import sys
import termios
import threading
import time
import tty

from conductor import FORMS, Conductor
from melodies import LIBRARY, MOODS_ALL, SONGS, STYLES, TITLES
from reader import CACHE, ROOTS, Activity, AgentWatcher, GlobalReporter, classify  # noqa: F401  classify: used by tests
from sonata import Piano, stop_on_term

STATE = CACHE / "position.json"
CHOICE = CACHE / "choice.json"     # the style and song last picked from the menu bar
STATUS = CACHE / "status.json"
COMMANDS = CACHE / "commands"
# The listener's own choices that should outlive the cache: a queue, liked and banned songs, signals
# turned off. control.py writes the same file.
PREFS = Path(os.environ.get("CODE_SONATA_PREFS") or Path.home() / "Library/Application Support/code-sonata/preferences.json")
PREF_KEYS = ("queue", "liked", "banned", "quiet")
SIGNAL_NAMES = {"wait": "izin ya da cevap bekliyor (çan)", "testfail": "test kırıldı (koyu akor, armoni askıda)",
                "pass": "test geçti (yükselen çağrı)", "ship": "commit / push (korno)", "fail": "komut hata verdi (koyu akor)",
                "adim": "adımlar (komut, okuma, düşünme: kısa notalar)"}
SECTIONS = ("piyano", "yaylılar", "koro", "çello", "flüt", "vibrafon", "korno", "arp", "akordeon")
STEPS = {"edit", "bash", "read", "tool", "think", "text"}
SIGNALS = {"fail", "testfail", "pass", "ship", "wait"}   # one-off motifs, not working steps
LEAD_MS = 150   # no network here: notes reach the engine a little early and start exactly on the beat
CHOICES = ("karisik", "sira", "akis")   # every song, the user's queue, loops instead of songs


class AgentMusic(Activity):
    """One conductor, one shared theme; every session (terminal or subagent) is a seat.

    The arrangement is the Agent Orchestra site's own (conductor.py) in the chosen style: even a
    single session gets the style's whole band (its ensemble), and every further session adds an
    instrument the band does not have yet (the style's joiners: in klasik flute, horn, choir,
    vibraphone, accordion), heard whatever the pace. A newcomer comes in on a bar line; a session
    that finishes its turn leaves where the next phrase starts, and the last one out lets the
    phrase end before a soft closing chord. A section plays while its session is mid-turn (between
    a prompt and its end), so long thinking does not cut the music. The pace of steps sets tempo
    and excitement; a command, a read or a thought is also a short note in that session's own
    instrument. "akis" plays loops instead of songs (conductor flow): no song comes back, a scene of
    eight loops builds, breaks and peaks, then another chord loop, key and riffs follow.
    """

    def __init__(self, song="karisik", position=None, style="klasik", melody="orta", prefs=None):
        super().__init__()
        self.prefs = {k: list((prefs or {}).get(k, [])) for k in PREF_KEYS}
        self.choice = song if song in LIBRARY or song in CHOICES else "karisik"
        songs, ordered = self.playlist(self.choice)
        self.slots = {}      # path -> seat number (its section: see section())
        self.volume = 100    # the sound engine's master level, 0-100
        self.now = 0.0
        self.last_tick = None
        self.conductor = Conductor(self.population, song=songs[0], songs=songs, lead_ms=LEAD_MS, style=style,
                                   moods=MOODS_ALL, error_cues=True, signal_gap_ms=2000, melody=melody,
                                   ordered=ordered, favorites=self.prefs["liked"], flow=self.choice == "akis")
        self.seed_flow()
        if isinstance(position, dict) and position.get("song") in songs:
            self.conductor.song = position["song"]
            self.conductor.position = int(position.get("position", 0)) % len(SONGS[self.conductor.song])
            self.conductor.song_beat = sum(beats for _, beats in SONGS[self.conductor.song][:self.conductor.position])

    def playlist(self, choice):
        """(songs, ordered) for a choice: the queue in its order, one song, or every song not banned."""
        if choice == "sira":
            queue = tuple(s for s in self.prefs["queue"] if s in LIBRARY)
            if queue:
                return queue, True
        if choice in LIBRARY:
            return (choice,), False
        return tuple(s for s in LIBRARY if s not in self.prefs["banned"]) or LIBRARY, False

    def apply_prefs(self, prefs):
        """New preferences while playing: the song list follows, the song now playing goes on unless
        it left the list (then the next one starts: in a queue, the one after it)."""
        self.prefs = {k: list(prefs.get(k, [])) for k in PREF_KEYS}
        c, old = self.conductor, list(self.conductor.songs)
        if self.choice == "sira" and not any(s in LIBRARY for s in self.prefs["queue"]):
            self.choice = "karisik"   # the queue emptied: back to the mix
        c.songs, c.ordered = self.playlist(self.choice)
        c.favorites = self.prefs["liked"]
        if c.song not in c.songs and c.flow:   # loops play on; the next song waits for when songs come back
            c.song = c.songs[0]
        elif c.song not in c.songs:
            if c.ordered and c.song in old:
                at = old.index(c.song)
                c.song = next((s for s in old[at + 1:] + old[:at] if s in c.songs), c.songs[0])
                c.position, c.song_beat, c.turn, c.lead = 0, 0, 0, None
            else:
                c.skip()

    def seed_flow(self, clock=time.time):
        """Loops start from the wall clock: the music's own clock (time.monotonic) counts from this process's
        start, and a seed from it opened every listener on the same chord loop."""
        if self.conductor.flow:
            self.conductor.flow.rng = int(clock()) % 2147483646 + 1

    def title(self):
        """What plays: the song's title, or in flow the scene's key and chord loop."""
        c = self.conductor
        return c.flow_title() if c.flow else TITLES[c.song]

    def like(self):
        """Like the song now playing, or take the like back; liked songs come first in their mood.
        Flow plays no song: None, nothing changes."""
        if self.conductor.flow:
            return None
        song, liked = self.conductor.song, self.prefs["liked"]
        liked.remove(song) if song in liked else liked.append(song)
        self.conductor.favorites = liked
        return song in liked

    def ban(self):
        """Never play the song now playing (it leaves the queue too); the next one starts. Not in flow."""
        if self.conductor.flow:
            return False
        song = self.conductor.song
        if song not in self.prefs["banned"]:
            self.prefs["banned"].append(song)
        for key in ("liked", "queue"):
            if song in self.prefs[key]:
                self.prefs[key].remove(song)
        if self.choice == song:   # the one song chosen: back to the mix without it
            self.choice = "karisik"
        self.apply_prefs(self.prefs)
        return True

    def enqueue(self):
        song = self.conductor.song
        if self.conductor.flow:
            return False
        if song not in self.prefs["queue"]:
            self.prefs["queue"].append(song)
            self.apply_prefs(self.prefs)
        return True

    def quiet(self, kind):
        """Turn a signal (or the step notes, "adim") off or back on."""
        quiet = self.prefs["quiet"]
        quiet.remove(kind) if kind in quiet else quiet.append(kind)
        return kind not in quiet

    def forget(self, path):
        self.slots.pop(path, None)

    def section(self, seat):
        """The first session leads; each next one takes a new timbre (the style's joiners), and when
        those run out, a section of the band again."""
        look = STYLES[self.conductor.style]
        order = [0] + look["joiners"] + [s for s in look["ensemble"] if s != 0]
        return order[seat % len(order)]

    def join(self, path):
        if path not in self.slots:
            taken = set(self.slots.values())
            self.slots[path] = next(i for i in range(len(taken) + 1) if i not in taken)
        return self.section(self.slots[path])

    def voices(self):
        names = STYLES[self.conductor.style]["names"]
        return [names[self.section(seat)] for seat in sorted(self.slots.values())]

    def population(self, now, dt):
        active, working, featured = [0] * len(SECTIONS), 0, set()
        for path, seen in self.working.items():
            if self.now - seen <= self.WORK_TIMEOUT:
                working += 1
                section = self.section(self.slots.get(path, 0))
                active[section] += 1
                if section:
                    featured.add(section)   # a session's own instrument plays at any pace
        if working:   # one person alone still hears the style's whole band
            for section in STYLES[self.conductor.style]["ensemble"]:
                active[section] = max(active[section], 1)
        return {"working": working, "total": len(self.sessions), "active": active, "listening": 0,
                "featured": sorted(featured)}

    def choose(self, song):
        """Play one song from its start, the queue ("sira") from its first song, "karisik": every song
        not banned, picked by the pace, or "akis": loops from the next bar line."""
        c = self.conductor
        if song not in LIBRARY and song not in CHOICES:
            return
        self.choice = song
        c.songs, c.ordered = self.playlist(song)
        if song == "akis" and not c.flow:
            c.set_flow(True)
            self.seed_flow()
        elif song != "akis":
            c.set_flow(False)
        if song not in ("karisik", "akis"):
            c.song = c.songs[0]
            c.position, c.song_beat, c.turn, c.lead = 0, 0, 0, None

    def programs(self):
        """(voice, General MIDI program) for the sound engine; voice 10 takes the drum kit."""
        look = STYLES[self.conductor.style]
        return [(voice, look["kit"] if voice == 10 else program) for voice, program in enumerate(look["programs"])]

    def accept(self, events, now):
        self.active(now)
        for path, kind in events:
            self.see(path, kind, now)
            section = self.join(path)
            if kind in STEPS:
                self.conductor.steps += 1
                if "adim" not in self.prefs["quiet"]:
                    self.conductor.accent("think" if kind == "text" else kind, section)
            elif kind in SIGNALS:
                self.signal(kind, now, section)

    def signal(self, kind, now, section=0):
        if kind in ("testfail", "pass") and kind in self.prefs["quiet"]:
            self.conductor.tension_next = kind == "testfail"   # the harmony still follows the tests
        elif kind not in self.prefs["quiet"]:
            self.conductor.signal(kind, section, now * 1000)

    def tick(self, now):
        """Notes as (pitch, velocity, seconds, voice, at) with `at` in time.monotonic() seconds."""
        dt = 25 if self.last_tick is None else max(0, now - self.last_tick) * 1000
        self.last_tick = self.now = now
        self.active(now)
        self.conductor.tick(now * 1000, dt)
        out, self.conductor.out = self.conductor.out, []
        return [(p, v, d, voice, at / 1000) for at, p, v, d, voice in out]

    def playing(self, now):
        return bool(self.conductor.clock) or self.is_working(now)


def load_position(song, path=STATE):
    """{"song", "position"} saved for this song choice, or None."""
    try:
        value = json.loads(path.read_text()).get(song)
        return value if isinstance(value, dict) else None
    except (OSError, ValueError, AttributeError):
        return None


def where(music):
    return {"song": music.conductor.song, "position": music.conductor.position}


def load_choice(path=CHOICE):
    try:
        value = json.loads(path.read_text())
        return value if isinstance(value, dict) else {}
    except (OSError, ValueError):
        return {}


def save_choice(music, path=CHOICE):
    try:
        path.write_text(json.dumps({"style": music.conductor.style, "song": music.choice,
                                    "melody": music.conductor.melody, "volume": music.volume}))
    except OSError:
        pass


def write_status(music, now, muted, path=STATUS):
    """Small JSON for the menu bar indicator. Atomic replace; errors are ignored."""
    c = music.conductor
    data = {"pid": os.getpid(), "updated": time.time(), "muted": muted, "playing": music.playing(now),
            "sessions": len(music.sessions), "working": len(music.working), "voices": music.voices(),
            "bpm": round(c.bpm), "intensity": round(c.intensity, 2), "climax": bool(c.shift), "song": music.title(),
            "style": c.style, "choice": music.choice, "styles": [[k, v["title"]] for k, v in STYLES.items()],
            "melody": c.melody, "volume": music.volume, "flow": bool(c.flow), "song_id": None if c.flow else c.song,
            "liked": not c.flow and c.song in music.prefs["liked"],
            "queue": [[k, TITLES[k]] for k in music.prefs["queue"] if k in TITLES], "quiet": music.prefs["quiet"],
            "signals": [[k, v] for k, v in SIGNAL_NAMES.items()],
            "library": [[k, TITLES[k]] for k in LIBRARY]}
    try:
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps(data, ensure_ascii=False))
        tmp.replace(path)
    except OSError:
        pass


def read_commands(path=COMMANDS):
    """Commands dropped by the menu bar (one per line): mute, unmute, toggle, next, wait, style:S, song:S,
    melody:az|orta|cok, volume:0-100."""
    try:
        text = path.read_text()
        path.unlink()
    except OSError:
        return []
    return [line.strip() for line in text.splitlines() if line.strip()]


def load_prefs(path=PREFS):
    """{"queue", "liked", "banned", "quiet"}: lists of song ids (signal kinds for "quiet")."""
    try:
        value = json.loads(path.read_text())
    except (OSError, ValueError):
        value = {}
    value = value if isinstance(value, dict) else {}
    return {k: [x for x in value.get(k, []) if isinstance(x, str)] if isinstance(value.get(k), list) else [] for k in PREF_KEYS}


def save_prefs(prefs, path=PREFS):
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps({k: prefs.get(k, []) for k in PREF_KEYS}, ensure_ascii=False, indent=1))
        tmp.replace(path)
    except OSError:
        pass


def save_position(song, position, path=STATE):
    try:
        data = json.loads(path.read_text()) if path.exists() else {}
        data[song] = position
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(data))
    except (OSError, ValueError, TypeError):
        pass


def level(value, default=100):
    """A volume 0-100 from the command line, a command or the saved choice."""
    try:
        return max(0, min(100, int(value)))
    except (TypeError, ValueError):
        return default


def run(silent=False, duration=None, song=None, roots=ROOTS, global_url=None, soundfont=None, style=None, eco=False,
        melody=None, volume=None):
    print("CODE SONATA · Bütün Claude / Codex oturumları dinleniyor", flush=True)
    watcher = AgentWatcher(roots)
    print(f"{len(watcher.offsets)} aktif oturum kaydı bulundu. Geçmiş sessiz, yeni adımlar çalacak.\n"
          "G: sesi aç/kapat · Q veya Ctrl+C: durdur", flush=True)
    piano = None if silent else Piano(soundfont, eco)
    if piano and piano.error:
        print(f"Ses açılamadı: {piano.error}", file=sys.stderr)
        return 1
    real = tuple(map(Path, roots)) == tuple(ROOTS)  # demo/test runs never touch the real position or menu bar
    saved = load_choice() if real else {}
    prefs = load_prefs() if real else {}
    song = song or saved.get("song") or "karisik"
    song = song if song in LIBRARY or song in CHOICES else "karisik"   # a removed personal song falls back
    style = style or saved.get("style")
    style = style if style in STYLES else "klasik"
    melody = melody or saved.get("melody")
    melody = melody if melody in FORMS else "orta"
    music = AgentMusic(song, position=load_position(song) if real else None, style=style, melody=melody, prefs=prefs)
    music.volume = level(volume if volume is not None else saved.get("volume"))
    if piano:
        for voice, program in music.programs():
            piano.send(f"program {voice} {program}")
        piano.send(f"volume {music.volume}")
    stop_on_term()   # before "ready": control.py may stop the listener right after it
    print("Dinleme hazır.", flush=True)
    print(f"Melodi: {song} · Stil: {STYLES[style]['title']} · melodi miktarı {melody} · ses %{music.volume}", flush=True)
    last_save = time.monotonic()
    reporter = GlobalReporter(global_url) if global_url else None
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
                for _, kind in batch:
                    counts[kind] = counts.get(kind, 0) + 1
            if reporter:
                reporter.add(batch, music.is_working(now), len(music.sessions), music.tools())
            if counts and now - last_report >= 3:
                c = music.conductor
                summary = " ".join(f"{k}:{v}" for k, v in sorted(counts.items()))
                title = music.title()
                if c.shift:
                    title += " · DORUK (+1 ton)"
                elif c.intensity > .3:
                    title += f" · heyecan %{c.intensity * 100:.0f}"
                print(f"♫ {music.active(now)} oturum · {', '.join(music.voices())} · {title} · "
                      f"{c.bpm:.0f} BPM · {summary}", flush=True)
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
                    elif command == "next":
                        music.conductor.skip()
                        print("Sonraki sahne (bir sonraki ölçüde)" if music.conductor.flow else f"Şarkı: {TITLES[music.conductor.song]}", flush=True)
                    elif command.startswith("style:") and command[6:] in STYLES:
                        music.conductor.set_style(command[6:])
                        if piano:
                            for voice, program in music.programs():
                                piano.send(f"program {voice} {program}")
                        save_choice(music)
                        print(f"Stil: {STYLES[command[6:]]['title']}", flush=True)
                    elif command.startswith("song:") and (command[5:] in LIBRARY or command[5:] in CHOICES):
                        music.choose(command[5:])
                        save_choice(music)
                        print(f"Şarkı: {TITLES.get(command[5:], {'sira': 'sıram', 'akis': 'akış'}.get(command[5:], 'karışık'))}", flush=True)
                    elif command in ("like", "ban", "enqueue") and music.conductor.flow:
                        print("Akışta şarkı yok: sevme, çalmama ve sıra şarkılar için.", flush=True)
                    elif command in ("like", "ban", "enqueue") or command.startswith("signal:"):
                        title = TITLES[music.conductor.song]
                        if command == "like":
                            print(f"{'Sevildi' if music.like() else 'Sevilmekten çıktı'}: {title}", flush=True)
                        elif command == "ban":
                            music.ban()
                            print(f"Artık çalmayacak: {title} · şimdi {TITLES[music.conductor.song]}", flush=True)
                        elif command == "enqueue":
                            music.enqueue()
                            print(f"Sıraya eklendi: {title}", flush=True)
                        elif command[7:] in SIGNAL_NAMES:
                            print(f"Sinyal {SIGNAL_NAMES[command[7:]]}: {'açık' if music.quiet(command[7:]) else 'kapalı'}", flush=True)
                        save_prefs(music.prefs)
                    elif command == "prefs":
                        music.apply_prefs(load_prefs())
                        print("Tercihler yenilendi.", flush=True)
                    elif command.startswith("melody:") and command[7:] in FORMS:
                        music.conductor.set_melody(command[7:])
                        save_choice(music)
                        print(f"Melodi miktarı: {command[7:]}", flush=True)
                    elif command.startswith("volume:"):
                        music.volume = level(command[7:], music.volume)
                        if piano:
                            piano.send(f"volume {music.volume}")
                        save_choice(music)
                        print(f"Ses: %{music.volume}", flush=True)
                if real:
                    write_status(music, now, muted)
                    save_position(music.choice, where(music))
                last_save = now
            if piano and not muted:
                piano.play(notes)
                if piano.error:
                    print(piano.error, file=sys.stderr)
                    result = 1
                    break
            # Notes leave 150 ms ahead with their exact time, so a calm loop costs no precision.
            time.sleep(.025 if music.playing(now) else .1)
    except KeyboardInterrupt:
        pass
    finally:
        stop.set()
        if reporter:
            reporter.stop.set()
        if real:
            save_position(music.choice, where(music))
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


def signals_demo(soundfont=None):
    """Each signal once, with its name: what the music says while the agents work."""
    piano = Piano(soundfont)
    if piano.error:
        print(f"Ses açılamadı: {piano.error}", file=sys.stderr)
        return 1
    quiet = lambda now, dt: {"working": 0, "total": 0, "active": [0] * 9, "listening": 0}
    c = Conductor(quiet, lead_ms=LEAD_MS, error_cues=True, signal_gap_ms=0)
    try:
        for kind, label in SIGNAL_NAMES.items():
            print(f"♪ {label}", flush=True)
            now = time.monotonic() * 1000
            if kind == "adim":
                c.accents = [["bash", 0], ["read", 0], ["think", 0]]
                for n, accent in enumerate(list(c.accents)):
                    c.accents = [accent]
                    c.play_accents(now + LEAD_MS + n * 500, -99, lambda base: base * 1.7, 500)
            else:
                c.signal(kind, 0, now)
                c.tick(now, 25)
            piano.play([(p, v, d, voice, at / 1000) for at, p, v, d, voice in c.out])
            c.out = []
            time.sleep(3)
    except KeyboardInterrupt:
        pass
    finally:
        piano.close()
    return 0


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--silent", action="store_true", help="Ses çıkarmadan adımları göster")
    parser.add_argument("--duration", type=float, help="Belirtilen saniye sonra dur (deneme için)")
    parser.add_argument("--song", choices=CHOICES + LIBRARY,
                        help="Şarkı (karisik: ajanların temposuna göre sırayla hepsi; sira: kendi sıran; akis: şarkı yerine "
                             "katmanlı döngüler; verilmezse son seçim). Üretken 'original' melodi yalnız klasör ve editör modunda.")
    parser.add_argument("--signals-demo", action="store_true", help="Sinyal seslerini birer kez çal ve adlarını yaz")
    parser.add_argument("--style", choices=tuple(STYLES), help="Stil: " + ", ".join(f"{k} ({v['title']})" for k, v in STYLES.items()))
    parser.add_argument("--soundfont", type=Path, metavar="SF2",
                        help="Sistemin General MIDI sesleri yerine bu ses bankası (ör. FluidR3_GM.sf2)")
    parser.add_argument("--eco", action="store_true", help="Pil tasarrufu: yankı kapalı, çalarken üçte bir daha az işlemci")
    parser.add_argument("--melody", choices=tuple(FORMS),
                        help="Melodi miktarı: az (tema ve ara), orta (tema, çeşitleme, ara), cok (arasız); verilmezse son seçim")
    parser.add_argument("--volume", type=int, metavar="0-100", help="Ses seviyesi (100: varsayılan); verilmezse son seçim")
    parser.add_argument("--roots", nargs="+", type=Path, default=ROOTS, help=argparse.SUPPRESS)
    parser.add_argument("--global", dest="global_url", metavar="URL",
                        help="Dünya orkestrasına katıl (yalnızca adım sayısı gönderilir)")
    args = parser.parse_args()
    if args.signals_demo:
        return signals_demo(args.soundfont.expanduser() if args.soundfont else None)
    if args.duration is not None and args.duration <= 0:
        parser.error("Süre sıfırdan büyük olmalı.")
    if args.volume is not None and not 0 <= args.volume <= 100:
        parser.error("Ses 0 ile 100 arasında olmalı.")
    if args.soundfont and not args.soundfont.expanduser().is_file():
        parser.error(f"Ses bankası bulunamadı: {args.soundfont}")
    if args.global_url:
        try:
            GlobalReporter.connection(args.global_url)
            GlobalReporter.event(args.global_url)
        except ValueError as exc:
            parser.error(str(exc))
    CACHE.mkdir(parents=True, exist_ok=True)
    soundfont = args.soundfont.expanduser() if args.soundfont else None
    return run(args.silent, args.duration, args.song, args.roots, args.global_url, soundfont, args.style, args.eco,
               args.melody, args.volume)


if __name__ == "__main__":
    sys.exit(main())
