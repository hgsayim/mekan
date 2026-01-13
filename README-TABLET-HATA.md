# Tablet'te Çalışmama Sorunu - Çözümler

## 🔴 Sorun: Hiçbir şey çalışmıyor

Uygulama tablette açılıyor ama işlevler çalışmıyor mu? İşte çözümler:

## ✅ Çözüm 1: Tarayıcı Console'unu Kontrol Edin

1. Tablette Chrome'da uygulamayı açın
2. **Menü (⋮)** → **"Geliştirici araçları"** veya **"Developer tools"** açın
3. **Console** sekmesine bakın
4. Kırmızı hata mesajları varsa bize gönderin

## ✅ Çözüm 2: HTTPS Sunucusu Kullanın (Önerilen)

Tablette basit bir HTTP sunucusu çalıştırın:

### Termux ile (Android 7+)

1. **Termux** uygulamasını Google Play'den yükleyin
2. Termux'ta şu komutları çalıştırın:
   ```bash
   pkg update
   pkg install python
   cd /sdcard/Download/MekanApp  # Dosyalarınızın olduğu klasör
   python -m http.server 8000
   ```
3. Tarayıcıda açın: `http://localhost:8000`

### Alternatif: HTTP Server Uygulaması

Google Play'den **"HTTP Server"** veya **"Simple HTTP Server"** uygulamalarını yükleyin ve dosyalarınızı sunun.

## ✅ Çözüm 3: Bilgisayar Sunucusu (Basit)

En kolay yol - Bilgisayarınızda sunucu çalıştırın:

1. `start-server.bat` dosyasını çalıştırın
2. Bilgisayarınızın IP adresini öğrenin (komut penceresinde gösterilir)
3. Tablet ve bilgisayar AYNI Wi-Fi'de olmalı
4. Tablette tarayıcıda açın: `http://[BİLGİSAYAR-IP]:8000`

## 📝 Notlar

- **Service Worker** sadece HTTP/HTTPS protokolünde çalışır
- **file://** protokolünde Service Worker çalışmaz ama uygulama çalışmalı
- **IndexedDB** file:// protokolünde çalışır
- Eğer hiçbir şey çalışmıyorsa, muhtemelen JavaScript hatası var

## 🆘 Hala Çalışmıyorsa

Console'daki hata mesajlarını kontrol edin ve bize gönderin.