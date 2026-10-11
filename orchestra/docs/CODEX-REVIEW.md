# Codex için bağımsız denetim notu (yayın hazırlığı turu, 2026-10-11)

Bu turu Claude yazdı (WORK-LOG 72–80, brief: PRODUCT-BRIEF "Yayın hazırlığı briefi"). /gg kuralı gereği yazan araç kendi işini kabul etmez: lütfen bağımsız denetle. **Claude'un raporunu doğru kabul ederek başlama**; kodu, testleri ve çalışan uygulamayı kendin ölç.

Yetki: yalnız inceleme ve bulgu raporu. Yayın, push, KK, dış paylaşım yok. Commit edilmemiş işe dokunmadan önce `git status`'a bak.

## Çalıştır

```sh
node orchestra/fetch-sounds.mjs --check    # eksikse argümansız çalıştır (27 MB)
python3 -m unittest
node --test orchestra/test-api.mjs orchestra/test-moment.mjs orchestra/test-video.mjs orchestra/test-conductor.mjs
PORT=4482 node orchestra/server.mjs        # http://127.0.0.1:4482
```

Claude'un ölçtüğü: 25/25 Node, 40/40 Python. Tarayıcı ölçümleri headless Chrome + DevTools protokolüyle yapıldı (MCP tarayıcısı disk dolunca takıldı).

## Özellikle bak

1. **Etkinlik bağlantısı** (`server.mjs` `EVENT_KEYS`, `isEvent`, `limited`, `admit`, SSE sınırı): anahtar sızarsa en kötü ne olur? Global tavanlar (2000 makine, 1000 dinleyici, 5000 eşleştirme) korunuyor mu? `readJson` artık hız sınırından önce gövdeyi okuyor (2 KiB); bunun bir istismar yolu var mı?
2. **Sayaçlar** (`/api/metric`, `/api/metrics`): IP veya kimlik dosyaya ya da yanıta sızıyor mu? `sameSecret` zamanlamaya dayanıklı mı? `METRICS_FILE` yazımı atomik mi, SIGTERM işleyicisi başka bir kapanışı bozuyor mu?
3. **Şef taşıması** (`web/conductor.mjs`): sunucudaki davranış eskisiyle aynı mı? Karşılaştırma tabanı `00af6b1` (taşımadan önceki son commit): `git diff 00af6b1 -- orchestra/server.mjs orchestra/web/conductor.mjs`. Ev piyanisti ve doruk geçişleri.
4. **Demo konseri** (`web/demo.js`, `app.js` `enterDemo/leaveDemo`): demo sırasında sunucuya hiçbir istek gidiyor mu (SSE, beacon dışında `demo` sayacı tek seferlik)? "Orkestrayı dinle" / "Sade tınıyla dinle" demodan düzgün çıkıyor mu? Saat farkı (`offsets`) sıfırlanıyor mu? Demo verisi gerçek sayaçlara ya da lige karışıyor mu?
5. **CSP ve yerel ses**: `web/vendor/smplr-1.1.0.mjs` npm paketindeki `dist/index.mjs` ile aynı mı (SHA-256 `31c898ef…e203`)? CSP herhangi bir yolu kırıyor mu (video, an önizleme, indirme)?
6. **Gizlilik metni** (`index.html` `data-view="privacy"`): her cümle koddaki davranışla aynı mı? "IP kaydedilmez" Traefik erişim kaydına bağlı (OPERATIONS).
7. **Erişilebilirlik**: görev numaraları (`content: … / ""`), demo şeridi `role="status"`, odak sırası.

## Açık koşullar (tamamlandı sayılmaz)

Gerçek iPhone (sessiz anahtar, ses, indirme), Safari, Docker çok aşamalı build, gerçek etkinlik ağı, işitsel değerlendirme, gizlilik metninin hukuki onayı, okuyucunun dışarıya dağıtımı (repo private), VPS/DNS yayını.

Bulguları önem sırasıyla, dosya/satır, tetikleyici, kullanıcı etkisi ve doğrulama yöntemiyle `orchestra/docs/CODEX-REVIEW-RESULT.md`'ye yaz.
