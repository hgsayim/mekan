# Plan: Ürün Aktarma ve Masa Taşıma Özellikleri

Onayınızdan sonra uygulanacaktır. Değiştirmek veya eklemek istediğiniz maddeler varsa yazın.

---

## 1. Ürün aktarma (Ürünü başka masaya taşıma)

**Amaç:** Açık olan bir masadaki seçili ürün satırlarını (satış kayıtlarını) başka bir masaya taşımak.

**Akış (önerilen):**
- Masa detay ekranında (masa modalı) yeni bir buton: **"Ürün Aktar"** (veya "Seçilenleri Taşı").
- Butona basılınca:
  - Bu masanın **ödenmemiş satışları** (unpaid sales) listelenir; kullanıcı taşınacak satırları seçer (çoklu seçim veya "tümünü seç").
  - **Hedef masa** seçilir (açık olan diğer masalar dropdown’da).
  - Onay: "X adet satış Masa Y’ye taşınsın mı?"
- Onaydan sonra:
  - Seçilen her `sale` kaydının `tableId` alanı hedef masa id’si ile güncellenir (DB’de update).
  - Her iki masanın toplamları yeniden hesaplanır (veya mevcut refresh/load ile güncellenir).
  - Masa detay modalı yenilenir; hedef masa kartı da güncellenir.

**Teknik notlar:**
- `getUnpaidSalesByTable(tableId)` zaten var; seçilen sale’ların `tableId`’si `updateSale` veya benzeri ile hedef masaya çekilir.
- Saatlik masada oyun süresi satışlara bağlı değilse sadece ürün satışları taşınır; gerekirse saatlik toplam sadece kapanışta hesaplanır (mevcut mantık korunur).

**UI yerleşimi:**
- Masa detay içinde ürün listesinin üstünde veya altında "Ürün Aktar" butonu.
- Aktarım adımları için ya mevcut bottom-sheet tarzı bir modal ya da masa detay içinde adım adım (1: satışları seç, 2: hedef masa seç, 3: onay) kullanılabilir.

---

## 2. Masa taşıma (Tüm hesabı başka masaya taşıma)

**Amaç:** Bir masadaki **tüm ödenmemiş hesabı** (tüm unpaid sales + istenirse saatlik oturum bilgisi) başka bir masaya taşımak. Örneğin müşteri masası değiştirdi veya yanlış masa açıldı.

**Akış (önerilen):**
- Masa detay ekranında yeni bir buton: **"Masaya Taşı"** (veya "Hesabı Taşı").
- Butona basılınca:
  - **Hedef masa** seçilir (açık ve farklı olan masalar listelenir).
  - Onay: "Bu masanın tüm hesabı [Masa Y] masasına taşınsın mı? Bu masa kapanacak."
- Onaydan sonra:
  - Kaynak masanın tüm **unpaid sales** kayıtlarının `tableId`’si hedef masaya güncellenir.
  - Saatlik masa ise: bu masadaki **hourly session** (açılış saati vb.) hedef masaya taşınabilir mi, yoksa sadece ürün satışları mı taşınsın — buna göre ya hedef masada aynı openTime/session bilgisi oluşturulur ya da sadece sales taşınır ve kaynak masa "açılış olmadan kapatılmış" gibi kapatılır.
  - Kaynak masa kapatılır (isActive: false, openTime/closeTime güncellenir; varsa hourlySessions temizlenir veya kapatma kaydı eklenir).
  - Her iki masa kartı ve masa detayı yenilenir.

**Teknik notlar:**
- Tüm unpaid sales’in `tableId`’si toplu veya döngüyle hedef masaya update edilir.
- Saatlik masa için: mevcut `hourlySessions` ve `openTime` yapısına göre ya hedef masaya session eklenir ya da sadece sales taşınır; kaynak masa normal kapanış akışına alınır (closeTable mantığı kullanılabilir).

**UI yerleşimi:**
- Masa detay footer’da veya üstte "Masaya Taşı" butonu (sadece bu masada ödenmemiş satış varken aktif).

---

## 3. Ortak kurallar

- Sadece **açık** masalar hedef olarak listelenir (ve kendi masası hariç).
- İşlemler **sadece ödenmemiş** satışlar üzerinde; ödenmiş/veresiye kapatılmış satışlar taşınmaz.
- Taşıma sonrası stok zaten satışa bağlı olduğu için ek stok düşümü yapılmaz; sadece `tableId` güncellenir.
- Raporlar mevcut sale kayıtlarına göre çalıştığı için, taşınan satışlar hedef masanın kapanışında hedef masaya ait görünür.

---

## 4. Onay

Bu planı aynen onaylıyor musunuz, yoksa değiştirmek istediğiniz noktalar var mı? (Örn: buton isimleri, sadece ürün aktarma mı, sadece masa taşıma mı, saatlik masa davranışı vb.) Onayınızdan sonra adım adım kodlamaya geçeceğim.
