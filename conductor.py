"""The Agent Orchestra conductor, for the local macOS tool.

A line-for-line port of orchestra/web/conductor.mjs, reading the same score (songs.mjs through
melodies.py). Times are milliseconds. test_conductor.py drives both versions through the same
scenario and requires identical notes, so the local tool and the site cannot drift apart again.
A song is heard in turns (FORMS): the theme, a variation, a breath, then the next song, played with
phrase dynamics, a ritardando before the close and a dominant seventh into the next key.
`flow` ("akış") plays loops instead of songs (flow.mjs): four-bar loops on one sixteenth grid, a scene
of eight loops, then a new chord loop, key, tempo and riffs.
"""
import math
import time
from types import SimpleNamespace

from melodies import FLOW, KEYS, METERS, MOODS, PLANS, PLAYLIST, SONGS, STYLES, TEMPOS, chord_tones, chords_for

TIMPANI, TREMOLO, DRUMS, ACCORDION = 8, 9, 10, 11   # engine voices; section 8 plays voice 11
LEAD_MS = 900
LOOKAHEAD_MS = 150
ACCENT_OCTAVE = (48, 48, 60, 36, 72, 72, 48, 60, 48)
# How much melody: "az" theme and breath, "orta" (default) theme, variation and breath, "cok" no breath.
FORMS = {"az": ("tema", "nefes"), "orta": ("tema", "varyasyon", "nefes"), "cok": ("tema", "varyasyon")}
BREATH_BARS = 8
RANGES = {}   # each song's lowest and highest note: the variation goes an octave up only below A6
NOTE_NAMES = ("Do", "Do♯", "Re", "Mi♭", "Mi", "Fa", "Fa♯", "Sol", "La♭", "La", "Si♭", "Si")


def fresh_flow(skip):
    """Flow's state: the scene (key, chord loop, riffs), where the loop is, and what this loop and bar play."""
    return SimpleNamespace(
        rng=0, count=0, key=(0, False), prog=[], prog_id="", loop=0, step=0, skip=skip, plan=None, bar=[],
        hooks={}, counter=[], bass="", comp="", arp="", stabs="", bells=None, riff=None, voicing=None, stab=None,
        choir=None, recent=[], bonus=False, shipped=False, left=None)


def js_round(x):
    """Math.round: halves go up (Python's round() goes to even)."""
    return math.floor(x + .5)


def eq(a, b):
    return abs(a - b) < 1e-9


class Conductor:
    def __init__(self, population, song="bella-ciao", lead_ms=LEAD_MS, songs=PLAYLIST,
                 error_cues=False, signal_gap_ms=10_000, style="klasik", moods=MOODS, melody="orta",
                 ordered=False, favorites=(), flow=False):
        self.population = population
        self.melody, self.turn = (melody if melody in FORMS else "orta"), 0
        self.ordered, self.favorites, self.anchor = ordered, list(favorites), None
        self.songs = tuple(songs)
        self.song = song if song in self.songs else self.songs[0]
        self.song_count = 0
        self.lead_ms, self.error_cues, self.signal_gap_ms = lead_ms, error_cues, signal_gap_ms
        self.style, self.moods = (style if style in STYLES else "klasik"), moods
        self.history, self.position, self.song_beat, self.chord, self.next_change, self.lead = [], 0, 0, None, 0, None
        self.tension = self.tension_next = False
        self.bpm, self.intensity, self.shift, self.target_shift = STYLES[self.style]["tempo"][0], 0, 0, 0
        self.clock, self.steps, self.short, self.long = 0, 0, 0, 0
        self.peak_since, self.calm_since, self.climax_since, self.cool_until = None, None, 0, 0
        self.active, self.working, self.cues, self.accents, self.last_signal, self.solo, self.out = [], 0, [], [], {}, 0, []
        self.house, self.last_active, self.peak, self.peak_day = False, 0, 0, ""
        # Who is on stage: a section comes in on a bar line and leaves where a phrase starts; featured
        # sections (played by a session of their own) always have a part.
        self.stage, self.featured, self.starring, self.ending, self.end_by = None, [], [], False, 0
        self.note_start, self.note_beat_ms, self.note_beat, self.note_pickup, self.lead_pitch = 0, 0, 0, 0, -99
        self.flow = fresh_flow(False) if flow else None

    # The next song follows the agents' pace: calm, warm or wild, or a neighbouring mood. The last
    # few songs heard (half the list, at most six) wait their turn whatever the mood, and among
    # the rest the one heard longest ago (or never) comes next: one mood never loops its few songs.
    # A favourite goes first, and a song in another key than the one just ended when there is a
    # choice. A queue (`ordered`) simply plays on in its order.
    def pick_song(self):
        i = self.intensity
        mood = "wild" if i >= .7 else "warm" if i >= .35 else "calm"
        near = ("calm", "wild") if mood == "warm" else ("warm",)
        self.history.append(self.song)
        if len(self.history) > 64:
            self.history.pop(0)
        if self.ordered:
            at = self.songs.index(self.song) if self.song in self.songs else -1
            return self.songs[(at + 1) % len(self.songs)]
        last = lambda s: max((n for n, x in enumerate(self.history) if x == s), default=-1)
        pool = [s for s in self.songs if s != self.song]
        wait = min(6, len(self.songs) // 2)
        recent = self.history[-wait:] if wait else []
        fresh = [s for s in pool if s not in recent]
        key = KEYS[self.song]

        def least(songs):
            other = [s for s in songs if KEYS[s] != key]
            best = None
            for s in other or songs:
                if best is None or last(s) < last(best):
                    best = s
            return best

        def first(songs):
            choice = least([s for s in songs if s in self.favorites])
            return choice if choice is not None else least(songs)
        for choice in (first([s for s in fresh if s in self.moods[mood]]),
                       first([s for s in fresh if any(s in self.moods[m] for m in near)]), first(fresh), first(pool)):
            if choice is not None:
                return choice
        return self.song

    def pace(self):
        """The tempo the pace asks for: the style's range, times the song's own tempo."""
        slow, fast = STYLES[self.style]["tempo"]
        return (slow + (fast - slow) * self.intensity) * TEMPOS.get(self.song, 1)

    def end_of_visit(self):
        """The beat where this visit of the song ends, if this turn is its last (the breath may stop early)."""
        form, plan = FORMS[self.melody], PLANS[self.song]
        if self.turn < len(form) - 1:
            return None
        total = plan[-1]["start"] + SONGS[self.song][-1][1]
        if self.part() != "nefes":
            return total
        cut = next((step for i, step in enumerate(plan)
                    if i and step["phrase_start"] and step["start"] >= BREATH_BARS * METERS[self.song][0] - 1e-9), None)
        return cut["start"] if cut else total

    def invert(self, pitch, step, pickup):
        """A new line on the theme's rhythm and chords: the tune upside down around the phrase's first
        note, on chord tones on the beat and scale tones between, within the song's range."""
        (tonic, minor), (root, intervals), (lo, hi) = KEYS[self.song], step["chord"], RANGES[self.song]
        chord = [(root + i) % 12 for i in intervals]
        scale = [(tonic + d) % 12 for d in ((0, 2, 3, 5, 7, 8, 10) if minor else (0, 2, 4, 5, 7, 9, 11))]
        strong = eq(math.fmod(math.fmod(step["start"] - pickup, 1) + 1, 1), 0)
        allowed = chord if strong else scale + chord
        fits = lambda p: lo - 2 <= p <= hi + 2 and p % 12 in allowed
        p = 2 * self.anchor - pitch
        while p > hi + 2:
            p -= 12
        while p < lo - 2:
            p += 12
        for d in range(7):
            if fits(p - d):
                return p - d
            if fits(p + d):
                return p + d
        return pitch

    def set_melody(self, name):
        """How much melody from the next turn on (FORMS)."""
        if name in FORMS:
            self.melody = name

    def part(self):
        form = FORMS[self.melody]
        return form[min(self.turn, len(form) - 1)]

    def set_style(self, name):
        """Another arrangement from the next note on; the tempo glides to the new style's range (flow: a new
        scene on the next bar line)."""
        if name in STYLES:
            self.style = name
            if self.flow:
                self.flow.skip = True

    def set_flow(self, on):
        """Loops or songs from the next bar line (a song from its first note)."""
        if (not on) == (not self.flow):
            return
        self.flow = fresh_flow(True) if on else None
        if not on:
            self.position, self.song_beat, self.turn, self.lead, self.shift = 0, 0, 0, None, 0

    def skip(self):
        """Menu bar "next song": start the next one from its first note (flow: the next scene from the next bar line)."""
        if self.flow:
            self.flow.skip = True
            return
        self.song = self.pick_song()
        self.song_count += 1
        self.position, self.song_beat, self.turn, self.lead = 0, 0, 0, None

    def tonality(self):
        return self.flow.key if self.flow else KEYS[self.song]

    def chord_at(self, octave):
        return chord_tones(self.chord, self.tonality(), octave)

    @staticmethod
    def band(p, lo):
        while p >= lo + 12:
            p -= 12
        while p < lo:
            p += 12
        return p

    def emit(self, at, p, v, d, i):
        if i != DRUMS:
            p += self.shift
        self.out.append([js_round(at), max(0, min(127, p)), max(1, min(120, js_round(v))), js_round(d * 1000) / 1000, i])

    # Signals become cues that play on the next bar line, in key and in time.
    def signal(self, kind, section, now):
        if kind in ("fail", "testfail") and not self.error_cues:
            return
        if kind in ("testfail", "pass"):
            self.tension_next = kind == "testfail"
        if now - self.last_signal.get(kind, -math.inf) < self.signal_gap_ms:
            return
        self.last_signal[kind] = now
        self.cue(kind)

    def cue(self, kind):
        if kind not in self.cues:
            self.cues.append(kind)

    def accent(self, kind, section):
        """A step of one kind from one section: a short note of its instrument on the next half beat."""
        if kind in ("bash", "read", "think") and len(self.accents) < 9 and [kind, section] not in self.accents:
            self.accents.append([kind, section])

    def tick(self, now, dt):
        pop = self.population(now, dt)
        working, total, active, listening = pop["working"], pop["total"], pop["active"], pop["listening"]
        self.active, self.working, self.featured = active, working, list(pop.get("featured", []))
        rate = self.steps / max(.001, dt / 1000)
        self.steps = 0
        self.short += (rate - self.short) * min(1, dt / 3000)
        self.long += (rate - self.long) * min(1, dt / 120_000)
        pace = min(1, self.short / working / 2) if working else 0
        surge = max(0, min(1, (self.short / max(self.long, .4 * working) - .9) / 1.2)) if working else 0
        target = min(1, .55 * pace + .45 * surge) if working else 0
        if now < self.cool_until:
            target = min(target, .6)
        self.intensity += (target - self.intensity) * min(1, dt / 1500)
        if not self.flow:
            self.bpm += (self.pace() - self.bpm) * min(1, dt / 2500)
        self.climax(now)
        if working:
            self.last_active = now
        day = time.strftime("%Y-%m-%d", time.gmtime(now / 1000))
        if day != self.peak_day:
            self.peak_day, self.peak = day, 0
        self.peak = max(self.peak, total)
        self.house = not working and listening > 0
        if self.flow:
            return self.flow_tick(now, working, total)
        if not working and not self.house:
            beat_ms = 60_000 / self.bpm
            vel = lambda base: base * 1.7 * .85
            # The last one out: the phrase plays to its end, or two bars on to a bar line, then a soft tonic.
            if self.clock and self.clock >= now - 500:
                if not self.ending:
                    self.ending, self.end_by = True, self.song_beat + 8
                while self.clock and self.clock <= now + LOOKAHEAD_MS:
                    meter, pickup = METERS[self.song]
                    in_bar = math.fmod(math.fmod(self.song_beat - pickup, meter) + meter, meter)
                    over = self.song_beat >= self.end_by and (eq(in_bar, 0) or self.song_beat >= self.end_by + meter)
                    if PLANS[self.song][self.position]["phrase_start"] or over:
                        self.close(self.clock + self.lead_ms, vel, beat_ms)
                        self.clock = 0
                    else:
                        self.note(self.clock)
            else:
                if self.clock and not self.ending:
                    self.close(now + self.lead_ms, vel, beat_ms)
                self.clock = 0
            if self.cues:
                self.play_cues(now + self.lead_ms, vel, beat_ms)
            self.accents.clear()
            if not self.clock:
                self.ending, self.stage, self.starring = False, None, []
            return {"working": working, "total": total}
        self.ending = False
        if not self.clock or self.clock < now - 500:
            self.clock = now
        while self.clock <= now + LOOKAHEAD_MS:
            self.note(self.clock)
        if self.accents:
            self.flush_accents(now)
        return {"working": working, "total": total}

    def flush_accents(self, now):
        """Steps are heard on the next half beat of the grid, not when the next melody note comes."""
        beat_ms, look = self.note_beat_ms, STYLES[self.style]
        half = beat_ms / 2
        rel = self.note_beat - self.note_pickup
        offset = math.fmod(math.fmod(rel, .5) + .5, .5)
        origin = self.note_start - offset * beat_ms
        k = max(0, math.ceil((now - origin) / half - 1e-9))
        pos = rel - offset + k * .5
        swing = (look["swing"] * beat_ms) / 6 if look["swing"] and eq(math.fmod(math.fmod(pos, 1) + 1, 1), .5) else 0
        crowd = .85 + .15 * min(1, math.log2(1 + self.working) / 6)
        # Loops: an accent takes the chord of the bar it lands in (past the loop: its first bar) and stops at that bar's end.
        limit, held = math.inf, self.chord
        if self.flow and self.flow.prog:
            f, bar = self.flow, math.floor(pos / 4 + 1e-9)
            # Its bar belongs to a scene not written yet (the loop ends the scene, or a skip waits): no chord to take, no accent.
            if (bar >= 4 and f.loop >= len(FLOW["arc"])) or (f.skip and bar != math.floor(self.note_beat / 4 + 1e-9)):
                self.accents.clear()
                return
            self.chord = f.prog[bar % 4]
            limit = (((bar + 1) * 4 - pos) * beat_ms - swing) / 1000   # a swung offbeat starts later, so it ends sooner
        self.play_accents(origin + k * half + swing + self.lead_ms, self.lead_pitch,
                          lambda base: base * 1.7 * (1 + .25 * self.intensity) * crowd, beat_ms, limit)
        self.chord = held

    # A climax is a moment, not a state: at most 20 s, then 30 s below it.
    def climax(self, now):
        if self.intensity > .8 and now >= self.cool_until:
            self.calm_since = None
            if self.peak_since is None:
                self.peak_since = now
            if not self.target_shift and now - self.peak_since > 3000:
                self.target_shift, self.climax_since = 2, now
                self.cue("climax")
            if self.target_shift and now - self.climax_since > 20_000:
                self.cool_until, self.target_shift = now + 30_000, 0
        else:
            self.peak_since = None
            if self.intensity < .55:
                if self.calm_since is None:
                    self.calm_since = now
                if self.target_shift and now - self.calm_since > 3000:
                    self.target_shift = 0

    def note(self, t):
        score, plan, key, look = SONGS[self.song], PLANS[self.song], KEYS[self.song], STYLES[self.style]
        pitch, beats = score[self.position]
        step = plan[self.position]
        # Ritardando: over the last bar before the song closes, the beat stretches by up to a quarter.
        end, meter = (None if self.ending else self.end_of_visit()), METERS[self.song][0]
        left = math.inf if end is None else end - self.song_beat
        beat_ms = (60_000 / self.bpm) * (1 + .25 * (1 - left / meter) if left <= meter + 1e-9 else 1)
        i_, active = self.intensity, self.active
        at = t + self.lead_ms
        crowd = .7 if self.house else .85 + .15 * min(1, math.log2(1 + self.working) / 6)
        vel = lambda base: base * 1.7 * (1 + .25 * i_) * crowd
        part = self.part()
        varied, breath = part == "varyasyon", part == "nefes"
        # A breath lasts its bars, then the song closes where the next phrase would start.
        if breath and step["phrase_start"] and self.position and not self.ending \
                and self.song_beat >= BREATH_BARS * meter - 1e-9:
            self.next_song(vel, beat_ms, key)
            return
        self.chord = step["chord"]
        self.next_change = step["next_change"]
        if self.stage is None:
            self.stage, self.starring = list(active), list(self.featured)
        if step["phrase_start"]:
            for s in range(len(self.stage)):
                if not active[s] > 0:
                    self.stage[s] = 0
            self.starring = [s for s in self.starring if s in self.featured]
        on = lambda s, start: self.stage[s] > 0 and (i_ >= start or s in self.starring)
        pickup = METERS[self.song][1]
        swing = lambda beat: (look["swing"] * beat_ms) / 6 if look["swing"] and eq(math.fmod(math.fmod(beat - pickup, 1) + 1, 1), .5) else 0
        # The variation hands the tune to another section on stage (the piano keeps it only when
        # alone); in a breath nobody sings and every accompanying part plays.
        singers = [s for s in (0, 8, 4, 1, 2) if s == 0 or on(s, .5 if s == 2 else 0 if s == 8 else .25)]
        others = [s for s in (8, 4, 1, 2) if self.stage[s] > 0]
        pool = others if varied and others else singers
        stays = self.lead is not None and (self.lead == 0 or self.stage[self.lead] > 0)
        if breath:
            self.lead = None
        elif step["phrase_start"] or not stays:
            self.lead = pool[(step["phrase"] + self.song_count) % len(pool)]
        lead = self.lead
        if self.song not in RANGES:
            tune = [p for p, _ in score if p is not None]
            RANGES[self.song] = (min(tune), max(tune))
        up = 12 if varied and lead != 4 and RANGES[self.song][1] + 12 <= 93 else 0
        # The variation's odd phrases are a new line (invert); each phrase still starts and ends on the theme's notes.
        if step["phrase_start"] or self.anchor is None:
            self.anchor = pitch
        tune = self.invert(pitch, step, pickup) if varied and pitch is not None and step["phrase"] % 2 == 1 \
            and not step["last"] and self.anchor is not None else pitch
        lead_pitch = -99 if tune is None or breath else tune + (12 if lead == 4 else 0) + up
        ctx = (lead, lead_pitch, on, vel, beat_ms, breath)
        self.note_start, self.note_beat_ms, self.note_beat, self.note_pickup, self.lead_pitch = t, beat_ms, self.song_beat, pickup, lead_pitch
        double = False
        first = math.ceil((self.song_beat - pickup) * 2 - 1e-9) / 2 - (self.song_beat - pickup)
        k = 0
        while k < beats - 1e-9:
            self.grid(at + k * beat_ms + swing(self.song_beat + k), self.song_beat + k, step, ctx, k == 0)
            if k == 0:
                double = lead != 4 and 4 in self.starring and self.stage[4] > 0
            k = first if k == 0 and first > 1e-9 else k + .5
        if tune is not None and not breath:
            self.solo = at
            # A phrase swells toward its middle and settles on its last note; the bar line leans a little.
            in_bar = math.fmod(math.fmod(self.song_beat - pickup, meter) + meter, meter)
            lean = 1.06 if eq(in_bar, 0) else 1 if eq(math.fmod(math.fmod(self.song_beat - pickup, 1) + 1, 1), 0) else .95
            shape = (.9 + .16 * step["arch"]) * (.9 if step["last"] else 1) * lean
            onset = at + swing(self.song_beat)
            self.emit(onset, lead_pitch, vel(54 if lead == 0 else 46) * shape,
                      min(2.6, (beats * beat_ms) / 1000 * .92 * look["staccato"]), ACCORDION if lead == 8 else lead)
            if double:
                self.emit(onset, tune if up else tune + 12, vel(20) * shape,
                          min(2.6, (beats * beat_ms) / 1000 * .92 * look["staccato"]), 4)
            # The variation's answer: under a long note, the piano (free of the tune) climbs the chord.
            if varied and lead != 0 and beats >= 2:
                tones = sorted(p for p in self.chord_at(60) + self.chord_at(72) if lead_pitch - 14 <= p < lead_pitch - 2)
                fill = tones[-min(3, math.floor((beats - 1) / .5 + 1e-9)):]
                for n, p in enumerate(fill):
                    self.emit(at + (1 + n * .5) * beat_ms + swing(self.song_beat + 1 + n * .5), p, vel(16), (beat_ms / 1000) * .45, 0)
        self.song_beat += beats
        self.clock = t + beats * beat_ms
        self.position += 1
        if self.position >= len(score):
            self.position, self.song_beat = 0, 0
            self.turn += 1
            # The form over, the next song; when things heat up, a wild one at once (ending: the same song closes).
            heating_up = i_ >= .7 and len(self.songs) > 1 and self.song not in self.moods["wild"]
            if not self.ending and (self.turn >= len(FORMS[self.melody]) or heating_up):
                self.next_song(vel, beat_ms, key)

    def next_song(self, vel, beat_ms, key):
        """Close the song: the tonic rings for two beats, then the next song's dominant seventh for two
        (a bridge into its key), and the next one begins at its own tempo."""
        self.close(self.clock + self.lead_ms, vel, beat_ms, key)
        self.position, self.song_beat = 0, 0
        self.song = self.pick_song()
        self.song_count += 1
        self.turn, self.lead, self.tension, self.tension_next = 0, None, False, False
        root, at = (KEYS[self.song][0] + 7) % 12, self.clock + 2 * beat_ms + self.lead_ms
        for n, p in enumerate([self.band(36 + root, 36)] + [self.band(48 + root + d, 55) for d in (4, 7, 10)]):
            self.emit(at + n * 25, p, vel(20), (2 * beat_ms) / 1000 * .9, 0)
        self.clock += 4 * beat_ms
        self.bpm = self.pace()

    def close(self, at, vel, beat_ms, key=None):
        """A closing tonic chord, rolled from the bottom: at the end of a song, or when the last agent finishes."""
        tonic = chord_tones(None, key or self.tonality(), 48)
        for n, p in enumerate([tonic[0] - 12] + [x + 12 for x in tonic]):
            self.emit(at + n * 25, p, vel(30), (2 * beat_ms) / 1000, 0)

    def grid(self, at, beat, step, ctx, onset):
        lead, lead_pitch, on, vel, beat_ms, breath = ctx
        i_, (meter, pickup), look = self.intensity, METERS[self.song], STYLES[self.style]
        in_bar = math.fmod(math.fmod(beat - pickup, meter) + meter, meter)
        waltz = meter == 3
        rel = beat - pickup
        bar_line, on_beat, change = eq(in_bar, 0), eq(math.fmod(math.fmod(rel, 1) + 1, 1), 0), onset and step["change"]
        twice = math.fmod(math.fmod(rel * 2, 1) + 1, 1)
        half = eq(twice, 0) or eq(twice, 1)
        if bar_line:
            self.shift = self.target_shift
            self.tension = self.tension_next
            for s, n in enumerate(self.active):
                if n > 0:
                    self.stage[s] = n
            for s in self.featured:
                if s not in self.starring:
                    self.starring.append(s)
        if bar_line and self.cues:
            self.play_cues(at, vel, beat_ms)
        if change or bar_line:
            until = min(self.next_change, beat + meter - in_bar)
            span = (max(.25, until - beat) * beat_ms) / 1000
            length = max(span * .5, span - .25) if eq(until, self.next_change) else span * .94
            self.harmony(at, length, lead, lead_pitch, on, vel, beat_ms)
        if half and look["bass"] != "long":
            low = self.chord_at(36)[0]
            root = low + 12 if low < 40 else low
            self.emit(at, root + 12 if look["bass"] == "octaves" and not on_beat else root, vel(24),
                      (beat_ms / 1000) * .45, 3 if on(3, 0) else 0)
        if look["bass"] == "long" and not waltz and eq(in_bar, 2) and not change and on(3, .35) and self.next_change - beat >= 2:
            fifth = self.chord_at(36)[2]
            self.emit(at, fifth - 12 if fifth >= 48 else fifth, vel(26), (2 * beat_ms) / 1000 * .9, 3)
        if half and look["comp"] == "ostinato" and on(1, .3) and lead != 1:
            c = self.chord_at(48)
            self.emit(at, self.band(c[0] if on_beat else c[2], 48), vel(13), (beat_ms / 1000) * .45, 1)
        if on_beat and (i_ >= .25 or 7 in self.starring or 5 in self.starring):
            colour = [s for s in (7, 5) if on(s, .45 if s == 5 else .25)]
            stars = [s for s in colour if s in self.starring]
            players = stars if len(stars) > 1 else [colour[math.floor(self.position / 8) % len(colour)]] if colour else []
            for s in players:
                if s == 7 or eq(in_bar, 0) or (not waltz and eq(in_bar, 2)):
                    p = self.chord_at(84)[math.floor(beat) % 3]
                    self.emit(at, p, vel(18 if s == 7 else 16), (beat_ms / 1000) * 1.2 if s == 7 else .45, s)
        if on_beat and (breath or not any(s != lead and on(s, 0 if s == 1 else .45 if s == 6 else .6) for s in (1, 6, 2))) \
                and not bar_line and not change:
            c = [self.band(p, 55) for p in self.chord_at(60)]
            pattern = [c[0], c[2], c[1]] if waltz else [c[0], c[2], c[1], c[2]]
            p = pattern[math.floor(in_bar + 1e-9) % len(pattern)]
            if abs(p - lead_pitch) <= 2:
                p = next((x for x in c if abs(x - lead_pitch) > 2), None)
            if p is not None:
                self.emit(at, p, vel(15), (beat_ms / 1000) * .95, 0)
        if on_beat and not bar_line and (waltz or eq(math.fmod(in_bar, 2), 1)) and lead != 8 and on(8, .3):
            for p in self.mid(lead_pitch):
                self.emit(at, p, vel(14), (beat_ms / 1000) * .3, ACCORDION)
        self.drums(at, in_bar, waltz, bar_line, on_beat, half, vel, i_)

    def drums(self, at, in_bar, waltz, bar_line, on_beat, half, vel, i_):
        kind = STYLES[self.style]["drums"]
        if kind == "orchestral" and bar_line and i_ >= .4:
            self.emit(at, self.chord_at(36)[0], vel(20), .8, TIMPANI)
        if kind == "lofi":
            if half and (bar_line or (not waltz and eq(in_bar, 2.5))):
                self.emit(at, 36, vel(18), .15, DRUMS)
            if on_beat and not bar_line and (waltz or eq(math.fmod(in_bar, 2), 1)):
                self.emit(at, 38, vel(10), .15, DRUMS)
            if half:
                self.emit(at, 42, vel(7 if on_beat else 5), .05, DRUMS)
            return
        if not self.shift and not (kind == "groove" and i_ >= .3):
            return
        if on_beat:
            kick = bar_line if waltz else eq(math.fmod(in_bar, 2), 0)
            self.emit(at, 36 if kick else 38, vel(30 if kick else 16 if waltz else 22), .15, DRUMS)
        elif half and kind == "groove" and i_ >= .55:
            self.emit(at, 42, vel(9), .05, DRUMS)

    def harmony(self, at, length, lead, lead_pitch, on, vel, beat_ms):
        look, low = STYLES[self.style], self.chord_at(36)[0]
        if look["bass"] == "long":
            if on(3, .2):
                self.emit(at, low, vel(34), length, 3)
            else:
                self.emit(at, low + 12 if low < 40 else low, vel(26), length, 0)
        pads = [s for s in (1, 6, 2) if s != lead and on(s, 0 if s == 1 else .45 if s == 6 else .6)]
        room = 2 if self.intensity >= .75 else 1
        for s in [s for i, s in enumerate(pads) if i < room or s in self.starring]:
            notes = self.horn() if s == 6 else self.mid(lead_pitch, 72 if s == 2 else 60)
            if look["comp"] == "arp" and notes:
                tick = beat_ms / 4
                count = max(1, math.floor((length * 1000) / tick + 1e-9))
                order = list(range(len(notes))) + (list(range(len(notes)))[1:-1][::-1] if len(notes) > 2 else [])
                for i in range(count):
                    self.emit(at + i * tick, notes[order[i % len(order)]], vel(12), (tick / 1000) * .9, s)
            else:
                for p in notes:
                    self.emit(at, p, vel(20 if s == 6 else 16), length, s)

    def mid(self, lead_pitch, lo=60):
        return [p for p in (self.band(p, lo) for p in self.pad_chord(60)) if abs(p - lead_pitch) > 2]

    def horn(self):
        h = self.chord_at(48)
        return [self.band(h[0], 48), self.band(h[2], 48)]

    def pad_chord(self, octave):
        """The held chord: a broken test suspends it until a test passes; lo-fi adds the seventh."""
        key = self.tonality()
        root, intervals = self.chord or chords_for(key)[0]
        tones = list(intervals)
        if self.tension:
            tones = [0, 7] if self.flow else [0, 5, 7]   # loops: an open fifth, the riffs keep their thirds
        elif STYLES[self.style]["sevenths"] and len(intervals) == 3:
            # The seventh the key's own scale has (natural minor in a minor key): a minor key's VII takes a
            # minor seventh. Outside the scale: a minor chord or the dominant a minor seventh, the rest a major one.
            scale = [(key[0] + d) % 12 for d in ((0, 2, 3, 5, 7, 8, 10) if key[1] else (0, 2, 4, 5, 7, 9, 11))]
            flat, major = (root + 10) % 12 in scale, (root + 11) % 12 in scale
            tones = tones + [(10 if flat else 11) if flat != major else 10 if intervals[1] == 3 or (root - key[0] + 12) % 12 == 7 else 11]
        base = octave - octave % 12 + root
        return [base + i for i in tones]

    def play_accents(self, at, lead_pitch, vel, beat_ms, limit=math.inf):
        accents, self.accents = self.accents, []
        for kind, section in accents:
            voice = ACCORDION if section == 8 else section
            c = self.chord_at(ACCENT_OCTAVE[section] + (12 if kind == "read" else 0))
            notes = [c[0]] if kind == "bash" else [c[2]] if kind == "read" else [c[0], c[1]]
            for p in notes:
                if abs(p - lead_pitch) > 2:
                    self.emit(at, p, vel(20 if kind == "bash" else 12 if kind == "read" else 10),
                              min(limit, (beat_ms / 1000) * (1.5 if kind == "think" else .45)), voice)

    def play_cues(self, at, vel, beat_ms):
        t = self.chord_at(60)
        base, up = self.band(t[0], 55), [0, t[1] - t[0], t[2] - t[0], 12]
        cues, self.cues = self.cues, []
        for kind in cues:
            if kind == "climax":
                self.emit(at, 49, vel(40), 2.2, DRUMS)
                self.emit(at, self.chord_at(36)[0], vel(46), 1.2, TIMPANI)
            elif kind == "ship":
                for d in (0, up[2], 12):
                    self.emit(at, base + d, vel(24), (beat_ms / 1000) * 2, 6)
            elif kind == "wait":
                for i, d in enumerate(up):
                    self.emit(at + (i * beat_ms) / 2, base + 24 + d, vel(22), 1.4 - i * .2, 7 if i == 3 else 5)
            elif kind in ("fail", "testfail"):
                low, w = self.chord_at(36)[0], 1.3 if kind == "testfail" else 1
                for d in (12, 15, 18):
                    self.emit(at, low + d, vel(18 * w), 1.4, TREMOLO)
                self.emit(at, low, vel(26 * w), 1, TIMPANI)
            else:
                for i, d in enumerate(up):
                    self.emit(at + (i * beat_ms) / 2, base + d, vel(26), (beat_ms / 1000) * .45, 6)

    # ---- Flow: loops instead of songs (flow.mjs) ----
    def flow_tick(self, now, working, total):
        """The agents working: one sixteenth after another. The last one out: the bar plays to its end (the
        next one too when less than a beat is left), then a soft tonic. With listeners and nobody working the
        house pianist plays the loops alone (house: piano only, no beat)."""
        f, beat_ms = self.flow, 60_000 / self.bpm
        vel = lambda base: base * 1.7 * .85
        if not working and not self.house:
            if self.clock and self.clock >= now - 500:
                if f.left is None:
                    f.left = 16 - f.step % 16
                    if f.left < 4:
                        f.left += 16
                while self.clock and self.clock <= now + LOOKAHEAD_MS:
                    if f.left <= 0:
                        self.close(self.clock + self.lead_ms, vel, beat_ms)
                        self.clock = 0
                    else:
                        self.flow_step(self.clock)
                        f.left -= 1
            else:   # a stall (sleep): no late chord mid-ending
                if self.clock and f.left is None:
                    self.close(now + self.lead_ms, vel, beat_ms)
                self.clock = 0
            if self.cues:
                self.play_cues(now + self.lead_ms, vel, beat_ms)
            self.accents.clear()
            if not self.clock:
                f.left, self.stage, self.starring = None, None, []
            return {"working": working, "total": total}
        f.left = None
        if not self.clock:   # start
            self.clock = now
            self.new_scene(now)
        elif self.clock < now - 500:   # a stall (sleep): the loop goes on where it was
            self.clock = now
        while self.clock <= now + LOOKAHEAD_MS:
            self.flow_step(self.clock)
        if self.accents:
            self.flush_accents(now)
        return {"working": working, "total": total}

    def flow_step(self, t):
        """One sixteenth: a loop or a bar may begin, then every note that starts on it."""
        f = self.flow
        ending = f.left is not None
        if f.step == 0 or (f.skip and not ending and f.step % 16 == 0):
            if ending and f.loop >= len(FLOW["arc"]):   # the last one out ends in this scene's key
                f.loop = len(FLOW["arc"]) - 1
            elif not f.prog or (not ending and (f.skip or f.loop >= len(FLOW["arc"]))):   # no scene yet: loops switched on mid-ending
                self.new_scene(t)
            self.flow_loop()
        beat_ms, s = 60_000 / self.bpm, f.step % 16
        if s == 0:
            self.flow_bar(t, beat_ms)
        at = t + self.lead_ms + self.flow_swing(s % 4) * beat_ms
        for k, p, v, d, i, ms, hook in f.bar:
            if k != s:
                continue
            self.emit(at + ms, p, v, d, i)
            if hook:
                self.solo, self.lead_pitch = at, p
        self.note_start, self.note_beat_ms, self.note_beat, self.note_pickup = t, beat_ms, f.step / 4, 0
        self.clock = t + beat_ms / 4
        f.step += 1
        if f.step >= 64:
            f.step = 0
            f.loop += 1

    def flow_swing(self, pos):
        """Swing in beats for the four sixteenths of a beat: the offbeat eighth late, the sixteenths around it halfway."""
        s = STYLES[self.style]["swing"] / 6
        return (0, s / 2, s, s / 2)[pos]

    def flow_title(self):
        """What the loops play: "Akış · La minör · i-VI-III-VII" (the key as heard, a climax included)."""
        f = self.flow
        if not f.prog_id:
            return "Akış"
        return f"Akış · {NOTE_NAMES[(f.key[0] + self.shift) % 12]} {'minör' if f.key[1] else 'majör'} · {f.prog_id}"

    def rand(self):
        """The same numbers here and in conductor.mjs (MINSTD): riffs are written, not looked up."""
        self.flow.rng = self.flow.rng * 48271 % 2147483647
        return self.flow.rng / 2147483647

    def pick(self, items):
        return items[math.floor(self.rand() * len(items))]

    def pick_other(self, items, last):
        other = [x for x in items if x != last]
        return self.pick(other or list(items))

    def new_scene(self, now):
        """A new scene: a chord loop not heard in the last three scenes, in a neighbouring key (the relative
        key when the mode changes), at the tempo the pace asks for, with new riffs and patterns."""
        f, look = self.flow, STYLES[self.style]["flow"]
        if not f.rng:
            f.rng = int(now // 1000) % 2147483646 + 1
        first = f.count == 0
        f.count += 1
        f.loop, f.step, f.skip, f.shipped = 0, 0, False, False
        fresh = [x for x in look["progressions"] if x not in f.recent]
        f.prog_id = self.pick(fresh or look["progressions"])
        f.recent.append(f.prog_id)
        while len(f.recent) > min(3, len(look["progressions"]) - 1):
            f.recent.pop(0)
        minor, chords = FLOW["progressions"][f.prog_id]["minor"], FLOW["progressions"][f.prog_id]["chords"]
        tonic, was_minor = f.key
        if first:
            key = self.pick((9, 4, 2, 7, 0) if minor else (0, 2, 5, 7, 9))
        elif minor == was_minor:   # every scene a new key signature: a fourth, a fifth or a tone away,
            key = (tonic + self.pick((5, 7, 2, 10))) % 12
        else:                      # or the relative of a neighbouring key
            key = (tonic + (9 if minor else 3) + self.pick((5, 7))) % 12
        f.key = (key, minor)
        f.prog = [[(key + d) % 12, iv] for d, iv in chords]
        slow, fast = look["tempo"]
        pace = js_round(slow + (fast - slow) * self.intensity)
        glide = max(self.bpm - 8, min(self.bpm + 8, pace))   # at most 8 BPM a scene, within the style's range
        self.bpm = pace if first or glide < slow or glide > fast else glide
        f.bass = self.pick_other(look["basses"], f.bass)
        f.comp = self.pick_other(look["comps"], f.comp)
        f.arp = self.pick_other(look["arps"], f.arp)
        f.stabs = self.pick_other(FLOW["stabs"], f.stabs)
        f.bells = {"rhythm": self.pick_other(FLOW["bells"], f.bells and f.bells["rhythm"]),
                   "idx": [math.floor(self.rand() * 4) for _ in range(8)]}
        f.riff = {"rhythm": self.pick_other(FLOW["riffs"], f.riff and f.riff["rhythm"]),
                  "idx": [math.floor(self.rand() * 4) for _ in range(8)]}
        a = self.make_hook(None, f.hooks["A"]["call"] if f.hooks else None)
        f.hooks = {"A": a, "A2": self.make_hook(a, None), "B": self.make_hook(None, a["call"])}
        f.counter = self.make_counter()

    def flow_loop(self):
        """A loop begins: who left has played out, the key moves up at a climax, and the arc says what plays.
        A commit (ship) makes the next loop the peak. Less melody keeps the hook in three loops of eight,
        more adds it to the intro and the break."""
        f, i_ = self.flow, self.intensity
        if self.stage is not None:
            for s in range(len(self.stage)):
                if not self.active[s] > 0:
                    self.stage[s] = 0
            self.starring = [s for s in self.starring if s in self.featured]
        self.shift = self.target_shift
        # A commit (one waiting for this bar line too) makes this loop the peak, once a scene: a busy crowd still hears the arc.
        bonus = not f.shipped and (f.bonus or "ship" in self.cues)
        arc = FLOW["arc"][FLOW["peak"] if bonus else f.loop]
        if bonus:
            f.shipped = True
        f.bonus = False
        levels, cap = ("light", "main", "busy"), 0 if i_ < .2 else 1 if i_ < .5 else 2   # a calm pace keeps the beat light
        beat = levels[min(levels.index(arc["beat"]), cap)] if arc["beat"] in levels else arc["beat"]
        hook = self.arc_hook(arc)
        if bonus and hook:   # a commit's peak: never the hook of the loop before or after it
            before = f.plan["hook"] if f.plan else None
            after = self.arc_hook(FLOW["arc"][f.loop + 1]) if f.loop + 1 < len(FLOW["arc"]) else None
            if hook in (before, after):
                hook = next(h for h in ("A", "B", "A2") if h not in (before, after))
        f.plan = {"name": arc["name"], "beat": beat, "hook": hook, "allow": arc["allow"], "sparse": bool(arc.get("sparse")), "fill": bool(arc.get("fill")),
                  "crash": bool(arc.get("crash")) or (f.loop == 0 and f.count > 1), "bass": arc.get("bass"), "comp": arc.get("comp")}

    def arc_hook(self, arc):
        """The hook a loop of the arc plays with this much melody."""
        if self.melody == "az":
            return arc["hook"] if arc.get("az") else None
        if self.melody == "cok":
            return arc["hook"] if arc["hook"] is not None else arc.get("cok")
        return arc["hook"]

    def flow_bar(self, t, beat_ms):
        """A bar: newcomers step in, the bar's chord, then every layer's notes, played sixteenth by sixteenth."""
        f, i_, look, plan = self.flow, self.intensity, STYLES[self.style]["flow"], self.flow.plan
        reg = {**FLOW["registers"], **look.get("registers", {})}
        bar, step_s, staccato = f.step // 16, beat_ms / 4000, STYLES[self.style]["staccato"]
        if self.stage is None:
            self.stage, self.starring = list(self.active), list(self.featured)
        for s, n in enumerate(self.active):
            if n > 0:
                self.stage[s] = n
        for s in self.featured:
            if s not in self.starring:
                self.starring.append(s)
        if self.house:   # the house pianist alone
            self.stage, self.starring = [1 if s == 0 else 0 for s in range(len(self.stage))], []
        self.tension = self.tension_next
        self.chord = f.prog[bar]
        crowd = .7 if self.house else .85 + .15 * min(1, math.log2(1 + self.working) / 6)
        vel = lambda base: base * 1.7 * (1 + .25 * i_) * crowd
        if self.cues:
            later = [k for k in self.cues if k == "climax"] if bar else []   # the climax waits for the loop, where the key moves up
            self.cues = [k for k in self.cues if k not in later]
            if "ship" in self.cues and bar:
                f.bonus = True
            if self.cues:
                self.play_cues(t + self.lead_ms, vel, beat_ms)
            self.cues.extend(later)
        notes = f.bar = []

        def add(s, p, v, d, voice, ms=0, hook=False):
            notes.append([s, p, vel(v), d, voice, ms, hook])

        # A layer plays when its section is on stage and the arc allows it at this pace, or when a session plays it
        # (at any pace; in a sparse loop only if the arc allows that layer at all).
        def on(s, layer):
            allowed = layer in plan["allow"]
            return self.stage[s] > 0 and ((allowed and i_ >= plan["allow"][layer]) or (s in self.starring and (allowed or not plan["sparse"])))

        def tones(pcs, lo, hi):
            return [p for p in range(lo, hi + 1) if p % 12 in pcs]

        triad = [(self.chord[0] + i) % 12 for i in self.chord[1]]
        pad = [p % 12 for p in self.pad_chord(60)]   # the style's sevenths, a broken test's suspension
        if plan["beat"] and not self.house:
            kit = FLOW["beats"][look["beat"]]["fill" if bar == 3 and plan["fill"] else plan["beat"]]
            for name, hits in kit.items():
                for s in range(16):
                    if hits[s] == ".":
                        continue
                    level = 1 if hits[s] == "X" else .75 if hits[s] == "x" else .45
                    if name == "timp":
                        add(s, self.band(self.chord[0], 36), FLOW["levels"]["timp"] * level, FLOW["lengths"]["timp"], TIMPANI)
                    else:
                        add(s, FLOW["drums"][name], FLOW["levels"][name] * level, FLOW["lengths"][name], DRUMS)
            if bar == 0 and plan["crash"] and look["crash"] is not None:
                add(0, look["crash"], 26, 2.2, DRUMS)
        # Bass from the bar's root ("a" steps into the next bar's root); the piano's left hand when nobody plays bass.
        if "bass" in plan["allow"] or 3 in self.starring:
            own, root, up = self.stage[3] > 0, self.band(self.chord[0], 40), self.band(f.prog[(bar + 1) % 4][0], 40)
            d = -1 if up > root else 1
            into = next((x for x in (up + d, up - d, up + 2 * d, up - 2 * d)   # a step into the next root, clear of the chord
                         if not any((x - pc) % 12 in (1, 11) for pc in pad)), None)
            for s, tone, length in FLOW["basses"][plan["bass"] or f.bass]:
                p = root if tone == "r" else root + 7 if tone == "5" else root + 12 if tone == "8" else \
                    root + self.chord[1][1] if tone == "3" else root + 7 if up == root or into is None else into
                add(s, p, (26 if s % 4 == 0 else 22) * (1 if own else .8), length * step_s * .9, 3 if own else 0)
        # Chords, voice-led from the last bar: struck, broken into an arpeggio, or root and fifth in turn.
        if "chords" in plan["allow"] or 1 in self.starring:
            comp, own = FLOW["comps"][plan["comp"] or f.comp], self.stage[1] > 0
            voice, level = (1, 1) if own else (0, .7)
            if comp.get("pair"):
                c = self.chord_at(48)
                pair = [self.band(c[0], 48), self.band(c[2], 48)]
                for n, s in enumerate(range(0, 16, comp["rate"])):
                    add(s, pair[n % 2], 13 * level, comp["rate"] * step_s * .9, voice)
            else:
                f.voicing = self.voice_lead(pad, reg["pad"], f.voicing)
                if "hits" in comp:
                    for s, length, l in comp["hits"]:
                        for n, p in enumerate(f.voicing):
                            add(s, p, (15 if length >= 8 else 16) * l * level, length * step_s * .94, voice, n * comp.get("roll", 0))
                else:
                    up = f.voicing + [f.voicing[0] + 12]
                    for n, s in enumerate(range(0, 16, comp["rate"])):
                        add(s, up[comp["order"][n % len(comp["order"])] % len(up)], 12 * level, comp["rate"] * step_s * .9, voice)
        # Voices: a held two-part line, the top on the chord tone nearest the last one.
        if on(2, "voices"):
            lo, hi = reg["voices"]
            line = tones(pad, lo, hi)
            target = f.choir if f.choir is not None else (lo + hi) / 2
            top = line[0]
            for p in line:
                if abs(p - target) < abs(top - target):
                    top = p
            f.choir = top
            below = [p for p in line if 3 <= top - p <= 9]
            for p in [top] + below[-1:]:
                add(0, p, 18 if plan["name"] == "mola" else 14, 16 * step_s * .94, 2)
        # The hook: the first session's voice (a joiner's when it has left), louder on the bar line, settling at its end.
        hook = f.hooks[plan["hook"]] if plan["hook"] else None
        singer = 0 if self.stage[0] > 0 else 4 if self.stage[4] > 0 else 8 if self.stage[8] > 0 else 0
        if hook:
            line = hook["bars"][bar]
            for n, (s, p, length) in enumerate(line):
                shape = (1.06 if s == 0 else 1 if s % 4 == 0 else .92) * (.9 if bar == 3 and n == len(line) - 1 else 1)
                add(s, p, (42 if singer == 0 else 38) * shape, min(2.6, length * step_s * .92 * staccato),
                    ACCORDION if singer == 8 else singer, 0, True)
        # The counter-melody answers in bars 2 and 4.
        if on(4, "counter") and singer != 4:
            for b, line in f.counter:
                if b == bar:
                    for s, p, length in line:
                        add(s, p, 30, min(2.6, length * step_s * .9 * staccato), 4)
        if on(5, "bells"):
            line = tones(triad, *reg["bells"])
            for n, (s, _) in enumerate(self.onsets(f.bells["rhythm"])):
                add(s, line[f.bells["idx"][(bar * 3 + n) % 8] % len(line)], 14, .45, 5)
        if on(6, "stabs"):
            f.stab = self.voice_lead(triad, reg["stab"], f.stab)
            for s, length in self.onsets(f.stabs):
                for p in f.stab:
                    add(s, p, 17, length * step_s * .8, 6)
        if on(7, "arp"):
            a, line, tune = FLOW["arps"][f.arp], tones(pad, *reg["arp"])[:5], hook["bars"][bar] if hook else []
            for n, s in enumerate(range(0, 16, a["rate"])):
                p = line[a["order"][n % len(a["order"])] % len(line)]
                h = next((x[1] for x in tune if x[0] <= s < x[0] + x[2]), None)
                if h is not None and abs(p - h) <= 2:   # never on the hook's note: an octave away
                    p += 12 if p + 12 <= reg["arp"][1] else -12
                add(s, p, 11, a["rate"] * step_s * .9, 7)
        if on(8, "riff") and singer != 8:
            line = tones(pad, *reg["riff"])
            for n, (s, _) in enumerate(self.onsets(f.riff["rhythm"])):
                add(s, line[f.riff["idx"][n % 8] % len(line)], 16, min(2.6, 2 * step_s * .85 * staccato), ACCORDION)

    @staticmethod
    def onsets(rhythm):
        """"x--x..": [sixteenth, length] of each note."""
        out = []
        for s, c in enumerate(rhythm):
            if c == "x":
                length = 1
                while s + length < len(rhythm) and rhythm[s + length] == "-":
                    length += 1
                out.append([s, length])
        return out

    @staticmethod
    def voice_lead(pcs, lo, last):
        """The chord stacked up from `lo` in each inversion; the one nearest the last voicing (or the lowest).
        Inversions with a minor second between neighbouring voices only when nothing else is left."""
        every = []
        for k in range(len(pcs)):
            v, p = [], lo - 1
            for j in range(len(pcs)):
                p += 1 + (pcs[(k + j) % len(pcs)] - p - 1) % 12
                v.append(p)
            every.append(v)
        best, cost = None, math.inf
        for v in [v for v in every if not any(v[j] - v[j - 1] == 1 for j in range(1, len(v)))] or every:
            c = sum(min(abs(x - y) for y in last) for x in v) if last else v[0] - lo
            if c < cost:
                best, cost = v, c
        return best

    def bar_scale(self, chord):
        """The key's scale for one bar: a chord tone outside it (a major V in minor, a flat VII in major)
        replaces its neighbour, the seventh degree first, never the tonic."""
        tonic, minor = self.flow.key
        scale = [(tonic + d) % 12 for d in ((0, 2, 3, 5, 7, 8, 10) if minor else (0, 2, 4, 5, 7, 9, 11))]
        for i in chord[1]:
            pc = (chord[0] + i) % 12
            if pc in scale:
                continue
            near = [j for j in range(1, 7) if (scale[j] - pc) % 12 == 1 or (pc - scale[j]) % 12 == 1]
            if near:
                scale[6 if 6 in near else near[0]] = pc
        return scale

    @staticmethod
    def deg_pitch(deg, scale, base):
        o = deg // 7
        return base + 12 * o + (scale[deg - 7 * o] - scale[0]) % 12

    def snap_line(self, raw, hits, chord, d_lo, d_hi):
        """On the beat, on a held note and at a phrase's ends a riff lands on the bar's chord: the nearest
        tone, first the way the line moves, and not the note just played when the line moved. An eighth a
        semitone off a chord tone lands too; only quick passing notes stay between."""
        scale, pcs, out = self.bar_scale(chord), [(chord[0] + i) % 12 for i in chord[1]], []
        for n, deg in enumerate(raw):
            s, length = hits[n]
            pc = scale[deg % 7]
            rubs = length >= 2 and any((x - pc) % 12 in (1, 11) for x in pcs)
            if not (s % 4 == 0 or length >= 3 or n == 0 or n == len(hits) - 1 or rubs):
                out.append(deg)
                continue
            moved, direction = n > 0 and deg != raw[n - 1], -1 if n > 0 and deg < raw[n - 1] else 1
            options = [d for d in (deg, deg + direction, deg - direction, deg + 2 * direction, deg - 2 * direction)
                       if d_lo - 1 <= d <= d_hi + 1 and scale[d % 7] in pcs]
            fresh = [d for d in options if not (moved and d == out[n - 1])]
            out.append(fresh[0] if fresh else options[0] if options else deg)
        return out

    def walk(self, count, start, d_lo, d_hi, cont):
        """Scale degrees mostly by step, sometimes repeating or leaping (a leap turns back by a step), within d_lo..d_hi."""
        out, d, leapt = [], max(d_lo, min(d_hi, start)), False
        direction = 1 if self.rand() < .5 else -1
        for i in range(count):
            if i > 0 or cont:
                r = self.rand()
                size = 0 if r < .1 else 1 if r < .6 else 2 if r < .9 else 3
                if leapt:
                    size, direction = 1, -direction
                elif self.rand() < .3:
                    direction = -direction
                if d + direction * size > d_hi or d + direction * size < d_lo:
                    direction = -direction
                d = max(d_lo, min(d_hi, d + direction * size))
                leapt = size >= 3
            out.append(d)
        return out

    def make_hook(self, keep, avoid):
        """A hook: a call (bar 1, again in bar 3 on its own chord), a short answer that leaves the second half
        of bar 2 to the counter-melody, and a cadence on a long chord tone. `keep`: that hook with a new cadence."""
        f, (lo, hi) = self.flow, STYLES[self.style]["flow"]["hook"]
        base, first = self.band(f.key[0], 60), self.bar_scale(f.prog[0])
        d_lo = -7
        while self.deg_pitch(d_lo, first, base) < lo:
            d_lo += 1
        d_hi = d_lo
        while self.deg_pitch(d_hi + 1, first, base) <= hi:
            d_hi += 1
        call = keep["call"] if keep else self.pick_other(list(range(len(FLOW["calls"]))), avoid)
        tail = keep["tail"] if keep else math.floor(self.rand() * len(FLOW["tails"]))
        cadence = self.pick_other(list(range(len(FLOW["cadences"]))), keep["cadence"]) if keep \
            else math.floor(self.rand() * len(FLOW["cadences"]))
        if keep:
            raw = keep["raw"][:3]
        else:
            one = self.walk(len(self.onsets(FLOW["calls"][call])), (d_lo + d_hi) // 2 + math.floor(self.rand() * 5) - 2, d_lo, d_hi, False)
            raw = [one, self.walk(len(self.onsets(FLOW["tails"][tail])), one[-1], d_lo, d_hi, True), one]
        raw = raw + [self.walk(len(self.onsets(FLOW["cadences"][cadence])), raw[2][-1], d_lo, d_hi, True)]
        bars = []
        for b, r in enumerate((FLOW["calls"][call], FLOW["tails"][tail], FLOW["calls"][call], FLOW["cadences"][cadence])):
            hits, scale = self.onsets(r), self.bar_scale(f.prog[b])
            line = self.snap_line(raw[b], hits, f.prog[b], d_lo, d_hi)
            bars.append([[s, self.deg_pitch(line[n], scale, base), length] for n, (s, length) in enumerate(hits)])
        return {"call": call, "tail": tail, "cadence": cadence, "raw": raw, "bars": bars}

    def make_counter(self):
        """The counter-melody: one rhythm and one walk over chord tones, answering in bars 2 and 4."""
        f, (lo, hi) = self.flow, STYLES[self.style]["flow"]["counter"]
        hits = self.onsets(self.pick(FLOW["counters"]))
        moves = [self.pick((1, 1, -1, -1, 2, -2, 0)) for _ in hits]
        start = self.rand()
        out = []
        for b in (1, 3):
            chord = f.prog[b]
            line = [p for p in range(lo, hi + 1) if any((chord[0] + i) % 12 == p % 12 for i in chord[1])]
            k, notes = math.floor(start * len(line)), []
            for n, (s, length) in enumerate(hits):
                if n:
                    k = max(0, min(len(line) - 1, k + moves[n]))
                notes.append([s, line[k], length])
            out.append([b, notes])
        return out
