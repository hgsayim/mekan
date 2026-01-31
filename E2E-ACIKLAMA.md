# E2E (End-to-End) Testler Nedir?

## 🎯 E2E Testler Ne İşe Yarar?

**E2E (End-to-End)** testler, uygulamanın **gerçek kullanıcı senaryolarını** otomatik olarak test eder. Gerçek bir tarayıcı açıp, kullanıcı gibi tıklayıp, form doldurup, sonuçları kontrol eder.

## 📊 Test Türleri Karşılaştırması

### 1. Unit Testler (Vitest) ✅
- **Ne test eder?**: Küçük fonksiyonlar, utility'ler
- **Örnek**: `formatDateTimeWithoutSeconds()` fonksiyonu doğru çalışıyor mu?
- **Hız**: Çok hızlı (milisaniyeler)
- **Bağımlılık**: Yok (izole)

### 2. E2E Testler (Playwright) 🔄
- **Ne test eder?**: Tüm uygulama akışı
- **Örnek**: Kullanıcı masaya tıklayıp ürün ekleyip ödeme yapabiliyor mu?
- **Hız**: Yavaş (saniyeler)
- **Bağımlılık**: Tüm sistem (DB, API, UI)

## 🔍 E2E Test Örneği

```javascript
test('should add product to table', async ({ page }) => {
  // 1. Sayfaya git
  await page.goto('/');
  
  // 2. Auth yap
  await page.fill('#auth-email', 'user@example.com');
  await page.click('#auth-login-btn');
  
  // 3. Masa kartına tıkla
  await page.click('.table-card');
  
  // 4. Ürün ekle
  await page.click('.product-card');
  
  // 5. Sonucu kontrol et
  await expect(page.locator('.sale-product-line')).toBeVisible();
});
```

## ✅ E2E Testlerin Avantajları

1. **Gerçek Kullanıcı Deneyimi**: Gerçek tarayıcıda çalışır
2. **Entegrasyon Testi**: Tüm sistem birlikte test edilir
3. **Regresyon Önleme**: Yeni özellik eklerken eski özelliklerin bozulmadığını garanti eder
4. **Dokümantasyon**: Testler, uygulamanın nasıl kullanılacağını gösterir

## ⚠️ E2E Testlerin Dezavantajları

1. **Yavaş**: Her test saniyeler sürer
2. **Kırılgan**: UI değişikliklerinde bozulabilir
3. **Bakım**: Selector'lar değişince güncellenmeli
4. **Bağımlılık**: DB, API, network gerektirir

## 🎯 Ne Zaman E2E Test Yazılmalı?

✅ **Yazılmalı**:
- Kritik kullanıcı akışları (ödeme, veresiye, masa işlemleri)
- Ana özellikler (ürün ekleme, hesap alma)

❌ **Yazılmamalı**:
- Her küçük özellik için
- Utility fonksiyonlar için (unit test yeterli)
- Çok sık değişen UI elementleri için

## 📝 MekanApp'teki E2E Testler

Şu an test edilenler:
- ✅ Masa modal açma
- ✅ Ürün ekleme
- ✅ Modal kapatma
- ✅ View'lar arası geçiş

Test edilebilecekler:
- 💰 Ödeme alma
- 📝 Veresiye yazma
- ❌ İptal etme
- 📊 Rapor görüntüleme
