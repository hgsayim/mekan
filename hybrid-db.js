// Hybrid DB: Supabase (source of truth) + IndexedDB (local cache)
//
// Goals:
// - Reads are served from IndexedDB for instant UI (no network lag / spinners).
// - Writes go to Supabase and also update IndexedDB immediately (best-effort).
// - A polling sync keeps IndexedDB up-to-date across devices.
//
// Requirements:
// - `database.js` must be loaded before this module so `window.Database` exists.

import { SupabaseDatabase } from './supabase-db.js';

export class HybridDatabase {
  /**
   * @param {import('https://esm.sh/@supabase/supabase-js@2').SupabaseClient} supabase
   * @param {{ syncEntities?: Array<'products'|'tables'|'sales'|'customers'|'expenses'> }} [opts]
   */
  constructor(supabase, opts = {}) {
    this.remote = new SupabaseDatabase(supabase);
    if (!window.Database) {
      throw new Error('HybridDatabase: window.Database not found. Ensure database.js is loaded before app.js');
    }
    this.local = new window.Database();

    this.syncEntities = opts.syncEntities || ['products', 'tables', 'sales', 'customers', 'expenses'];

    this._syncInFlight = false;
    this._lastSyncAt = 0;

    // Delta sync tracking (per-entity)
    this._lsPrefix = 'mekanapp:lastSync:';
    this._fullSyncEveryMs = 15 * 60 * 1000; // safety net for deletes / missed updates
    this._lastFullSyncAt = 0;

    // Which timestamp columns exist per table for delta sync.
    this._deltaTsCols = {
      products: ['created_at'],
      tables: ['updated_at', 'created_at'],
      sales: ['created_at', 'payment_time'],
      customers: ['created_at'],
      expenses: ['created_at', 'expense_date'],
    };

    /** One-time warn per table when delta sync gets 404 (avoids console spam every 3s) */
    this._fetch404Warned = new Set();
  }

  async init() {
    try {
      await this.remote.init();
      await this.local.init();
      // Sync arka planda; "Database init timeout" ve sync timeout uyarısı oluşmasın
      this.syncNow({ force: true, forceFull: true }).catch((err) => {
        console.warn('HybridDatabase: Arka plan sync tamamlanamadı (yerel önbellek kullanılıyor):', err?.message || err);
      });
    } catch (error) {
      console.error('HybridDatabase: Init hatası:', error);
    }
    return true;
  }

  _getLastSyncISO(entity) {
    try {
      const v = localStorage.getItem(this._lsPrefix + entity);
      if (v) return v;
    } catch (_) {}
    // epoch
    return new Date(0).toISOString();
  }

  _setLastSyncISO(entity, iso) {
    try {
      localStorage.setItem(this._lsPrefix + entity, iso);
    } catch (_) {}
  }

  async _replaceStore(storeName, rows) {
    // Best-effort full replace (clear + put all).
    // This ensures deletions are reflected locally too.
    if (!this.local?.db?.objectStoreNames?.contains?.(storeName)) return;
    const db = this.local.db;
    return new Promise((resolve, reject) => {
      const tx = db.transaction([storeName], 'readwrite');
      const store = tx.objectStore(storeName);
      const clearReq = store.clear();
      clearReq.onerror = () => reject(clearReq.error);
      clearReq.onsuccess = () => {
        (rows || []).forEach((r) => {
          try {
            store.put(r);
          } catch (e) {
            // ignore single-row errors
          }
        });
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  async _upsertStore(storeName, rows) {
    if (!rows || rows.length === 0) return false;
    if (!this.local?.db?.objectStoreNames?.contains?.(storeName)) return false;
    const db = this.local.db;
    return new Promise((resolve, reject) => {
      const tx = db.transaction([storeName], 'readwrite');
      const store = tx.objectStore(storeName);
      (rows || []).forEach((r) => {
        try {
          store.put(r);
        } catch (e) {
          // ignore single-row errors
        }
      });
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  async _deleteFromStore(storeName, id) {
    if (id == null) return false;
    if (!this.local?.db?.objectStoreNames?.contains?.(storeName)) return false;
    const db = this.local.db;
    return new Promise((resolve, reject) => {
      const tx = db.transaction([storeName], 'readwrite');
      const store = tx.objectStore(storeName);
      const req = store.delete(id);
      req.onerror = () => reject(req.error);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  /**
   * Apply Supabase realtime payload directly to local IndexedDB cache.
   * This makes multi-device updates appear instantly without waiting for polling/delta filters.
   *
   * @param {'tables'|'products'|'sales'|'customers'|'expenses'} tableName
   * @param {any} payload
   */
  async applyRealtimeChange(tableName, payload) {
    const map = {
      tables: { key: 'tables', store: 'tables' },
      products: { key: 'products', store: 'products' },
      sales: { key: 'sales', store: 'sales' },
      customers: { key: 'customers', store: 'customers' },
      expenses: { key: 'expenses', store: 'expenses' },
    };
    const entry = map[tableName];
    if (!entry) return false;

    const eventType = payload?.eventType || payload?.event_type || payload?.type || '';
    const isDelete = String(eventType).toUpperCase() === 'DELETE';
    const rowRaw = isDelete ? payload?.old : payload?.new;
    const id = rowRaw?.id ?? payload?.old?.id ?? payload?.new?.id ?? null;

    try {
      if (isDelete) {
        await this._deleteFromStore(entry.store, id);
        return true;
      }

      if (!rowRaw) return false;
      const row = this.remote._snakeToCamel(entry.key, rowRaw);
      await this._upsertStore(entry.store, [row]);

      // Move lastSync forward based on server timestamps, so delta sync stays cheap.
      const prev = this._getLastSyncISO(entry.key);
      const next = this._maxTimestampISO([row], prev);
      const bump = new Date(new Date(next).getTime() + 1).toISOString();
      this._setLastSyncISO(entry.key, bump);
      return true;
    } catch (_) {
      return false;
    }
  }

  async _fetchSince(tableKey, sinceISO) {
    // Fetch rows where one of the timestamp columns is >= sinceISO.
    // NOTE: relies on DB columns existing; we keep a per-table mapping above.
    const tableName = this.remote.tables?.[tableKey] || tableKey;
    const cols = this._deltaTsCols?.[tableKey] || ['updated_at', 'created_at'];
    let query = this.remote.supabase.from(tableName).select('*');
    if (cols.length === 1) {
      query = query.gte(cols[0], sinceISO);
    } else {
      // PostgREST "or" filter
      query = query.or(cols.map((c) => `${c}.gte.${sinceISO}`).join(','));
    }
    const res = await query;
    if (res.error) {
      const code = String(res.error?.code || '');
      const msg = String(res.error?.message || '');
      const is404 = res.status === 404 || code === 'PGRST116' || code === '42P01' || /not found|404/i.test(msg);
      if (is404 && !this._fetch404Warned.has(tableKey)) {
        this._fetch404Warned.add(tableKey);
        console.warn(
          `[MekanApp] Sync: tablo "${tableName}" (${tableKey}) için 404 alındı. ` +
          `Supabase'deki tablo adının supabase-db.js içindeki this.tables ile aynı olduğundan emin olun (örn. tables: 'tables' veya 'restaurant_tables').`
        );
      }
      if (is404) return [];
      this.remote._throwIfError(res);
    }
    return (res.data || []).map((r) => this.remote._snakeToCamel(tableKey, r));
  }

  _maxTimestampISO(rows, prevISO) {
    let max = new Date(prevISO).getTime();
    (rows || []).forEach((r) => {
      const t = r?.updatedAt || r?.createdAt || null;
      if (!t) return;
      const ms = new Date(t).getTime();
      if (!Number.isNaN(ms) && ms > max) max = ms;
    });
    return new Date(max).toISOString();
  }

  async syncNow({ force = false, forceFull = false } = {}) {
    if (this._syncInFlight) return false;
    const now = Date.now();
    if (!force && now - this._lastSyncAt < 250) return false;
    this._syncInFlight = true;
    try {
      const shouldFull = forceFull || (now - this._lastFullSyncAt >= this._fullSyncEveryMs);
      let anyChanged = false;

      if (shouldFull) {
        const tasks = [];
        if (this.syncEntities.includes('products')) {
          tasks.push(this.remote.getAllProducts().then((rows) => this._replaceStore('products', rows)).catch(() => {}));
        }
        if (this.syncEntities.includes('tables')) {
          tasks.push(this.remote.getAllTables().then((rows) => this._replaceStore('tables', rows)).catch(() => {}));
        }
        if (this.syncEntities.includes('sales')) {
          tasks.push(this.remote.getAllSales().then((rows) => this._replaceStore('sales', rows)).catch(() => {}));
        }
        if (this.syncEntities.includes('customers')) {
          tasks.push(this.remote.getAllCustomers().then((rows) => this._replaceStore('customers', rows)).catch(() => {}));
        }
        if (this.syncEntities.includes('expenses')) {
          tasks.push(this.remote.getAllExpenses().then((rows) => this._replaceStore('expenses', rows)).catch(() => {}));
        }
        await Promise.all(tasks);
        // Reset per-entity lastSync to "now" so subsequent delta syncs are cheap.
        const nowIso = new Date().toISOString();
        this.syncEntities.forEach((e) => this._setLastSyncISO(e, nowIso));
        this._lastFullSyncAt = Date.now();
        anyChanged = true;
      } else {
        // Delta sync: only upsert changed rows
        const deltaTasks = [];

        const enqueue = (entity, tableKey, storeName) => {
          const since = this._getLastSyncISO(entity);
          deltaTasks.push(
            this._fetchSince(tableKey, since)
              .then(async (rows) => {
                if (!rows || rows.length === 0) return false;
                await this._upsertStore(storeName, rows);
                const next = this._maxTimestampISO(rows, since);
                // +1ms to avoid re-fetching same edge row repeatedly
                const bump = new Date(new Date(next).getTime() + 1).toISOString();
                this._setLastSyncISO(entity, bump);
                return true;
              })
              .catch(() => false)
          );
        };

        if (this.syncEntities.includes('products')) enqueue('products', 'products', 'products');
        if (this.syncEntities.includes('tables')) enqueue('tables', 'tables', 'tables');
        if (this.syncEntities.includes('sales')) enqueue('sales', 'sales', 'sales');
        if (this.syncEntities.includes('customers')) enqueue('customers', 'customers', 'customers');
        if (this.syncEntities.includes('expenses')) enqueue('expenses', 'expenses', 'expenses');

        const results = await Promise.all(deltaTasks);
        anyChanged = results.some(Boolean);
      }

      this._lastSyncAt = Date.now();
      return anyChanged;
    } finally {
      this._syncInFlight = false;
    }
  }

  // Tables-only full sync. Local-first: yerel daha yeniyse (updated_at) remote ile ezilmez.
  async syncTablesFull() {
    try {
      let localTables = [];
      try { localTables = await this.local.getAllTables(); } catch (_) {}
      const remoteRows = await this.remote.getAllTables() || [];
      const localByKey = new Map((localTables || []).map((t) => [String(t?.id), t]));

      const merged = [];
      for (const remote of remoteRows) {
        const key = String(remote?.id);
        const local = localByKey.get(key);
        const remoteTs = remote?.updated_at || remote?.updatedAt || '';
        const localTs = local?.updated_at || local?.updatedAt || '';
        if (local && localTs && remoteTs && localTs > remoteTs) {
          merged.push(local);
        } else {
          merged.push(remote);
        }
      }
      // Remote'da olmayan yerel masaları da ekle (silinmemiş olsun)
      for (const [key, local] of localByKey) {
        if (!remoteRows.some((r) => String(r?.id) === key)) merged.push(local);
      }

      const beforeSnap = (localTables || []).map((t) => `${t?.id}:${t?.updated_at || ''}:${t?.openTime || ''}`).join('|');
      const afterSnap = merged.map((t) => `${t?.id}:${t?.updated_at || ''}:${t?.openTime || ''}`).join('|');
      const changed = beforeSnap !== afterSnap;

      await this._replaceStore('tables', merged);
      this._setLastSyncISO('tables', new Date().toISOString());
      return changed;
    } catch (_) {
      return false;
    }
  }

  // ----- Products -----
  async addProduct(product) {
    const id = await this.remote.addProduct(product);
    try {
      await this.local.updateProduct({ ...product, id });
    } catch (e) {
      // If update fails because it doesn't exist, fallback to add
      try { await this.local.addProduct({ ...product, id }); } catch (_) {}
    }
    return id;
  }
  async getAllProducts() {
    try { return await this.local.getAllProducts(); } catch (_) { return await this.remote.getAllProducts(); }
  }
  async getProduct(id) {
    try {
      const r = await this.local.getProduct(id);
      if (r) return r;
    } catch (_) {}
    return await this.remote.getProduct(id);
  }
  async updateProduct(product) {
    try { await this.local.updateProduct(product); } catch (_) {}
    const id = product?.id ?? null;
    this.remote.updateProduct(product).catch((e) => console.warn('HybridDB: updateProduct remote:', e?.message || e));
    return id;
  }
  async deleteProduct(id) {
    await this.remote.deleteProduct(id);
    try { await this.local.deleteProduct(id); } catch (_) {}
  }

  // ----- Tables -----
  async addTable(table) {
    const id = await this.remote.addTable(table);
    try { await this.local.updateTable({ ...table, id }); } catch (_) {
      try { await this.local.addTable({ ...table, id }); } catch (_) {}
    }
    return id;
  }
  async getAllTables() {
    try { return await this.local.getAllTables(); } catch (_) { return await this.remote.getAllTables(); }
  }
  async getTable(id) {
    try {
      const r = await this.local.getTable(id);
      if (r) return r;
    } catch (_) {}
    return await this.remote.getTable(id);
  }
  async updateTable(table) {
    const nowIso = new Date().toISOString();
    const row = { ...table, updated_at: nowIso };
    try { await this.local.updateTable(row); } catch (_) {}
    const id = row?.id ?? null;
    this.remote.updateTable(row).catch((e) => console.warn('HybridDB: updateTable remote:', e?.message || e));
    return id;
  }
  async deleteTable(id) {
    await this.remote.deleteTable(id);
    try { await this.local.deleteTable(id); } catch (_) {}
  }

  // ----- Sales -----
  async addSale(sale) {
    const id = await this.remote.addSale(sale);
    try { await this.local.updateSale({ ...sale, id }); } catch (_) {
      try { await this.local.addSale({ ...sale, id }); } catch (_) {}
    }
    return id;
  }
  async getAllSales() {
    try { return await this.local.getAllSales(); } catch (_) { return await this.remote.getAllSales(); }
  }
  async getSale(id) {
    try {
      const r = await this.local.getSale(id);
      if (r) return r;
    } catch (_) {}
    return await this.remote.getSale(id);
  }
  async updateSale(sale) {
    const id = await this.remote.updateSale(sale);
    try { await this.local.updateSale(sale); } catch (_) {}
    return id;
  }
  async deleteSale(id) {
    try { await this.local.deleteSale(id); } catch (_) {}
    this.remote.deleteSale(id).catch((e) => console.warn('HybridDB: deleteSale remote:', e?.message || e));
  }
  async getUnpaidSalesByTable(tableId) {
    try { return await this.local.getUnpaidSalesByTable(tableId); } catch (_) {
      return await this.remote.getUnpaidSalesByTable(tableId);
    }
  }

  /** Only query remote (for loadTables recovery when local may be stale after transfer) */
  async getUnpaidSalesByTableFromRemote(tableId) {
    return await this.remote.getUnpaidSalesByTable(tableId);
  }

  /** Write sales to local store only (so next getUnpaidSalesByTable sees them after remote recovery) */
  async upsertSalesToLocal(sales) {
    if (!sales || sales.length === 0) return;
    return await this._upsertStore('sales', sales);
  }

  // ----- Customers -----
  async addCustomer(customer) {
    const id = await this.remote.addCustomer(customer);
    try { await this.local.updateCustomer({ ...customer, id }); } catch (_) {
      try { await this.local.addCustomer({ ...customer, id }); } catch (_) {}
    }
    return id;
  }
  async getAllCustomers() {
    try { return await this.local.getAllCustomers(); } catch (_) { return await this.remote.getAllCustomers(); }
  }
  async getCustomer(id) {
    try {
      const r = await this.local.getCustomer(id);
      if (r) return r;
    } catch (_) {}
    return await this.remote.getCustomer(id);
  }
  async updateCustomer(customer) {
    const id = await this.remote.updateCustomer(customer);
    try { await this.local.updateCustomer(customer); } catch (_) {}
    return id;
  }
  async deleteCustomer(id) {
    await this.remote.deleteCustomer(id);
    try { await this.local.deleteCustomer(id); } catch (_) {}
  }
  async getSalesByCustomer(customerId) {
    // Prefer remote because it can be large; local may be stale if sync is off.
    try { return await this.remote.getSalesByCustomer(customerId); } catch (_) {
      // best-effort fallback
      const all = await this.getAllSales();
      return (all || []).filter((s) => String(s.customerId) === String(customerId));
    }
  }

  // ----- Expenses -----
  async addExpense(expense) {
    try {
      const id = await this.remote.addExpense(expense);
      try { await this.local.updateExpense({ ...expense, id }); } catch (_) {
        try { await this.local.addExpense({ ...expense, id }); } catch (_) {}
      }
      return id;
    } catch (error) {
      console.error('addExpense remote error:', error);
      // If remote fails, still try to save locally for offline support
      try {
        const localId = await this.local.addExpense(expense);
        return localId;
      } catch (localError) {
        console.error('addExpense local error:', localError);
        throw error; // Throw original remote error
      }
    }
  }
  async getAllExpenses() {
    try { return await this.local.getAllExpenses(); } catch (_) { return await this.remote.getAllExpenses(); }
  }
  async getExpense(id) {
    try {
      const r = await this.local.getExpense(id);
      if (r) return r;
    } catch (_) {}
    return await this.remote.getExpense(id);
  }
  async updateExpense(expense) {
    try {
      const id = await this.remote.updateExpense(expense);
      try { await this.local.updateExpense(expense); } catch (_) {}
      return id;
    } catch (error) {
      console.error('updateExpense remote error:', error);
      // If remote fails, still try to update locally for offline support
      try {
        await this.local.updateExpense(expense);
        return expense.id;
      } catch (localError) {
        console.error('updateExpense local error:', localError);
        throw error; // Throw original remote error
      }
    }
  }
  async deleteExpense(id) {
    // Ensure id is a number
    const expenseId = typeof id === 'string' ? parseInt(id, 10) : id;
    if (isNaN(expenseId)) {
      throw new Error('Invalid expense ID');
    }
    
    try {
      await this.remote.deleteExpense(expenseId);
      try { await this.local.deleteExpense(expenseId); } catch (_) {}
    } catch (error) {
      console.error('deleteExpense remote error:', error);
      // If remote fails, still try to delete locally for offline support
      try {
        await this.local.deleteExpense(expenseId);
      } catch (localError) {
        console.error('deleteExpense local error:', localError);
        throw error; // Throw original remote error
      }
    }
  }

  // ----- Admin -----
  async clearAllData() {
    await this.remote.clearAllData();
    try { await this.local.clearAllData(); } catch (_) {}
  }
}

