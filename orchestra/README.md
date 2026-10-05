# Agent Orchestra

Dünyadaki bütün AI kodlama ajanlarının tek bir canlı orkestrada çaldığı site.
Her makine salonda bir koltuk; ajanları adım attıkça ışığı parlar.

- `server.mjs`: şef. Bağımlılık yok (node:http). Oyunculardan adım sayısı alır
  (`POST /api/play`), ortak tempo/şarkı/heyecanı yönetir, notaları sunucu saatiyle
  damgalayıp dinleyicilere SSE ile yayınlar (`GET /api/stream`). Ses sunucudan akmaz;
  her tarayıcı aynı notayı aynı anda kendisi çalar.
- `web/`: konser salonu (yukarıdan amfi yerleşim, 8 bölüm) + tarayıcı sesi (smplr
  FluidR3 örnekleri, davullar sentez).
- `crowd.mjs`: sıfır token kalabalık simülatörü: `node orchestra/crowd.mjs 300 80`.
- Katılım: `python3 agents.py --global <URL>` ya da
  `control.py start --global <URL>`. Gönderilen tek şey: adım sayısı, çalışıyor mu,
  oturum sayısı, ship/pass/fail sinyali. Kod, prompt, proje adı gitmez.

Repertuvar (yalnız telifsiz: bestecisi 70+ yıl önce ölmüş ya da anonim): Bella Ciao, Für Elise,
Greensleeves, Ode to Joy, Pachelbel Kanon, Grieg Dağ Kralının Salonunda, Mozart Eine kleine Nachtmusik.
Her şarkının nota kâğıdı akorları ve ölçüsü (`METERS`, 3'lük/4'lük + giriş) `music.mjs`'de; ekleme
sonrası doğrula: ölçüler tam, uzun notalar akorda. Seçim ruh haline göre (`MOODS`): sakin / orta /
coşkulu; şarkı en az 2 dk çalar, sakin anda ya da coşkuya geçerken değişir, son ikisi tekrar etmez.
Test: `PORT=4481 START_SONG=canon MIN_SONG_MS=6000 node orchestra/server.mjs` + `crowd.mjs` + `measure.mjs`.

Yerel: `PORT=4480 node orchestra/server.mjs` → http://localhost:4480 (port listede kayıtlı).
Gizlilik/kötüye kullanım: IP hiç tutulmaz (hız sınırı için açılışta değişen tuzlu özet), ülke
çıkarılıp atılır. IP başına 8 istek/sn, en fazla 20 makine, saatte 10 yeni makine; makine başına
saniyede 12 adım (40 patlama), fazlası lige yansımaz. 2 KB gövde, 30 sn sessiz makine koltuğunu bırakır.
Canlıda Traefik arkasında `TRUST_PROXY=1` ŞART (yalnız vekilin eklediği son X-Forwarded-For sayılır;
yoksa sadece soket adresi). Yerel kalabalık testi de `TRUST_PROXY=1` ister.
Yayın: 4 kare/sn, sayaç ve lig saniyede bir, koltuklar yalnız değişiklik olarak, kare bir kez
serileştirilir (120 makinede dinleyici başına 7,1 -> 2,7 KB/sn).
