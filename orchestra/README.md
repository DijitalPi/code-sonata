# Agent Orchestra

Claude/Codex ile çalışma faaliyetlerinin kişisel ve ortak müziğe dönüştüğü yerel deneyim.
**Kendi çalışma sesini keşfet → ortak orkestraya katıl → sana ait bir anı paylaş.**
Her makine salonda bir koltuk; yeni faaliyet geldikçe ışığı parlar. İş kalitesi veya üretkenlik puanı değildir.

- `server.mjs`: şef. Bağımlılık yok (node:http). Oyunculardan adım sayısı alır
  (`POST /api/play`), ortak tempo/şarkı/heyecanı yönetir, notaları sunucu saatiyle
  damgalayıp dinleyicilere SSE ile yayınlar (`GET /api/stream`). Ses sunucudan akmaz;
  her tarayıcı aynı notayı aynı anda kendisi çalar.
- `web/`: konser salonu (yukarıdan amfi yerleşim, 8 bölüm) + tarayıcı sesi (smplr
  `web/vendor/`, FluidR3 örnekleri `web/sounds/`, davullar sentez). Şef `web/conductor.mjs`
  hem sunucuda hem demo konserinde (`web/demo.js`, yalnız tarayıcıda) çalışır.
- Ses örnekleri git'te değil: `node orchestra/fetch-sounds.mjs` (27 MB, `sounds.json` SHA-256).
  CC BY 3.0, sayfada atıf var. Docker build bunu kendisi yapar.
- `crowd.mjs`: sıfır token kalabalık simülatörü, sunucu `ALLOW_SIMULATION=1` ister:
  `node orchestra/crowd.mjs 300 80`.
- Katılım: `python3 agents.py --global <URL>` ya da
  `control.py start --global <URL>`. Gönderilen tek şey: adım sayısı, çalışıyor mu,
  oturum/tür sayıları, anonim makine kimliği ve ship/pass/fail sinyali. Özel bağlantı kurulmuşsa geçici eşleştirme anahtarı da gider. Kod, prompt, proje adı gitmez.

Repertuvar (yalnız telifsiz: bestecisi 70+ yıl önce ölmüş ya da anonim): Bella Ciao, Für Elise,
Greensleeves, Ode to Joy, Pachelbel Kanon, Grieg Dağ Kralının Salonunda, Mozart Eine kleine Nachtmusik.
Her şarkının nota kâğıdı akorları ve ölçüsü (`METERS`, 3'lük/4'lük + giriş) `web/music.mjs`'de; ekleme
sonrası doğrula: ölçüler tam, uzun notalar akorda. Seçim ruh haline göre (`MOODS`): sakin / orta /
coşkulu; şarkı en az 2 dk çalar, sakin anda ya da coşkuya geçerken değişir, son ikisi tekrar etmez.
Test: `PORT=4481 START_SONG=canon MIN_SONG_MS=6000 node orchestra/server.mjs` + `crowd.mjs` + `measure.mjs`.

Boş salon: çalışan ajan yokken ve en az bir dinleyici varken salon piyanisti çalar (yalnız piyano,
sakin, yumuşak). Katılımcı gibi gösterilmez; sayfa açıkça “salon piyanisti” der, son ajanın ne zaman
çaldığını ve günün zirvesini (makine sayısı) yazar. Yeni dinleyici sayaçları bağlandığı an alır.

Yerel: `PORT=4480 node orchestra/server.mjs` → http://localhost:4480 (port listede kayıtlı).
Gizlilik/kötüye kullanım: IP kalıcı saklanmaz (hız sınırı için açılışta değişen tuzlu özet), ülke
çıkarılıp atılır. IP başına 8 istek/sn, en fazla 20 makine, saatte 10 yeni makine; makine başına
saniyede 12 adım (40 patlama), fazlası lige yansımaz. 2 KB gövde, 30 sn sessiz makine koltuğunu bırakır.
Canlıda Traefik arkasında `TRUST_PROXY=1` ŞART (yalnız vekilin eklediği son X-Forwarded-For sayılır;
yoksa sadece soket adresi). Yerel kalabalık testi `TRUST_PROXY=1 ALLOW_SIMULATION=1` ister.
Etkinlik salonu (aynı ağdan çok kişi): `EVENT_KEYS=<16-64 karakter>` + bağlantı `?event=<anahtar>`, IP başına
sınırlar 300'e çıkar. `CF-IPCountry` yalnız `TRUST_CF=1` iken okunur. Günlük sayaçlar: `METRICS_KEY`, `METRICS_FILE`.
Yayın: 4 kare/sn, sayaç ve lig saniyede bir, koltuklar yalnız değişiklik olarak, kare bir kez
serileştirilir (120 makinede dinleyici başına 7,1 -> 2,7 KB/sn).

## Yeni yolculuk ve kullanım

Repo kökünde `PORT=4480 node orchestra/server.mjs`; varsayılan yalnız127.0.0.1. Bu geliştirme oturumunda önceden açık4480 süreci korunup güncel sunucu **http://127.0.0.1:4482** üzerinde bırakıldı (`PORT=4482 node orchestra/server.mjs`). Başka süreci otomatik öldürme.

1. **Dinle/keşfet:** Orkestrayı dinle zengin örnekleri bu siteden yükler (dış istek yok, CSP). Sade tını ek örnek indirmez; yerel örnek gerçek katılımcı sayılmaz. Ses/seviye/hareket kontrolü mevcut.
2. **Katıl:** Bağlantı komutumu oluştur → komutu bu repo Terminal'inde çalıştır → Claude/Codex ile yeni faaliyet. macOS ya da Linux ve Python 3 gerekir (Windows yok). Komutta özel anahtar vardır; paylaşma. `--silent` yerel hoparlörü kapalı tutar.
3. **Kendini bul:** bağlı/ilk faaliyet/kesinti durumları, metinsel koltuk ve SEN vurgusu. Yalnız benim sesim gerçek yeni faaliyetlerden kısa motif çalar.
4. **Anını oluştur:** kişisel gerçek faaliyetten veya son12sn anonim ortak notalardan PNG+WAV. Başlığı/sayı görünürlüğünü seç, önizle, indir. Desteklenen tarayıcıda VP8/Opus WebM; video hatasında PNG/WAV hazır kalır. An bir müzikal yorumdur, canlı soundfont kaydı değildir.
5. **Ayrıl:** Terminal'de Ctrl+C okuyucuyu durdurur. Tarayıcı eşleştirmesini kaldır özel bağı kaldırır; ortak okuyucuyu kapatmaz.

Kişisel anahtar/sayılar en fazla1saat sunucu belleğinde; restart yeni komut gerektirir. Genel SSE anahtar, makine kimliği, kod/prompt/yol taşımaz. Medya sunucuya yüklenmez. Ölçüm isteğe bağlı ve yalnız cihazda; silme UI'da. Bildirimler best-effort, kesintide kayıp olabilir. Crowd POST ve SSE testleri simülasyon olarak etiketli; kişisel an üretemez.

## Doğrulama ve teslim

```sh
python3 -m unittest -v
node --test orchestra/test-api.mjs orchestra/test-moment.mjs orchestra/test-video.mjs
node orchestra/benchmark.mjs 120 45 120
```

2026-10-09:38Python+12Node geçti; Chrome320/390/768/masaüstü, klavye, gerçek okuyucu/PNG/WAV/video, kesinti ve yerel Docker doğrulandı. 500 makine kısa **simülasyon** kapasite ölçümü üretim veya gerçek kullanıcı sayısı değildir. Gerçek20–30dk dinleme, kullanıcı araştırması, fiziksel telefon/Safari, genel TLS/proxy/crawler doğrulaması açık.

- [Ürün briefi](docs/PRODUCT-BRIEF.md), [60 döngü ve kararlar](docs/WORK-LOG.md)
- [Teslim ve kabul matrisi](docs/VALIDATION.md), [Yerel kanıt dosyaları](evidence/README.md)
- [Araştırma/ölçüm](docs/RESEARCH-MEASUREMENT.md), [İşletme/yayın adayı](docs/OPERATIONS.md)
- [Lansman/sosyal metin/demo/buluşma](launch/LAUNCH-PACK.md), [Poster](launch/poster.png)

Dockerfile yerel olarak testli, non-root ve base digest sabit. Genel yayın, ücretli hizmet ve dış hesap paylaşımı yapılmadı; bunlar somut hedef/config/maliyet/sonuç üzerinden ayrı onay gerektirir. Commit/push veya KK çalıştırılmadı.
