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
   * @param {{ syncEntities?: Array<'products'|'tables'|'sales'|'customers'|'manualSessions'|'expenses'> }} [opts]
   */
  constructor(supabase, opts = {}) {
    this.remote = new SupabaseDatabase(supabase);
    if (!window.Database) {
      throw new Error('HybridDatabase: window.Database not found. Ensure database.js is loaded before app.js');
    }
    this.local = new window.Database();

    this.syncEntities = opts.syncEntities || ['products', 'tables', 'sales', 'customers', 'manualSessions', 'expenses'];

    this._syncInFlight = false;
    this._lastSyncAt = 0;

    // Delta sync tracking (per-entity)
    this._lsPrefix = 'mekanapp:lastSync:';
    this._fullSyncEveryMs = 15 * 60 * 1000; // safety net for deletes / missed updates
    this._lastFullSyncAt = 0;

    // Which timestamp columns exist per table for delta sync.
    // Some schemas may not have updated_at on every table (e.g. manual_sessions).
    this._deltaTsCols = {
      // Your schema may NOT have updated_at on all tables.
      // We default to created_at to avoid 400s; realtime + periodic full sync covers updates/deletes.
      products: ['created_at'],
      tables: ['updated_at', 'created_at'], // tables usually has updated_at; if not, it will be caught by full sync/realtime
      // IMPORTANT: sales "payment/credit" is an UPDATE (is_paid + payment_time),
      // so created_at-only delta sync will miss it. Include payment_time to catch closures across devices.
      sales: ['created_at', 'payment_time'],
      customers: ['created_at'],
      manualSessions: ['created_at'],
      expenses: ['created_at', 'expense_date'],
    };
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
   * @param {'tables'|'products'|'sales'|'customers'|'manual_sessions'|'manualSessions'} tableName
   * @param {any} payload
   */
  async applyRealtimeChange(tableName, payload) {
    const map = {
      tables: { key: 'tables', store: 'tables' },
      products: { key: 'products', store: 'products' },
      sales: { key: 'sales', store: 'sales' },
      customers: { key: 'customers', store: 'customers' },
      manual_sessions: { key: 'manualSessions', store: 'manualSessions' },
      manualSessions: { key: 'manualSessions', store: 'manualSessions' },
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

  // Tables-only full sync (cheap + reliable even if updated_at isn't present/maintained).
  // Returns true if anything important changed (active/open state etc.)
  async syncTablesFull() {
    try {
      let before = [];
      try { before = await this.local.getAllTables(); } catch (_) { before = []; }
      const rows = await this.remote.getAllTables();

      const snap = (t) => JSON.stringify({
        id: t?.id ?? null,
        isActive: Boolean(t?.isActive),
        openTime: t?.openTime ?? null,
        closeTime: t?.closeTime ?? null,
        hourlyRate: Number(t?.hourlyRate || 0),
        hourlyTotal: Number(t?.hourlyTotal || 0),
        salesTotal: Number(t?.salesTotal || 0),
        checkTotal: Number(t?.checkTotal || 0),
        // session history affects "still running" perception
        hourlySessions: Array.isArray(t?.hourlySessions) ? t.hourlySessions.length : 0,
      });

      const beforeMap = new Map((before || []).map((t) => [String(t?.id), snap(t)]));
      let changed = false;
      (rows || []).forEach((t) => {
        const key = String(t?.id);
        if (!beforeMap.has(key) || beforeMap.get(key) !== snap(t)) changed = true;
      });
      if ((before || []).length !== (rows || []).length) changed = true;

      await this._replaceStore('tables', rows);
      // Keep delta sync cheap
      const nowIso = new Date().toISOString();
      this._setLastSyncISO('tables', nowIso);
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

  // ----- Expenses -----
  async addExpense(expense) {
    const id = await this.remote.addExpense(expense);
    try { await this.local.updateExpense({ ...expense, id }); } catch (_) {
      try { await this.local.addExpense({ ...expense, id }); } catch (_) {}
    }
    return id;
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
    const id = await this.remote.updateExpense(expense);
    try { await this.local.updateExpense(expense); } catch (_) {}
    return id;
  }
  async deleteExpense(id) {
    await this.remote.deleteExpense(id);
    try { await this.local.deleteExpense(id); } catch (_) {}
  }

  // ----- Admin -----
  async clearAllData() {
    await this.remote.clearAllData();
    try { await this.local.clearAllData(); } catch (_) {}
  }
}

