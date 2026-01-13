# Termux ile Android Tablet'te Çalıştırma

## 📱 Kurulum Adımları

### 1. Termux'u Yükleyin
Google Play Store'dan **Termux** uygulamasını yükleyin.

### 2. Python HTTP Server'ı Yükleyin

Termux'ta şu komutları çalıştırın:

```bash
# Paket listesini güncelle
pkg update

# Python'u yükle
pkg install python

# Storage izni ver (dosyalarınıza erişim için)
termux-setup-storage
```

### 3. Dosyaları Hazırlayın

MekanApp dosyalarınızı tablette bir klasöre koyun. Örneğin:
- `/sdcard/Download/MekanApp/`
- veya `/sdcard/Documents/MekanApp/`

**Önemli:** Tüm dosyalar bir klasörde olmalı:
- `index.html`
- `app.js`
- `database.js`
- `styles.css`
- `manifest.json`
- `service-worker.js`

### 4. Sunucuyu Başlatın

Termux'ta:

```bash
# Dosyalarınızın olduğu klasöre gidin
cd /sdcard/Download/MekanApp

# Sunucuyu başlatın (port 8000)
python -m http.server 8000
```

**Not:** `/sdcard/Download/MekanApp` yerine kendi klasör yolunuzu yazın.

### 5. Tarayıcıda Açın

Tabletin tarayıcısında (Chrome önerilir) şu adresi açın:

```
http://localhost:8000
```

veya tabletin IP adresini kullanarak başka cihazlardan da erişebilirsiniz:

```
http://[TABLET-IP]:8000
```

Tabletin IP adresini öğrenmek için Termux'ta:
```bash
ifconfig | grep "inet "
```

## ✅ Çalışıyor mu Kontrol Edin

1. Tarayıcıda `http://localhost:8000` açıldığında uygulama görünmeli
2. Console'da (F12 veya Developer Tools) hata olmamalı
3. Service Worker kayıtlı olmalı (Console'da "ServiceWorker registration successful" görünmeli)

## 🔧 Sorun Giderme

### 404 Hatası
- Dosyaların doğru klasörde olduğundan emin olun
- `cd` komutuyla klasöre girdiğinizden emin olun
- Tüm dosyaların adlarının doğru olduğunu kontrol edin

### Port Zaten Kullanılıyor
Farklı bir port kullanın:
```bash
python -m http.server 8080
```
Sonra tarayıcıda: `http://localhost:8080`

### Dosyalar Bulunamıyor
Termux'ta dosya yolu kontrolü:
```bash
ls -la  # Mevcut klasördeki dosyaları listeler
pwd     # Şu anki klasör yolunu gösterir
```

### Storage İzni Sorunu
```bash
termux-setup-storage
```
komutunu çalıştırın ve izin verin.

## 📝 Notlar

- Sunucu çalışırken Termux'u kapatmayın (arka planda çalışabilir)
- Sunucuyu durdurmak için `Ctrl+C` basın
- Uygulama verileri tabletin tarayıcısında (IndexedDB) saklanır
- İnternet bağlantısı olmadan da çalışır (ilk yükleme sonrası)