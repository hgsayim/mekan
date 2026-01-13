# Termux Kurulum Rehberi - Adım Adım

## 🔍 ÖNEMLİ: Dosyalarınızı Bulun

Termux'ta önce dosyalarınızın nerede olduğunu bulun:

### 1. Storage İzni Verin
```bash
termux-setup-storage
```
"İzin Ver" deyin.

### 2. Dosyalarınızı Bulun

Dosyalarınız muhtemelen şu klasörlerden birinde:
```bash
# Download klasörünü kontrol edin
ls /sdcard/Download/

# Documents klasörünü kontrol edin  
ls /sdcard/Documents/

# veya tüm klasörleri görün
cd /sdcard
ls
```

### 3. MekanApp Dosyalarınızı Bulun

Dosyalarınızı tablete nasıl aktardınız?
- **USB ile kopyaladıysanız:** `/sdcard/Download/` veya `/sdcard/Documents/` altında olabilir
- **Email ile indirdiysanız:** `/sdcard/Download/` altında olabilir
- **Google Drive'dan indirdiysanız:** `/sdcard/Download/` veya `/sdcard/Google Drive/` altında olabilir

### 4. Dosyaları Kontrol Edin

Bulguları klasöre girdikten sonra:
```bash
cd /sdcard/Download/MekanApp  # Bulduğunuz klasör yolu
ls -la
```

Şu dosyalar olmalı:
- index.html
- app.js
- database.js
- styles.css
- manifest.json
- service-worker.js

### 5. Eğer Dosyalar Yoksa

Dosyaları bilgisayarınızdan tablete aktarın:
- **USB ile:** USB kablosuyla bağlayın ve kopyalayın
- **Google Drive/Dropbox ile:** Drive'a yükleyin, tablette indirin
- **Email ile:** Kendinize email atın, tablette açın

### 6. Sunucuyu Başlatın

Dosyaların bulunduğu klasörde:
```bash
cd /sdcard/Download/MekanApp  # Kendi yolunuzu yazın
python -m http.server 8000
```

### 7. Tarayıcıda Açın

Chrome'da:
```
http://localhost:8000
```

## ⚠️ Yaygın Hatalar

### "ls: 0" Hatası
- Yanlış klasördesiniz
- `cd` ile doğru klasöre gidin
- `pwd` komutuyla şu anki klasörü görün

### 404 Hatası Devam Ediyor
- Dosyalar klasörde değil
- Dosya isimleri yanlış (index.html, app.js vb. olmalı)
- `ls -la` ile kontrol edin

### Python Bulunamıyor
```bash
pkg install python
```

### Storage İzni Yok
```bash
termux-setup-storage
```
