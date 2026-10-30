#!/usr/bin/env python3
"""Bring your own music: turn a MIDI file into a song the local conductor can play.

    python3 songbook.py tracks parca.mid                 # which track holds the melody?
    python3 songbook.py import parca.mid --name zelda    # saved only on this Mac
    python3 songbook.py import parca.mid --track 1 --bars 5-20 --title "Ana tema" --mood wild
    python3 songbook.py list
    python3 songbook.py remove zelda

The melody is the highest note of the chosen track at each moment; chords are guessed from all
the other notes, half a bar at a time. Imported songs live in
~/Library/Application Support/code-sonata/songs and are played only by this Mac's tool: they are
never sent anywhere. The file is your responsibility: import only music you may use.
"""
import argparse
import json
import math
import os
from pathlib import Path
import re
import sys

SONGBOOK = Path(os.environ.get("CODE_SONATA_SONGS") or Path.home() / "Library/Application Support/code-sonata/songs")
NAMES = ("C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B")
GRID = .25   # sixteenth notes


# ---------- Standard MIDI File ----------
def parse_midi(data):
    """Notes [(start, end, pitch, velocity, track, channel)] in ticks, plus division, tempos, meters."""
    if data[:4] != b"MThd":
        raise ValueError("MIDI dosyası değil (MThd yok).")
    length = int.from_bytes(data[4:8], "big")
    _, count, division = (int.from_bytes(data[8 + i:10 + i], "big") for i in (0, 2, 4))
    if division & 0x8000:
        raise ValueError("SMPTE zamanlı MIDI desteklenmiyor.")
    notes, tempos, meters, names = [], [], [], {}
    pos = 8 + length
    for track in range(count):
        if data[pos:pos + 4] != b"MTrk":
            break
        end = pos + 8 + int.from_bytes(data[pos + 4:pos + 8], "big")
        pos, tick, status, sounding = pos + 8, 0, 0, {}
        while pos < end:
            delta = 0
            while True:
                byte = data[pos]
                pos += 1
                delta = (delta << 7) | (byte & 0x7F)
                if byte < 0x80:
                    break
            tick += delta
            if data[pos] >= 0x80:
                status = data[pos]
                pos += 1
            if status == 0xFF:
                kind, size = data[pos], 0
                pos += 1
                while True:
                    byte = data[pos]
                    pos += 1
                    size = (size << 7) | (byte & 0x7F)
                    if byte < 0x80:
                        break
                body = data[pos:pos + size]
                pos += size
                if kind == 0x51 and size == 3:
                    tempos.append((tick, int.from_bytes(body, "big")))
                elif kind == 0x58 and size >= 2:
                    meters.append((tick, body[0], 2 ** body[1]))
                elif kind == 0x03:
                    names[track] = body.decode("latin-1").strip()
                continue
            if status in (0xF0, 0xF7):
                size = 0
                while True:
                    byte = data[pos]
                    pos += 1
                    size = (size << 7) | (byte & 0x7F)
                    if byte < 0x80:
                        break
                pos += size
                continue
            kind, channel = status & 0xF0, status & 0x0F
            if kind in (0xC0, 0xD0):
                pos += 1
                continue
            a, b = data[pos], data[pos + 1]
            pos += 2
            if kind == 0x90 and b > 0:
                sounding.setdefault((channel, a), []).append((tick, b))
            elif kind in (0x80, 0x90):
                started = sounding.get((channel, a))
                if started:
                    begin, velocity = started.pop(0)
                    if tick > begin:
                        notes.append((begin, tick, a, velocity, track, channel))
        pos = end
    return {"notes": sorted(notes), "division": division, "tempos": sorted(tempos), "meters": sorted(meters), "names": names}


def tracks(midi):
    """Melodic tracks (drum channel 10 left out) with what helps to pick the melody."""
    rows = {}
    for start, end, pitch, velocity, track, channel in midi["notes"]:
        if channel == 9:
            continue
        row = rows.setdefault(track, {"track": track, "name": midi["names"].get(track, ""), "notes": 0, "low": 127, "high": 0, "sum": 0})
        row["notes"] += 1
        row["low"], row["high"], row["sum"] = min(row["low"], pitch), max(row["high"], pitch), row["sum"] + pitch
    for row in rows.values():
        row["average"] = round(row.pop("sum") / row["notes"])
    return sorted(rows.values(), key=lambda r: r["track"])


# ---------- music from notes ----------
def snap(x):
    return round(x / GRID) * GRID


def guess_key(weights):
    """Krumhansl-Schmuckler: (tonic pitch class, minor?)."""
    major = (6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88)
    minor = (6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17)

    def correlation(profile, tonic):
        xs = [weights[(tonic + i) % 12] for i in range(12)]
        mx, my = sum(xs) / 12, sum(profile) / 12
        num = sum((x - mx) * (y - my) for x, y in zip(xs, profile))
        den = math.sqrt(sum((x - mx) ** 2 for x in xs) * sum((y - my) ** 2 for y in profile)) or 1
        return num / den
    return max(((t, m) for t in range(12) for m in (False, True)),
               key=lambda k: correlation(minor if k[1] else major, k[0]))


def chord_name(root, minor):
    return NAMES[root] + ("m" if minor else "")


def best_chord(weights, bass, key):
    """The major or minor triad that holds most of what sounds; the bass and the key break ties."""
    tonic, minor = key
    scale = {(tonic + d) % 12 for d in ((0, 2, 3, 5, 7, 8, 10, 11) if minor else (0, 2, 4, 5, 7, 9, 11))}
    best, score = None, -1e9
    for root in range(12):
        for is_minor in (False, True):
            tones = {root, (root + (3 if is_minor else 4)) % 12, (root + 7) % 12}
            fit = sum(weights[p] for p in tones) - .6 * sum(weights[p] for p in range(12) if p not in tones)
            fit += .5 * (bass == root) * max(weights) + .15 * len(tones & scale) * max(weights)
            if fit > score:
                best, score = (root, is_minor), fit
    return best


def song_from_midi(midi, track=None, bars=None, title=None, mood=None, pickup=0.0, upbeat=0.0):
    """A songs.mjs-style entry from parsed MIDI: melody, lead-sheet chords, meter, phrases, key.

    `pickup` beats before the first bar are taken in, and the same amount is left off the end, so
    the song loops bar by bar and the pickup leads into the repeat. `upbeat` is for files whose
    bar lines are shifted (the pickup written as a whole first bar): the cut stays, only the meter's
    first bar line moves."""
    division = midi["division"]
    beat = lambda tick: tick / division
    numerator, denominator = (midi["meters"][0][1], midi["meters"][0][2]) if midi["meters"] else (4, 4)
    meter = numerator * 4 / denominator
    melodic = [n for n in midi["notes"] if n[5] != 9]
    if not melodic:
        raise ValueError("MIDI dosyasında nota yok.")
    if track is None:   # the track that sits highest on average, with enough notes, carries the tune
        rows = [r for r in tracks(midi) if r["notes"] >= 8] or tracks(midi)
        track = max(rows, key=lambda r: (r["average"], r["notes"]))["track"]
    lead = [n for n in melodic if n[4] == track]
    if not lead:
        raise ValueError(f"{track}. izde nota yok. İzleri görmek için: songbook.py tracks DOSYA")
    first_bar, last_bar = bars or (1, None)
    start = (first_bar - 1) * meter - pickup
    end_of_music = max(beat(n[1]) for n in melodic)
    stop = ((last_bar * meter) if last_bar else math.ceil(end_of_music / meter) * meter) - pickup
    # Melody: the highest note starting at each onset, unless the melody note above it still sounds
    # (an accompaniment note under a held tune note does not cut the tune). A note lasts until the
    # next melody note or its own end.
    onsets = {}
    for begin, finish, pitch, velocity, _, _ in lead:
        at = snap(beat(begin))
        if start <= at < stop and pitch > onsets.get(at, (0, 0))[0]:
            onsets[at] = (pitch, max(snap(beat(finish)), at + GRID))
    if not onsets:
        raise ValueError("Seçilen ölçülerde melodi yok.")
    tune = []
    for at in sorted(onsets):
        pitch, finish = onsets[at]
        if tune and tune[-1][2] > at + 1e-9 and tune[-1][1] > pitch:
            continue
        tune.append([at, pitch, finish])
    notes, starts, clock = [], [], start
    span = meter / 2 if meter >= 4 else meter
    # Chord windows (half bars, whole bars in three) start on the music's own bar lines: after the
    # pickup, and after a bar line moved by `upbeat`.
    origin = start + math.fmod(pickup + upbeat, span)
    if origin > start + 1e-9:
        origin -= span

    def rest(until):
        # Rests are cut at chord boundaries, so a chord change inside a rest keeps its place.
        nonlocal clock
        while until > clock + 1e-9:
            boundary = origin + (math.floor((clock - origin) / span + 1e-9) + 1) * span
            end = min(until, boundary)
            notes.append([None, end - clock])
            starts.append(clock)
            clock = end
    for i, (at, pitch, finish) in enumerate(tune):
        rest(at)
        following = tune[i + 1][0] if i + 1 < len(tune) else stop
        length = max(GRID, min(following, finish) - at)
        notes.append([pitch, length])
        starts.append(at)
        clock = at + length
    rest(stop)
    # Key from the selected bars; chords half a bar at a time, from what sounds there.
    weights = [0.0] * 12
    for begin, finish, pitch, *_ in melodic:
        weights[pitch % 12] += max(0.0, min(beat(finish), stop) - max(beat(begin), start))
    key = guess_key(weights)
    marks, previous = [], None
    t = origin
    while t < stop - 1e-9:
        w, low = [0.0] * 12, (128, None)
        for begin, finish, pitch, _, tr, _ in melodic:
            overlap = min(beat(finish), t + span) - max(beat(begin), t)
            if overlap > 0:
                w[pitch % 12] += overlap * (.5 if tr == track else 1)
                if tr != track and pitch < low[0]:
                    low = (pitch, pitch % 12)
        if sum(w):
            chord = best_chord(w, low[1], key)
            if chord != previous:
                # The chord starts at the first note or rest from here on; a change inside a held
                # note waits for the next one. With nothing left after it, the change is dropped.
                index = next((i for i, s in enumerate(starts) if s >= t - 1e-9), None)
                if index is not None and (not marks or marks[-1][0] != index):
                    marks.append([index, chord_name(*chord)])
                elif index is not None:
                    marks[-1][1] = chord_name(*chord)
                previous = chord
        t += span
    if not marks or marks[0][0] != 0:
        marks.insert(0, [0, chord_name(*key)])
    # A phrase every two bars (four in three-time).
    phrase_len = meter * (4 if meter <= 3 else 2)
    phrases = sorted({0} | {next(i for i, s in enumerate(starts) if s >= p - 1e-9)
                            for p in frange(start + pickup + upbeat, stop, phrase_len) if any(s >= p - 1e-9 for s in starts)})
    tempo = 60_000_000 / midi["tempos"][0][1] if midi["tempos"] else 120
    return {
        "title": title or "İçe aktarılan şarkı",
        "key": [key[0], key[1]], "meter": [meter if meter != int(meter) else int(meter), pickup + upbeat],
        "mood": mood or ("calm" if tempo < 90 else "wild" if tempo > 140 else "warm"),
        "phrases": phrases or [0], "chords": marks, "notes": [[p, round(d, 4)] for p, d in notes],
    }


def frange(start, stop, step):
    while start < stop - 1e-9:
        yield start
        start += step


# ---------- the personal songbook ----------
def personal_songs():
    """Imported songs on this Mac: {id: entry}. Unreadable files are skipped."""
    songs = {}
    for path in sorted(SONGBOOK.glob("*.json")) if SONGBOOK.is_dir() else []:
        try:
            entry = json.loads(path.read_text(encoding="utf-8"))
            if entry.get("notes") and entry.get("chords") and entry.get("meter") and entry.get("key"):
                songs[path.stem] = entry
        except (OSError, ValueError):
            continue
    return songs


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="action", required=True)
    show = sub.add_parser("tracks", help="MIDI dosyasındaki izleri göster")
    show.add_argument("file", type=Path)
    add = sub.add_parser("import", help="MIDI dosyasını şarkı olarak ekle")
    add.add_argument("file", type=Path)
    add.add_argument("--name", help="Kısa ad (harf, rakam, tire); verilmezse dosya adından")
    add.add_argument("--title", help="Menüde görünen ad")
    add.add_argument("--track", type=int, help="Melodinin izi (tracks çıktısındaki numara)")
    add.add_argument("--bars", help="Ölçü aralığı, ör. 5-20")
    add.add_argument("--pickup", type=float, default=0.0, help="İlk ölçüden önce alınacak giriş vuruşu, ör. 0.5")
    add.add_argument("--upbeat", type=float, default=0.0, help="Dosyada ölçü çizgisi kaymışsa seçimin içindeki giriş vuruşu")
    add.add_argument("--mood", choices=("calm", "warm", "wild"))
    add.add_argument("--print", action="store_true", help="Kaydetme, JSON'u yazdır")
    sub.add_parser("list", help="İçe aktarılmış şarkılar")
    drop = sub.add_parser("remove", help="İçe aktarılmış şarkıyı sil")
    drop.add_argument("name")
    args = parser.parse_args()
    try:
        if args.action == "tracks":
            for row in tracks(parse_midi(args.file.read_bytes())):
                print(f"iz {row['track']:2d}  {row['notes']:5d} nota  {row['low']:3d}-{row['high']:3d} (ort. {row['average']})  {row['name']}")
            return 0
        if args.action == "list":
            for name, entry in personal_songs().items():
                print(f"{name:20s} {entry.get('title', '')}  ({len(entry['notes'])} nota)")
            return 0
        if args.action == "remove":
            target = SONGBOOK / f"{args.name}.json"
            if not target.is_file():
                raise ValueError(f"Böyle bir şarkı yok: {args.name}")
            target.unlink()
            print(f"Silindi: {args.name}")
            return 0
        bars = None
        if args.bars:
            match = re.fullmatch(r"(\d+)-(\d+)", args.bars)
            if not match or int(match[1]) < 1 or int(match[2]) < int(match[1]):
                raise ValueError("--bars biçimi: 5-20")
            bars = (int(match[1]), int(match[2]))
        name = args.name or re.sub(r"[^a-z0-9-]+", "-", args.file.stem.lower()).strip("-")
        if not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,40}", name or ""):
            raise ValueError("Ad yalnız küçük harf, rakam ve tire olabilir.")
        song = song_from_midi(parse_midi(args.file.read_bytes()), args.track, bars, args.title or args.file.stem, args.mood, args.pickup, args.upbeat)
        if args.print:
            print(json.dumps(song, ensure_ascii=False))
            return 0
        SONGBOOK.mkdir(parents=True, exist_ok=True)
        (SONGBOOK / f"{name}.json").write_text(json.dumps(song, ensure_ascii=False), encoding="utf-8")
        print(f"Eklendi: {name} · {song['title']} · {len(song['notes'])} nota, {len(song['chords'])} akor. "
              f"Çalmak için: kod müziğini aç, şarkı {name}")
        return 0
    except (OSError, ValueError, IndexError) as exc:
        print(str(exc), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
