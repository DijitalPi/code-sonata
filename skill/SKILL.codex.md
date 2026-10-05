---
name: code-sonata
description: Kod müziğini aç, kapat veya durumunu kontrol et. Kullanıcı Code Sonata, kod müziği veya Claude/Codex oturumlarının çalışmasını (bütün pencereler) piyano olarak dinlemek istediğinde kullan. Genel müzik üretimi için kullanma.
---

# Code Sonata

macOS'ta `/Users/selimcitil/Projects/code-sonata` uygulamasını arka planda yönet.
Kullanıcıya terminal komutu yapıştırma işi verme; aşağıdaki yardımcıyı doğrudan çalıştır.

## Başlat (varsayılan: bütün Claude / Codex oturumları)

Varsayılan mod klasör değil **ajan aktivitesi**: Mac'teki bütün Claude Code ve Codex
oturumlarının kayıtları (`~/.claude/projects/**/*.jsonl`, `~/.codex/sessions/**/*.jsonl`)
izlenir. Hangi pencere/proje olursa olsun her adım çalar; proje sorma.

```sh
python3 /Users/selimcitil/.codex/skills/code-sonata/scripts/control.py start
```

Adım türü sesi belirler: Edit/Write melodiyi ilerletir, Bash bas notası, Read/Grep
hafif tıngırtı, düşünme/metin yumuşak akor, görev bitişi kapanış akoru. Toplam adım hızı
tempoyu, aynı anda çalışan oturum sayısı eşliğin kalınlığını belirler. Yalnızca adım
türü okunur; mesaj/kod içeriği ses motoruna gitmez.

**Koro:** Tek şef, tek şarkı. Melodi sırası bütün oturumlarda ortak ve kaldığı yerden
devam eder (`~/Library/Caches/code-sonata/position.json`, yeniden başlatmada da sürer).
Her oturum (terminal veya subagent) bir enstrümandır, geliş sırasıyla: piyano, yaylılar,
koro, çello, flüt, vibrafon, korno, arp. Her ses kendi oturumunun adımlarıyla gürleşir,
boşta kalınca geri çekilir; 20 sn sessiz kalan oturumun yeri yeni gelene verilir.

Varsayılan repertuvar `karisik` (Bella Ciao → Für Elise → Greensleeves → Neşeye Övgü).
Çalışan oturum varken müzik kesintisiz sürer; menü çubuğunda ♫ göstergesi açılır
(sessiz/sonraki şarkı/kapat). Test/demo gerekiyorsa `python3 /Users/selimcitil/Projects/code-sonata/demo.py`
kullan: sıfır token. Test için ASLA subagent açma.

Kullanıcı açıkça tek bir klasörün kayıtlarını dinlemek isterse eski klasör modu:

```sh
python3 /Users/selimcitil/.codex/skills/code-sonata/scripts/control.py start /tam/proje/yolu
```

Tek şarkı istenirse: La Casa de Papel → `--song bella-ciao`, Für Elise → `--song fur-elise`,
Greensleeves → `--song greensleeves`. Beethoven / Neşeye Övgü için
`--song ode-to-joy`, özgün üretken müzik için `--song original` ekle.
Bilinen melodi modunda ana nota sırası korunur; kod değişimleri tempoyu ve eşliği
etkiler. Başka bir şarkının hazır olduğunu varsayma; seçenekler: karisik, bella-ciao, fur-elise, greensleeves, ode-to-joy, original.

Komut başarılı olmadan müziğin açıldığını söyleme. Zaten aynı projeyi izliyorsa
ikinci süreç başlatmaz; farklı proje verilirse önceki dinlemeyi durdurup yenisine geçer.
Geçmiş adımlar sessizdir; yalnızca başlatmadan sonraki adımlar çalar. Hiçbir dosya
değiştirilmez. Dinleme kullanıcı kapatana veya macOS oturumu bitene kadar sürer.

## Durdur veya durumunu öğren

```sh
python3 /Users/selimcitil/.codex/skills/code-sonata/scripts/control.py stop
python3 /Users/selimcitil/.codex/skills/code-sonata/scripts/control.py status
```

“Kod müziğini kapat/sustur” için `stop` kullan. Yalnızca bu skill'in yönettiği
dinleyici durur; elle açılmış Terminal dinleyicileri etkilenmez.
Yardımcı hata verirse nedenini kısaca bildir; çalışıyor gibi davranma.
Durum/log dosyaları `~/Library/Caches/code-sonata/` içindedir.

Başlatıldıktan sonra kısa yanıt ver: ne dinleniyor ve “kod müziğini kapat”
yazarak durdurabileceği. Başka bir geliştirme göreviyle birlikte istenmişse o işe devam et.
