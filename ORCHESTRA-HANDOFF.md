# Agent Orchestra — Selim'in geliştirme siparişi

Tarih: 2026-10-09. Bu dosya, önceki oturumda Selim ile kabul edilen ürün kararlarını yeni repo oturumuna aktarır. Henüz uygulanmış veya kullanıcılarla doğrulanmış özellikler olarak yorumlama.

## Başlangıç talimatı

`/gg tam` akışını bu repo için uygula. Önce AGENTS.md, CLAUDE.md, README.md, orchestra/README.md ve bu dosyayı oku. `/Users/selimcitil/.codex/skills/gg/SKILL.md` ve ilgili referansı ürün yönetimi çerçevesi olarak kullan.

Bu sipariş yerel geliştirmeye başlama talimatıdır. 60 ana döngü ve somut ihtiyaç varsa 20 ek döngü yürüt. İlk 10 döngüden sonra durma. Yaklaşık altı saatlik yoğun çalışma bütçesi hedefleniyor; süre doldurmak için bekleme veya gereksiz özellik üretme, kesintisiz saat/gün garantisi verme. Formal goal kullanıcı ayrıca başlattığında oluşturulur; bu belgeyi okumak tek başına goal aracı kullanma talimatı değildir.

Önce mevcut uygulamayı ve Git durumunu incele. Tamamlanmış işleri yeniden yapma. Mevcut kullanıcı değişikliklerini koru. Rutin, geri alınabilir geliştirme kararlarını özerk ver. Ara değerlendirmeler bitiş değildir; çalışmayı kayıtlarla sürdür.

## Ürün vizyonu

Ana ifade: **Bugünkü çalışmanın bir sesi var. Onu duy, başkalarınınkiyle birleştir.**

Ana yolculuk: **Kendi çalışma sesini keşfet → ortak orkestraya katıl → sana ait bir anı paylaş.**

Claude ve Codex oturumlarından gerçekten alınabilen faaliyetler kişisel ve ortak müziğe dönüşsün. Ürün, işin kalitesini veya kişinin üretkenliğini ölçtüğünü iddia etmesin. Faaliyetlerin müzikal temsili bir performans değerlendirmesi değildir.

Üç temel deneyim:

1. **Kendi çalışma sesim:** Kullanıcı tek başına da değer bulur; katkısını duyabilir ve görebilir.
2. **Ortak orkestra:** Başkalarıyla aynı anda ortak bir müziğe katılır; kendi katkısını bütün içinde fark eder.
3. **Paylaşılabilir çalışma anım:** Gerçek deneyiminden oluşan kısa ses/görsel çıktısını önizleyip paylaşabilir.

Ürün anlamlı olmak için sürekli çok sayıda eşzamanlı katılımcıya ihtiyaç duymasın. Boş/az katılımcılı deneyimi ve kaydedilmiş anların rolünü tasarla. Gerçek katılımcı, demo ve test verilerini açıkça ayır.

Öncelik: İyi müzik → kişisel katkının anlaşılması → kolay katılım → ortak varlık hissi → kişisel paylaşım çıktısı → tekrar gelme nedeni → DijitalPi bağlantısı.

## Kullanıcılar ve senaryolar

İlk hedef: Claude/Codex ile düzenli çalışan geliştiriciler ve yaratıcı teknoloji ekipleri. Önce küçük bir gruba değer sunmayı doğrula; büyük topluluk, dünya haritası, çok sayıda oda gibi özellikleri varsayılan olarak ekleme.

- Dinleyici: Sosyal paylaşımdan gelir, fikri anlar, oturum bağlamadan dinler.
- Katılımcı: Desteklenen oturumu bağlar, başarı durumunu ve ilk faaliyetini fark eder, kendi yerini bulur.
- Tek başına kullanım: Başka kimse yokken kendi çalışma sesinden değer bulur.
- Ortak kullanım: Katılım arttıkça ses, sahne ve performans bütünlüğünü korur.
- Paylaşım: Kişisel kısa çıktıyı oluşturur, önizler, görünür bilgisini kontrol eder ve isterse paylaşır.
- Paylaşımdan geliş: Yeni ziyaretçi çıktının bağlamını anlar ve ürüne kolayca ulaşır.
- Ticari muhatap: Etkinlik/hackathon/marka kampanyası/ekip deneyimi düzenleyicisi DijitalPi'nin katkısını ve iletişim yolunu bulur.

## DijitalPi ve pazarlama

Ürün değeri, marka değeri ve ticari talebi ayrı değerlendir. Kullanıcı ilgisi otomatik olarak müşteri veya gelir anlamına gelmez.

Ticari teklif hipotezi: **DijitalPi, markalar ve etkinlikler için katılımcıların birlikte oluşturduğu canlı dijital deneyimler tasarlar.**

İlk ticari değerlendirme: markaya özel kampanyalar, etkinlik ve hackathon deneyimleri, ekip orkestraları. Abonelik, ödeme sistemi ve kapsamlı ekip yönetimini doğrulanmış ihtiyaç olmadan geliştirme.

Üründe ve paylaşım çıktılarında ölçülü DijitalPi imzası; proje hikâyesi ve doğrulanmış iletişim yolu olsun. Twitter/X için merak, kısa gösterim, kişisel çıktı ve davet; LinkedIn için fikir, uygulama becerisi ve işletmelere kullanım olasılıkları öne çıksın.

İlk lansmanı planlı bir canlı buluşma olarak değerlendir: belirli zamanda birlikte çalışıp dinleme. Katılım azsa uygulanacak açık alternatifi belirle. Sahte kalabalık veya kullanıcı sayısı üretme.

Başlangıç metin yönleri (uygulama gerçekten desteklediğinde kullan):

- Bugünkü çalışmanın bir sesi var.
- Çalışma sesini keşfet.
- Orkestrayı dinle.
- Orkestraya katıl.
- Bu anı paylaş.
- DijitalPi tarafından geliştirildi.
- Markanız veya etkinliğiniz için birlikte bir deneyim tasarlayalım.

## 200 kişilik uzmanlık modeli

Selim, ürünü 200 kişilik yazılım/tasarım/grafik/marketing ekibine brief veren ürün yöneticisi titizliğiyle ele almak istiyor. Bu gerçek çalışan veya ajan sayısı değildir; kendiliğinden subagent başlatma talimatı değildir. Mevcut proje belgelerindeki ajan/test kurallarını koru.

| Uzmanlık | Temsili kişi | Sorumluluk |
|---|---:|---|
| Ürün | 10 | Kapsam, öncelik, kararlar ve bütünsel teslim |
| Araştırma | 12 | İhtiyaç, anlaşılabilirlik, kullanılabilirlik ve varsayımlar |
| UX/UI | 22 | Yolculuklar, kontroller, tüm durumlar ve cihazlar |
| Grafik/hareket | 18 | Özgün kimlik, ortak sahne ve paylaşım görselleri |
| Frontend | 30 | Arayüz, bağlantı durumları, ses kontrolü ve paylaşım |
| Backend/entegrasyon | 28 | Olay modeli, bağlantı protokolü ve oturum yaşam döngüsü |
| Ses/müzik | 20 | Ses paleti, armoni/ritim, yoğunluk ve geçişler |
| Kalite/erişilebilirlik | 18 | Kritik akışlar, regresyon ve erişilebilirlik |
| Altyapı/güvenlik | 12 | Kurulum, kapasite, veri, maliyet ve geri alma |
| Marketing/marka | 20 | Konumlandırma, metinler, lansman ve ticari geçiş |
| Analitik | 10 | Sınırlı veriyle karar verecek ölçümler |
| Toplam | 200 | Temsili organizasyon |

Her ilgili uzmanlık için amaç, girdiler, teslimler, bağımlılıklar ve gözlemlenebilir kabul koşulları yaz. Tek başına güzel ekran, sağlam kod veya iyi tanıtım yeterli değildir; birlikte tutarlı deneyim oluşturmalıdır.

Her önemli özellik için kullanıcı/ihtiyaç, giriş, başarı çıktısı, boş-bekleme-hata-izin-iptal durumları, veri sözleşmesi, cihaz/erişilebilirlik, mahremiyet, ölçüm, bağımlılık ve kabul koşulu tanımla. Bir paylaşım düğmesi tüm paylaşım deneyiminin tamamlandığı anlamına gelmez.

## Döngülerin çalışma kuralı

Döngü = anlamlı bir ürün sorusu + uygulama/değerlendirme + uygun doğrulama + kaydedilen karar. Dosya değişikliği veya test komutu tek başına döngü değildir. Zaten yeterli davranışı doğrulayabilirsin; sayı doldurmak için değiştirme.

Her 10 döngüde devam/düzelt/yeniden tasarla/dış bağımlılık kararı ver. İlk 10 kontrol noktasıdır; nihai bitiş değildir. Sonraki sıralamayı kanıta göre güncelle. Gerçek kullanıcı geri bildirimi yoksa bunu açıkça belirt; teknik test veya kendi incelemeni kullanıcı araştırması gibi sunma.

## 60 ana döngü

### 01–10: İlk gösterilebilir deneyim

1. Belgeler, mimari, Git ve mevcut durum.
2. Çalışan kullanıcı yolculukları ve sürtünmeler.
3. Kapsam ve ana ürün anlatımı.
4. Veri kapsamı ve bağlantı sınırları.
5. Görsel yön ve tasarım kuralları.
6. Açılış ve ilk dinleme.
7. İlk ses ve temel kontroller.
8. Kurulumsuz keşif ve demo ayrımı.
9. Kişisel katkının ilk gösterimi.
10. İlk sürümün bütünsel doğrulaması ve yeniden önceliklendirme.

Çıktı: Anlaşılabilir, dinlenebilir ve kişisel katkıyı açıklayan ilk deneyim.

### 11–20: Kişisel değer

11. Resmî bağlantı yöntemlerini doğrula.
12. Bağlanma adımlarını sadeleştir.
13. Bağlantı/olay bekleme durumları.
14. Gerçek bağlantı hataları ve çözüm adımları.
15. Tek başına dinleme.
16. Faaliyet-ses ilişkisi.
17. Kendi katılımcı kimliğini bulma.
18. Kendi katkısını ayırt etme.
19. Ayrılma ve yeniden bağlanma.
20. Kişisel değeri değerlendir.

Çıktı: Başka katılımcı yokken de anlamlı kullanım.

### 21–30: Ortak orkestra

21. Ses paleti ve kalite.
22. Armoni/ritim kuralları.
23. Az katılımcılı deneyim.
24. Yoğun katılımda ses yönetimi.
25. Sessizlik ve geçişler.
26. Ses-görüntü ilişkisi.
27. Ortak sahne ve gerçek varlık hissi.
28. Katılım anı.
29. Uzun dinleme ve yoruculuk.
30. Boş/sakin/yoğun orkestrayı değerlendir.

Çıktı: Farklı katılım düzeylerinde bütünlüğünü koruyan müzik ve sahne.

### 31–40: Paylaşılabilir an

31. Paylaşım ihtiyacı ve çıktı briefi.
32. Kayıt/yeniden üretim yönteminin seçimi.
33. Gerçek faaliyetlerden kişisel bölüm.
34. Paylaşım görseli.
35. Uygulanabilir sesli kısa çıktı/video ve cihaz alternatifi.
36. Önizleme ve görünür bilgi kontrolü.
37. Ortak an kaydı, izinler ve saklama davranışı.
38. Bağlantı önizlemesi ve ziyaretçi devamı.
39. Davet akışı.
40. Paylaşımın uçtan uca değerlendirmesi.

Çıktı: Oluşturulabilir, önizlenebilir ve paylaşılabilir gerçek deneyim.

### 41–50: Marka ve lansman

41. DijitalPi imzası.
42. Proje hikâyesi.
43. İşletmelere yönelik teklif.
44. Doğrulanmış iletişim yolu.
45. Twitter/X içerikleri.
46. LinkedIn içerikleri.
47. Demo/video senaryoları ve uygulanabilir çıktılar.
48. Planlı canlı buluşma.
49. Kullanıcı ve ticari araştırma hazırlığı.
50. Lansman akışının değerlendirmesi.

Çıktı: Ürünle uyumlu tanıtım paketi ve uygulanabilir buluşma planı.

### 51–60: Güvenilirlik ve teslim

51. Başarı ölçümleri.
52. Veri minimizasyonuyla ölçüm uygulaması.
53. Mobil doğrulama.
54. Erişilebilirlik.
55. Performans/kapasite ve ölçülen sınırlar.
56. Kesinti ve toparlanma.
57. Güvenlik/mahremiyet.
58. Maliyet varsayımları, kurulum ve yayın hazırlığı.
59. Son bütünsel doğrulama ve kusur düzeltme.
60. Teslim, kanıtlar ve sonraki kararlar.

Çıktı: Belgelenmiş, doğrulanmış uygulama ve açık yayın hazırlığı.

### 61–80: Gerekçeli ek bütçe

Kullanıcı anlayışı, bağlantı, müzik, kişisel katkı, kayıt/paylaşım, mobil, kapasite, güvenlik ve gerçek geri bildirim sorunlarına ayır. Her ek döngünün gerekçesini yaz. Kullanılmayan bütçeyi açıkça belirt.

## Araştırma ve ölçüm

Sorular: Kullanıcı ürünü nasıl anlatıyor? Dinleyebiliyor ve bağlanabiliyor mu? Katıldığında ne değiştiğini fark ediyor mu? Kendi çıktısını kiminle neden paylaşır? Yeniden gelmesi için ne gerekir?

Ölçümler: İlk dinleme, başarılı bağlantı, kişisel çıktı üretimi, davetle geliş, tekrar ziyaret, DijitalPi'ye geçiş, ilgili iş talebi. Bunları ayrı değerlendir; gereksiz kişisel veri toplama.

## Doğrulama, yetki ve bitiş

- Önemli arayüz değişikliklerini çalışan tarayıcıda doğrula.
- Sesin teknik ölçümünü gerçek dinleme değerlendirmesinden ayır. Dinlemediğin sesi dinlediğini söyleme.
- Olaylardan prompt, kaynak kod, dosya yolu ve hassas bilgiyi gereksiz biçimde aktarma.
- Kişisel/ortak/paylaşım akışlarının boş, hata ve kesinti durumlarını ele al.
- İlgili testleri tamamla; kritik kusurları gider.
- Ücretli hizmet, herkese açık yayın, dış hesaplardan paylaşım ve dış kişilere mesaj için önce somut sonucu hazırla ve gerekli onayı iste. Mevcut açık yetki varsa koru. Bu sipariş commit/push veya KK talebi değildir.
- Engellenen işleri tamamlandı sayma; yapılabilir bağımsız işlere devam et.
- Kesintisiz çalışma için garanti verme; kalıcı kayıtlarla devamlılık sağla.

Proje düzenine uygun brief, plan, karar, doğrulama ve bağımlılık kayıtları oluştur. Her döngüde başlangıç kanıtı/varsayımı, değişiklik, doğrulama ve karar yaz. Bağlam yenilendiğinde bu kayıtlardan devam et.

Nihai teslim: çalışan uygulama; kişisel/ortak/paylaşım deneyimleri; güncel belgeler; döngü/karar kayıtları; doğrulama ve sınırlar; DijitalPi hikâyesi/iletişim yolu; sosyal metin/görseller; demo/buluşma planı; ölçüm/araştırma planı; işletme ve yayın hazırlığı.

Başarı: Kullanıcı anlıyor, dinlemekten keyif alıyor, katkısını fark ediyor ve paylaşabiliyor. DijitalPi'nin üretici olduğu ve işletmenin nasıl iletişime geçeceği belli. Gerçek geri dönüş, yayılma veya ticari talep yoksa bunları başarı olarak raporlama.

**İlk 10 döngüde veya ilk demo sonunda durma. Nihai kapsamın uygulanabilir işleri ve doğrulamaları tamamlanana kadar devam et. Dış bağımlılıkları açıkça raporla.**
