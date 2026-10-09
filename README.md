# Code Sonata

Codex, Claude veya editörün proje dosyalarını değiştirdikçe piyano çalan,
tamamen yerel bir macOS terminal prototipi.
Python 3 ve Xcode Command Line Tools gerekir. Harici paket veya servis kullanmaz.

## Varsayılan: bütün Claude / Codex oturumlarını dinle

Müzik klasöre değil ajanların çalışmasına bağlıdır. Mac'teki bütün Claude Code
(`~/.claude/projects/**/*.jsonl`) ve Codex (`~/.codex/sessions/**/*.jsonl`) oturum
kayıtları izlenir; hangi pencere/proje olursa olsun her adım duyulur.

```sh
python3 ~/Projects/code-sonata/agents.py            # sesli
python3 ~/Projects/code-sonata/agents.py --silent   # adımları yazıyla göster
```

| Adım | Ses |
|---|---|
| Edit / Write / apply_patch | melodi ilerler |
| Bash / exec | bas notası |
| Read / Grep / Glob | hafif yüksek tıngırtı |
| düşünme / metin | yumuşak akor |
| görev bitti | kapanış akoru |

Toplam adım hızı tempoyu, aynı anda çalışan oturum sayısı (son 20 sn) eşliğin
kalınlığını belirler. Geçmiş sessizdir; yalnızca başlatmadan sonraki adımlar çalar.
**Koro:** Tek şef, tek şarkı. Melodi sırası bütün oturumlarda ortak ve kaldığı yerden
devam eder (`~/Library/Caches/code-sonata/position.json`, yeniden başlatmada da sürer).
Her oturum (terminal veya subagent) bir enstrümandır, geliş sırasıyla: piyano, yaylılar,
koro, çello, flüt, vibrafon, korno, arp. Her ses kendi oturumunun adımlarıyla gürleşir,
boşta kalınca geri çekilir; 20 sn sessiz kalan oturumun yeri yeni gelene verilir.

**Kesintisiz akış:** Bir oturum mesaj alıp çalışmaya başladığından görevi bitirene kadar
(`end_turn` / `task_complete`) müzik yumuşakça sürer; uzun düşünmelerde kopmaz. Hepsi
bitince susar. 2 dakika hiç yazmayan "çalışıyor" oturumu bitmiş sayılır.

**Uyum:** Melodinin altındaki akor her notaya göre seçilir; adım vurguları (komut, okuma,
düşünme, bitiş) her zaman o akorun notalarıdır, detone çatışma olmaz.

**Heyecan:** Tempo arttıkça katmanlar girer: hi-hat + nabız gibi atan bas (%30), kick (%50),
tremolo yaylılar (%60), trampet (%65), timpani (%70), melodi oktav ikilemesi. En tepede 3 sn
kalınca zil + bütün müzik bir ton yukarı (doruk, menüde 🔥); tempo düşünce geri iner.

**Anlamlı sesler:** Claude izin/cevap beklerken yükselen nazik çan (Claude Code `Notification`
hook'u, `~/.claude/settings.json`). Araç hatası: kısa kasvetli akor; test kırıldı: daha
güçlüsü. Testler geçti: korno arpeji. `git commit`/`git push`: fanfar + zil. Bunun için araç
çıktısına/komutuna yalnızca evet-hayır kontrolü yapılır, içerik tutulmaz.

**Repertuvar:** Varsayılan `karisik`: Bella Ciao → Für Elise → Greensleeves → Neşeye Övgü
sırayla döner; her şarkı en az 2 dk çalar (tekrarlanır), heyecanlı anda değişmez, geçişte kapanış akoru + kısa nefes. Tek şarkı için `--song bella-ciao|fur-elise|greensleeves|ode-to-joy`.

**Menü çubuğu:** `♫ 3` = 3 oturum çalıyor, `♪` bekliyor, `♪ sessiz`, `♪ kapalı`. Menüden
sesi kapat/aç, sonraki şarkı, müziği aç/kapat. Müzik açılınca kendiliğinden gelir.

**Sıfır token demo:** `python3 demo.py` sahte Claude oturumlarıyla 8 enstrümanlı orkestrayı
çalar (model çağrısı yok). `--sessions 3 --silent` ile sessiz deneme. Demo gerçek müziğin
kaldığı yere ve menü çubuğuna dokunmaz. Ses motorunu ölçmek için: `swift check_voices.swift`.

**Kaynak:** ~33 MB RAM, ortalama %0,1 işlemci; hiç token harcamaz.

Yalnızca adım türü (ve yukarıdaki evet-hayır kontrolleri) kullanılır; mesaj, kod ve araç girdisi tutulmaz.

## Klasör modu: tek projenin dosya kayıtlarını dinle

Finder'da `start.command` veya `watch.command` dosyasına çift tıkla ve proje klasörünü seç.
Açılan dinleme penceresi açık kalsın; Codex veya Claude ile alıştığın yerde çalış.
Terminalden klasörü doğrudan da verebilirsin:

```sh
~/Projects/code-sonata/watch.command /tam/yol/projen
```

Proje terminalindeysen `~/Projects/code-sonata/watch.command .` yeterlidir.
Göreli yollar komutu çalıştırdığın klasöre göre çözülür. `G` sesi açar/kapatır,
`Q` veya Ctrl+C dinlemeyi durdurur. Kod dosyalarına hiçbir şey yazılmaz.
Mevcut dosyalar ilk taramada sessizce öğrenilir; yalnızca sonraki değişiklikler çalar.

Varsayılan melodi **Bella Ciao** temasının sade piyano yorumudur. Diğer seçenekler:
`--song ode-to-joy` (Beethoven, Neşeye Övgü teması) ve `--song original` (üretken
melodi). Tanıdık temalarda nota sırası korunur; kod değişimleri tempo ve eşliği etkiler.
Bunlar kendi sade eşliğimizle çalınan temalardır; dizi kaydı veya hazır ses dosyası
kullanılmaz. Bella Ciao geleneksel melodi kaynağı:
[8notes](https://www.8notes.com/scores/bella_ciao_trad_.asp).

Codex skill'i: `~/.codex/skills/code-sonata`. “Kod müziğini aç/kapat” isteklerini
Terminal açtırmadan arka planda yönetir. Kullanıcı oturumu kapanınca durur;
bilgisayar açılışına kalıcı servis kurulmaz.

Kaydedilen değişiklikler yaklaşık 0,4–0,8 saniye içinde algılanır. Toplu değişiklikler
2,5–8 saniyelik sınırlı bir müzik cümlesine yayılır; ardından sesler sönümlenir.
Değişiklik miktarı ve sıklığı tempoyu etkiler. Ekrandaki token akışı, düşünme süresi,
sohbet mesajları veya henüz kaydedilmemiş metin takip edilmez. Değişikliğin hangi
uygulamadan geldiği ayırt edilmez; izlenen klasördeki tüm kod kayıtları duyulur.

Python, JS/TS, Swift, Go, Rust, Java, C/C++, CSS, HTML ve başka yaygın kod uzantıları
izlenir. Fonksiyon/döngü/koşul ayrımı basit satır örüntüleridir; bütün dillerin
tam sözdizimini çözümlemez. Gizli klasörler, bağımlılık/derleme klasörleri,
küçültülmüş JS/CSS, `.d.ts`, sembolik bağlantılar ve 256 KiB üzeri dosyalar atlanır.
Özel `.gitignore` kuralları okunmaz. 2000 kod dosyası sınırında daha dar klasör seçilir.
İzleme ayrı iş parçacığında çalışır; tarama müziğin ritmini bekletmez.

Ses olmadan izlemeyi denemek için:

```sh
python3 ~/Projects/code-sonata/watch.py /tam/yol/projen --silent --duration 10
```

## Önceki bağımsız editör

Bağımsız editörü ayrıca açmak için terminalde:

```sh
cd ~/Projects/code-sonata
./start.command --editor
```

Var olan UTF-8 dosyanı açmak için `./start.command --editor dosya.py` kullan.
Dosya verilmezse yeni çalışma `sessions/` altında saklanır.
Ctrl+S kaydeder; Ctrl+Q veya Ctrl+C kaydedip çıkar; Ctrl+G sesi açar/kapatır;
Ctrl+Z son düzenlemeyi geri alır. Oklar, Home/End, silme ve otomatik girinti desteklenir.
Kaydetme başarısız olursa editör açık kalır. Beklenmedik kapanışta mümkünse ayrı
bir kurtarma dosyası yazılır; zorla süreç sonlandırmaya karşı otomatik kayıt yoktur.

## Müzik

Son dört saniyedeki yazma yoğunluğu 55–140 BPM aralığına yumuşakça çevrilir.
Melodi ritmik aralıklarda çalar; her tuş ayrı nota değildir. Do majör / La minör
çevresinde yavaş armoni, hafif bas ve pentatonik melodiler kullanılır.
Fonksiyon adı deterministik bir motif seçer, döngüler arpej üretir, koşullar
melodinin yönünü değiştirir. `return`, `pass`, `raise` ve boş satır kapanış
hissi verir. Bunlar satır tabanlı müzikal sezgilerdir; tam Python ayrıştırıcısı değildir.
Durunca yeni notalar kesilir ve mevcut seslerin kuyruğu sönümlenir.

İzleme modu yalnızca seçilen klasördeki kod dosyalarını okur; editör modu kendi
yazma alanındaki olayları okur. Yazılan kodu çalıştırmaz,
global klavye dinlemez ve ağa veri göndermez. Ses macOS'un yerleşik General MIDI
piyanosu ve AVAudioEngine ile üretilir. Motor açılamazsa editör hata mesajıyla çalışır.

İlk sürüm sade bir scratchpad'dir: geniş emoji/CJK karakterlerinde imleç hizası,
gelişmiş seçim, kopyala/yapıştır ve çok büyük dosyalar için tam editör desteği yoktur.
Türkçe metin desteklenir. Piyano tınısı ve müzikal zevk için gerçek dinleme denemesi gerekir.

## Kontrol

```sh
python3 -m unittest -v
python3 sonata.py --silent
```

## Agent Orchestra — yerel ürün geliştirmesi

Kendi çalışma sesini keşfet, ortak orkestraya katıl, gerçek faaliyetlerinden PNG/WAV/sesli video oluştur. Kurulum, 60 döngü kaydı, testler ve açık kabul koşulları [orchestra/README.md](orchestra/README.md) içinde. Güncel yerel önizleme bu oturumda http://127.0.0.1:4482; genel yayın yapılmadı.

Orkestra katılımı açıkça `--global` ile seçilir; anonim kimlik ve faaliyet sayıları seçilen sunucuya gider. Kod/prompt/yol aktarılmaz. Yerel izleme/editör modu hakkındaki ağsız davranış bu seçimden ayrıdır.
