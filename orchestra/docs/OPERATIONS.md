# Yerel çalışma ve yayın adayı

2026-10-09. Genel yayın yok; DNS/proxy/VPS hesabı değiştirilmedi; ücretli işlem, image push veya Git push yapılmadı.

## Yerel başlat

Repo kökünde `PORT=4480 node orchestra/server.mjs`. Varsayılan bind 127.0.0.1; localhost/127.0.0.1 tarayıcıdan açılır. Bu ortamda Chrome localhost erişimini engelledi, 127.0.0.1 ile çalıştı. Link: http://127.0.0.1:4480. Bu oturumda önceden açık4480 süreci korunup güncel teslim4482 üzerinde bırakıldı: `PORT=4482 node orchestra/server.mjs` → http://127.0.0.1:4482. Aynı portu kullanan başka süreç varsa onu otomatik öldürme.

Tarayıcı komutu oluşturduktan sonra repo Terminal'inde çalıştır. `--silent` okuyucu yerel hoparlörü açmaz, tarayıcı müziği çalar. Geçmiş oturumlar sessiz, yalnız yeni faaliyetler. Kapatmak Ctrl+C. `skill/scripts/control.py` repo içinden APP yolunu bulur; kurulu skill kopyası başka klasördeyse `CODE_SONATA_APP=/tam/repo/yolu python3 .../control.py ...` kullan. Skill kurulumu/launchctl hizmeti bu geliştirmede değiştirilmedi.

## Doğrulama komutları

- `python3 -m unittest -v`
- `node --test orchestra/test-api.mjs orchestra/test-moment.mjs orchestra/test-video.mjs`
- `node orchestra/benchmark.mjs 120 45 120` veya `500 60 200` (ayrı 4494 test sunucusu açıp kapatır; simülasyon işaretlidir).
- `PORT=4491 TRUST_PROXY=1 node orchestra/server.mjs`, ardından `node orchestra/crowd.mjs 120 45 http://127.0.0.1:4491 120` ve `measure.mjs`. Testleri genel salonda çalıştırma.

## Ölçülen sınırlar

120 simülasyon +121 SSE: 45sn, 2.17 KB/sn/dinleyici, health P95 1ms, RSS150.9MiB, en büyük frame2036byte, en uzun framegap253ms.
500 simülasyon +201 SSE: 60sn, 2.7KB/sn/dinleyici, health P95 1.6ms, RSS158MiB, en büyük frame2699byte, gap256ms.

Bu tek makinede kısa testtir; üretim kapasitesi, uzun süreli kararlılık, farklı ağlar, TLS/proxy maliyeti veya gerçek kullanıcı sayısı değildir. İlk buluşma için 5–12 gerçek katılımcı hipotezi uygundur; yeni kapasite sözü verilmez. Sunucu dinleyici sınırı1000/toplam, IP başına8, 256KiB yazma kuyruğunda yavaş bağlantıyı kapatır. Makine tavanı2000'e sınırlandı; 2000 üretim kapasitesi test edilmedi, 500 kısa yerel test doğrulandı. SSE için proxy buffering kapalı olmalı.

## Veri ve saklama

- Kod/prompt/yol/proje adı ağ payload'una girmez. Tür toplamları ve anonim makine kimliği gider.
- Makine koltuğu son heartbeat'ten30sn sonra bırakılır; seyrek idle heartbeat10sn.
- Özel eşleştirme/totaller en fazla bir saat (+temizleme timer'ı1sn) sunucu belleğinde, restart ile tümü kaybolur. Genel SSE'ye sır yok.
- IP ülke çözümünde kullanılır, hız sınırı için açılış tuzlu özet. Kimlik/ülke listeleri bellekte; log istemleri gövde veya sır içermemeli. Proxy access log politikası ayrıca doğrulanmalı.
- PNG/WAV/video tarayıcı belleğinde; upload yok. Sil/yenile/kapat yerel önizlemeyi temizler; indirilmiş dosyayı kullanıcı yönetir.
- Opt-in yerel sayaçları temizlemek UI'daki düğmeyle mümkün. Ticari talep ürün sayaçlarından çıkarılmaz.
- Zengin ses seçimi dış CDN ve ses örneği kaynaklarından indirme yapar, ağ metadatası bu kaynaklara gider. Sade tını ve yerel örnek üçüncü taraf ses yüklemez. Bu bağımlılıkların erişimi/mahremiyeti genel yayın öncesi ayrıca gözden geçirilmeli.

## Yayın adayı

`orchestra/Dockerfile` bağımlılıksız Node runtime, non-root user ve healthcheck içerir. Docker Desktop29.4.1 ile yerel build geçti; container loopback4482 üzerinden health200, USER node uid1000 ve Docker healthcheck healthy doğrulandı. Yayın/image push yapılmadı. Önerilen build: `docker build -f orchestra/Dockerfile -t agent-orchestra:local .`. Node25-alpine base image digest bu makinede çözümlenen `sha256:bdf2cca6fe3dabd014ea60163eca3f0f7015fbd5c7ee1b0e9ccb4ced6eb02ef4` olarak sabitlendi; hedef mimaride ayrıca test et.

Yerel container denemesi: `docker run --rm -p 127.0.0.1:4480:4480 agent-orchestra:local`. HOST container içinde0.0.0.0, host portu yalnızloopback'e açıktır. Genel yayın değildir. Yerel QA container farklı host port4482 ile çalıştırıldı ve doğrulama sonrası kapatıldı. Komut hedef ortama göre uyarlanmalı.

Onaylı VPS/proxy yayınında: HOST=0.0.0.0, TRUST_PROXY=1; yalnız güvenilir ters proxy sunucu portuna ulaşabilmeli. Client doğrudan portu görürse forged XFF ile rate limit/ülke aşılır. Proxy ingress body2KiB, request rate, SSE buffering off, TLS ve origin doğrulaması gerekir. DNS `orchestra.dijitalpi.com` yalnız gerçek yayına hazır olduğunda yapılandırılır.

Yayın hazırlık incelemesi: gerçek hedef host/ağ sınırı, TLS, proxy güveni, log saklama, 5–12 kişilik yük, telefon ses/indirme, CDN kesintisi, health ve yeniden başlatma, PUBLIC_URL ile mutlak OG/canonical URL, crawler önizlemesi, gerçek dinleme değerlendirmesi. Bunlar üretimde tamamlandı sayılmadı.

## Maliyet varsayımları ve yetki

Yerel geliştirme/ölçüm model API'si veya ücretli render servisi kullanmaz. Server bağımlılıksız; tarayıcı sese yerelde işlem uygular. Zengin örnekler CDN indirmesi, SSE egress ve VPS kaynakları üretimde maliyet yaratabilir. Mevcut VPS'nin kullanılabilir bütçesi/faturası bu oturumda görülmedi; fiyat veya “ücretsiz üretim” sözü yok. 500 yük örneğinde 201 dinleyici toplam yaklaşık0.54MB/sn egress, sürekli kullanımda ciddi trafik olabilir; ilk buluşmayı sınırlı tut.

Ücretli servis veya kapasite artışı için somut host/servis, süre ve maliyet teklifiyle onay istenir. Genel yayın için image/config/rollback/QA sonucu ve hedef DNS görülerek onay istenir. Dış hesaplara içerik veya kişilere mesaj yalnız ayrı açık yetkiyle. Şimdi yalnız dosyalar hazır.

## Geri alma ve kesinti

Sunucu durdurulunca tarayıcı SSE otomatik2sn retry; özel me timeout/yeniden deneme. Restart pair'leri siler; yeni komut oluşturmak gerekir. Gelen notalar eski zamanlıysa çalınmaz, clock/offset toparlanır. Kesinti sırasında canlı sayılar “—”, özel koltuk gizlidir; restart sonrası eski anahtar404 yeni komut oluşturmayı engellemez. Okuyucu canlı olayları best-effort yollar; başarısız gönderim için kalıcı kuyruk/replay yok, kesinti faaliyetleri kaybolabilir. Sunucu yeniden başlayana kadar sessiz/sade yerel demo kullanılabilir.

Yerel değişiklik geri alma: kullanıcı AGENTS.md/CLAUDE.md/handoff değişikliklerini koru. Değişen uygulama dosyalarını diff ile seçerek geri al; `git reset --hard` veya `git clean` kullanma. Yayında önceki image digest/config kaydı tutulup geri dönülür; kullanıcı pair'leri yeniden kurar. Medya çıktıları sunucuda olmadığından restart onları uzaktan değiştirmez.

Yayın konfigürasyonunda `PUBLIC_URL=https://orchestra.dijitalpi.com` OG/Twitter görselini ve canonical adresi mutlak üretir. Yerelde bu değişkeni boş bırak. URL ayarı DNS veya deploy yapmaz.
