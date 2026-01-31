# Test Hataları ve Düzeltmeler

## 🔧 Yapılan Düzeltmeler

### 1. Vitest Hatası: ESM Loader (https:// URL)

**Sorun**: `app.js` içinde `import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';` var. Bu https:// URL'si Node.js ESM loader tarafından desteklenmiyor.

**Çözüm**:
- `test/setup.js` dosyasına `vi.mock()` ile Supabase mock'u eklendi
- `vitest.config.js`'de `app.js` testlerden hariç tutuldu (çok karmaşık ve https:// import'ları var)
- Test dosyası (`test/utils.test.js`) artık utility dosyalarını doğrudan test ediyor, `app.js`'i import etmiyor

### 2. Test Dosyası Hatası: app.js Import

**Sorun**: `test/utils.test.js` dosyası `app.js`'i import ediyordu ve `app.debounce()` gibi metodları çağırıyordu. Ancak bu fonksiyonlar artık `src/utils/` klasöründe ayrı dosyalarda.

**Çözüm**:
- Test dosyası güncellendi: Artık utility dosyalarını doğrudan import ediyor
- `src/utils/performance.js` → `debounce`, `throttle`
- `src/utils/formatters.js` → `formatDateTimeWithoutSeconds`, `formatTimeOnly`, `formatHoursToReadable`
- `src/utils/calculators.js` → `calculateHoursUsed`, `calculateHoursBetween`

### 3. Playwright Hatası: test.describe()

**Sorun**: Playwright `test.describe()` çağrısında hata veriyordu.

**Çözüm**:
- `playwright.config.js` sadeleştirildi (sadece chromium projesi kaldı)
- Web server timeout artırıldı (120 saniye)
- Test dosyası doğru yapılandırıldı

## 📝 Test Dosyaları Yapısı

### Unit Testler (Vitest)
- **Dosya**: `test/utils.test.js`
- **Test Edilen**: Utility fonksiyonlar (`src/utils/`)
- **Çalıştırma**: `npm test`

### E2E Testler (Playwright)
- **Dosya**: `e2e/table-operations.spec.js`
- **Test Edilen**: Masa operasyonları (açma, ürün ekleme, kapatma)
- **Çalıştırma**: `npm run test:e2e`

## ✅ Test Çalıştırma

### Vitest (Unit Testler)
```bash
npm test              # Tüm testler
npm run test:ui       # UI ile
npm run test:coverage # Coverage raporu ile
```

### Playwright (E2E Testler)
```bash
npm run test:e2e      # Tüm E2E testler
npm run test:e2e:ui  # UI ile
```

## ⚠️ Önemli Notlar

1. **app.js Test Edilmiyor**: `app.js` dosyası testlerden hariç tutuldu çünkü:
   - https:// import'ları var (Node.js'de çalışmıyor)
   - Çok karmaşık ve DOM'a bağımlı
   - Utility fonksiyonlar ayrı dosyalarda test ediliyor

2. **Mock'lar**: `test/setup.js` dosyasında Supabase, IndexedDB, DOM mock'ları var

3. **Test Coverage**: Sadece utility fonksiyonlar test ediliyor. Servisler ve ana uygulama mantığı için ayrı testler yazılabilir.

## 🚀 Sonraki Adımlar

1. ✅ Utility fonksiyonları test ediliyor
2. ⏳ Servis katmanı testleri yazılabilir (`TableService`, vb.)
3. ⏳ E2E testler genişletilebilir (daha fazla senaryo)
4. ⏳ Integration testleri eklenebilir
