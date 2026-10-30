# Notes for coding agents

Read `README.md` and `CONTRIBUTING.md` first. The short version:

- Tests: `python3 -m unittest -v` and `node --test orchestra/test-*.mjs`. Both must pass.
- `conductor.py` mirrors `orchestra/web/conductor.mjs` line for line. Change both together;
  `test_conductor.py` compares their notes.
- The score lives in `orchestra/web/songs.mjs`, `flow.mjs` and `styles.mjs`; both conductors read them.
  A new `.mjs` module there goes into the copy list in `install.sh`.
- Python is stdlib-only and must run on Python 3.9. The server is `node:http` only.
- Never send code, prompts, paths or project names over the network (`reader.py`, `agents.py --global`).
- Test without spending tokens: `python3 demo.py`, `node orchestra/crowd.mjs`. Do not start agents
  or subagents to produce test traffic.
- Only public domain, traditional or original music. Record where the notes came from in `source`.
