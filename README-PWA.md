# Android Tablet'te PWA Olarak Kullanım

## 📱 PWA Nedir?

PWA (Progressive Web App), uygulamanızı Android tablette **normal bir uygulama gibi** kullanmanızı sağlar. Bilgisayar sunucusu **GEREKMEZ**!

## ✅ Avantajlar

- ✅ **Bilgisayar gerekmez** - Tablet doğrudan çalıştırır
- ✅ **Offline çalışır** - İnternet olmadan da kullanılabilir
- ✅ **Ana ekrana eklenebilir** - Normal uygulama gibi görünür
- ✅ **Hızlı** - Cache sayesinde çabuk açılır

## 🚀 Kurulum Adımları

### 1. Dosyaları Tablete Aktarın

Uygulamanızı tablette kullanmak için dosyaları tablete aktarmanız gerekir. Birkaç yöntem:

**Yöntem A: USB ile**
- Bilgisayarınızdan tablete USB ile bağlayın
- Tüm dosyaları (index.html, app.js, database.js, styles.css, manifest.json, service-worker.js) tablete kopyalayın

**Yöntem B: Google Drive/Dropbox ile**
- Dosyaları bir klasöre koyun
- Google Drive veya Dropbox'a yükleyin
- Tablette indirin

**Yöntem C: Email ile**
- Dosyaları zip yapın
- Kendinize email atın
- Tablette açın

### 2. Tablette Dosyaları Açın

**Dosya Yöneticisi ile:**
1. Dosya yöneticisini açın (Google Files, ES File Explorer vb.)
2. Dosyaların bulunduğu klasöre gidin
3. `index.html` dosyasına dokunun
4. "Tarayıcı ile aç" seçeneğini seçin (Chrome önerilir)

### 3. Ana Ekrana Ekleme

1. Tarayıcıda uygulama açıkken, menü (⋮) butonuna basın
2. **"Ana ekrana ekle"** veya **"Add to Home screen"** seçeneğini bulun
3. Onaylayın
4. Artık normal bir uygulama gibi kullanabilirsiniz!

## 📝 Notlar

- İlk açılışta internet gerekebilir (Chart.js CDN'den yüklenir)
- Veriler IndexedDB'de saklanır (tabletin tarayıcısında)
- Tüm özellikler offline çalışır

## 🎨 İkon Ekleme (Opsiyonel)

İsterseniz daha sonra icon ekleyebilirsiniz:
1. 192x192 ve 512x512 piksel boyutlarında PNG iconlar oluşturun
2. `icon-192.png` ve `icon-512.png` olarak kaydedin
3. `manifest.json` dosyasına icon satırlarını ekleyin

## ⚠️ Önemli

- Uygulama sadece tarayıcıda çalışır (Chrome/Edge önerilir)
- Dosyalar tablette kalıcı olarak durmalı (silmeyin)
- Veriler tabletin tarayıcısında saklanır