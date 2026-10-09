# Claude için inceleme notu

Selim bu çalışmayı bağımsız olarak incelemeni istiyor. Önce kök `AGENTS.md`, `CLAUDE.md`, `README.md`, `orchestra/README.md` ve `ORCHESTRA-HANDOFF.md` dosyalarını oku. Ardından bu notu uygulamayla karşılaştır.

## İncelemenin amacı

Ürün vizyonu: **kendi çalışma sesini keşfet → ortak orkestraya katıl → sana ait bir anı paylaş.**

Codex yerel geliştirmeyi60ana döngüyle tamamladığını raporladı. Bu raporu doğru kabul ederek başlama: kodu, çalışma kayıtlarını, testleri ve gerçek davranışı bağımsız doğrula. Döngü sayısı veya geçen testler tek başına ürün kabulü değildir. Gerçek dinleme, kullanıcı araştırması, fiziksel telefon ve üretim ortamı kabulü tamamlanmadı.

Bu inceleme talebi genel yayın, ücretli hizmet, dış kişilere mesaj, dış hesap paylaşımı, commit/push veya KK yetkisi değildir. Mevcut kullanıcı değişikliklerini koru; başka süreçleri otomatik durdurma. Bulguları raporla; kapsamlı uygulama değişikliği için Selim'in sonraki talimatını bekle.

## Mevcut durum ve kayıtlar

- Güncel yerel geliştirme sunucusu son teslimde **http://127.0.0.1:4482** üzerinde bırakıldı. Hâlâ çalıştığını kontrol et. Gerekirse boş bir yerel portta `PORT=4482 node orchestra/server.mjs` ile başlat.
-4480'de önceden açık bir sunucu korunmuştu; backend sürümü eski olabilir. Güncel backend kontrolü için4480'e güvenme.
- Git değişiklikleri commit edilmedi. Başlangıçta `AGENTS.md`, `CLAUDE.md` değişiklikleri ve yeni `ORCHESTRA-HANDOFF.md` kullanıcıya aitti; bunlar korunmuştur.
- Kök `CLAUDE.md` önceki oturumun durumunu içerir. “Kod değişikliği yok”, “deploy dosyası yok” gibi eski satırlar bu teslimin güncel durumunu anlatmaz. Gerçek Git/kod durumunu ve aşağıdaki kayıtları esas al; çelişkileri raporla.
- `orchestra/docs/PRODUCT-BRIEF.md`: kapsam, uzmanlık briefleri, özellik sözleşmeleri.
- `orchestra/docs/WORK-LOG.md`:01–60 soruları, onlu kontrol noktaları, kusur ve karar kayıtları.61–80ek bütçesi kullanılmadı.
- `orchestra/docs/VALIDATION.md`: kabul matrisi, kanıtlar ve açık koşullar.
- `orchestra/docs/OPERATIONS.md`: kurulum, veri ömrü, kapasite, maliyet, yayın/rollback.
- `orchestra/docs/RESEARCH-MEASUREMENT.md`: gerçek dinleme/kullanıcı/ticari araştırma planı.
- `orchestra/launch/LAUNCH-PACK.md`: poster, sosyal taslaklar, demo ve buluşma önerisi. Hiçbiri yayınlanmadı/gönderilmedi.
- `orchestra/evidence/README.md`: dosyaların anlamı ve geçersiz eski video uyarısı.

GG çerçevesini incelemek gerekirse `/Users/selimcitil/.codex/skills/gg/SKILL.md` ve `references/brief-framework.md` dosyalarını oku. Bu bir Codex skill yoludur; Claude'un komutu otomatik tanıdığı varsayılmamalı. Bu inceleme, `/gg tam` ile tüm geliştirmeyi yeniden başlatma talebi değildir.

## Değişikliklerin özeti

- Node HTTP/SSE ortak şef korundu; özel pair/me/unpair akışı, geçici anahtar, sınırlı payload/sayı/origin/rate/SSE ve simulation etiketi eklendi. Varsayılan bind127.0.0.1; PUBLIC_URL metadata ayarı deploy yapmaz.
- Python okuyucu yeni Claude/Codex faaliyetlerini içeriksiz tür sayılarıyla gönderir. Fragment'teki pair anahtarı POST gövdesine taşınır; genel yayına kod/prompt/yol/anahtar eklenmez.
- Türkçe akışkan arayüz: ilk dinleme, sade ses alternatifi, demo, ses/seviye/hareket, kişisel kimlik/koltuk ve dinleme modu.
- Gerçek kişisel faaliyetlerden veya ayrı etiketli anonim ortak notalardan yerel PNG/WAV; desteklenirse WebCodecs VP8/Opus WebM. Önizleme, görünür sayı/başlık, iptal/silme/indirme mevcut. Bu çıktı sade sentez yorumudur, canlı soundfont kaydı değildir.
- Davet anahtarı temizler; isteğe bağlı ölçüm yalnız localStorage. DijitalPi imzası/hikâye ve resmi iletişim yolu var.
- Non-root Dockerfile yerelde build/smoke/healthcheck ile denendi, base digest sabitlendi. Genel yayın yok.

Başlıca dosyalar: `agents.py`, `skill/scripts/control.py`, `orchestra/server.mjs`, `orchestra/crowd.mjs`, `orchestra/web/{index.html,style.css,app.js,experience.js,moment.js,video.js}`; yeni API/motif/WebM testleri ve benchmark.

## Bağımsız doğrulama

```sh
python3 -m unittest -v
node --test orchestra/test-api.mjs orchestra/test-moment.mjs orchestra/test-video.mjs
```

Raporlanan sonuç38Python+12Node başarılı. Logları kaynakla karşılaştır; önemli bir değişiklik yaptıysan ilgili testleri yeniden çalıştır. Kod keşfinde AGENTS talimatındaki codebase-memory MCP graph araçlarını tercih et.

İncelemede özellikle şunları değerlendir:

1. **Veri ve eşleştirme:** private endpoint/anahtar ömrü, başka makine/IP sahipliği, sızıntı ihtimali, loglar, byte/sayı sınırları, origin ve proxy güveni. Kesinti sırasında gönderim best-effort; kalıcı kuyruk/replay yok.
2. **Gerçek katkı ve doğruluk:** demo/simülasyon ile gerçek makine ayrımı, boş salon piyanisti,0oturumun yapay1gösterilmemesi, kişisel delta/baseline ve yeniden bağlantı. UI “bağlı” demeden gerçek veri şart mı?
3. **Ses yaşam döngüsü:** ortak/kişisel/demo geçişleri, sade ses resume dış indirmeye geçiyor mu, durdurma, seviye, çift sekme, kaynak/oscillator temizliği. Teknik ölçüm işitsel kalite kanıtı değildir.
4. **An/video:** başlık/sayı kontrolü çıktıya yansıyor mu; boş kaynak, iptal, yarış durumları, nesne URL/encoder cleanup, geçerli track/timestamp ve süre. MediaRecorder bu Chrome yüzeyinde kare üretmedi; fallback doğru hata ve PNG/WAV sunmalı.
5. **Mobil/erişilebilirlik:**320/390/768/masaüstü, gerçek klavye odağı/skip, kontrollerin isimleri, hareket ve bağlantı metinleri. Browser viewport testi fiziksel telefon veya ekran okuyucu testi değildir.
6. **Kapasite/operasyon:**120/45sn ve500/60sn simülasyon sonuçlarını gerçek kullanıcı/üretim kapasitesi sayma.2000makine tavanı test edilmiş kapasite değildir. SSE backpressure ve bellek sınırlarını incele.
7. **Kapsam ve iddialar:**60döngü kayıtları anlamlı soru/değerlendirme/doğrulama/karar içeriyor mu? Kabul matrisi eksikleri dürüst gösteriyor mu? Pazarlama gerçek ürün davranışıyla uyumlu mu?

Medya kanıtı: `final-personal-moment.png/.wav/.webm` gerçek yeni Codex faaliyetlerinden oluşturuldu; son kişisel WebM453124byte/1200×630/VP8/Opus48kHz/12sn, tüm decode hatasız raporlandı. `common-moment.webm` ayrı ortak kaynak. `invalid-recorder-110bytes.webm` bilerek saklanan **geçersiz kusur kanıtıdır**, geçerli teslim sayma. Dosyaları kendin doğrulayabilirsin; gerçek hoparlör dinlemesi yapmadan “dinledim” deme.

## Açık kabul koşulları ve onay ayrımı

Eksik olanlar:

-20–30dk gerçek işitsel değerlendirme: keyif, yoruculuk, yoğunluk ve geçişler.
- Gönüllü5geliştirici görev araştırması: anlama, dinleme/bağlanma, kendi katkısını bulma, an üretme ve paylaşma gerekçesi.
- Fiziksel telefon/Safari ses başlatma, önizleme ve dosya indirme.
- Somut yayın hedefinde VPS/proxy/TLS/log/erişim/CDN ve görsel crawler kontrolleri, maliyet ve rollback incelemesi. Genel yayın öncesi kullanılan örnek/eser haklarının uygunluğu da doğrulanmalı.

Codex'in ilk teslimde “yayın ve dış paylaşım onay bekliyor” demesi erkendi; Selim'e düzeltildi. **Şu anda Selim'in vermesi gereken bekleyen bir yayın onayı yok.** Somut hedef/config/maliyet/QA sonucu henüz yayın önerisi olarak sunulmadı. Önce yapılabilir kabul kontrolleri ve yayın paketi somutlaştırılır; sonra genel yayın/ücretli işlem/dış paylaşım için gerekli ayrı onay istenir. Teknik testler bu açık koşulların yerine geçmez.

## Beklenen inceleme raporu

Bulguları önem sırasıyla, dosya/satır, somut tetikleyici, kullanıcı etkisi ve doğrulama yöntemiyle yaz. Kanıtlanmış kusuru varsayımdan ayır. Özellikle:

- Kritik veya yayın engelleyici kusurlar var mı?
- Yerel teslim “tamamlandı” iddiası hangi koşullarda doğru/eksik?
- Kabul matrisiyle gerçek uygulama arasında hangi farklar var?
- Yayından önce yapılacak en küçük, öncelikli iş listesi nedir?

Kusur bulmadıysan bunu söyle, fakat incelemediğin durumları ve kalan test boşluklarını açık tut. Sahte araştırma sonucu, kullanıcı sayısı, dinleme veya ticari talep üretme.
