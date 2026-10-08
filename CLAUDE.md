# code-sonata

Claude/Codex oturumlarının adımlarını müziğe çeviren macOS aracı + herkese açık "Agent Orchestra"
sitesi (`orchestra/`). Ayrıntı tek kaynakta: `README.md` (araç) ve `orchestra/README.md` (site).
Skill: `skill/` (kurulu kopya `~/.codex/skills/code-sonata/`, yardımcı `scripts/control.py`).
Test/demo sıfır token: `demo.py` (araç), `orchestra/crowd.mjs` (site). Test için ajan açılmaz.

## Son iş — 2026-10-09: orchestra yerel demo, Codex'e devir
- Kod değişikliği yok; main temiz (son kod commit'i 46809d1).
- `orchestra.dijitalpi.com` DNS'te çözülmüyor (curl exit 6) → site CANLIDA DEĞİL. Repoda deploy
  dosyası (Dockerfile/compose/Traefik) yok; `web/index.html:104` bu adresi katılım komutu olarak gösteriyor.
- Yerel demo çalıştı: `PORT=4480 TRUST_PROXY=1 node orchestra/server.mjs` + `node orchestra/crowd.mjs 20 180`
  → ~20 sn'de 7 makine / 10 dinleyici. Loglar `~/Library/Caches/code-sonata/{orchestra-server,crowd}.log`.
- Açık: canlı yayın (VPS + Traefik + DNS, `TRUST_PROXY=1` şart) · yerel dinleyiciyi siteye bağlama
  `control.py start --global <URL>` denenmedi.
