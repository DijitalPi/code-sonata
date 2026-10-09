# Araştırma ve ölçüm planı

Teknik testler kullanıcı araştırması değildir. Şu anda gerçek kullanıcı görüşmesi, müzik beğenisi, viral yayılma veya ilgili iş talebi kanıtı yok.

## Görev temelli araştırma

5 düzenli Claude/Codex geliştiricisi; mümkünse 2 kişi yalnız dinleyici, 3 kişi macOS ile katılımcı. Sadece gönüllü katılım; oturum/prompt/kod kaydı isteme. Araştırmacı olay zamanını ve başarı/başarısızlığı not eder; kullanıcı kimliği gerekmiyor. Görüşme notları varsayılan anonim, 30 gün sonra silme önerisi; gerçek veri toplanınca kullanıcıyla süre belirlenir.

1. Sayfayı gör ve kendi sözlerinle anlat. Beklenen: çalışma faaliyetleri ortak müziğe dönüşüyor; üretkenlik puanı değil. Yanlış anlayış → açılış metnini düzelt.
2. Kurmadan dinle, ses seviyesini değiştir ve durdur. Beklenen: kullanıcı kontrolü; süre not edilir, yapay süre hedefi benchmark diye sunulmaz.
3. Ajanını bağla ve ilk faaliyeti bul. Beklenen: komut → bağlı → faaliyet; hassas bilgi gönderildiği korkusu/gerçek hata sorulur.
4. Kendi koltuğunu ve sesini ortak deneyimden ayır. Beklenen: kişisel motifin yorum olduğunu anlar; takım seçimini makine bağlantısı sanmaz.
5. An oluştur, sayı görünürlüğünü kapat, dinle ve indir. “Kiminle, neden paylaşırdın?” gerçek cevap kaydedilir; indirmenin paylaşım olduğu varsayılmaz.
6. Telefon/dar ekran ve kesintiden dönüş görevi. Beklenen: görünür kontroller ve gerçek hata metni.
7. 20–30 dakika işitsel oturum: tını yorgunluğu, tempo geçişi, sessizlik, düşük/yüksek yoğunluk. Ses duyulmuş kabulünü gerçek dinleme notu olmadan kapatma.
8. Ertesi gün neden geri geleceğini sor. İki gün sonra izin verilmişse bir kez tekrar kullanım görüşmesi; dış mesaj için ayrı yetki gerekir.

Kabul hipotezi (ölçülmüş hedef değil): 5 kişiden en az4'ü ürünü doğru anlatır ve kurmadan dinleyebilir; en az3 katılımcı kendi katkısını bulur. Paylaşma ve keyif için eşik yerine gerçek gerekçeleri öğren. Yanlışsa ek özellik yerine anlaşılabilirliği/kurulumu/müziği düzelt.

## Ticari araştırma

3 etkinlik/hackathon/ekip düzenleyicisiyle ayrı görüşme: ihtiyaç, katılım ortamı, mahremiyet beklentisi, markalı deneyim değeri, bütçe sahibi, satın alma süreci. Gerçek talep olmadan fiyat/abonelik/ödeme/ekip yönetimi geliştirme. Teknik ürünü beğenmek ile satın alma niyeti farklıdır.

## Veri minimizasyonlu ölçüm

Uygulamada opt-in yerel sayaçlar: visit, return, listen, connection, moment, video, invite, invited, brand. Checkbox varsayılan kapalı; izin ve sayılar yalnız localStorage. Sayıları sil düğmesi var. Ağ analitik endpoint'i, cookie kimliği, session replay veya üçüncü taraf analitik script'i yok. Çoğalan tıklamalar kullanıcı sayısı değildir; connection geçişi reconnect dahil teknik olaydır. İzin veren tek cihazdaki sayılar toplam pazar dönüşümü sayılmaz.

İlgili iş talebi ürün tarafından otomatik sayılmaz; resmî iletişim kanalından gönüllü gelen talebin gerçekten konuyla ilgili olduğu insan tarafından değerlendirilir. Site linkine tıklamak talep değildir.

İlk dinleme = başarılı ses başlatma (gerçek sesin duyulduğunun kanıtı değil). Bağlantı = özel me connected geçişi. An = gerçek kaynakla PNG/WAV üretimi; paylaşım değil. Davet = gizli bilgisi temizlenmiş URL kopyası. Davetle geliş = from=invite, izinli cihazda yerel sayaç. Tekrar ziyaret = aynı cihazda izinli ziyaret sayacı; kişi kimliği yok.

## Araştırma sonrası karar şablonu

Soru → anonim gözlem → teknik veya kullanıcı kanıtı → kabul/yeniden tasarla → ürün/marka/ticari etkisi → sonraki tek iş. Yanıtları WORK-LOG ek döngülerine bağla. Bekleyen gerçek görüşmeleri bu geliştirme oturumunda yapılmış sayma.
