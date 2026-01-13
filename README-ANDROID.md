# Android Tablet'te MekanApp Kullanımı

## Hızlı Başlangıç

### Yöntem 1: Python ile (Önerilen)

1. `start-server.bat` dosyasını çift tıklayın
2. Komut penceresinde görünen IP adresini not edin
3. Android tablette tarayıcıyı açın
4. Adres çubuğuna yazın: `http://[IP-ADRESINIZ]:8000`

**Örnek:** `http://192.168.1.100:8000`

### Yöntem 2: Node.js ile

1. Node.js yüklü olmalı (https://nodejs.org)
2. `start-server-node.bat` dosyasını çift tıklayın
3. Android tablette tarayıcıyı açın
4. Adres çubuğuna yazın: `http://[IP-ADRESINIZ]:8000`

### Yöntem 3: Manuel Python Komutu

Eğer script çalışmazsa, proje klasöründe PowerShell veya CMD açın ve:

```bash
python -m http.server 8000
```

## Önemli Notlar

⚠️ **Bilgisayar ve tablet AYNI Wi-Fi ağında olmalı!**

⚠️ **Güvenlik duvarı izin vermeli** (Windows genelde sorar)

⚠️ **Bilgisayarın IP adresini öğrenmek için:**
```bash
ipconfig
```
"IPv4 Address" satırını bulun (örn: 192.168.1.100)

## Sorun Giderme

### Uygulama açılmıyor
- IP adresinin doğru olduğundan emin olun
- Port 8000'in kullanıldığını kontrol edin
- Güvenlik duvarı izinlerini kontrol edin

### Bağlantı hatası
- Bilgisayar ve tablet aynı Wi-Fi'de mi?
- Bilgisayarda sunucu çalışıyor mu?
- IP adresi değişmiş olabilir (yeniden kontrol edin)

### Python/Node.js bulunamıyor
- Python için: https://www.python.org/downloads/
- Node.js için: https://nodejs.org/