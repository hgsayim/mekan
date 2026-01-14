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
   * @param {import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm').SupabaseClient} supabase
   * @param {{ syncEntities?: Array<'products'|'tables'|'sales'|'customers'|'manualSessions'> }} [opts]
   */
  constructor(supabase, opts = {}) {
    this.remote = new SupabaseDatabase(supabase);
    if (!window.Database) {
      throw new Error('HybridDatabase: window.Database not found. Ensure database.js is loaded before app.js');
    }
    this.local = new window.Database();

    this.syncEntities = opts.syncEntities || ['products', 'tables', 'sales', 'customers', 'manualSessions'];

    this._syncInFlight = false;
    this._lastSyncAt = 0;

    // Delta sync tracking (per-entity)
    this._lsPrefix = 'mekanapp:lastSync:';
    this._fullSyncEveryMs = 15 * 60 * 1000; // safety net for deletes / missed updates
    this._lastFullSyncAt = 0;
  }

  async init() {
    await this.remote.init();
    await this.local.init();
    // Initial sync so app starts with a warm local cache.
    await this.syncNow({ force: true, forceFull: true });
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

  async _fetchSince(tableKey, sinceISO) {
    // Fetch rows where updated_at or created_at is >= sinceISO.
    // NOTE: relies on DB columns existing; if not, fallback to full sync.
    const tableName = this.remote.tables?.[tableKey] || tableKey;
    const res = await this.remote.supabase
      .from(tableName)
      .select('*')
      .or(`updated_at.gte.${sinceISO},created_at.gte.${sinceISO}`);
    this.remote._throwIfError(res);
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
        if (this.syncEntities.includes('manualSessions')) {
          tasks.push(this.remote.getAllManualSessions().then((rows) => this._replaceStore('manualSessions', rows)).catch(() => {}));
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
        if (this.syncEntities.includes('manualSessions')) enqueue('manualSessions', 'manualSessions', 'manualSessions');

        const results = await Promise.all(deltaTasks);
        anyChanged = results.some(Boolean);
      }

      this._lastSyncAt = Date.now();
      return anyChanged;
    } finally {
      this._syncInFlight = false;
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
    const id = await this.remote.updateProduct(product);
    try { await this.local.updateProduct(product); } catch (_) {}
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
    const id = await this.remote.updateTable(table);
    try { await this.local.updateTable(table); } catch (_) {}
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
    await this.remote.deleteSale(id);
    try { await this.local.deleteSale(id); } catch (_) {}
  }
  async getUnpaidSalesByTable(tableId) {
    try { return await this.local.getUnpaidSalesByTable(tableId); } catch (_) {
      return await this.remote.getUnpaidSalesByTable(tableId);
    }
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

  // ----- Manual Sessions -----
  async addManualSession(session) {
    const id = await this.remote.addManualSession(session);
    try { await this.local.addManualSession({ ...session, id }); } catch (_) {}
    return id;
  }
  async getAllManualSessions() {
    try { return await this.local.getAllManualSessions(); } catch (_) { return await this.remote.getAllManualSessions(); }
  }
  async deleteManualSession(id) {
    await this.remote.deleteManualSession(id);
    try { await this.local.deleteManualSession(id); } catch (_) {}
  }

  // ----- Admin -----
  async clearAllData() {
    await this.remote.clearAllData();
    try { await this.local.clearAllData(); } catch (_) {}
  }
}

