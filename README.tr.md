# Code Sonata

[English](README.md) · Türkçe

Codex ve Claude çalışırken müzik çalan, tamamen yerel bir macOS aracı.
Python 3 ve Xcode Command Line Tools gerekir. Harici paket veya servis kullanmaz.

## Kurulum

```sh
./install.sh            # kur ya da güncelle (2 sn, 432 KB)
./install.sh --kaldir   # kaldır; eklediğin MIDI şarkıları kalır (--hepsi onları da siler)
```

Python 3.9+ ve Xcode Command Line Tools yeter. Ses motorunu ve menü çubuğunu
`~/Library/Application Support/code-sonata/bin` altına derler, skill'i `~/.claude/skills` ve (varsa)
`~/.codex/skills` altına bağlar, sonunda `control.py doctor` ile kontrol eder. Repo Masaüstü, Belgeler,
İndirilenler ya da iCloud Drive'daysa çalışan kopyayı `.../code-sonata/app` altına alır: macOS arka
plan programlarına o klasörler için izin sorar ve ses motoru o soruda takılırdı. Geliştirirken
`./install.sh --link` repodaki dosyaları doğrudan kullanır. Açılışta kendiliğinden başlayan servis
kurmaz. Sonra Claude Code ya da Codex'e "kod müziğini aç" demek yeterli.

## Varsayılan: bütün Claude / Codex oturumlarını dinle

Müzik klasöre değil ajanların çalışmasına bağlıdır. Mac'teki bütün Claude Code
(`~/.claude/projects`), Codex (`~/.codex/sessions`), Gemini CLI (`~/.gemini/tmp`) ve Grok Build
(`~/.grok/sessions`) oturum kayıtları izlenir; hangi pencere/proje olursa olsun her adım duyulur.

```sh
python3 agents.py            # sesli (repo klasöründe)
python3 agents.py --silent   # adımları yazıyla göster
```

**Tek şef, iki salon.** Yerel araç Agent Orchestra sitesiyle aynı şefi kullanır: `conductor.py`,
sitedeki `orchestra/web/conductor.mjs`'in satır satır karşılığıdır ve aynı dosyaları
(`orchestra/web/songs.mjs`, `flow.mjs`) okur. Site akış çalar; yerel araç varsayılan olarak şarkıları,
`--song akis` ile akışı çalar. `test_conductor.py` ikisine aynı senaryoyu oynatır ve
notaların birebir aynı olmasını ister.

**Koro.** Her oturum (terminal veya subagent) bir koltuktur. İlk oturum stilin bütün grubunu
başlatır; sonra gelen her oturum grupta henüz olmayan bir enstrüman ekler ve tempo ne olursa olsun
duyulur:

| Stil | 2., 3., 4. … oturum |
|---|---|
| `klasik` | flüt, korno, koro, vibrafon, akordeon |
| `8bit` | testere melodi, synth brass, kalliope, charang |
| `sinema` | flüt, trompet, çelesta |
| `lofi` | flüt, tenor saksafon, koro pad, caz gitar |
| `synthwave` | kare melodi, polysynth, koro pad, kristal, bas-melodi |

Liste bitince sonraki oturumlar grubun bölümlerini kalınlaştırır. Yeni gelen ilk bar başında girer.
Turunu bitiren oturum içinde olduğu müzik cümlesini tamamlar, sonraki cümle başında çekilir. Son
oturum da bitince cümle sonuna kadar (en çok iki ölçü) çalınır, sonra kapanış akoru gelir. Bir
bölüm, oturumu çalışırken (prompt ile turun sonu arasında) çalar; 20 sn boşta kalan oturumun yeri
yeni gelene verilir. Melodi bir cümle boyunca aynı enstrümanda kalır, el değiştirmesi yalnız cümle
başında olur. Armoni nota
kâğıdı akorlarıyla (Bella Ciao'da 5 akor değişimi) gelir; bas, bir pad ve bir renk sesi ayrı
registerlarda durur.

| Adım | Ses |
|---|---|
| her adım | tempoyu ve heyecanı artırır |
| Bash / exec | o oturumun enstrümanında kısa bas notası |
| Read / Grep / Glob | tiz, hafif akor notası |
| düşünme / metin | yumuşak üçlü |
| tur bitti | o oturumun enstrümanı cümle sonunda çekilir; son oturumda cümle biter, kapanış akoru gelir |

Notalar bir sonraki yarım vuruşta, akorun içinde çalar.

**Kesintisiz akış.** Bir oturum mesaj alıp çalışmaya başladığından görevi bitirene kadar
(`end_turn` / `task_complete` / kullanıcı durdurması) müzik sürer; uzun düşünmede kopmaz.
Hepsi bitince kapanış akoruyla susar. 2 dakika hiç yazmayan "çalışıyor" oturumu bitmiş sayılır.

**Ritim.** Notalar 150 ms önden, tam çalma anlarıyla gönderilir; Swift ses motoru onları kesin
zamanlayıcıyla başlatır. Ölçüm: planlanan anla gerçek başlangıç arasındaki fark ortalama
0,06 ms, en fazla 0,10 ms (önceki sürümde ortalama 11,5 ms, en kötü 29 ms ve 25 sn'de 0,7 sn kayma).

**Heyecan.** Adım hızı tempoyu 66–116 BPM arasında taşır. Hızlanma heyecanı artırır: önce eşlik
kalınlaşır, en tepede 3 sn kalınca bütün müzik bir ton yukarı çıkar, zil ve timpani girer, davul
yalnız bu doruğa özgüdür. Doruk en fazla 20 sn sürer, sonra 30 sn dinlenir (menüde 🔥).

**Anlamlı sesler.** Claude izin/cevap beklerken yükselen çan (Claude Code `Notification` kancası,
`install.sh` komutu gösterir). Araç hatası: kısa koyu akor; test kırıldı: daha güçlüsü. Testler
geçti: yükselen korno. `git commit`/`git push` gerçekten başarılı olunca fanfar. Test ve commit
sonuçları yalnız komut çıktılarında, evet-hayır olarak okunur: bir log dosyasını okumak "test
kırıldı" demek değildir, `10 passed; 0 failed` başarıdır. İçerik tutulmaz.

**Stiller.** Aynı şarkı beş ayrı düzenlemeyle çalar; tek oturum çalışırken bile stilin bütün grubu
duyulur:

| Stil | Ne duyulur |
|---|---|
| `klasik` | piyano, yaylılar, çello, arp; davul yalnız dorukta (varsayılan) |
| `8bit` | oyun müziği: kare dalga melodi, hızlı arpejler, oktav bas, 808 davul (100–150 BPM) |
| `sinema` | film müziği: yaylı ostinatosu, koro, brass, bar başında timpani |
| `lofi` | çalışma müziği: elektrik piyano, swing, yumuşak davul, yedili akorlar (70–86 BPM) |
| `synthwave` | synth lead ve pad, sekizlik synth bas, 808 davul |

Test kırılınca armoni askıda kalır (üçlü yerine dörtlü), test geçince çözülür.

**Şarkının akışı.** Bir şarkı üç turda çalar: önce tema, sonra varyasyon, sonra nefes. Varyasyonda
melodi sahnedeki başka bir enstrümana geçer (tek oturumda piyanodan yaylılara), şarkının en yüksek
notası A6'yı aşmıyorsa bir oktav yukarı çıkar, uzun notaların altında piyano akordu yukarı doğru
tamamlayarak cevap verir. Varyasyonun tek sayılı cümleleri yeni bir ezgidir: aynı ritim ve akorlar
üstünde melodi cümlenin ilk notası etrafında ters çevrilir, vuruş başında akor sesine, aralarda
dizi sesine oturur; cümle temanın kendi notasıyla başlar ve biter. Nefeste melodi susar; en fazla
8 ölçü boyunca yalnız eşlik çalar ve piyano kırık akorla akar. Son ölçü yavaşlar (en çok %25),
kapanış akoru alttan yukarı arpejle çalar, ardından sonraki şarkının dominant yedilisi 2 vuruş
köprü kurar ve yeni şarkı kendi temposunda başlar. İş hızlanınca sıradaki coşkulu şarkıya tema
bitince geçilir. Önceden şarkı en az 2 dk çalmak zorundaydı ve yalnız sakin anda değişebiliyordu:
4 ölçülük bir tema art arda 13 kez dönüyordu.

**Çalış biçimi.** Melodi her cümlede ortasına doğru güçlenir (başında hızın %90'ı, ortasında
%106'sı), cümlenin son notası %10 daha yumuşaktır; ölçü başı %6 vurgulu, ara vuruşlar %5 yumuşak.
Her eserin kendi temposu var (`songs.mjs` `tempo`):
Gymnopédie stilin aralığının 0,85'i, Air 0,8'i, Rondo alla Turca 1,15'i, Für Elise 1,25'i (sekizlik
vuruşla yazıldığı için). Son ölçüdeki yavaşlama dışında notalar ızgarada kalır. Yerel motor bölümleri
sitedeki gibi sahneye yayar (yaylılar ve arp solda, çello ve vibrafon sağda); yanlara açılan sesler
mikserde ~2 dB kaybettiği için çıkış kazancı +9'dan +11 dB'ye çıktı.

`--melody az|orta|cok` melodi miktarını seçer. `az` yalnız tema ve nefes, `orta` (varsayılan) üç turun
hepsi, `cok` tema ve varyasyondur (nefes yok). `--volume 0-100` ses seviyesini ayarlar (100 bugünkü
seviye). İkisi de çalarken değişir ve hatırlanır; menü çubuğunda "Melodi" ve "Ses" alt menüleri var.

**Repertuvar.** 20 eser, varsayılan `karisik`. Sonraki şarkı ajanların temposuna göre seçilir (sakin,
ılık, coşkulu). Son çalınan 6 şarkı ruh hali ne olursa olsun sırasını bekler; seçilen ruh halinde
uygun şarkı kalmadıysa komşu ruh haline geçilir. Seçenek varsa yeni şarkı bir öncekinden başka
tondadır. Sakin listede 8 eser var (önceden 4).

**Akış: şarkı yerine döngüler.** `control.py start --song akis` (menüde Şarkı > Akış) şarkı çalmaz.
Incredibox'taki gibi katmanlar üst üste biner. Her katman dört ölçülük bir döngüdür; hepsi aynı on
altılık ızgarada, aynı ton ve akor döngüsünde çalar. Yeni gelen ölçü başında girer, çıkan döngüsünü
bitirir. İlk oturum davul, bas, akor, arpej ve nakaratı getirir; her yeni oturum kendi katmanını ekler
(klasikte flüt cevabı, korno vuruşları, koro, vibrafon çanları, akordeon riff'i). Bir sahne sekiz
döngü sürer: giriş, tema, çeşitleme, değişim, mola (davulsuz), yükseliş, doruk, kapanış. Bir oturumun
kendi katmanı her tempoda çalar; yalnız giriş ve molada sahnenin izin verdiği az sayıda katman çalar. Sonra
son üç sahnede çalmamış bir akor döngüsü, yeni bir donanımda komşu bir ton (dörtlü, beşli ya da bir ton öte,
mod değişirse komşu tonun ilgili tonu) ve yeniden yazılmış nakaratlarla yeni sahne gelir; ilk sahne saatten
tohumlanır.
Tempo sahne başına en fazla 8 BPM değişir. Commit/push sinyali gelirse sonraki döngü doruk olur (sahne
başına bir kez). Kırık testte armoni askıya alınmaz, boş beşliye iner (nakaratların üçlüsüyle sürtüşmesin). Tek
oturumla 20 dakikada 12-20 sahne çalar; aynı nakarat en çok 2 kez gelir, art arda hiç gelmez.
`--melody az` nakaratı 8 döngünün 3'ünde çalar, `cok` giriş ve molaya da ekler. Akışta şarkı
olmadığı için sevme, çalmama ve sıra kapalıdır, menüdeki "Sonraki şarkı" "Sonraki sahne" olur
(`control.py next` de aynısını yapar).
Desenler `orchestra/web/flow.mjs`, stil ayarları `styles.mjs` içindeki `flow` alanında. Agent Orchestra
sitesinin salonu da akış çalar (klasik stil).

**Kendi sıran ve tercihlerin.** Tercihler `~/Library/Application Support/code-sonata/preferences.json`
dosyasında durur; kaldırma işlemi (`./install.sh --kaldir`) bu dosyayı da MIDI şarkıları gibi bırakır.

```sh
control.py queue add gymnopedie air brahms-lullaby   # kendi sıran (remove, set, clear da var)
control.py start --song sira                          # sırayla çalar, sonra başa döner
control.py like [ŞARKI]       # sevdim: kendi ruh halinde önce gelir (şarkı verilmezse çalan şarkı)
control.py ban [ŞARKI]        # bir daha çalma (sıradan da çıkar); tekrar verilirse geri alınır
control.py signals            # sinyallerin listesi; signals off ship adim, signals on ship, signals demo
```

Menü çubuğunda aynıları var: "Sevdim", "Bu şarkıyı çalma", "Sıraya ekle", Şarkı menüsünde "Sıram",
"Sinyaller" alt menüsünde her sinyal ayrı açılıp kapanır. Sinyaller: izin ya da cevap bekliyor (çan),
test kırıldı, test geçti, commit / push, komut hatası ve adım notaları (`adim`). Test sinyali kapalıyken
de armoni test sonucunu izler. `signals demo` her sinyali adıyla birer kez çalar.

- Klasik ve geleneksel: Bella Ciao, Für Elise (A bölümü, Do majör ara bölüm ve dönüş, 22 ölçü),
  Greensleeves, Neşeye Övgü (16 ölçünün tamamı), Pachelbel Canon, Dağ Kralının Salonunda (Si minör
  tema ve Fa diyez majördeki ikinci cümle), Eine kleine Nachtmusik (ilk 10 ölçü), Minuet in G,
  Mozart 40. Senfoni.
- Sakin eserler: Satie Gymnopédie No. 1, Brahms Ninnisi, Chopin Prelude No. 7, Bach Air.
- Film ve oyunlardan tanınan, telifsiz: The Entertainer (The Sting), Rondo alla Turca, Korobeiniki
  (Tetris'ten tanınan halk şarkısı), Shchedryk (çan şarkısı).
- Mutopia Project'in kamu malı (Public Domain) MIDI dosyalarından alınanlar: The Entertainer, Rondo
  alla Turca, Für Elise, dört sakin eser, Dağ Kralı'nın ikinci cümlesi ve Nachtmusik'in 5-10. ölçüleri.
  Her eserin kaynağı `songs.mjs` içindeki `source` alanında.
- Bu proje için yazılan özgün temalar: Keşif, Boss, Zafer.

Telifli oyun ve film müzikleri kütüphanede yok. Herkes kendi MIDI dosyasını ekleyebilir; şarkı yalnız
onun Mac'inde çalar, siteye gitmez:

```sh
python3 songbook.py tracks parca.mid                 # melodi hangi izde?
python3 songbook.py import parca.mid --name parcam --track 1 --bars 5-20
python3 songbook.py list
```

Melodi seçilen izin en üst sesi, akorlar diğer seslerden yarım ölçüde bir tahmin edilir; gerekirse
`--bars` ile bölüm seçilir. Stil ve şarkı menü çubuğundan çalarken değişir; seçim hatırlanır.
Komutla: `--style 8bit --song korobeiniki` (agents.py ya da control.py start).

**Ses bankası.** Varsayılan macOS'un General MIDI seti. Siteyle aynı tınıyı istersen bir SF2
(ör. FluidR3_GM.sf2) `--soundfont DOSYA` ile verilir ya da
`~/Library/Application Support/code-sonata/soundfont.sf2` olarak konur.

**Menü çubuğu:** `♫ 3` = 3 oturum çalıyor, `♪` bekliyor, `♪ sessiz`, `♪ kapalı`. Menüden
sesi kapat/aç, sonraki şarkı (akışta sonraki sahne), stil, şarkı (Akış dahil), melodi miktarı, ses seviyesi, müziği aç/kapat. Açma ya da kapatma başarısız olursa hata menüde
görünür.

**Sıfır token demo:** `python3 demo.py` sahte Claude oturumlarıyla orkestrayı çalar (model
çağrısı yok). `--sessions 3 --silent` ile sessiz deneme. Demo gerçek müziğin kaldığı yere ve menü
çubuğuna dokunmaz. Ses motorunu ölçmek için: `swift check_voices.swift`.

**Kaynak** (bu Mac, ~8.000 oturum kaydı, bir çekirdeğin yüzdesi olarak):

| Parça | Bellek | Boşta | Çalarken |
|---|---|---|---|
| Dinleyici (Python) | 21,5 MB | %0,1-0,5 | %0,7 |
| Ses motoru (Swift) | 26 MB | %0 (4 sn sessizlikte duraklar, 32 ms'de uyanır) | %5,5 (`--eco`: %3,7) |
| Menü çubuğu | 44 MB | %0,02 (müzik 2 dk kapalı kalınca kendini kapatır) | %0,02 |

Müzik hiç token harcamaz. Token yalnız skill çağrıldığında harcanır: yaklaşık 700 token (önceki
sürümde ~2.100), açıklama satırı her oturumda ~45 token. Her 2 sn yalnız klasörler kontrol edilir
(yeni kayıt klasörü değiştirir), bütün ağaç 30 sn'de bir taranır, yalnız son 15 dakikada yazılan
kayıtlar okunur. Uyuyan bir oturum (bir haftadan yeni) uyanınca kaldığı yerden okunur; geçmiş
tekrar çalmaz. `--eco` (pil tasarrufu) yankıyı kapatır.

Yalnızca adım türü (ve yukarıdaki evet-hayır kontrolleri) kullanılır; mesaj, kod ve araç girdisi tutulmaz.

## Klasör modu: tek projenin dosya kayıtlarını dinle

Finder'da `start.command` veya `watch.command` dosyasına çift tıkla ve proje klasörünü seç.
Açılan dinleme penceresi açık kalsın; Codex veya Claude ile alıştığın yerde çalış.
Terminalden klasörü doğrudan da verebilirsin:

```sh
./watch.command /tam/yol/projen
```

Proje terminalindeysen `<repo>/watch.command .` yeterlidir.
Göreli yollar komutu çalıştırdığın klasöre göre çözülür. `G` sesi açar/kapatır,
`Q` veya Ctrl+C dinlemeyi durdurur. Kod dosyalarına hiçbir şey yazılmaz.
Mevcut dosyalar ilk taramada sessizce öğrenilir; yalnızca sonraki değişiklikler çalar.

Varsayılan melodi **Bella Ciao** temasının sade piyano yorumudur. Diğer seçenekler yukarıdaki
eserler ve `--song original` (üretken melodi). `karisik` seçilirse her şarkı iki kez çalar, sonra
sıradakine geçilir. Tanıdık temalarda nota sırası korunur ve
sitedeki nota kâğıdı akorları kullanılır; kod değişimleri tempo ve eşliği etkiler.
Bunlar kendi sade eşliğimizle çalınan temalardır; dizi kaydı veya hazır ses dosyası
kullanılmaz. Bella Ciao geleneksel melodi kaynağı:
[8notes](https://www.8notes.com/scores/bella_ciao_trad_.asp).

Skill (`install.sh` bağlar): “Kod müziğini aç/kapat” isteklerini Terminal açtırmadan arka
planda yönetir. Kullanıcı oturumu kapanınca durur; bilgisayar açılışına kalıcı servis kurulmaz.

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
python3 watch.py /tam/yol/projen --silent --duration 10
```

## Önceki bağımsız editör

Bağımsız editörü ayrıca açmak için terminalde:

```sh
./start.command --editor
```

Var olan UTF-8 dosyanı açmak için `./start.command --editor dosya.py` kullan.
Dosya verilmezse yeni çalışma `sessions/` altında saklanır.
Ctrl+S kaydeder; Ctrl+Q veya Ctrl+C kaydedip çıkar; Ctrl+G sesi açar/kapatır;
Ctrl+Z son düzenlemeyi geri alır. Oklar, Home/End, silme ve otomatik girinti desteklenir.
Kaydetme başarısız olursa editör açık kalır. Beklenmedik kapanışta mümkünse ayrı
bir kurtarma dosyası yazılır; zorla süreç sonlandırmaya karşı otomatik kayıt yoktur.

## Klasör ve editör modunda müzik

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
python3 -m unittest -v          # node kuruluysa iki şefin eşitliği de sınanır
python3 sonata.py --silent
```

## Agent Orchestra: ortak salon

Kendi çalışma sesini keşfet, ortak orkestraya katıl, gerçek faaliyetlerinden PNG/WAV/sesli video oluştur. Kurulum ve testler [orchestra/README.md](orchestra/README.md), kendi sunucunda yayın [orchestra/docs/OPERATIONS.md](orchestra/docs/OPERATIONS.md) içinde. Site henüz herkese açık bir adreste çalışmıyor; yerelde ya da kendi sunucunda açabilirsin.

Siteye katılmak için repo gerekmez: site tek dosyalık okuyucuyu (`reader.py`, yalnız Python 3) kendisi verir. Yerel araçla birlikte katılmak için `python3 agents.py --global <URL>`. Her iki yolda da anonim kimlik ve faaliyet sayıları seçilen sunucuya gider; kod, prompt ve dosya yolu gitmez. Yerel izleme/editör modu ağa hiçbir şey göndermez.

## Katkı ve lisans

Katkı rehberi: [CONTRIBUTING.md](CONTRIBUTING.md). Kod MIT lisanslı ([LICENSE](LICENSE)); üçüncü taraf dosyaların lisansları İngilizce README'nin "Credits" bölümünde.
