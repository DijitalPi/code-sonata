---
name: code-sonata
description: Code Sonata ("kod müziği"): background music from Claude/Codex work on this Mac. Start, stop, status, style, song. Not for general music making.
---

# Code Sonata

Run the helper yourself; never ask the user to paste commands. Helper: `python3 ~/.codex/skills/code-sonata/scripts/control.py`

- Start (every Claude and Codex session on this Mac): `start [--style S] [--song ID]`. While music plays, the same command switches style or song without a restart; omitted options keep the last choice.
- `stop`, `status`, `list` (all styles and songs), `doctor` (install check). `--eco` on start: battery saver, no reverb.
- On start, also live: `--melody az|orta|cok` (how much tune: az has long breaks, cok none) and `--volume 0-100`. "Less melody" → `--melody az`; "quieter" → `--volume 50`.
- `--song akis`: layered loops instead of songs (like Incredibox): new hooks every minute or so, a chord loop not heard in the last three scenes, a neighbouring key. "Too repetitive", "Incredibox", "loops", "akış" → `--song akis`. No like/ban/queue there. `next`: the next scene (next song outside flow).
- Personal: `queue add|remove|set|clear ID…` then `start --song sira` (own order); `like [ID]`, `ban [ID]` (no ID: the song playing; like = comes first, ban = never again, leaves the queue too); `signals [on|off KIND…|demo]` (wait, testfail, pass, ship, fail, adim).
- Zero-token demo: `demo` (about a minute). Never open subagents to test.
- Folder mode only when the user names a folder: `start /path` (`--song original` exists only there).
- The user's own MIDI, played only on this Mac: `import /path/file.mid --name ID [--title T] [--track N] [--bars 5-20]`; restart the music to hear it.

Styles: klasik (default), 8bit (game), sinema (film), lofi (calm, work), synthwave.
Requests: "oyun müziği" → 8bit (+ kesif or boss), "Tetris" → korobeiniki, "film" → sinema, "sakin/çalışma" → lofi, "Mozart" → rondo-alla-turca or mozart-40, "La Casa de Papel" → bella-ciao, "Beethoven" → ode-to-joy or fur-elise; `list` for the rest. There are no copyrighted game or film themes; offer MIDI import instead.

Never say the music is on unless the command succeeded; report helper errors in one line. Answer in the user's language in one or two lines: what plays, and that "kod müziğini kapat" stops it.
