# Code Sonata

English · [Türkçe](README.tr.md)

Code Sonata plays music while Claude Code and Codex work on your Mac. Every step an agent takes
(a command, a file read, an edit, a thinking block) becomes a note in a live arrangement. Each
session gets its own instrument, the tempo follows how busy the agents are, and passing tests,
failing tests and successful commits each have their own sound.

It runs locally. It reads only the *kind* of each step from the session logs, never the messages,
code or tool input, and the music costs zero tokens.

The repo also holds **Agent Orchestra** (`orchestra/`), a small web hall where several machines
play into one shared piece. See [Agent Orchestra](#agent-orchestra) below.

## Requirements

- macOS (the sound engine and menu bar are Swift and AVAudioEngine)
- Python 3.9+ and Xcode Command Line Tools
- Node 20+ only for the Agent Orchestra site and for the test that compares the two conductors

No pip or npm packages.

## Install

```sh
./install.sh                    # install or update (about 2 seconds)
./install.sh --link             # development: run straight from this checkout
./install.sh --kaldir           # uninstall; imported MIDI songs stay
./install.sh --kaldir --hepsi   # uninstall and delete imported songs too
```

The script builds the sound engine and the menu bar app into
`~/Library/Application Support/code-sonata/bin`, links the skill into `~/.claude/skills` and
`~/.codex/skills` (if present), and finishes with `control.py doctor`. If the repo sits in Desktop,
Documents, Downloads or iCloud Drive, it copies a working copy to `.../code-sonata/app`, because
macOS asks background programs for permission to read those folders and the engine would hang on
that prompt. With a copy install, run `./install.sh` again after changing the repo. Nothing starts at
login.

Then ask Claude Code or Codex to "start code sonata" (or, in Turkish, "kod müziğini aç"). You can
also run the listener yourself:

```sh
python3 agents.py            # play
python3 agents.py --silent   # print the steps instead of playing
python3 demo.py              # zero-token demo: fake sessions drive the real listener for a minute
```

## What you hear

The listener watches `~/.claude/projects/**/*.jsonl` and `~/.codex/sessions/**/*.jsonl`, so every
session on the Mac joins, whatever window or project it runs in.

| Step | Sound |
|---|---|
| any step | raises tempo (66–116 BPM) and energy |
| Bash / exec | short bass note on that session's instrument |
| Read / Grep / Glob | light, high chord tone |
| thinking / text | soft third |
| turn ends | the session's instrument finishes its phrase and leaves; after the last one, a closing chord |

| Signal | Sound |
|---|---|
| waiting for permission or an answer | rising bell (Claude Code `Notification` hook; `install.sh` prints the command) |
| tool error | short dark chord |
| test failed | stronger dark chord; the harmony stays suspended until tests pass |
| tests passed | rising horn |
| `git commit` / `git push` succeeded | fanfare |

Test and commit results are read only from command output, as yes or no: reading a log file does not
count as a failed test, and `10 passed; 0 failed` counts as a pass.

**Sessions as instruments.** The first session brings in the whole band for the current style. Each
new session (a terminal or a subagent) adds an instrument the band doesn't have yet, entering at the
start of a bar. A session that finishes completes its phrase and steps out at the next one. A session
idle for 20 seconds gives its seat to the next newcomer.

**Styles.** `klasik` (piano, strings, cello, harp; drums only at the climax), `8bit`, `sinema`
(film), `lofi`, `synthwave`. Option values are Turkish for now: `klasik` is classical, `sinema` is cinema.

**Songs and flow.** 20 pieces: public domain classics (Für Elise, Gymnopédie No. 1, The
Entertainer, Rondo alla Turca, Korobeiniki and others) and three themes written for this project.
A song plays as theme, variation and a short accompaniment-only "breath", then bridges into the next
song. `--song akis` switches to *flow*: stacked four-bar loops on one grid where each session adds a
layer, in eight-loop scenes that change key and chord loop. `--song sira` plays your own queue.

**Climax.** When steps keep coming fast, the accompaniment thickens; after 3 seconds at the top the
music modulates up a step and bells, timpani and drums come in. It lasts at most 20 seconds, then
rests for 30.

**Timing.** Notes are sent 150 ms ahead with exact start times and the Swift engine schedules them.
Measured offset between planned and actual start: 0.06 ms on average, 0.10 ms at worst.

## Controls

The menu bar shows `♫ 3` (three sessions playing), `♪` (waiting), `♪ sessiz` (muted) or
`♪ kapalı` (off). From the menu: mute, next song, style, song, melody amount, volume, start and stop.
The same from the command line:

```sh
python3 skill/scripts/control.py start --style lofi --song gymnopedie
python3 skill/scripts/control.py start --melody az --volume 60   # less melody, quieter (az/orta/cok)
python3 skill/scripts/control.py queue add gymnopedie air brahms-lullaby
python3 skill/scripts/control.py like gymnopedie        # play it earlier in its mood
python3 skill/scripts/control.py ban gymnopedie         # never play it
python3 skill/scripts/control.py signals off ship
python3 skill/scripts/control.py list                   # also: status, stop, doctor
```

Preferences live in `~/Library/Application Support/code-sonata/preferences.json`.

**Your own music.** Import any MIDI file; it plays only on your Mac:

```sh
python3 songbook.py tracks piece.mid
python3 songbook.py import piece.mid --name mypiece --track 1 --bars 5-20
```

**Sound bank.** The default is macOS's built-in General MIDI set. To match the site's sound, pass an
SF2 file (for example FluidR3_GM.sf2) with `--soundfont FILE`, or put it at
`~/Library/Application Support/code-sonata/soundfont.sf2`.

## Resource use

Measured on one Mac with about 8,000 session logs, as a percentage of one core:

| Part | Memory | Idle | Playing |
|---|---|---|---|
| Listener (Python) | 21.5 MB | 0.1–0.5% | 0.7% |
| Sound engine (Swift) | 26 MB | 0% (pauses after 4 s of silence) | 5.5% (`--eco`: 3.7%) |
| Menu bar | 44 MB | 0.02% (quits after 2 min with music off) | 0.02% |

The skill costs about 700 tokens when called; its description line costs about 45 tokens per
session. The listener checks folders every 2 seconds, scans the whole tree every 30, and reads only
logs written in the last 15 minutes.

## Agent Orchestra

`orchestra/` is a shared concert hall in the browser. Machines that join send only counts (steps by
kind, whether they are working, number of sessions, an anonymous machine id and a pass/fail/ship
signal); no code, prompts, paths or project names. The server is plain `node:http` with no
dependencies. It runs one conductor and streams timestamped notes over SSE, and every browser plays
the same notes at the same moment with its own samples.

```sh
node orchestra/fetch-sounds.mjs        # instrument samples, 27 MB, checked against sounds.json
PORT=4480 node orchestra/server.mjs    # http://127.0.0.1:4480
```

The page gives you a one-line command that downloads `reader.py` (Python 3, stdlib only) from the
server and joins. To play locally and join at the same time: `python3 agents.py --global <URL>`.
There is no public hall yet; run your own. Self-hosting, Docker and reverse proxy settings are in
[orchestra/docs/OPERATIONS.md](orchestra/docs/OPERATIONS.md), architecture details in
[orchestra/README.md](orchestra/README.md) (Turkish).

## Folder and editor modes

Older modes that need no agent: `./watch.command /path/to/project` turns saved code changes in one
folder into piano phrases, and `./start.command --editor` opens a small terminal scratchpad that
plays as you type. Neither sends anything over the network. Details in [README.tr.md](README.tr.md).

## Project layout

| Path | What it is |
|---|---|
| `agents.py` | Listener: reads session logs, classifies steps, drives the conductor and engine |
| `conductor.py` | Local conductor, a line-for-line port of `orchestra/web/conductor.mjs` |
| `orchestra/web/songs.mjs`, `flow.mjs`, `styles.mjs` | The score, flow patterns and styles, read by both conductors |
| `Piano.swift` | Sound engine: one sampler per voice, timed commands on stdin |
| `MenuBar.swift` | Menu bar indicator and controls |
| `skill/` | Claude Code and Codex skill, `control.py` helper |
| `reader.py` | Site reader, served by the server as `/reader.py` |
| `songbook.py`, `melodies.py` | MIDI import and the shared song loader |
| `watch.py`, `sonata.py` | Folder and editor modes |
| `orchestra/server.mjs` | Agent Orchestra server |

## Tests

```sh
python3 -m unittest -v           # with node installed, also compares both conductors note by note
node --test orchestra/test-*.mjs
```

No test calls a model. `demo.py` and `orchestra/crowd.mjs` simulate sessions and machines for free.

## Contributing

Issues and pull requests are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) first; the main rule
is that `conductor.py` and `orchestra/web/conductor.mjs` change together.

Much of the user-facing text (CLI help, menu labels, option values, the site) is in Turkish.
Translations are welcome.

## Credits and licenses

Code Sonata is released under the [MIT License](LICENSE). Bundled and downloaded third-party files
keep their own licenses:

- **smplr** 1.1.0 by danigb, MIT: `orchestra/web/vendor/` ([license](orchestra/web/vendor/smplr-1.1.0.LICENSE.txt))
- **Fraunces** and **Instrument Sans** fonts, SIL Open Font License 1.1: `orchestra/web/fonts/`
- **IP to Country Lite** by [DB-IP](https://db-ip.com), CC BY 4.0: `orchestra/geo/`
- **FluidR3 GM** samples by Frank Wen, rendered by
  [gleitz/midi-js-soundfonts](https://github.com/gleitz/midi-js-soundfonts), CC BY 3.0. Not in the
  repo; `fetch-sounds.mjs` downloads them.
- **Music**: public domain or traditional works and themes written for this project. Several are taken
  from [Mutopia Project](https://www.mutopiaproject.org) public domain MIDI files. Each piece lists its
  source in the `source` field of `orchestra/web/songs.mjs`. Copyrighted game and film music is not
  accepted.

Made by [DijitalPi](https://dijitalpi.com).
