# 🚀 Kurulum Rehberi

## Mevcut Durum

Test framework'leri (Vitest, Playwright) için **npm** gereklidir. Ancak şu an npm kurulu değil.

## Seçenekler

### Seçenek 1: npm Kurulumu (Önerilen)

Node.js ve npm kurulumu:

1. **Node.js İndir**: https://nodejs.org/
   - LTS versiyonunu indirin (v20.x veya üzeri)
   - Kurulum sırasında "Add to PATH" seçeneğini işaretleyin

2. **Kurulumu Doğrula**:
   ```powershell
   node --version
   npm --version
   ```

3. **Test Framework'lerini Kur**:
   ```powershell
   npm install
   ```

4. **Testleri Çalıştır**:
   ```powershell
   npm test              # Unit testler
   npm run test:e2e      # E2E testler
   npm run test:all     # Tüm testler
   ```

### Seçenek 2: npm Olmadan Devam Et

npm olmadan da şu özellikler kullanılabilir:

✅ **Kod Organizasyonu**:
- `src/utils/` klasöründeki utility fonksiyonlar
- `src/services/` klasöründeki servisler
- Bu dosyalar doğrudan import edilebilir

✅ **Performans Optimizasyonları**:
- `src/utils/performance-monitor.js` - Performans izleme
- `src/utils/lazy-loader.js` - Lazy loading
- Bu dosyalar npm olmadan kullanılabilir

❌ **Test Framework'leri**:
- Vitest ve Playwright npm gerektirir
- npm kurulana kadar testler çalıştırılamaz
- Ancak test dosyaları hazır, npm kurulduğunda hemen kullanılabilir

## npm Olmadan Kullanım

### Utility Fonksiyonları Kullanma

```javascript
// app.js içinde
import { formatDateTimeWithoutSeconds } from './src/utils/formatters.js';
import { calculateHoursUsed } from './src/utils/calculators.js';
import { debounce } from './src/utils/performance.js';

// Kullanım
const formatted = formatDateTimeWithoutSeconds(dateString);
const hours = calculateHoursUsed(openTime);
const debouncedFn = debounce(myFunction, 300);
```

### Service Kullanma

```javascript
// app.js içinde
import { TableService } from './src/services/TableService.js';

// Constructor'da
this.tableService = new TableService(this.db);

// Kullanım
const updatedTable = await this.tableService.updateTableTotals(table, unpaidSales);
```

### Performans İzleme

```javascript
// app.js içinde
import { performanceMonitor } from './src/utils/performance-monitor.js';

// Fonksiyon performansını ölç
await performanceMonitor.measure('loadTables', async () => {
    await this.loadTables();
});

// Performans raporu
const report = performanceMonitor.getReport();
console.log(report);
```

## Geçici Çözüm

npm kurulana kadar:

1. ✅ **Kod organizasyonu dosyaları hazır** - Kullanılabilir
2. ✅ **Performans optimizasyonları hazır** - Kullanılabilir
3. ⏳ **Test dosyaları hazır** - npm kurulduğunda kullanılacak

## Öneri

npm kurulumu önerilir çünkü:
- Test framework'leri ile kod kalitesi artar
- CI/CD pipeline kurulabilir
- Dependency management kolaylaşır
- Modern JavaScript tooling kullanılabilir

Ancak npm olmadan da:
- Kod organizasyonu yapılabilir
- Performans optimizasyonları kullanılabilir
- Mevcut uygulama çalışmaya devam eder

## Sonraki Adımlar

1. **npm kurulumu yapılacaksa**: `npm install` çalıştırın
2. **npm kurulumu yapılmayacaksa**: Utility ve service dosyalarını kullanmaya başlayın
3. **Test dosyaları**: npm kurulduğunda hazır olacak
