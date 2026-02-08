# MekanApp kaynak yapısı

## Modüller

| Dosya | Açıklama |
|-------|----------|
| `constants.js` | `DEBUG_MODE`, `debugLog`, `debugWarn` |
| `auth.js` | Giriş modalı, `ensureSignedIn(supabase)` |
| `modules/dialogs.js` | `appAlert`, `appConfirm`, `appDialog`, `showLoadingOverlay`, `hideLoadingOverlay` |

Bu modüller `app.js` içinde import edilir; `dialogs` metodları `Object.assign(MekanApp.prototype, dialogsModule)` ile sınıfa eklenir.

## app.js içindeki kategoriler

Ana uygulama sınıfı `app.js` içinde bölüm yorumlarıyla ayrılmıştır:

- **Auth & kullanıcı** — Rol, menü görünürlüğü
- **Init & başlatma** — `init()`, event dinleyiciler, PWA
- **Sync & realtime** — Poll sync, Supabase realtime, `reloadViews`
- **Görünüm & navigasyon** — `switchView`, `loadInitialData`, header, loading ekranları
- **Tables (liste ve kartlar)** — `loadTables`, kartlar, swipe, fiyat güncellemeleri
- **Masa formu** — Masa ekleme/düzenleme modalı
- **Masa modalı** — Masa detayı, ürün ekleme, ödeme, veresiye
- **Ürünler** — Liste, form, kategoriler, stok
- **Müşteriler** — Liste, form, bakiye, ödeme
- **Satış geçmişi** — Filtreleme, kartlar
- **Giderler** — Liste, form
- **Günlük rapor** — Dashboard, grafikler
- **Tema & footer** — Karanlık mod, footer metni

## Utils

- `utils/performance.js` — `debounce`, `throttle`
- `utils/formatters.js` — Tarih/saat formatlama
- `utils/calculators.js` — `calculateHoursUsed`, `calculateHoursBetween`

## Yeni modül eklemek

1. `src/modules/your-module.js` oluştur; fonksiyonları export et.
2. `app.js` başında: `import * as yourModule from './src/modules/your-module.js';`
3. Sınıf tanımından hemen sonra: `Object.assign(MekanApp.prototype, yourModule);`
4. `app.js` içinden ilgili metodları kaldır.

Metodlar `this` ile app örneğine erişir; birbirlerini `this.otherMethod()` ile çağırabilir.
