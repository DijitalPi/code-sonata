# Agent Orchestra — uygulama briefi

2026-10-09 · Kaynak: ORCHESTRA-HANDOFF.md. Yerel uygulama; gerçek kullanıcı araştırması henüz yok.

## Ürün ve kapsam

Claude/Codex ile çalışan geliştirici kendi faaliyetinin sesini keşfeder, ortak müziğe katılır ve kendine ait gerçek bir anı indirir. Adım sayısı üretkenlik veya iş kalitesi puanı değildir. İlk değer: kurulumsuz örneği dinleyip faaliyet/ses ilişkisini anlamak. Kişisel değer: kendi anonim bağlantısını doğrulamak ve yalnız katkısının motifini dinlemek. Ortak değer: aynı saatle düzenlenen müzik ve kendi koltuğunu bulmak. Paylaşım: gerçek katkıdan yerelde oluşturulan PNG ve WAV; desteklenen tarayıcıda sesli video. Önizleme ve silme kullanıcı kontrolündedir.

Mevcut Node/SSE ve Python oturum okuyucusu korunur. Yeni hesap, ödeme, oda, dünya haritası veya ücretli bağımlılık yok. Demo ortak katılımcı sayısını yükseltmez. Yerel sunucu varsayılan olarak localhost'a bağlanır. Yayın/harici paylaşım/ücretli işlem/commit/push yetkisi verilmedi.

## Görsel ve etkileşim kararı

Frontend-design modu: immersive; ikincil editorial. Görsel tez: sıcak siyah bir konser salonu, altın nota çizgileri ve okunabilir Türkçe yönlendirme. Sahne dekor değil gerçek katılımı gösterir. Açık ilk eylem, sonra keşfet → bağlan → anını oluştur sırası. Ekran akışkan, sayfa kaydırılabilir; ses ve hareket daima kontrol edilebilir.

## Uzmanlık sözleşmeleri

| Alan | Amaç / girdiler | Teslim / bağımlılık | Gözlenebilir kabul |
|---|---|---|---|
| Ürün (10) | Handoff ve mevcut yolları tutarlı kıl | Bu brief, 60 döngü kaydı; bütün alanlar | Üç deneyimin başarısı ve sınırları ayrı |
| Araştırma (12) | Anlayış/paylaşım ihtiyacı hipotezleri | Görüşme ve görev planı; çalışan ürün | Gerçek araştırma yapılmış gibi rapor yok |
| UX/UI (22) | İlk dinleme ve bağlantı belirsizliğini çöz | Eylem sırası, hata/boş/kesinti durumları; veri sözleşmesi | Klavye ve mobilde görevler yapılabilir |
| Grafik/hareket (18) | Sahne ve kişisel çıktıyı anlamlı yap | Koltuk vurgusu, yerel PNG; gerçek katkı | Demo ve gerçek an ayrı etiketli, azaltılmış hareket |
| Frontend (30) | Dinleme, kimlik ve kayıt kontrolü | Ses kontrolü, kurulum, önizleme; SSE | Başarı ancak veri geldiğinde, temiz iptal |
| Backend (28) | Kişisel bağlantıyı güvenle tanı | Anonim eşleştirme, özel durum, sınırlı olay; Python | Kimlik genel SSE'ye sızmaz, yanlış anahtar erişemez |
| Ses (20) | Solo/ortak müzikal bütünlük | Ortak motor korunur; kişisel motif ve kayıt | Nota/süre/gain sınırları ve teknik ölçüm; dinleme onayı ayrı |
| QA/a11y (18) | Kritik yolların regresyonunu önle | API/müzik testleri, tarayıcı kanıtları | Dar ekran, klavye, hata ve toparlanma kaydı |
| Altyapı (12) | Veri/maliyet/yayın sınırlarını koru | Yerel bağlanma, operasyon ve geri alma; API | Genel yayın yapılmaz, hassas içerik saklanmaz |
| Marka (20) | Ürünü doğru anlat, ticari hipotezi ayır | DijitalPi hikâyesi, sosyal taslak, buluşma planı | Doğrulanmış iletişim bağlantısı; talep iddiası yok |
| Analitik (10) | İlk değer ile iş talebini ayır | Yerel isteğe bağlı sayaçlar; UX | Kişisel olaylar sunucuya izinsiz gönderilmez |

## Özellik sözleşmeleri

| Yol | Giriş ve başarı | Durumlar / veri / kabul |
|---|---|---|
| Dinle | Açık ses eylemi → ortak notalar | Sessiz başlangıç, yüklenme, örnek bağımlılığı hatası, tekrar dene, durdur, ses seviyesi; SSE içeriksiz nota tuple'ları; mobilde ulaşılır |
| Keşfet | Yerel örnek → faaliyet motifleri | Demo etiketi ve gerçek sayaçlardan ayrım; iptal/durdur; ağ POST'u yok |
| Katıl | Tek kullanımlık özel eşleştirme anahtarı → Python komutu → gerçek heartbeat | Bekliyor, bağlı ama faaliyet yok, aktif, kesik, ayrılmış; anahtar fragment/POST gövdesinde, genel koltuklarda yok; prompt/kod/yol iletilmez |
| Kendimi duy | Özel gerçek faaliyet sayıları → kendi motifim | Hiç faaliyet yoksa açıklama, yalnız/ortak geçiş; motif yorumdur; koltuk metinsel ve görsel |
| Anı | Gerçek sayılar → kullanıcı kontrollü PNG/WAV/video önizleme | Boş an engelli, üretim/hata/iptal/silme; görünür bilgi seçimi; yalnız yerel bellek ve indirme; ortak kayıt anonim müzik olarak ayrı etiketli |
| Davet | Bağlantıyı kopyala → aynı sayfaya geliş | Eşleştirme sırrı çıkarılır; yerel URL yayın sanılmaz; kopyalama hatasında seçilebilir metin |
| DijitalPi | Hikâye → doğrulanmış resmi iletişim sayfası | İşletme önerisi hipotez; dış mesaj gönderilmez; ücretli hizmet yok |

## Hipotez ve doğrulama

Kullanıcı müziği keyifli bulur ve kendi anını paylaşmak ister: henüz kanıt yok; 5 geliştiriciye görev temelli görüşme gerekir. Yanlışsa paylaşım kapsamı daralır. Teknik testler bu hipotezleri doğrulamaz. Destek: mevcut macOS yerel okuyucu; tarayıcı dinleyici farklı cihazlarda. Resmî ürün API'leri hakkında yeni iddia yerine mevcut kayıt biçimleri ve parser testleri doğrulanır.

## Plan ve nihai hedef

Handoff'un 01–60 sorularını altı aşamada yürüt. Her kayıt başlangıç kanıtı, uygulama/değerlendirme, doğrulama ve karar içerir. Her onlu aşama kontrol noktasıdır. 61–80 yalnız ortaya çıkan somut kusur için. Yaklaşık altı saat yoğun çalışma bütçesi; bekleyerek doldurma yok.

Hedef: mevcut kullanıcı değişikliklerini koruyarak üç deneyimi yerelde çalıştır, güvenlik/erişilebilirlik/kapasite kanıtlarını ve marka/lansman/araştırma/operasyon teslimlerini repoya kaydet. Gerçek kullanıcı, işitsel kalite ve genel yayın bağımlılıklarını açık tut. İlk demo sonunda durma; uygulanabilir iş ve kritik düzeltmeler tamamlanınca teslim et. Formal goal oluşturma.

## Tasarım briefi · 2026-10-10 (Selim: "daha iyisini, daha tarzını yap", /gg tam)

Görsel tez: gece konser salonu + basılı konser programı. Sahne ışıkla, sütun matbaa düzeniyle konuşur. Akılda kalacak tek şey: salonun altında akan **canlı nota şeridi**; herkesin ajan adımı gerçek zamanlı nota kâğıdına düşer (sunucudan gelen gerçek notalar, süs değil).

| Alan | Karar | Kabul |
|---|---|---|
| Tipografi | Fraunces (başlık, eğik vurgu) + Instrument Sans (arayüz), ikisi de siteye gömülü, OFL | Dış font isteği yok, Türkçe karakterler doğru |
| Sahne | Işık durumları: sakin / çalıyor / doruk; boş sandalyeler ve basamaklar | Boş salon ilk bakışta "salon" okunur |
| Seyirci | Çizgi film maskotları yerine parter: dinleyiciler takım bloklarında koltuk noktaları | Kendi yerin işaretli, sayılar okunur |
| Nota şeridi | 5 çizgili porte, notalar sağdan sola akar, bölüm rengiyle | Ses kapalıyken de akar; azaltılmış harekette durur |
| Program | İşler konser programı gibi numaralı (I, II, III), başlık = yapılan iş | Net dil; slogan yok, uzun tire yok |

Sınırlar: işlev ve öğe kimlikleri değişmez; içerik hareketi ≤0,35 sn; transform/opacity; :active + :focus-visible. Gerçek kullanıcı beğenisi ölçülmedi, Selim'in gözü kabul ölçütüdür.

Döngü planı (ek bütçe 64–71): 64 tipografi · 65 nota şeridi · 66 seyirci parteri · 67 sahne ışık durumları · 68 program sütunu · 69 mobil/erişilebilirlik/azaltılmış hareket · 70 bütünsel tarayıcı kontrolü ve düzeltme · 71 teslim.
