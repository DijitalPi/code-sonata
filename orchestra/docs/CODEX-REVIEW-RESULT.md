# Bağımsız Codex denetimi

Tarih: 2026-10-11. İncelenen HEAD: `2140accfd7c49ad1d4c6081eaff87e5d88e7ae33`. Şef karşılaştırma tabanı: `00af6b1`.

**Sonuç:** Altı kanıtlanmış kusur bulundu: dört orta (P2), iki düşük (P3). Yayın hazırlığını kusursuz veya uçtan uca doğrulanmış kabul etmiyorum. Sunucu portu sandbox tarafından engellendi; gerçek HTTP, tarayıcı ve yayın ortamı kabulü verilmedi.

Başlangıç Git çalışma ağacı temizdi. Claude'un raporu, WORK-LOG, VALIDATION ve önceki evidence kayıtları kanıt olarak kullanılmadı. Proje kuralları ve CODEX-REVIEW.md kapsamı okundu; OPERATIONS yalnız beklenen yapılandırmayı anlamak için kullanıldı. Uygulama, test veya yapılandırma dosyası değiştirilmedi; commit/push yapılmadı. Bu denetimin tek kalıcı repo çıktısı bu dosyadır.

## Yöntem ve ortam sınırları

- Python 3 testleri `PYTHONDONTWRITEBYTECODE=1 python3 -B -m unittest -v` ile çalıştırıldı: **40/40 geçti**.
- `node orchestra/fetch-sounds.mjs --check`: **all present and verified**. İndirme gerekmemiştir.
- İstenen dört dosyalı Node komutu çalıştırıldı. `test-api.mjs` sunucu başlatamadığı için çıkış kodu 1 verdi; diğer **14 test geçti**. API dosyasındaki 11 test senaryosu yürütülemedi ve geçti sayılmadı.
- Ardından portsuz testler ayrı çalıştırıldı: `node --test orchestra/test-moment.mjs orchestra/test-video.mjs orchestra/test-conductor.mjs` → **14/14 geçti**. Node: `v25.9.0`.
- `PORT=4482 node orchestra/server.mjs` → **`listen EPERM: operation not permitted 127.0.0.1:4482`**. Rastgele port (`PORT=0`) da aynı nedenle engellendi. Mevcut başka sunucuya bağlanılmadı veya süreç öldürülmedi.
- Bellek içi ek deneylerde kaynaklar dosyaya yazılmadan `node --experimental-vm-modules --input-type=module` ile çalıştırıldı. Sunucunun gerçek istek işleyicisi kullanıldı; yalnız HTTP dinleme/istek/yanıt nesneleri, saat ve zamanlayıcılar taklit edildi. Sayaç diski deneyinde dosya sistemi bellekte taklit edildi. Arayüz deneyinde gerçek app/experience/demo modülleri çalıştı; DOM, EventSource, fetch, Web Audio ve zamanlayıcılar taklit edildi. Bunlar **gerçek ağ veya tarayıcı testinin yerine geçmez**.
- Kod grafiği araması güncel imzaları bulmadı; `admit` snippet'i yanlış satırlara karşılık geldi. `index_repository(persistence=false)` çağrısı onay politikası nedeniyle engellendi. Bu nedenle güncel kaynaklar doğrudan okundu; grafik çıktısı kod kanıtı sayılmadı.
- npm paketini bellekte indirip yerel vendor ile karşılaştırma denemesi DNS çözümleme hatasıyla sonuçlandı: `URLError: [Errno 8] nodename nor servname provided, or not known`. Upstream eşitliği doğrulanmadı.

## Kanıtlanmış kusurlar — önem sırasıyla

### 1. P2 — Demo notaları gerçek ortak an etiketiyle üretilebiliyor

**Konum:** `orchestra/web/experience.js:27`, `:29`, `:201`, `:207`; `orchestra/web/app.js:644`, `:663`.

**Somut tetikleyici:** Demo konserini aç, en az bir nota karesi al, canlı salona dön. Son demo karesinden 12,1 saniye sonra, gerçek salondan hiç nota almadan “Salonun son 12 saniyesi” kaynağıyla an oluştur.

**Neden:** `receiveFrame` demo notalarını ortak `recent` dizisine ekliyor; notaların demo kimliği tutulmuyor. Notanın ileriye planlanan zamanı nedeniyle, son kareden 12 saniye sonra bile kayıt penceresinde kalabiliyor. Buna karşılık `simulationUntil` kare alındıktan tam 12 saniye sonra bitiyor. `resetHall`/`leaveDemo`, experience içindeki nota geçmişini temizlemiyor. Sonuçta eski demo notaları bulunuyor fakat `simulated` artık false oluyor. Geçişten hemen sonra oluşturulan ortak anlarda da demo ve canlı notalar aynı havuzda karışabiliyor.

**Kullanıcı etkisi:** Simüle edilmiş faaliyet, görselde ve görünür bilgi metninde “anonim ortak an” diye sunuluyor; DEMO uyarısı kayboluyor. Gerçek deneyimden paylaşım üretme ve demo/gerçek ayrımı kabul koşulu bozuluyor. Sunucunun gerçek ligine veri yazıldığını saptamadım; kusur tarayıcıdaki paylaşım geçmişinde.

**Doğrulama:** **Çalıştırıldı, bellek içi arayüz düzeneği.** Gerçek demo/app/experience modülleriyle üretildi. Çıktı: `Görünür bilgi: “Title”, anonim ortak an, DijitalPi imzası...`. Ayrıca yalnız `receiveFrame({t, demo:true, notes:[[t+900,69,58,.5,0]]})` verilip saat `t+12100` yapıldığında gerçek an oluşturma işleyicisi aynı sonucu verdi. Gerçek tarayıcıda çalıştırılmadı.

### 2. P2 — Geçersiz ve büyük POST gövdeleri istek hız sınırına hiç girmiyor

**Konum:** `orchestra/server.mjs:395`, `:425`, `:428`, `:448`, `:451`, `:478`, `:480`.

**Somut tetikleyici:** Aynı IP'den `/api/play`, `/api/metric` veya özel eşleştirme uçlarına bozuk JSON ya da 2048 bayttan büyük gövde gönder. Gövde ayrıştırma `limited` çağrısından önce yanıt verip çıkıyor.

**Kullanıcı etkisi:** Belgelenen IP başına istek sınırı, bu trafik için uygulanmıyor. Saldırgan sınırı tüketmeden gövde okuma, dönüştürme ve hata yanıtı işini tekrarlatabiliyor. Tamamlanmamış gövdeler de limit kontrolüne ulaşmadan bağlantı/işleyici tutuyor. Bunun üretimde hizmet kesintisine yol açacağı **ölçülmedi**; kanıtlanan kusur hız sınırlamasının bu istekleri kapsamaması.

**Doğrulama:** **Çalıştırıldı, gerçek sunucu işleyicisi + taklit HTTP nesneleri.** Aynı IP'den 100 bozuk JSON isteği → 100 adet 400; ardından 10 geçerli metric isteği → `[204,204,204,204,204,204,204,204,429,429]`. Limit dolduktan sonra 100 büyük gövde → 100 adet 413, 429 yok. Kod okuması aynı sıralamayı diğer belirtilen uçlarda doğruladı. Gerçek soket, yavaş gövde ve DoS yük testi yapılmadı. `requestTimeout`/`headersTimeout` 10 saniye olarak ayarlı; bunlar istek hız sınırı değildir.

### 3. P2 — Demo konserinde özel sorgular sunucuya devam ediyor

**Konum:** `orchestra/web/experience.js:145`, `:148`, `:162`; `orchestra/web/app.js:648`, `:651`; `orchestra/web/index.html:158`.

**Somut tetikleyici:** Önce bağlantı komutu oluşturup özel eşleştirme token'ı edin; ardından demo konserini aç. İki saniyelik `poll` döngüsü demo durumunu kontrol etmiyor.

**Kullanıcı etkisi:** SSE kapanmasına rağmen `/api/me` sorguları demo boyunca devam ediyor. Demo, tek seferlik demo sayacı dışında sunucuya istek göndermeme koşulunu karşılamıyor; sunucu yükü sürüyor. Bu durum demo motorunun kendi kodunda ağ çağrısı arayan mevcut testi geçebiliyor çünkü istek başka modülde. İlk kez gelen ve eşleştirmesi olmayan kullanıcı için bu sorgu oluşmuyor.

**Doğrulama:** **Çalıştırıldı, gerçek arayüz modülleri + ağ taklitleri.** Pair işleyicisi, demo açma işleyicisi, demo zamanlayıcıları ve polling çalıştırıldı. İlk SSE kapalıydı; tek `demo` beacon'ı oluştu; buna rağmen demo sırasında yakalanan istek listesinde `/api/me` vardı. Gerçek sunucu yükü ölçülmedi.

### 4. P2 — Sayaç dosyası yazımı başarısız olunca yeniden deneme kayboluyor

**Konum:** `orchestra/server.mjs:368`, `:370`, `:371`, `:376`.

**Somut tetikleyici:** Kaydedilmemiş sayaç varken `writeFileSync` veya `renameSync` geçici hata versin; örneğin disk dolsun veya volume yazılamasın. Sorun düzelsin fakat yeni metric/makine olayı gelmesin.

**Neden:** `usageDirty=false` yazma başarıyla tamamlanmadan önce atanıyor. Catch bu durumu geri almıyor. Sonraki periyodik kayıt ve SIGTERM/SIGINT kaydı `!usageDirty` nedeniyle dosyayı yazmayı denemiyor.

**Kullanıcı etkisi:** Son kayıttan sonraki günlük toplamlar diske aktarılmadan kalır ve restartta kaybolur. Yeni olay gelirse tekrar kirli işaretlenir ve eski bellek toplamları da kaydedilebilir; yeni olay yoksa hata düzelmiş olsa bile kurtarma yoktur.

**Doğrulama:** **Çalıştırıldı, gerçek saveUsage/zamanlayıcı kodu + bellek içi dosya sistemi.** İki listen olayı sonrası ilk yazmaya EACCES enjekte edildi. Hata kaldırılıp kayıt zamanlayıcısı yeniden çağrıldığında yazma çağrısı sayısı `1 → 1` kaldı. Yeni visit olayı sonrasında kayıt yeniden yapıldı. Gerçek disk arızası veya OS sinyali gönderilmedi.

### 5. P3 — Küçük, geçerli UTF-8 gövde parça sınırına göre 413 olabiliyor

**Konum:** `orchestra/server.mjs:396`, `:397`.

**Somut tetikleyici:** `JSON.stringify({name:'visit', extra:'😀'.repeat(240)})` gövdesi çok baytlı karakterlerin ortasında bölünen Buffer parçalarıyla gelsin. Gövde gerçekte 987 bayttır.

**Neden:** Her Buffer ayrı ayrı `raw += chunk` ile UTF-8'e dönüştürülüyor. Bölünmüş karakterler replacement karakterlerine dönüşüp byteLength'i şişiriyor; gerçek baytlar sayılmıyor ve kesintisiz UTF-8 çözümlemesi yapılmıyor.

**Kullanıcı etkisi:** Aynı geçerli JSON ağın parçalama biçimine göre kabul veya ret alabiliyor. Mevcut okuyucu payload'u ve metric adları ASCII olduğu için ana kullanım yolunda ortaya çıktığı gösterilmedi; genel küçük JSON gövde sözleşmesinde düşük önem taşıyan kusur.

**Doğrulama:** **Çalıştırıldı.** Gerçek `readJson` ve `json` kaynakları değiştirilmeden bellek içinde yürütüldü. Tek Buffer ile durum 200; bayt bayt Buffer ile 413. Aynı sorun gerçek sunucu işleyicisi düzeneğinde de görüldü. Gerçek TCP parçalama deneyi yapılmadı.

### 6. P3 — Gizlilik metni IP özetinin günlük ölçüm tekilleştirmesini açıklamıyor

**Konum:** `orchestra/web/index.html:153`, `:155`; `orchestra/server.mjs:354`, `:359`, `:364`, `:365`, `:482`.

**Somut tetikleyici:** Ziyaret/dinleme ölçüm olayı gönder. Sunucu aynı tuzlu IP özetini `seenToday` içinde olay türü başına Set'lerde gün değişene veya süreç kapanana kadar tutup `unique` sayısını hesaplıyor.

**Kullanıcı etkisi:** “IP adresin yalnız ülkeyi bulmak ve kötüye kullanımı sınırlamak için” ifadesi teknik olarak eksik: IP'den türetilen özet ölçümlerin tekilleştirilmesi için de kullanılıyor. “Yalnız günlük toplam sayılar” cümlesi ölçümün bellekteki günlük tekilleştirme durumunu belirtmiyor. **Ham IP'nin metric dosyasına yazılması veya metric yanıtına sızması bulunmadı**; bulgu metnin eksikliği, kimlik sızıntısı iddiası değildir.

**Doğrulama:** **Kod okuması ve bellek içi sunucu deneyi.** Aynı IP'den iki listen olayı toplamı iki, unique'i bir yaptı; kaydedilen/yanıtlanan JSON yalnız toplamları içerdi. Hukuki uygunluk değerlendirilmedi.

## İncelendi, kusur yok — yalnız belirtilen kapsamda

| Alan | Bağımsız kanıt ve kapsam |
|---|---|
| Etkinlik anahtarı ve global tavanlar | Gerçek handler düzeneğinde doğru key ile aynı IP'den 300 eşleştirme ve 300 makine kabul edildi, sonraki istek reddedildi. Çok IP ile 2000 makine tavanı korundu; 5000 pair kapasitesinde 503 ve 1000 SSE dinleyicisinden sonra 429 görüldü. Bunlar kaynak/işleyici sınırlarıdır, kapasite veya egress ölçümü değildir. |
| Anahtar sızmasının yetki kapsamı | Kodda etkinlik key'i yalnız IP başına limitleri yükseltiyor; 2000/1000/5000 global tavanlarını veya makine başına STEP_RATE/STEP_BURST'ü kaldırmıyor. `/api/metrics` okuma sırrı ve özel pair token'ı ayrı. Geçerli etkinlik key'i bilmek tek başına bu sırları okumayı sağlamıyor. |
| Sayaç yanıtı ve normal kalıcı veri biçimi | Gerçek handler/disk taklitleriyle metric yanıtı ve kayıt JSON'u yalnız `{days:{...:{count,unique}}}` içerdi; test IP'si, pair token'ı ve makine kimliği bunlara eklenmedi. Hatalı/eksik Authorization 404 döndü. |
| `sameSecret` | Eşit uzunlukta Buffer'lar `timingSafeEqual` ile karşılaştırılıyor. Farklı uzunluklar erken dönüyor; fonksiyon her uzunluk için sabit süreli değildir. Bu incelemede bundan anahtar içeriği çıkaran bir kusur kanıtlanmadı; istatistiksel zamanlama ölçümü yapılmadı. |
| Başarılı metrics yazımının atomik görünürlüğü | Kod, aynı dizindeki `.tmp` dosyasını yazıp `renameSync` ile değiştiriyor; başarılı yol yerinde JSON dosyasını kısmen güncellemiyor. Kalıcılık/fsync veya güç kesintisi garantisi ölçülmedi. Hata sonrası yeniden deneme ayrı kusur 4'tür. |
| SIGTERM/SIGINT işleyicisinin diğer kapanışlarla çakışması | Güncel server kaynaklarında başka sinyal/kapanış işleyicisi bulunmadı. Yeni handler kayıt ardından exit yapıyor; mevcut başka handler'ı bozan kanıt yok. Gerçek OS sinyali ve container kapanışı test edilmedi. |
| Şef taşımasının eşdeğerliği | `git diff 00af6b1` okundu. Eski conductor kaynağı ve yeni createConductor, yedi şarkıda toplam **84.000 adet 25 ms sanal tick** boyunca aynı girişlerle karşılaştırıldı: dönüşler, bütün conductor durum alanları ve üretilen notalar eşitti. 11.370 tick doruk, 11.200 tick ev piyanisti içerdi; şarkı geçişleri oluştu. Taşıma kaynaklı fark bulunmadı. |
| Notalar ve şarkı verisi | Eski `orchestra/music.mjs` ile yeni `orchestra/web/music.mjs` SHA-256 aynı: `d2d7f2f9b9d7310459aee60dc34251d2746f0de662f6f45a14b8ec85b044a1da`. Portsuz conductor testlerinde boş salon susması ve yalnız piyano ev piyanisti geçti. İşitsel kalite ölçülmedi. |
| Demo motorunun sunucu durumuna yazması | `demo.js` kendi conductor/makine/ülke skorlarını tutuyor; fetch/EventSource/beacon çağrısı yok. Sunucudaki players/scores/usage dizilerine demo verisi yazan yol bulunmadı. Açık kalan özel polling ve ortak an geçmişi kusurları ayrı tutuldu. |
| Demo çıkış düğmeleri ve saat örnekleri | Gerçek arayüz modüllerinin bellek içi deneyinde hem “Sade tınıyla dinle” hem “Orkestrayı dinle” demo timer'larını durdurdu, şeridi gizledi, canlı EventSource açtı. Kodda geçişler offsets dizisini temizliyor; sonraki kare offset'i yeniden hesaplıyor. Sayısal offset ilk kare gelene kadar eski değerini tutuyor; bu incelemede bundan ayrıca bir kusur kanıtlanmadı. |
| Yerel ses zinciri | Ses manifesti check geçti; Soundfont'a yerel instrumentUrl veriliyor. Vendor bu dosyayı fetch edip JSON/base64 olarak çözüyor; kullanılan Soundfont yolunda dış loopData yüklemesi etkin değil, eval gerekmiyor. Yerel vendor SHA-256: `31c898ef1ede38ac7da7a61b4abc8fb6825543d6a1fc7b7676e785bf80d0e203`. npm eşitliği ve gerçek decode ayrıca doğrulanmadı. |
| CSP'nin kaynakta tanımlı medya izinleri | `script-src 'self'` yerel modülleri, `connect-src 'self'` yerel SSE/sesleri, `img-src ... blob:` PNG'yi ve `media-src 'self' blob:` WAV/video önizlemelerini kapsıyor. Aktif ses yolunda inline script/eval bağımlılığı bulunmadı. Tarayıcıda CSP'nin gerçekten uygulandığı ve tüm indirmelerin çalıştığı doğrulanmadı. |
| Gizlilik metninin kalan temel veri akışları | Okuyucu ağ gövdesi kimlik ve faaliyet/sinyal/araç sayılarını whitelist üzerinden oluşturuyor; kaynak kod, prompt ve yol alanı eklemiyor. Pair temizleme bir saat TTL'ye bağlı; medya üretimi yerel Blob'lar üzerinden ve upload yolu yok. Demo ve ölçüm ifadelerinin istisnaları bulgularda yazıldı; proxy logları doğrulanmadı. |
| Erişilebilirliğin kaynak kısmı | Görev numaraları için boş alternatifli `content: ... / ""`, demo şeridinde `role="status"`, view başlıklarında `tabindex="-1"`, view değişiminde başlığa focus, skip bağlantısı, input etiketleri ve focus-visible stilleri var. Kaynakta bunların eksikliği bulunmadı. Gerçek erişilebilirlik ağacı/odak sırası doğrulanmadı. |
| Portsuz paylaşım hesapları | 14 Node testi kapsamında bounded kişisel motif, WAV yapısı/tepe sınırı, şarkı ölçüleri, davette sır temizleme, nota yerleşimi ve WebM mux başlığı testleri geçti. Bu, gerçek PNG render/WebCodecs/MediaRecorder testinin yerine geçmez. |

## Varsayımlar ve henüz kanıtlanmamış riskler

- **Etkinlik key'i sızarsa:** Bir IP, 300 dinleyici/makine/pair sınırından yararlanabilir. Aynı IP'de bunlar ayrı havuzlardır; birkaç IP ile global havuzlar doldurulabilir. Key katılımcı doğrulaması yapmıyor. Mantıksal limitler korunsa da olası kaynak tüketimi ve diğer kullanıcıların reddedilmesi koddan çıkarılan risktir; saldırı yükü veya üretim maliyeti ölçülmedi.
- **Gövdeyi limitten önce okuma:** Eksik/hatalı gövde trafiğinde rate kontrolünün uygulanmadığı kanıtlandı. Gerçek yavaş bağlantılarla bellek, CPU, descriptor tüketimi ve Node timeout zamanlaması ölçülmedi; hizmet kesintisi yaşandı diye raporlanmıyor.
- **“IP kaydedilmez” yayın koşulu:** Uygulamanın metric kayıtlarında ham IP görülmedi. Traefik/Cloudflare/VPS erişim kayıtları bu incelemenin dışında; OPERATIONS'daki kapalı/IP'siz erişim kaydı koşulunun sağlandığına dair bağımsız kanıt yok.
- **CSP:** Kaynakta izinler uygun görünse de gerçek tarayıcı uygulanması, inline style davranışı, codeclerin kullanılabilirliği, preview ve download etkileşimleri ölçülmedi. Bunlar geçti sayılmıyor.

## İncelenmedi / tamamlandı sayılmayan alanlar

- Gerçek soket üzerinden 11 API test senaryosu, SSE close/backpressure, kopma-toparlanma, yavaş POST ve gerçek etkinlik ağı.
- Çalışan sayfanın gerçek Chrome render'ı, mobil görünümü, klavye odak sırası, ekran okuyucu ağacı ve CSS boş alternatifinin tarayıcı/okuyucu uyumluluğu. DOM taklidi görsel veya erişilebilirlik kabulü değildir.
- Gerçek iPhone, sessiz anahtar/audioSession, Safari, kullanıcı jestiyle ses açma, cihazda PNG/WAV/video indirme.
- Gerçek ses dinleme, uzun konser, tını/yoruculuk değerlendirmesi ve Soundfont decode başarısı.
- CSP altında gerçek PNG/video preview ve WebCodecs/MediaRecorder üretimi; muxer birim testleri bunları doğrulamaz.
- npm `smplr@1.1.0` arşivindeki `dist/index.mjs` ile byte-for-byte karşılaştırma: dış ağ/DNS denemesi başarısız.
- Docker çok aşamalı build, container health/permission/volume davranışı ve gerçek SIGTERM kapanışı. Dockerfile okundu; build çalıştırılmadı.
- Gerçek disk/volume arızası, rename atomikliği ve güç kesintisinde kalıcılık.
- VPS, DNS, TLS, Traefik/Cloudflare güven zinciri, erişim logları, genel crawler/OG önizlemesi, 2000/1000 kapasitesinde performans ve egress.
- Okuyucunun dış kullanıcıya dağıtımı, gerçek kullanıcı araştırması ve gizlilik metninin hukuki onayı.

## Basitçe anlatım

- Testler ve eski/yeni müzik şefi karşılaştırması olumlu; canlı site bu sandbox'ta açılamadı.
- Demo sesi, bir süre sonra gerçek ortak kayıt gibi etiketlenebiliyor; demo sırasında bazı sunucu sorguları da sürüyor.
- Bozuk istekler hız sınırını atlıyor; sayaç dosyası bir kez yazılamazsa yeniden deneme duruyor.
- Yayın kabulü için bu kusurların düzeltilmesi ve gerçek tarayıcı/ağ/telefon kontrollerinin ayrıca yapılması gerekiyor.
