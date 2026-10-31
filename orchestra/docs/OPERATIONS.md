# Çalıştırma ve yayın

## Yerel başlat

Repo kökünde `PORT=4480 node orchestra/server.mjs`, sonra http://127.0.0.1:4480. Sunucu varsayılan olarak yalnız 127.0.0.1'e bağlanır. Bazı tarayıcılar `localhost`'u engelliyor; o durumda 127.0.0.1 ile aç.

Sayfadaki "Ajanımı bağla" komutu tek dosyalık okuyucuyu (`/reader.py`, repo kökündeki `reader.py`) siteden indirir; repo gerekmez. Okuyucu ses çalmaz, müziği tarayıcı çalar. Geçmiş oturumlar sessiz kalır, yalnız yeni adımlar gider. Ctrl+C kapatır. Yerel müzik için `./install.sh`; `control.py` repoyu kendi gerçek konumundan bulur (`CODE_SONATA_APP` ile değiştirilebilir).

## Test ve ölçüm

- `python3 -m unittest -v`
- `node --test orchestra/test-*.mjs`
- `node orchestra/benchmark.mjs 120 45 120` ya da `500 60 200`: 4494'te ayrı bir test sunucusu açıp kapatır, makineler simülasyon olarak işaretlidir.
- Elle: `PORT=4491 TRUST_PROXY=1 ALLOW_SIMULATION=1 node orchestra/server.mjs`, sonra `node orchestra/crowd.mjs 120 45 http://127.0.0.1:4491 120` ve `node orchestra/measure.mjs`. Kalabalık testini herkese açık bir salonda çalıştırma.

## Ölçülen sınırlar

Hepsi tek bir Mac'te kısa ölçümler. Üretim kapasitesi, uzun süreli kararlılık ya da TLS/vekil maliyeti değil.

- 120 simüle makine + 121 dinleyici, 45 sn: dinleyici başına 2,17 KB/sn, health P95 1 ms, RSS 150,9 MiB, en büyük kare 2036 bayt, en uzun kare arası 253 ms.
- 500 simüle makine + 201 dinleyici, 60 sn: dinleyici başına 2,7 KB/sn, health P95 1,6 ms, RSS 158 MiB, en büyük kare 2699 bayt, kare arası 256 ms.
- Salon akış çalarken: boşta %0,27 işlemci ve 101 MiB; 5 makine + 5 dinleyici %0,62 ve dinleyici başına 845 B/sn; 50 + 50 %1,18 ve 1.758 B/sn.
- Simülasyon olmayan 150 makine + 400 dinleyici, 90 sn (dinleyiciler gecikme, titreme, takılma ve saat kayması taklit eder): sunucu %1,5–4,5 işlemci, 75 MiB. Notalar 0,9 sn önden giderken mobil profilde (90 ms gecikme, 160 ms titreme, 1,2 sn'ye kadar takılma) notaların %1,2'si geç kalıyordu; 1,5 sn önden %0. Dinleyiciler arası fark gecikme ölçümüyle 183 ms'den 60 ms'ye indi.

Sunucu sınırları: toplam 1000 dinleyici, adres başına 32 (IPv6'da /64 bir adres sayılır). Yazma kuyruğu 64 KiB'ı aşan bağlantı kapanır; işletim sisteminin ve vekilin tamponu buna eklendiği için okumayı bırakan dinleyici dakikalar sonra düşer. Makine tavanı 2000, ama yalnız 500'e kadar ölçüldü. SSE için vekilde tamponlama kapalı olmalı.

## Veri ve saklama

- Kod, prompt, dosya yolu ve proje adı ağa gitmez. Adım türü toplamları ve anonim makine kimliği gider.
- Makine koltuğu son sinyalden 30 sn sonra boşalır; boştaki makine 10 sn'de bir sinyal yollar.
- Kişisel eşleştirme ve toplamları en fazla bir saat sunucu belleğinde kalır; yeniden başlatma hepsini siler. Genel SSE akışında sır yok.
- IP yalnız ülkeyi bulmak için kullanılır. Hız sınırı için her açılışta değişen tuzlu bir özet bellekte tutulur. Vekilin erişim kaydı ayrıca ayarlanmalı (aşağıda).
- PNG/WAV/video tarayıcıda üretilir, sunucuya yüklenmez.
- Cihazdaki isteğe bağlı sayaçlar arayüzdeki düğmeyle silinir.
- Ses motoru, ses örnekleri ve yazı tipleri sitenin kendisinden gelir; tarayıcıdan başka siteye istek gitmez.
- Koltuk siparişi `ORDERS_FILE`'da durur: ad, link, blok, tutar, Stripe oturum/ödeme kimliği ve Stripe'tan gelen e-posta. Kart bilgisi sunucuya hiç gelmez. Bekleme sınırı için tuzlu adres özeti yalnız bellekte ve sipariş beklerken tutulur, dosyaya yazılmaz. Bekleyen logo herkese kapalı `SEATS_DIR/pending/`'de durur; reddedilince silinir. Süresi dolan siparişin logosu ödeme süresinin bitiminden itibaren 24 saat, kaydı 4 gün tutulur (Stripe bir olayı 3 gün boyunca yeniden gönderir; geç gelen ödeme kaybolmaz). 24 saatten geç gelen ödemenin logosu kalmamıştır: onaylanamaz, panelden iade edilir.

## Docker

`orchestra/Dockerfile` bağımlılıksız Node çalışma ortamı, root olmayan kullanıcı ve healthcheck içerir. Build sırasında ses örneklerini indirip `sounds.json` sağlama toplamıyla doğrular; build makinesinin GitHub Pages'e erişimi olmalı. Temel imaj `node:25-alpine` digest ile sabitli; başka mimaride ayrıca dene.

```sh
docker build -f orchestra/Dockerfile -t agent-orchestra:local .
docker run --rm -p 127.0.0.1:4480:4480 agent-orchestra:local
```

Koltuk satışıyla: kalıcı bir volume bağla, ayarları dosyadan ver (`-v /srv/orchestra:/data -e SEATS_DIR=/data/seats -e ORDERS_FILE=/data/orders.json --env-file stripe.env`). Klasör `node` kullanıcısına yazılabilir olmalı.

Kapsayıcı içinde `HOST=0.0.0.0`; örnek komut host portunu yalnız loopback'e açar.

## Ters vekil arkasında yayın

`HOST=0.0.0.0` ve `TRUST_PROXY=1`. Sunucu portuna yalnız güvenilir vekil ulaşabilmeli: istemci portu doğrudan görürse sahte X-Forwarded-For ile hız sınırını ve ülkeyi aşar. Vekilde istek gövdesi 2 KiB (koltuk alırken `/api/seats/checkout` 450 KiB, Stripe olayı `/api/stripe` 64 KiB), istek hızı sınırı, SSE tamponlaması kapalı, TLS ve origin doğrulaması olmalı. `PUBLIC_URL=https://alan-adin` OG/Twitter görselini ve canonical adresi mutlak üretir; yerelde boş bırak.

Kesinti: sunucu durunca tarayıcı SSE'yi kendisi yeniden dener, vekilin 502'si sayfayı kalıcı koparmaz (1–30 sn arası artan aralıklarla). Yeniden başlatma eşleştirmeleri siler; kullanıcı yeni komut oluşturur. Eski zamanlı notalar çalınmaz, saat farkı toparlanır. Kesinti sırasında canlı sayılar "—" görünür. Okuyucu olayları en iyi çabayla yollar; kalıcı kuyruk yok, kesintideki adımlar kaybolabilir. Geri dönüş için önceki imaj digest'ini ve ayarları sakla.

## Ayarlar

| Değişken | Ne zaman | Etki |
|---|---|---|
| `TRUST_PROXY=1` | Ters vekil arkasında, şart | Son X-Forwarded-For istemci sayılır. Dockerfile varsayılanı 0: açılmazsa bütün ziyaretçiler tek adres sayılır (32 dinleyici); sunucu günlüğe bir kez uyarı yazar |
| `TRUST_CF=1` | Yalnız alan adı Cloudflare'de proxy'liyse | İstemci `CF-Connecting-IP`'den, ülke `CF-IPCountry`'den okunur. Sunucu portu yalnız Cloudflare IP aralıklarına açık olmalı, yoksa başlık sahte yazılabilir |
| `EVENT_KEYS` | Etkinlik, hackathon | `?event=<anahtar>` ile IP başına sınır 300 (dinleyici, makine, eşleştirme, hız) |
| `METRICS_KEY`, `METRICS_FILE` | Ölçüm istenirse | Günlük toplam sayaç; okuma `Authorization: Bearer`; dosya için kalıcı volume |
| `ALLOW_SIMULATION=1` | ASLA üretimde | Yalnız crowd/benchmark testleri |
| `PUBLIC_URL` | Yayında | Mutlak OG ve canonical adres |
| `HALL=songs` | Gerekirse | Salon akış yerine eski şarkı modunu çalar; varsayılan akış |
| `SEATS_FILE`, `SEATS_DIR` | Koltuk sahipleri | Elle eklenen koltuklar (JSON) ve logo klasörü; dosya bir dakika içinde yeniden okunur |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `ORDERS_FILE` | Koltuk satışı | Üçü, `SEATS_DIR` ve `ADMIN_KEYS` varken "Koltuk al" ödemeye açılır (onaylayacak kimse yoksa satış açılmaz); biri eksikse ya da sipariş dosyası okunamazsa sayfa ödemenin açık olmadığını söyler. Kısıtlı anahtar yeter (aşağıda) |
| `ADMIN_KEYS` | Yönetim paneli | `ad:anahtar,ad2:anahtar2`; ad küçük harf, rakam, tire (≤20), anahtar ≥24 karakter. Yoksa `/yonetim/` 404. Onaylar kimin anahtarıyla yapıldıysa o adla kaydedilir |
| `SLACK_WEBHOOK_URL` | İsteğe bağlı | Ödenen her sipariş için bir Slack mesajı, panele bağlantıyla |

Etkinlik anahtarı olmadan da bir ofis ağı çalışır: makine raporları ayrı sayılır (adres başına 40 rapor/sn, en fazla 20 makine, saatte 40 yeni makine; uykudan 20 dakika içinde dönen makine yeni sayılmaz ve kendi bölümüne döner). Dinleyici ve kişisel eşleştirme adres başına 32. Sayfa, eşleştirme ve sayaç istekleri adres başına 8/sn; kişisel görünümün iki saniyelik sorgusu eşleştirme başına sayılır. `/api/play` yalnız okuyucudan kabul edilir (JSON, tarayıcı başlığı yok): başka bir site ziyaretçilerinin tarayıcısından makine oturtamaz, dinleyici koltuğu tutamaz.

## Koltuk ödemesi (Stripe)

Alıcı yeri seçer, logo ve link verir, Stripe Checkout'ta öder; koltuk elle onaylanınca salonda görünür, reddedilirse ödeme tamamen iade edilir. Defterdeki her değişiklik diske yazıldığında geçerli olur: yazılamazsa geri alınır ve istek 500 döner; Stripe olayı kendisi yeniden gönderir, panel işlemi elle yeniden denenir. Tek istisna açılmış ödeme sayfasının kimliğidir: yazılamazsa sayfa alıcıya yine verilir, kimlik bir sonraki yazımla diske geçer; arada sunucu yeniden başlarsa iptal o yeri bırakmaz, Stripe'ın süre dolumu bırakır.

İade, Stripe'a sorulmadan önce siparişe işaretlenir ve işaret varken sipariş onaylanamaz. İşaret yalnız Stripe ilk denemeyi açıkça reddederse kalkar; yanıt alınamazsa (zaman aşımı, 5xx) ya da kayıt yazılamazsa kalır ve aynı adım (bekleyende Reddet, yayındakinde Kaldır; iade kutusu kilitli işaretli gelir) tekrarlanınca aynı istek anahtarıyla tamamlanır. Belirsiz bir denemeden sonraki ret (429, 401) işareti kaldırmaz: o ret yalnız yeni denemeyi yanıtlar. Stripe bu anahtarı 24 saat tanır; daha geç denemede ödeme zaten iade edilmişse yanıt "zaten iade edildi" olur ve sipariş iade edilmiş sayılır. Bekleyen (pending) iade iade edilmiş sayılır; nadiren sonradan başarısız olursa Stripe bunu hesap sahibine bildirir, panel görmez. Fiyatı sunucu belirler, ödeme sayfası 31 dakika açık kalır (Stripe en az 30 ister), süresi dolan yer boşalır: Stripe'ın süre dolumu olayıyla, olay gelmezse sunucunun kendi taramasıyla tutma süresinden 10 dakika sonra. Alıcı dönüşte sonucu öğrenemezse sipariş adreste kalır; sayfayı yenilemek yeniden sorar.

1. Stripe panelinde kısıtlı anahtar: Checkout Sessions yaz, Charges and Refunds yaz, Payment Intents oku. Başka izin gerekmez.
2. Webhook uç noktası `https://alan-adin/api/stripe`, olaylar `checkout.session.completed` ve `checkout.session.expired`. İmza sırrı `STRIPE_WEBHOOK_SECRET`. Aynı Stripe hesabındaki başka ürünlerin oturumları da gelir; sipariş kimliği (`o-…`) taşımayanlar yok sayılır. Kimliği taşıyan ama defterde olmayan bir ödeme sunucu günlüğüne, `SLACK_WEBHOOK_URL` varsa Slack'e de yazılır.
3. `PUBLIC_URL` dönüş adresini belirler; yayında şart.
4. Stripe sayfası tutarı alıcının para biriminde gösterebilir (Adaptive Pricing); tahsilat ve iade yine USD tutarı üzerinden yapılır.
5. Yerelde test modunda dene: `stripe listen --forward-to localhost:4480/api/stripe --events checkout.session.completed,checkout.session.expired`, imza sırrı `stripe listen --print-secret`. Kart `4242 4242 4242 4242`.

## Yayın kontrol listesi

1. Vekilin erişim kaydı kapalı ya da IP'siz olmalı. Sayfadaki gizlilik metni "IP kaydedilmez" diyor; etkinlik anahtarı da `/api/stream` adresinde gider.
2. `/sounds/` 27 MB. Sıkıştırmayı yalnız statik dosyalarda aç. `/api/stream` (`text/event-stream`) sıkıştırılmaz ve tamponlanmaz.
3. TLS ile HTTP/2 açık olsun. HTTP/1.1'de tarayıcı bir siteye en fazla 6 bağlantı açar, yedinci sekme bekler.
4. Vekil üzerinden bir akışın 3 dakikadan uzun açık kaldığını dene (`curl -N https://…/api/stream`). 60 sn'de kesiliyorsa vekilin okuma zaman aşımını kapat; istek süresini sunucu kendisi sınırlar. Sunucu boştaki bağlantıyı 95 sn tutar, yaygın 90 sn vekil zaman aşımından uzun.
