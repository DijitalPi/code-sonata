# Çalıştırma ve yayın

## Yerel başlat

Repo kökünde `PORT=4480 node orchestra/server.mjs`, sonra http://127.0.0.1:4480. Sunucu varsayılan olarak yalnız 127.0.0.1'e bağlanır. Bazı tarayıcılar `localhost`'u engelliyor; o durumda 127.0.0.1 ile aç.

Sayfadaki "Ajanımı bağla" komutu tek dosyalık okuyucuyu (`/reader.py`, repo kökündeki `reader.py`) siteden indirir; repo gerekmez. Okuyucu ses çalmaz, müziği tarayıcı çalar. Geçmiş oturumlar sessiz kalır, yalnız yeni adımlar gider. Okuyucu arka planda çalışır (Terminal kapanınca durmaz; makine başına bir tane, yeni komut eskisinin yerine geçer), `python3 reader.py --stop` kapatır; kaydı, pid ve kilit dosyaları `~/Library/Caches/code-sonata/` (Linux'ta `~/.cache/code-sonata/`). Yerel müzik için `./install.sh`; `control.py` repoyu kendi gerçek konumundan bulur (`CODE_SONATA_APP` ile değiştirilebilir).

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

## Sunucuya kurulum (compose + Caddy)

`orchestra/deploy/` hazır bir kurulumdur: `compose.yaml` sunucuyu ve önündeki Caddy'yi açar. Sunucu portu dışarıya kapalıdır, ona yalnız
Caddy ulaşır. `Caddyfile` sertifikayı Let's Encrypt'ten alır; HSTS, aşağıdaki gövde sınırları, yalnız statik dosyada sıkıştırma,
tamponsuz akış ve HTTP/2-3 sağlar. Erişim kaydı ve ziyaretçi adresli hata kaydı yazmaz. İstek hızını sunucu kendisi sınırlar (Caddy'de
hız sınırı eklentisi yok). `backup.sh` ve `restore.sh` aşağıdaki Yedek bölümünün betikleridir. Gereken: Docker + compose, `python3` (geri yükleme arşivi okur; Ubuntu ve Debian'da hazır gelir), 80 ve 443
(TCP), 443/UDP açık, build sırasında GitHub Pages erişimi.

1. Alan adının A (varsa AAAA) kaydı sunucuya. Cloudflare'de "DNS only" kalsın; proxy açılacaksa Ayarlar'daki `TRUST_CF` satırı.
2. `git clone https://github.com/DijitalPi/code-sonata /srv/code-sonata`, sonra `cd /srv/code-sonata/orchestra/deploy`.
3. `cp .env.example .env`: `DOMAIN`. `cp orchestra.env.example orchestra.env && chmod 600 orchestra.env`: Stripe canlı kısıtlı
   anahtarı, webhook imza sırrı (aşağıda Koltuk ödemesi 1-2), `ADMIN_KEYS` (`openssl rand -hex 16`), isteğe bağlı `SLACK_WEBHOOK_URL`.
4. `install -d -o 1000 -g 1000 /srv/orchestra` (veri klasörü, `node` kullanıcısı yazar).
5. `docker compose up -d --build`. Denetim: `curl https://ALAN/api/health`, `curl -sI https://ALAN/ | grep -i strict-transport`,
   `/api/seats` yanıtında `"checkout":true`; panel `https://ALAN/yonetim/`.
6. Yedek: `rclone config` ile şifreli hedef (`yedek-sifreli`), cron satırı `backup.sh` başında; bir kez elle çalıştır ve geri yüklemeyi dene.
7. Aşağıdaki Yayın kontrol listesi. Canlı ödemeyi bir kez dene: arka sırada 1 koltuk (3 $) al, panelden Reddet; iade Stripe'ta görünsün.

Güncelleme: `docker tag agent-orchestra:local agent-orchestra:onceki && git pull && docker compose up -d --build`. Geri dönüş:
`compose.yaml`'da imajı `agent-orchestra:onceki` yap, `docker compose up -d --no-build`. 80/443'ü başka bir vekil tutuyorsa `caddy`
servisini çıkar, sunucuya `ports: ["127.0.0.1:4480:4480"]` ekle ve o vekile bir sonraki bölümü uygula.

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
| `AUCTION_FILE` | Ön blok açık artırması | Koltuk satışı açıkken bu dosya da verilirse sahnenin önündeki 24×4 blok panelden açık artırmaya çıkarılabilir. Yoksa ya da okunamazsa açık artırma uçları 404, sayfada kutu yok |
| `SLACK_WEBHOOK_URL` | İsteğe bağlı | Ödenen her sipariş için bir Slack mesajı, panele bağlantıyla; açık artırmanın başlangıcı, her yeni en yüksek teklif, bitişi ve tahsilat sorunu |
| `STRIPE_API_BASE` | Yalnız test | Stripe yerine yerel sahte sunucu (testler, tarayıcı denemesi). Yayında boş kalmalı: gizli anahtar bu adrese gider |

Etkinlik anahtarı olmadan da bir ofis ağı çalışır: makine raporları ayrı sayılır (adres başına 40 rapor/sn, en fazla 20 makine, saatte 40 yeni makine; uykudan 20 dakika içinde dönen makine yeni sayılmaz ve kendi bölümüne döner). Dinleyici ve kişisel eşleştirme adres başına 32. Sayfa, eşleştirme ve sayaç istekleri adres başına 8/sn; kişisel görünümün iki saniyelik sorgusu eşleştirme başına sayılır. `/api/play` yalnız okuyucudan kabul edilir (JSON, tarayıcı başlığı yok): başka bir site ziyaretçilerinin tarayıcısından makine oturtamaz, dinleyici koltuğu tutamaz.

## Koltuk ödemesi (Stripe)

Alıcı yeri seçer, logo ve link verir, Stripe Checkout'ta öder; koltuk elle onaylanınca salonda görünür, reddedilirse ödeme tamamen iade edilir. Defterdeki her değişiklik diske yazıldığında geçerli olur: yazılamazsa geri alınır ve istek 500 döner; Stripe olayı kendisi yeniden gönderir, panel işlemi elle yeniden denenir. Tek istisna açılmış ödeme sayfasının kimliğidir: yazılamazsa sayfa alıcıya yine verilir, kimlik bir sonraki yazımla diske geçer; arada sunucu yeniden başlarsa iptal o yeri bırakmaz, Stripe'ın süre dolumu bırakır.

İade, Stripe'a sorulmadan önce siparişe işaretlenir ve işaret varken sipariş onaylanamaz. İşaret yalnız Stripe ilk denemeyi açıkça reddederse kalkar; yanıt alınamazsa (zaman aşımı, 5xx) ya da kayıt yazılamazsa kalır ve aynı adım (bekleyende Reddet, yayındakinde Kaldır; iade kutusu kilitli işaretli gelir) tekrarlanınca aynı istek anahtarıyla tamamlanır. Belirsiz bir denemeden sonraki ret (429, 401) işareti kaldırmaz: o ret yalnız yeni denemeyi yanıtlar. Stripe bu anahtarı 24 saat tanır; daha geç denemede ödeme zaten iade edilmişse yanıt "zaten iade edildi" olur ve sipariş iade edilmiş sayılır. Bekleyen (pending) iade iade edilmiş sayılır; nadiren sonradan başarısız olursa Stripe bunu hesap sahibine bildirir, panel görmez. Fiyatı sunucu belirler, ödeme sayfası 31 dakika açık kalır (Stripe en az 30 ister), süresi dolan yer boşalır: Stripe'ın süre dolumu olayıyla, olay gelmezse sunucunun kendi taramasıyla tutma süresinden 10 dakika sonra. Alıcı dönüşte sonucu öğrenemezse sipariş adreste kalır; sayfayı yenilemek yeniden sorar.

1. Stripe panelinde kısıtlı anahtar: Checkout Sessions yaz, Charges and Refunds yaz, Payment Intents oku (açık artırma varsa Payment Intents yaz: bloke kaldırma ve tahsilat). Başka izin gerekmez.
2. Webhook uç noktası `https://alan-adin/api/stripe`, olaylar `checkout.session.completed` ve `checkout.session.expired`. İmza sırrı `STRIPE_WEBHOOK_SECRET`. Aynı Stripe hesabındaki başka ürünlerin oturumları da gelir; sipariş kimliği (`o-…`) taşımayanlar yok sayılır. Kimliği taşıyan ama defterde olmayan bir ödeme sunucu günlüğüne, `SLACK_WEBHOOK_URL` varsa Slack'e de yazılır.
3. `PUBLIC_URL` dönüş adresini belirler; yayında şart.
4. Stripe sayfası tutarı alıcının para biriminde gösterebilir (Adaptive Pricing); tahsilat ve iade yine USD tutarı üzerinden yapılır.
5. Yerelde test modunda dene: `stripe listen --forward-to localhost:4480/api/stripe --events checkout.session.completed,checkout.session.expired`, imza sırrı `stripe listen --print-secret`. Kart `4242 4242 4242 4242`.

## Ön blok açık artırması

Sahnenin önündeki 24×4 = 96 koltuk tek tek satılmaz; panelin "Açık artırma" sekmesinden başlatılır. Başlangıç 2.400 $, en az +100 $, 5 gün; son 10 dakikada öne geçen teklif bitişi 10 dakika uzatır, toplam en çok 6 gün (Stripe kart blokesi 7 gün). Başladığı andan blok normal satışta dolu sayılır; blokta tutulan, ödenmiş ya da yayındaki koltuk varsa başlamaz.

- Her teklif bir Stripe sayfasıdır ve kartta bloke edilir (manual capture), çekilmez. Teklif, sunucu Stripe'tan blokeyi okuyunca geçerli olur; tutar tutmuyorsa, süre bitmişse ya da arada fiyat yükselmişse bloke hemen kaldırılır. Geçilen teklifin blokesi de hemen kaldırılır; kaldırma düşerse dakikalık taramada aynı istek anahtarıyla yeniden denenir.
- Bitişte en yüksek teklif tahsil edilir. Durumlar: `open` sürüyor, `capturing` tahsil ediliyor (yanıt alınamadıysa tarama ve paneldeki "Tahsilatı yeniden dene" aynı anahtarla tamamlar, iki kez çekmez), `won` kazanıldı, `unsold` teklifsiz bitti, `failed` Stripe blokenin artık olmadığını gösterdi (süresi doldu ya da iptal edildi; panel yeniden başlatmaya ya da "Satışa aç" ile bloğu normal satışa döndürmeye izin verir). Başka her hata (ağ, 5xx, 401/403, 429) önceki bir denemenin parayı çekmiş olabileceğini gizleyebilir: açık artırma `capturing` kalır, sunucu blokeyi Stripe'tan okuyarak sonuçlandırır.
- Kazanan dönüş adresindeki teklif kimliğiyle logo, ad ve link gönderir; sipariş "Onay bekleyenler"e düşer, onay, ret ve iade normal sipariş gibi. Her açık artırmanın tek siparişi vardır (kimliği açık artırmanınkinden türer): yeniden gönderim ya da ikinci sekme aynı siparişi günceller, onaya kadar logo değiştirilebilir. Sipariş iade edilir ya da kaldırılırsa açık artırma yeniden başlatılabilir; yenisi öncekinin hâlâ açık ödeme sayfalarını, bırakılamamış blokelerini ve süresi dolmuş sayfalarını (Stripe bir olayı 3 gün yeniden gönderdiği için 4 gün) izlemeye devam eder; panelin tablosunda "önceki açık artırma" diye görünürler. Logo önce yanına yazılır, sipariş kaydedilince yerine geçer; yazılamayan logo gelmiş sayılmaz.
- `AUCTION_FILE`'da teklif tutarı, saati, Stripe kimlikleri ve Stripe'tan gelen e-posta durur; adres özeti dosyaya yazılmaz. Kazanmayanların e-postaları bitişten 30 gün sonra silinir; kazananınki kalır (siparişte de durur). Sayfa yalnız tutar ve saat görür.
- Yerelde denemek için `AUCTION_FILE` ver, panelden başlat; bitişi denemek için dosyada `endsAt`'i geçmişe çekip sunucuyu yeniden başlat, ilk tarama bitirir.

## Kupon (bedava koltuk)

Bir kupon kodu bir koltuğu bedava yapar: tek koltuk seçilirse ödeme yoktur ve Stripe'a gidilmez; daha büyük blokta bloğun sırasındaki bir koltuğun bedeli düşer, kalanı Stripe'ta ödenir (ürün adı "… (1 free)"). Stripe ayarı ve kısıtlı anahtarın izinleri değişmez. Açık artırma bloğunda kupon geçmez.

- Kodlar panelin "Kuponlar" sekmesinden açılır: kod (3-24 harf, rakam, tire; büyük harfe çevrilir), sıra (ön, orta, arka ya da her sıra), kullanım sınırı (1-1000) ve süre (1-90 gün). "Durdur" kodu o an kapatır; kod silinmez, aynı kod yeniden açılamaz.
- Kullanılan, kodu taşıyan tutulan, onay bekleyen, sorunlu ve yayındaki siparişlerin sayısıdır: süresi dolan, reddedilen ya da kaldırılan sipariş hakkını kendiliğinden geri verir. Son hakka aynı anda gelen iki alıcıdan biri alır.
- Bedava sipariş doğrudan "Onay bekleyenler"e düşer ("Kupon: KOD · bedava"); reddetmek ve kaldırmak iade aramaz. Alıcı sayfada "Koltuğun ayrıldı; onay bekliyor" ya da "Koltuğun onaylanmadı" okur. `SLACK_WEBHOOK_URL` varsa "Kuponla bedava koltuk: …" mesajı gider; indirimli ödemenin mesajında "kupon KOD" yazar.
- Kodlar `ORDERS_FILE`'da (`coupons`) siparişlerle birlikte durur; kuponlu siparişte `coupon` ve `discount` (sent). Adres başına günde bir kupon ve saatte en çok 10 yanlış kod denemesi; ikisi de yalnız bellekte tutulur, sunucu yeniden başlayınca sıfırlanır.

## Yedek

Koltuk satışı açıkken kimin ne ödediğinin tek kaydı volume'dadır; makine ya da volume giderse kayıtlar Stripe panelinden elle çıkarılır.
Günde bir kez, makine dışına yedek al.

- Ne: `ORDERS_FILE` (siparişler, olaylar, kupon kodları), `AUCTION_FILE`, `SEATS_DIR` (logolar; `pending/` onay bekleyenler), varsa
  `SEATS_FILE` ve `METRICS_FILE`.
- Sıra: önce JSON dosyaları, sonra `SEATS_DIR`. Defter `.tmp`'ye yazılıp yeniden adlandırılır, kopya her an tutarlıdır; logo siparişten
  önce yazıldığı için bu sırayla yedekteki her siparişin logosu da yedektedir (arada reddedilenin logosu eksik olabilir, zararsız).
- Nereye: kendi kontrolündeki başka bir makineye ya da şifreli bir hedefe (ör. `rclone crypt`). Yedekte ad, link ve Stripe'tan gelen
  e-posta var; gizlilik metni "sunucuda tutulur, paylaşılmaz" diyor.
- Saklama: 30 gün; daha eskisini sil.

Betik `orchestra/deploy/backup.sh` (bu sırayla kopyalar, her şeyi yalnız sahibinin okuyacağı izinle yazar, hata olursa yarım arşiv ya da
kopya bırakmaz, `rclone` ile makine dışına gönderir, 30 günden eskiyi siler): cron `15 4 * * * root /srv/code-sonata/orchestra/deploy/backup.sh`. `DATA`, `BACKUPS`, `REMOTE`, `KEEP_DAYS` ile ayarlanır.

Geri yükleme: `docker compose stop orchestra && ./restore.sh /var/backups/orchestra/GÜN.tgz && docker compose start orchestra`.
Betik önce arşivi denetler (tek klasör, defterler bütün JSON); bozuksa hiçbir şeyi değiştirmeden durur. Değiştirdiği dosyaları silmez,
`/srv/orchestra.before-<zaman>`'a taşır, yarıda kalırsa geri koyar, sahibini `node` yapar. Sunucu açılışta her siparişi ve teklifi yeniden
denetler: kayıtta `not read` görürsen ödeme kapalı kalmıştır, `.before-` klasöründen geri dön. Panelde Genel bakış sayıları ve
onay bekleyenler yedekle aynı olmalı. Yedek alındıktan sonra ödenmiş siparişler Stripe
panelinde (Payments) görünür, panelde yoktur: o sürede ödeme geldiyse alıcıyla iletişime geç ya da iade et. Geri yüklemeyi yayından
önce bir kez dene.

## Yayın kontrol listesi

`orchestra/deploy/` ile 1, 2, 3 ve 5 hazır gelir; 4 ve 6'yı yine dene.

1. Vekilin erişim kaydı kapalı ya da IP'siz olmalı. Sayfadaki gizlilik metni "IP kaydedilmez" diyor; etkinlik anahtarı da `/api/stream` adresinde gider.
2. `/sounds/` 27 MB. Sıkıştırmayı yalnız statik dosyalarda aç. `/api/stream` (`text/event-stream`) sıkıştırılmaz ve tamponlanmaz.
3. TLS ile HTTP/2 açık olsun. HTTP/1.1'de tarayıcı bir siteye en fazla 6 bağlantı açar, yedinci sekme bekler.
4. Vekil üzerinden bir akışın 3 dakikadan uzun açık kaldığını dene (`curl -N https://…/api/stream`). 60 sn'de kesiliyorsa vekilin okuma zaman aşımını kapat; istek süresini sunucu kendisi sınırlar. Sunucu boştaki bağlantıyı 95 sn tutar, yaygın 90 sn vekil zaman aşımından uzun.
5. HSTS vekilde açık olsun (`Strict-Transport-Security: max-age=31536000`); sunucu kendisi göndermez, TLS vekilde biter.
6. Koltuk satışı açıksa yedek (yukarıda) kurulu ve geri yükleme bir kez denenmiş olsun.
