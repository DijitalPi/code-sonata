# Contributing

Thanks for helping. Issues and pull requests in English or Turkish are both fine.

## Setup

```sh
git clone https://github.com/DijitalPi/code-sonata.git
cd code-sonata
./install.sh --link     # run straight from the checkout, no copy
python3 demo.py         # hear it without spending a token
```

`--link` matters if the repo lives in Desktop, Documents, Downloads or iCloud Drive: a plain
`./install.sh` copies the files elsewhere, and your edits only take effect after you run it again.

For the site: `node orchestra/fetch-sounds.mjs` once, then `PORT=4480 node orchestra/server.mjs`.
To fill the hall with fake machines, start the server with `ALLOW_SIMULATION=1 TRUST_PROXY=1` and run
`node orchestra/crowd.mjs 20 120`.

## Before you open a pull request

```sh
python3 -m unittest -v
node --test orchestra/test-*.mjs
```

Both suites run in CI on macOS. Keep tests free: use `demo.py` and `crowd.mjs` instead of real agent
sessions, and never call a model from a test.

## Rules that the tests enforce

- **Two conductors, one behavior.** `conductor.py` is a line-for-line port of
  `orchestra/web/conductor.mjs`. Change both in the same pull request. `test_conductor.py` plays the
  same scenario through both and requires identical notes in every style.
- **New modules get installed.** A new `.mjs` file under `orchestra/web/` that the local tool reads
  must be added to the copy list in `install.sh`. `test_melodies.InstallTests` checks this.
- **Notes stay in range.** If a new song or pattern goes beyond the loaded samples, update
  `NOTE_RANGE` in `orchestra/web/instruments.js`. `test-moment` catches it.
- **Melody timing stays on the grid.** Apart from the final-bar ritardando, don't add humanized
  offsets to melody notes; the rhythm tests compare against the exact grid.

## Rules that the tests don't fully enforce

- **Nothing private leaves the machine.** The reader sends counts only: step kinds, working or not,
  session count, an anonymous machine id and a pass/fail/ship signal. No code, prompts, file paths
  or project names. Open an issue before adding any field to that payload.
- **No new dependencies.** Python uses the standard library only and has to run on the
  `/usr/bin/python3` that macOS ships (3.9). The server uses `node:http` only. The one browser
  library, smplr, is vendored.
- **Music must be free to use.** Add only works whose composer died more than 70 years ago,
  traditional tunes, or music you wrote yourself, and fill in `source` in `songs.mjs` (where the notes
  came from and which bars). No copyrighted game or film music, even if it is famous.
- **Musical changes need ears.** Tests check structure, not taste. For a change to how the music
  sounds, describe what you listened to, or attach a short recording.

## Style

Match the surrounding code: short functions, comments only where the reason isn't obvious. Commit
messages follow `feat:`, `fix:`, `docs:`, `test:`.

## Security

Report vulnerabilities through GitHub's private vulnerability reporting (Security tab, "Report a
vulnerability"), not in a public issue.
