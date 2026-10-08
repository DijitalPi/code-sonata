# AGENTS.md (Codex devri, 2026-10-09)

Kurallar ve son durum tek kaynakta: **`CLAUDE.md`** (kök) + `README.md` + `orchestra/README.md`.
Önce onları oku; burada tekrar edilmez.

- Site yerel: `PORT=4480 TRUST_PROXY=1 node orchestra/server.mjs` → http://localhost:4480
- Kalabalık demosu (sıfır token): `node orchestra/crowd.mjs <makine> <saniye>`
- Testler: `python3 -m unittest -v`, site ölçümü `orchestra/measure.mjs`.
- `orchestra.dijitalpi.com` henüz yayında değil; deploy manuel ve onaylıdır.
