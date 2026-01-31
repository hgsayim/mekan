# E2E Test Notları

## Auth Gereksinimleri

E2E testleri çalıştırmak için:

1. **Test Kullanıcısı**: Supabase'de bir test kullanıcısı oluşturun
2. **Auth Bilgileri**: `e2e/table-operations.spec.js` dosyasındaki test kullanıcı bilgilerini güncelleyin:
   ```javascript
   await page.fill('#auth-email', 'test@example.com');
   await page.fill('#auth-password', 'testpassword');
   ```

## Alternatif: Mock Auth

Eğer test ortamında auth'u bypass etmek isterseniz, `app.js`'de test modu ekleyebilirsiniz.

## Test Çalıştırma

```bash
npm run test:e2e
```

## Notlar

- Testler gerçek Supabase bağlantısı gerektirir
- Test veritabanında test verileri olmalı (masalar, ürünler)
- Auth modal timeout'u 15 saniye
- Tables grid yükleme timeout'u 20 saniye
