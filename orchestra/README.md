# Agent Orchestra

Claude/Codex ile çalışma faaliyetlerinin kişisel ve ortak müziğe dönüştüğü yerel deneyim.
**Kendi çalışma sesini keşfet → ortak orkestraya katıl → sana ait bir anı paylaş.**
Her makine salonda bir koltuk; yeni faaliyet geldikçe ışığı parlar. İş kalitesi veya üretkenlik puanı değildir.

- `server.mjs`: şef. Bağımlılık yok (node:http). Oyunculardan adım sayısı alır
  (`POST /api/play`), ortak tempo/şarkı/heyecanı yönetir, notaları sunucu saatiyle
  damgalayıp dinleyicilere SSE ile yayınlar (`GET /api/stream`). Ses sunucudan akmaz;
  her tarayıcı aynı notayı aynı anda kendisi çalar.
- `web/`: konser salonu (yukarıdan amfi yerleşim, 9 bölüm) + tarayıcı sesi (smplr
  `web/vendor/`, FluidR3 örnekleri `web/sounds/`, davullar sentez, `web/instruments.js`).
  Şef `web/conductor.mjs` hem sunucuda hem demo konserinde (`web/demo.js`, yalnız tarayıcıda)
  çalışır; yerel macOS aracı aynı şefin Python karşılığını (`conductor.py`) çalar.
- Ses örnekleri git'te değil: `node orchestra/fetch-sounds.mjs` (27 MB, `sounds.json` SHA-256).
  CC BY 3.0, sayfada atıf var. Docker build bunu kendisi yapar. Tarayıcı önce yalnız piyanoyu
  indirir; diğer enstrümanlar bölümleri sahneye çıkınca gelir ve yalnız şefin çalabileceği notalar
  çözülür (`NOTE_RANGE`). Ölçüm: eskiden 11 enstrüman açılışta ~1.160 MB çözülmüş ses tutuyordu;
  şimdi açılış ~60 MB, dolu salon ~300 MB. Salon yankısı (`hall()`) sayfada üretilir; `?dry` ile kapanır.
- `crowd.mjs`: sıfır token kalabalık simülatörü, sunucu `ALLOW_SIMULATION=1` ister:
  `node orchestra/crowd.mjs 300 80`.
- Katılım: site tek dosyalık okuyucuyu `/reader.py` olarak verir (repo kökündeki `reader.py`,
  yalnız Python 3); sayfadaki komut onu indirip başlatır. Yerel müzikle birlikte:
  `python3 agents.py --global <URL>` ya da `control.py start --global <URL>`. Gönderilen tek şey: adım sayısı, çalışıyor mu,
  oturum/tür sayıları, anonim makine kimliği ve ship/pass/fail sinyali. Özel bağlantı kurulmuşsa geçici eşleştirme anahtarı da gider. Kod, prompt, proje adı gitmez.

Repertuvar (yalnız telifsiz: bestecisi 70+ yıl önce ölmüş ya da anonim, ya da bu proje için yazılmış):
Bella Ciao, Für Elise, Greensleeves, Ode to Joy, Pachelbel Kanon, Grieg Dağ Kralının Salonunda, Mozart Eine
kleine Nachtmusik, The Entertainer, Rondo alla Turca, Korobeiniki, Shchedryk, Minuet in G, Mozart 40. Senfoni,
Satie Gymnopédie No. 1, Brahms Ninnisi, Chopin Prelude No. 7, Bach Air ve özgün Keşif, Boss, Zafer. Her eserin kaynağı `web/songs.mjs`'de `source` alanında. Stiller (`web/styles.mjs`)
şefte tanımlı; site `klasik` çalar.

**Salon döngü çalar.** 2026-10-21'den beri salon şarkı yerine akış çalar (`web/flow.mjs`, şefte `flow`):
her bölüm dört ölçülük bir katman, sahne sekiz döngü sürer, sonra yeni akor döngüsü, ton ve nakarat gelir.
Koltuklar önce solist sandalyelerine (piyano, akordeon), sonra boş bölümlere verilir; ilk dokuz kişi dokuz
ayrı katman olur. Gerçek (simülasyon olmayan) çalışan makinesi olan bölüm `featured` sayılır ve katmanı her
tempoda çalar; giriş ve molada (`sparse`) yalnız sahnenin izin verdiği katmanlar çalar, dolu salonda da nefes
kalır. Dokuzdan fazla kişide katman paylaşılır. `crowd.mjs` makineleri simülasyon diye işaretler; onların
bölümü `featured` sayılmaz, bu yüzden kalabalık ölçümü gerçek salondan daha az nota görür. Şarkı modu `HALL=songs` ile açılır; şarkılar
aşağıdaki gibi duruyor, yerel araç ikisini de çalar. Tarayıcının davul sentezi akışın vuruşlarını (klap,
rim, tom, tef, shaker) çalar, `NOTE_RANGE` akışın gerçek çıktısından genişletildi, timpani açılışta yüklenir.
Her şarkının notaları, nota kâğıdı akorları, ölçüsü (3'lük/4'lük + giriş) ve cümle başları
`web/songs.mjs`'da; site ve yerel araç bu tek dosyayı okur. Melodi cümle başında el değiştirir. Ekleme
sonrası doğrula: ölçüler tam, uzun notalar akorda, cümleler doğru (`test-moment`, `test_conductor.py`); yeni
notalar örnek aralığını aşarsa `web/instruments.js` `NOTE_RANGE` güncellenir (`test-moment` yakalar).
Şarkı üç turda çalar (`FORMS` in `web/conductor.mjs`): tema, varyasyon (başka enstrüman, bir oktav yukarı,
piyanonun cevabı, tek sayılı cümlelerde akorlara oturan ters çevrilmiş ezgi), nefes (en fazla 8 ölçü
melodisiz eşlik); son ölçü yavaşlar, sonraki şarkının dominant yedilisi köprü kurar. Melodi cümle
içinde güçlenip yumuşar; her eserin kendi temposu `songs.mjs` `tempo` alanında. Seçim ruh haline göre
(`MOODS`: sakin / orta / coşkulu); son çalınan 6 şarkı ruh hali ne olursa olsun bekler, uygun şarkı
kalmazsa komşu ruh haline geçilir, seçenek varsa başka tonda bir şarkı gelir. Site varsayılan `orta`
melodi miktarını çalar; sıra (`ordered`) ve favoriler (`favorites`) yalnız yerel araçta.
Test: `PORT=4481 node orchestra/server.mjs` (akış) ya da `PORT=4481 HALL=songs START_SONG=canon node orchestra/server.mjs`
(şarkı) + `crowd.mjs` + `measure.mjs`.

Boş salon: çalışan ajan yokken ve en az bir dinleyici varken salon piyanisti çalar (yalnız piyano,
sakin, yumuşak; akışta davulsuz döngüler, ajan dönünce sonraki ölçüde davul ve katmanlar geri gelir). Katılımcı gibi gösterilmez; sayfa açıkça “salon piyanisti” der, son ajanın ne zaman
çaldığını ve günün zirvesini (makine sayısı) yazar. Yeni dinleyici sayaçları bağlandığı an alır.

Yerel: `PORT=4480 node orchestra/server.mjs` → http://localhost:4480 (port listede kayıtlı).
Gizlilik/kötüye kullanım: IP kalıcı saklanmaz (hız sınırı için açılışta değişen tuzlu özet), ülke
çıkarılıp atılır. IP başına sayfa/eşleştirme/sayaç için 8 istek/sn; makine raporları ayrı sayılır (IP başına 40 rapor/sn,
her makine saniyede bir rapor atar), en fazla 20 makine, saatte 40 yeni makine; makine başına
saniyede 12 adım (40 patlama), fazlası lige yansımaz. Önce her bölüme bir kişi oturur, sonrakiler
orkestra oranlarına göre dağılır (ülkece birlikte oturmak yalnız denge bozulmuyorsa); 10 kişilik tek
ülkeli buluşma da tam orkestra olur. 2 KB gövde, 30 sn sessiz makine koltuğunu bırakır.
Canlıda Traefik arkasında `TRUST_PROXY=1` ŞART (yalnız vekilin eklediği son X-Forwarded-For sayılır;
yoksa sadece soket adresi). Yerel kalabalık testi `TRUST_PROXY=1 ALLOW_SIMULATION=1` ister.
Etkinlik salonu (aynı ağdan çok kişi): `EVENT_KEYS=<16-64 karakter>` + bağlantı `?event=<anahtar>`, IP başına
sınırlar 300'e çıkar. `CF-IPCountry` yalnız `TRUST_CF=1` iken okunur. Günlük sayaçlar: `METRICS_KEY`, `METRICS_FILE`.
Yayın: 4 kare/sn, sayaçlar saniyede bir; ülkeler, takımlar ve lig yalnız değiştiğinde (yeni dinleyici
hepsini bağlanınca alır). Koltuklar yalnız değişiklik olarak, kare bir kez serileştirilir (120 makinede
dinleyici başına 7,1 -> 2,7 KB/sn). Lig saniyede bir hesaplanır (eskiden her 25 ms'de). Dinleyici yokken
kare hazırlanmaz; makine ve dinleyici yokken şef durur.

## Yeni yolculuk ve kullanım

Repo kökünde `PORT=4480 node orchestra/server.mjs`; sunucu varsayılan olarak yalnız 127.0.0.1'e bağlanır.

1. **Dinle/keşfet:** Orkestrayı dinle zengin örnekleri bu siteden yükler (dış istek yok, CSP). Sade tını ek örnek indirmez; yerel örnek gerçek katılımcı sayılmaz. Ses/seviye/hareket kontrolü mevcut.
2. **Katıl:** Bağlantı komutumu oluştur → komutu herhangi bir Terminal'de çalıştır (okuyucuyu siteden indirir) → Claude/Codex ile yeni faaliyet. macOS ya da Linux ve Python 3 gerekir (Windows yok). Komutta özel anahtar vardır; paylaşma.
3. **Kendini bul:** bağlı/ilk faaliyet/kesinti durumları, metinsel koltuk ve SEN vurgusu. Yalnız benim sesim gerçek yeni faaliyetlerden kısa motif çalar.
4. **Anını oluştur:** kişisel gerçek faaliyetten veya son 12 sn anonim ortak notalardan PNG+WAV. Ses tarayıcıda salonun kendi örnekleri ve yankısıyla üretilir (stereo, 44,1 kHz); dinleyici sade tınıyı seçtiyse ya da örnekler yüklenemezse sade sentez. Başlığı/sayı görünürlüğünü seç, önizle, indir. Desteklenen tarayıcıda VP8/Opus WebM; video hatasında PNG/WAV hazır kalır.
5. **Ayrıl:** Terminal'de Ctrl+C okuyucuyu durdurur. Tarayıcı eşleştirmesini kaldır özel bağı kaldırır; ortak okuyucuyu kapatmaz.

Kişisel anahtar/sayılar en fazla1saat sunucu belleğinde; restart yeni komut gerektirir. Genel SSE anahtar, makine kimliği, kod/prompt/yol taşımaz. Medya sunucuya yüklenmez. Ölçüm isteğe bağlı ve yalnız cihazda; silme UI'da. Bildirimler best-effort, kesintide kayıp olabilir. Crowd POST ve SSE testleri simülasyon olarak etiketli; kişisel an üretemez.

## Test

```sh
python3 -m unittest -v
node --test orchestra/test-api.mjs orchestra/test-moment.mjs orchestra/test-video.mjs orchestra/test-conductor.mjs
node orchestra/benchmark.mjs 120 45 120
```

`benchmark.mjs` kendi test sunucusunu açar ve sonucu `orchestra/evidence/` altına yazar (git dışı). Simülasyon kapasite ölçümüdür, gerçek kullanıcı sayısı değildir.

Kendi sunucunda yayınlamak, Docker, koltuk ödemesi (Stripe), ters vekil ayarları ve ölçülen sınırlar: [docs/OPERATIONS.md](docs/OPERATIONS.md).
