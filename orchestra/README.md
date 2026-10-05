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

Yerel: `PORT=4480 node orchestra/server.mjs` → http://localhost:4480 (port listede kayıtlı).
Gizlilik/kötüye kullanım: IP başına 8 istek/sn, 2 KB gövde, rastgele hex kimlik,
30 sn sessiz makine koltuğunu bırakır, en fazla 100.000 makine.
