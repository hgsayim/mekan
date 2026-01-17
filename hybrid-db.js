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

    // If an entity's delta query is not supported by schema, disable delta for it to avoid 400 spam.
    this._deltaDisabled = new Set();
  }

  _normId(v) {
    if (v == null) return v;
    if (typeof v === 'number') return v;
    if (typeof v === 'string') {
      const s = v.trim();
      if (/^\d+$/.test(s)) return Number(s);
    }
    return v;
  }

  _normalizeProduct(p) {
    if (!p) return p;
    const out = { ...p };
    if ('id' in out) out.id = this._normId(out.id);
    return out;
  }

  _normalizeTable(t) {
    if (!t) return t;
    const out = { ...t };
    if ('id' in out) out.id = this._normId(out.id);
    return out;
  }

  _normalizeCustomer(c) {
    if (!c) return c;
    const out = { ...c };
    if ('id' in out) out.id = this._normId(out.id);
    return out;
  }

  _normalizeSale(s) {
    if (!s) return s;
    const out = { ...s };
    if ('id' in out) out.id = this._normId(out.id);
    if ('tableId' in out) out.tableId = this._normId(out.tableId);
    if ('customerId' in out) out.customerId = this._normId(out.customerId);
    if (Array.isArray(out.items)) {
      out.items = out.items.map((it) => {
        if (!it) return it;
        const itemOut = { ...it };
        if ('productId' in itemOut) itemOut.productId = this._normId(itemOut.productId);
        return itemOut;
      });
    }
    return out;
  }

  _normalizeManualSession(s) {
    if (!s) return s;
    const out = { ...s };
    if ('id' in out) out.id = this._normId(out.id);
    if ('tableId' in out) out.tableId = this._normId(out.tableId);
    return out;
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

  async _localPut(storeName, row) {
    if (!row) return false;
    if (!this.local?.db?.objectStoreNames?.contains?.(storeName)) return false;
    const db = this.local.db;
    return new Promise((resolve, reject) => {
      const tx = db.transaction([storeName], 'readwrite');
      const store = tx.objectStore(storeName);
      try {
        store.put(row);
      } catch (e) {
        // ignore
      }
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  async _localDelete(storeName, id) {
    const nid = this._normId(id);
    if (nid == null) return false;
    if (!this.local?.db?.objectStoreNames?.contains?.(storeName)) return false;
    const db = this.local.db;
    return new Promise((resolve, reject) => {
      const tx = db.transaction([storeName], 'readwrite');
      const store = tx.objectStore(storeName);
      const req = store.delete(nid);
      req.onerror = () => reject(req.error);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  /**
   * Apply Supabase Realtime payload directly into local IndexedDB cache.
   * This is critical for DELETE events (delta polling can't detect deletions without tombstones).
   *
   * @param {string} tableName - e.g. 'tables' | 'sales' | 'products' | 'customers' | 'manual_sessions'
   * @param {any} payload - Supabase realtime payload
   */
  async applyRealtimePayload(tableName, payload) {
    try {
      const eventType = String(payload?.eventType || payload?.event || '').toUpperCase();
      if (!eventType) return false;

      const key = tableName === 'manual_sessions' ? 'manualSessions' : tableName;
      const storeName = key;

      const rawRow = eventType === 'DELETE' ? payload?.old : payload?.new;
      if (!rawRow) return false;

      // Convert to app shape, then normalize IDs
      const camel = this.remote?._snakeToCamel ? this.remote._snakeToCamel(key, rawRow) : rawRow;
      const normalized =
        key === 'sales' ? this._normalizeSale(camel)
          : key === 'tables' ? this._normalizeTable(camel)
            : key === 'products' ? this._normalizeProduct(camel)
              : key === 'customers' ? this._normalizeCustomer(camel)
                : key === 'manualSessions' ? this._normalizeManualSession(camel)
                  : camel;

      if (eventType === 'DELETE') {
        return await this._localDelete(storeName, normalized?.id ?? camel?.id ?? rawRow?.id);
      }

      // INSERT / UPDATE
      return await this._localPut(storeName, normalized);
    } catch (e) {
      // best-effort only
      return false;
    }
  }

  async _fetchSince(tableKey, sinceISO) {
    // Delta fetch using ONE column at a time (avoids PostgREST `or` parsing/unknown-column spam).
    // If schema doesn't support any of these, caller will disable delta for this entity.
    const tableName = this.remote.tables?.[tableKey] || tableKey;
    const base = () => this.remote.supabase.from(tableName).select('*');

    const tryGte = async (col) => {
      const res = await base().gte(col, sinceISO);
      this.remote._throwIfError(res);
      return res.data || [];
    };

    const cols = [];
    // Common
    cols.push('updated_at', 'created_at');
    if (tableKey === 'sales') cols.push('sell_datetime', 'payment_time');
    if (tableKey === 'tables') cols.push('open_time');
    if (tableKey === 'manualSessions') cols.push('close_time');

    let lastErr = null;
    for (const col of cols) {
      try {
        const rows = await tryGte(col);
        return (rows || []).map((r) => this.remote._snakeToCamel(tableKey, r));
      } catch (e) {
        lastErr = e;
      }
    }
    const err = lastErr || new Error('Delta sync not supported');
    err._deltaSyncFailed = true;
    throw err;
  }

  _maxTimestampISO(rows, prevISO) {
    let max = new Date(prevISO).getTime();
    (rows || []).forEach((r) => {
      // Use any known timestamp field we may have in the app shape
      const t =
        r?.updatedAt ||
        r?.createdAt ||
        r?.sellDateTime ||
        r?.paymentTime ||
        r?.openTime ||
        r?.closeTime ||
        null;
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
          tasks.push(
            this.remote
              .getAllProducts()
              .then((rows) => this._replaceStore('products', (rows || []).map((r) => this._normalizeProduct(r))))
              .catch(() => {})
          );
        }
        if (this.syncEntities.includes('tables')) {
          tasks.push(
            this.remote
              .getAllTables()
              .then((rows) => this._replaceStore('tables', (rows || []).map((r) => this._normalizeTable(r))))
              .catch(() => {})
          );
        }
        if (this.syncEntities.includes('sales')) {
          tasks.push(
            this.remote
              .getAllSales()
              .then((rows) => this._replaceStore('sales', (rows || []).map((r) => this._normalizeSale(r))))
              .catch(() => {})
          );
        }
        if (this.syncEntities.includes('customers')) {
          tasks.push(
            this.remote
              .getAllCustomers()
              .then((rows) => this._replaceStore('customers', (rows || []).map((r) => this._normalizeCustomer(r))))
              .catch(() => {})
          );
        }
        if (this.syncEntities.includes('manualSessions')) {
          tasks.push(
            this.remote
              .getAllManualSessions()
              .then((rows) => this._replaceStore('manualSessions', (rows || []).map((r) => this._normalizeManualSession(r))))
              .catch(() => {})
          );
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
          if (this._deltaDisabled.has(entity)) return;
          const since = this._getLastSyncISO(entity);
          deltaTasks.push(
            this._fetchSince(tableKey, since)
              .then(async (rows) => {
                if (!rows || rows.length === 0) return false;
                const normalized =
                  tableKey === 'sales' ? rows.map((r) => this._normalizeSale(r))
                    : tableKey === 'tables' ? rows.map((r) => this._normalizeTable(r))
                      : tableKey === 'products' ? rows.map((r) => this._normalizeProduct(r))
                        : tableKey === 'customers' ? rows.map((r) => this._normalizeCustomer(r))
                          : tableKey === 'manualSessions' ? rows.map((r) => this._normalizeManualSession(r))
                            : rows;
                await this._upsertStore(storeName, normalized);
                const next = this._maxTimestampISO(rows, since);
                // +1ms to avoid re-fetching same edge row repeatedly
                const bump = new Date(new Date(next).getTime() + 1).toISOString();
                this._setLastSyncISO(entity, bump);
                return true;
              })
              .catch((e) => {
                // If delta filters are not supported by the schema, do not spam 400 every 3 seconds.
                // Move the cursor forward so we stop retrying until the next full sync.
                if (e && e._deltaSyncFailed) {
                  this._deltaDisabled.add(entity);
                }
                try {
                  const nowIso = new Date().toISOString();
                  const bump = new Date(new Date(nowIso).getTime() + 1).toISOString();
                  this._setLastSyncISO(entity, bump);
                } catch (_) {}
                return false;
              })
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
    const localRow = this._normalizeProduct({ ...product, id });
    try {
      await this.local.updateProduct(localRow);
    } catch (e) {
      // If update fails because it doesn't exist, fallback to add
      try { await this.local.addProduct(localRow); } catch (_) {}
    }
    return id;
  }
  async getAllProducts() {
    try { return await this.local.getAllProducts(); } catch (_) { return await this.remote.getAllProducts(); }
  }
  async getProduct(id) {
    const nid = this._normId(id);
    try {
      const r = await this.local.getProduct(nid);
      if (r) return r;
    } catch (_) {}
    return await this.remote.getProduct(nid);
  }
  async updateProduct(product) {
    const normalized = this._normalizeProduct(product);
    const id = await this.remote.updateProduct(normalized);
    try { await this.local.updateProduct(normalized); } catch (_) {}
    return id;
  }
  async deleteProduct(id) {
    const nid = this._normId(id);
    await this.remote.deleteProduct(nid);
    try { await this.local.deleteProduct(nid); } catch (_) {}
  }

  // ----- Tables -----
  async addTable(table) {
    const id = await this.remote.addTable(table);
    const localRow = this._normalizeTable({ ...table, id });
    try { await this.local.updateTable(localRow); } catch (_) {
      try { await this.local.addTable(localRow); } catch (_) {}
    }
    return id;
  }
  async getAllTables() {
    try { return await this.local.getAllTables(); } catch (_) { return await this.remote.getAllTables(); }
  }
  async getTable(id) {
    const nid = this._normId(id);
    try {
      const r = await this.local.getTable(nid);
      if (r) return r;
    } catch (_) {}
    return await this.remote.getTable(nid);
  }
  async updateTable(table) {
    const normalized = this._normalizeTable(table);
    const id = await this.remote.updateTable(normalized);
    try { await this.local.updateTable(normalized); } catch (_) {}
    return id;
  }
  async deleteTable(id) {
    const nid = this._normId(id);
    await this.remote.deleteTable(nid);
    try { await this.local.deleteTable(nid); } catch (_) {}
  }

  // ----- Sales -----
  async addSale(sale) {
    const normalizedInput = this._normalizeSale(sale);
    const id = await this.remote.addSale(normalizedInput);
    const localRow = this._normalizeSale({ ...normalizedInput, id });
    try { await this.local.updateSale(localRow); } catch (_) {
      try { await this.local.addSale(localRow); } catch (_) {}
    }
    return id;
  }
  async getAllSales() {
    try { return await this.local.getAllSales(); } catch (_) { return await this.remote.getAllSales(); }
  }
  async getSale(id) {
    const nid = this._normId(id);
    try {
      const r = await this.local.getSale(nid);
      if (r) return r;
    } catch (_) {}
    return await this.remote.getSale(nid);
  }
  async updateSale(sale) {
    const normalized = this._normalizeSale(sale);
    const id = await this.remote.updateSale(normalized);
    try { await this.local.updateSale(normalized); } catch (_) {}
    return id;
  }
  async deleteSale(id) {
    const nid = this._normId(id);
    await this.remote.deleteSale(nid);
    try { await this.local.deleteSale(nid); } catch (_) {}
  }
  async getUnpaidSalesByTable(tableId) {
    const tid = this._normId(tableId);
    try { return await this.local.getUnpaidSalesByTable(tid); } catch (_) {
      return await this.remote.getUnpaidSalesByTable(tid);
    }
  }

  // ----- Customers -----
  async addCustomer(customer) {
    const id = await this.remote.addCustomer(customer);
    const localRow = this._normalizeCustomer({ ...customer, id });
    try { await this.local.updateCustomer(localRow); } catch (_) {
      try { await this.local.addCustomer(localRow); } catch (_) {}
    }
    return id;
  }
  async getAllCustomers() {
    try { return await this.local.getAllCustomers(); } catch (_) { return await this.remote.getAllCustomers(); }
  }
  async getCustomer(id) {
    const nid = this._normId(id);
    try {
      const r = await this.local.getCustomer(nid);
      if (r) return r;
    } catch (_) {}
    return await this.remote.getCustomer(nid);
  }
  async updateCustomer(customer) {
    const normalized = this._normalizeCustomer(customer);
    const id = await this.remote.updateCustomer(normalized);
    try { await this.local.updateCustomer(normalized); } catch (_) {}
    return id;
  }
  async deleteCustomer(id) {
    const nid = this._normId(id);
    await this.remote.deleteCustomer(nid);
    try { await this.local.deleteCustomer(nid); } catch (_) {}
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
    const normalizedInput = this._normalizeManualSession(session);
    const id = await this.remote.addManualSession(normalizedInput);
    try { await this.local.addManualSession({ ...normalizedInput, id: this._normId(id) }); } catch (_) {}
    return id;
  }
  async getAllManualSessions() {
    try { return await this.local.getAllManualSessions(); } catch (_) { return await this.remote.getAllManualSessions(); }
  }
  async deleteManualSession(id) {
    const nid = this._normId(id);
    await this.remote.deleteManualSession(nid);
    try { await this.local.deleteManualSession(nid); } catch (_) {}
  }

  // ----- Admin -----
  async clearAllData() {
    await this.remote.clearAllData();
    try { await this.local.clearAllData(); } catch (_) {}
  }
}

