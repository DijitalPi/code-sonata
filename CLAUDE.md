# code-sonata

Claude/Codex oturumlarının adımlarını müziğe çeviren macOS aracı + herkese açık "Agent Orchestra"
sitesi (`orchestra/`). Ayrıntı tek kaynakta: `README.md` (araç) ve `orchestra/README.md` (site).
Skill: `skill/` (kurulu kopya `~/.codex/skills/code-sonata/`, yardımcı `scripts/control.py`).
Test/demo sıfır token: `demo.py` (araç), `orchestra/crowd.mjs` (site). Test için ajan açılmaz.

## Son iş — 2026-10-11: yayın hazırlığı turu (DURAKLATILDI, disk doldu)

- `5526279` (main): /gg tam döngü 72-76. Brief `orchestra/docs/PRODUCT-BRIEF.md` "Yayın hazırlığı briefi", kayıt WORK-LOG 72-76. Devam: `/gg devam` (77 demo konseri, 78 paylaşım görseli, 79 metinler + CC BY atfı, 80 doğrulama + Docker build + Codex denetim notu).
- Yeni ortam değişkenleri: `EVENT_KEYS` (etkinlik salonu, IP başına sınır 300), `TRUST_CF=1` (yalnız Cloudflare arkasında), `ALLOW_SIMULATION=1` (yalnız test/crowd), `METRICS_KEY` + `METRICS_FILE` (çerezsiz günlük sayaç).
- Zengin ses kendi sitemizden: `web/vendor/smplr-1.1.0.mjs` + `node orchestra/fetch-sounds.mjs` (27 MB, `sounds.json` sağlama toplamı, git dışı). Yerelde zengin ses için önce bu betik.
- 🔴 Ses örnekleri CC BY 3.0: sayfada atıf ZORUNLU (79'da eklenecek). Okuyucu Linux'ta da çalışıyor (MSI'da denendi), sayfa hâlâ "yalnız macOS" diyor.
- Tuzak: crowd.mjs/benchmark artık `ALLOW_SIMULATION=1` ister; üretimde simüle makine 403.

## Son iş — 2026-10-10: Agent Orchestra /gg tam teslimi, Claude incelemesi, tasarım

- Kod `02cad6e`, belgeler/kanıtlar `bc24dcc` (main). Codex 60 döngü yaptı; Claude inceledi ve iki ek döngü ekledi (61-62). Kayıt: `orchestra/docs/WORK-LOG.md`, kabul: `VALIDATION.md`.
- Düzeltildi: eşleştirme anahtarı dolunca/kaldırılınca/sunucu yeniden başlayınca makine ortak orkestradan düşüyordu (403 + okuyucu anahtarı bırakmıyordu). Şimdi sunucu `pair:"expired"|"used"` döner, okuyucu anonim devam eder. IP başına 5 açık eşleştirme.
- Tasarım (Selim: "berbat", sonra "daha tarzını yap" → /gg tam, döngü 64-71, `1247eeb`): gece konser salonu + basılı program. Solda numaralı program sütunu (`web/views.js`), sağda kenara kadar salon; altında **canlı nota şeridi** (`#score`, gerçek SSE notaları); maskotlar yerine seyirci koltukları; spot ışığı `body.is-playing/.is-climax`. Fontlar `web/fonts/` (Fraunces + Instrument Sans, OFL). Brief: `orchestra/docs/PRODUCT-BRIEF.md` sonu.
- Hâlâ canlı DEĞİL (DNS yok). `orchestra/Dockerfile` var ama yayın ayrı onay. Yerel: `PORT=4482 node orchestra/server.mjs`.
- Açık: gerçek dinleme + 5 kişilik deneme + telefon/Safari yapılmadı · `?simulation=1` herkese "Test salonu" yazdırabiliyor · paylaşım görseli 0 olan türe nota çiziyor · 4480'de eski sunucu tüm ağa açık.
- Tuzak: kişisel eşleştirme (`/api/pair|me|unpair`) yalnız tarayıcı görünümüdür; ortak katılımı asla 403 ile kesme.

## Son iş — 2026-10-09: orchestra yerel demo, Codex'e devir

- 2026-10-09: Selim ile yeni ürün vizyonu ve geliştirme siparişi `ORCHESTRA-HANDOFF.md` dosyasına aktarıldı. Ana deneyim: kendi çalışma sesini keşfet → ortak orkestraya katıl → kişisel anı paylaş. 60 ana + gerektiğinde 20 ek döngü; ilk 10'da durulmayacak. Bu kayıt yeni özelliklerin uygulandığı anlamına gelmez. Repo artık `/Users/selimcitil/Desktop/C Projelerim/code-sonata` yolunda.
- Kod değişikliği yok; main temiz (son kod commit'i 46809d1).
- `orchestra.dijitalpi.com` DNS'te çözülmüyor (curl exit 6) → site CANLIDA DEĞİL. Repoda deploy
  dosyası (Dockerfile/compose/Traefik) yok; `web/index.html:104` bu adresi katılım komutu olarak gösteriyor.
- Yerel demo çalıştı: `PORT=4480 TRUST_PROXY=1 node orchestra/server.mjs` + `node orchestra/crowd.mjs 20 180`
  → ~20 sn'de 7 makine / 10 dinleyici. Loglar `~/Library/Caches/code-sonata/{orchestra-server,crowd}.log`.
- Açık: canlı yayın (VPS + Traefik + DNS, `TRUST_PROXY=1` şart) · yerel dinleyiciyi siteye bağlama
  `control.py start --global <URL>` denenmedi.
