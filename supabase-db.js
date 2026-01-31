// Supabase-backed DB adapter for MekanApp.
// Goal: mimic the existing Database API so app.js changes stay minimal.

export class SupabaseDatabase {
  /**
   * @param {import('https://esm.sh/@supabase/supabase-js@2').SupabaseClient} supabase
   */
  constructor(supabase) {
    this.supabase = supabase;

    // If your table names differ, change these.
    this.tables = {
      products: 'products',
      tables: 'tables',
      sales: 'sales',
      customers: 'customers',
      manualSessions: 'manual_sessions',
      expenses: 'expenses',
    };

    // Column mapping: app.js uses camelCase, Supabase tables use snake_case.
    // Add/adjust mappings here to match your schema exactly.
    this.columnMaps = {
      products: {
        arrivalPrice: 'arrival_price',
        trackStock: 'track_stock',
        createdAt: 'created_at',
        updatedAt: 'updated_at',
      },
      tables: {
        hourlyRate: 'hourly_rate',
        isActive: 'is_active',
        openTime: 'open_time',
        closeTime: 'close_time',
        hourlySessions: 'hourly_sessions',
        salesTotal: 'sales_total',
        checkTotal: 'check_total',
        hourlyTotal: 'hourly_total',
        createdAt: 'created_at',
        updatedAt: 'updated_at',
      },
      sales: {
        tableId: 'table_id',
        customerId: 'customer_id',
        sellDateTime: 'sell_datetime',
        isPaid: 'is_paid',
        isCredit: 'is_credit',
        saleTotal: 'sale_total',
        paymentTime: 'payment_time',
        createdAt: 'created_at',
        updatedAt: 'updated_at',
      },
      customers: {
        createdAt: 'created_at',
        updatedAt: 'updated_at',
      },
      manualSessions: {
        tableId: 'table_id',
        tableName: 'table_name',
        openTime: 'open_time',
        closeTime: 'close_time',
        hoursUsed: 'hours_used',
        hourlyRate: 'hourly_rate',
        createdAt: 'created_at',
        updatedAt: 'updated_at',
      },
      expenses: {
        expenseDate: 'expense_date',
        createdAt: 'created_at',
        updatedAt: 'updated_at',
      },
    };

    // Prevent 400 errors: app.js may include fields that are not real DB columns
    // (e.g. tables.sales array used only in IndexedDB). We whitelist columns per table.
    this.allowedColumns = {
      products: new Set(['id', 'name', 'icon', 'category', 'price', 'arrival_price', 'track_stock', 'stock', 'created_at', 'updated_at']),
      tables: new Set([
        'id',
        'name',
        'type',
        'icon',
        'hourly_rate',
        'is_active',
        'open_time',
        'close_time',
        'hourly_sessions',
        'sales_total',
        'check_total',
        'hourly_total',
        'created_at',
        'updated_at',
      ]),
      sales: new Set([
        'id',
        'table_id',
        'customer_id',
        'items',
        'sell_datetime',
        'sale_total',
        'is_paid',
        'is_credit',
        'payment_time',
        'created_at',
        'updated_at',
      ]),
      customers: new Set(['id', 'name', 'balance', 'created_at', 'updated_at']),
      manualSessions: new Set([
        'id',
        'type',
        'table_id',
        'table_name',
        'open_time',
        'close_time',
        'hours_used',
        'hourly_rate',
        'amount',
        'created_at',
        'updated_at',
      ]),
      expenses: new Set([
        'id',
        'description',
        'amount',
        'category',
        'expense_date',
        'created_at',
        'updated_at',
      ]),
    };

    // Supabase/PostgREST often returns numeric columns as strings. Normalize them here so app.js math works.
    this.numericFields = {
      products: new Set(['price', 'arrivalPrice', 'stock']),
      tables: new Set(['hourlyRate', 'salesTotal', 'checkTotal', 'hourlyTotal']),
      sales: new Set(['saleTotal']),
      customers: new Set(['balance']),
      manualSessions: new Set(['amount', 'hoursUsed', 'hourlyRate']),
      expenses: new Set(['amount']),
    };

    // Feature flags (auto-disable when a Supabase schema doesn't support a column yet)
    this._supports = {
      productIcon: true,
      productCategory: true,
    };
  }

  // Keep parity with old Database.init()
  async init() {
    // No-op: connection is stateless in browser.
    return true;
  }

  _throwIfError(result) {
    const { error } = result || {};
    if (error) throw error;
    return result;
  }

  _camelToSnake(tableKey, obj) {
    if (!obj) return obj;
    const map = this.columnMaps[tableKey] || {};
    const allowed = this.allowedColumns?.[tableKey] || null;
    const out = {};
    Object.keys(obj).forEach((k) => {
      const dbKey = map[k] || k;
      if (!allowed || allowed.has(dbKey)) {
        out[dbKey] = obj[k];
      }
    });
    return out;
  }

  _snakeToCamel(tableKey, row) {
    if (!row) return row;
    const map = this.columnMaps[tableKey] || {};
    const reverse = {};
    Object.keys(map).forEach((k) => {
      reverse[map[k]] = k;
    });
    const out = {};
    Object.keys(row).forEach((k) => {
      const appKey = reverse[k] || k;
      let v = row[k];
      if (v != null && typeof v === 'string' && this.numericFields?.[tableKey]?.has?.(appKey)) {
        const n = Number(v);
        v = Number.isNaN(n) ? v : n;
      }
      out[appKey] = v;
    });
    return out;
  }

  // Products
  async addProduct(product) {
    const insertRow = this._camelToSnake('products', product);
    if (!this._supports.productIcon) {
      try { delete insertRow.icon; } catch (_) {}
    }
    if (!this._supports.productCategory) {
      try { delete insertRow.category; } catch (_) {}
    }
    try {
    const res = await this.supabase
      .from(this.tables.products)
      .insert([insertRow])
      .select('*')
      .single();
    this._throwIfError(res);
    return res.data?.id;
    } catch (e) {
      // If the DB doesn't have the "icon" column yet, retry without it (avoid breaking the app).
      const msg = String(e?.message || '');
      if (this._supports.productIcon && msg.toLowerCase().includes('column') && msg.toLowerCase().includes('icon')) {
        this._supports.productIcon = false;
        try { delete insertRow.icon; } catch (_) {}
        const res2 = await this.supabase
          .from(this.tables.products)
          .insert([insertRow])
          .select('*')
          .single();
        this._throwIfError(res2);
        return res2.data?.id;
      }
      if (this._supports.productCategory && msg.toLowerCase().includes('column') && msg.toLowerCase().includes('category')) {
        this._supports.productCategory = false;
        try { delete insertRow.category; } catch (_) {}
        const res3 = await this.supabase
          .from(this.tables.products)
          .insert([insertRow])
          .select('*')
          .single();
        this._throwIfError(res3);
        return res3.data?.id;
      }
      throw e;
    }
  }

  async getAllProducts() {
    const res = await this.supabase.from(this.tables.products).select('*').order('name', { ascending: true });
    this._throwIfError(res);
    return (res.data || []).map((r) => this._snakeToCamel('products', r));
  }

  async getProduct(id) {
    const res = await this.supabase.from(this.tables.products).select('*').eq('id', id).maybeSingle();
    this._throwIfError(res);
    return res.data ? this._snakeToCamel('products', res.data) : null;
  }

  async updateProduct(product) {
    if (!product || product.id == null) throw new Error('updateProduct: missing id');
    const { id, ...patch } = product;
    const updatePatch = this._camelToSnake('products', patch);
    if (!this._supports.productIcon) {
      try { delete updatePatch.icon; } catch (_) {}
    }
    if (!this._supports.productCategory) {
      try { delete updatePatch.category; } catch (_) {}
    }
    try {
    const res = await this.supabase.from(this.tables.products).update(updatePatch).eq('id', id).select('*').single();
    this._throwIfError(res);
    return res.data?.id;
    } catch (e) {
      const msg = String(e?.message || '');
      if (this._supports.productIcon && msg.toLowerCase().includes('column') && msg.toLowerCase().includes('icon')) {
        this._supports.productIcon = false;
        try { delete updatePatch.icon; } catch (_) {}
        const res2 = await this.supabase.from(this.tables.products).update(updatePatch).eq('id', id).select('*').single();
        this._throwIfError(res2);
        return res2.data?.id;
      }
      if (this._supports.productCategory && msg.toLowerCase().includes('column') && msg.toLowerCase().includes('category')) {
        this._supports.productCategory = false;
        try { delete updatePatch.category; } catch (_) {}
        const res3 = await this.supabase.from(this.tables.products).update(updatePatch).eq('id', id).select('*').single();
        this._throwIfError(res3);
        return res3.data?.id;
      }
      throw e;
    }
  }

  async deleteProduct(id) {
    const res = await this.supabase.from(this.tables.products).delete().eq('id', id);
    this._throwIfError(res);
  }

  // Tables
  async addTable(table) {
    const insertRow = this._camelToSnake('tables', table);
    const res = await this.supabase.from(this.tables.tables).insert([insertRow]).select('*').single();
    this._throwIfError(res);
    return res.data?.id;
  }

  async getAllTables() {
    const res = await this.supabase.from(this.tables.tables).select('*').order('name', { ascending: true });
    this._throwIfError(res);
    return (res.data || []).map((r) => this._snakeToCamel('tables', r));
  }

  async getTable(id) {
    const res = await this.supabase.from(this.tables.tables).select('*').eq('id', id).maybeSingle();
    this._throwIfError(res);
    return res.data ? this._snakeToCamel('tables', res.data) : null;
  }

  async updateTable(table) {
    if (!table || table.id == null) throw new Error('updateTable: missing id');
    const { id, ...patch } = table;
    const updatePatch = this._camelToSnake('tables', patch);
    const res = await this.supabase.from(this.tables.tables).update(updatePatch).eq('id', id).select('*').single();
    this._throwIfError(res);
    return res.data?.id;
  }

  async deleteTable(id) {
    const res = await this.supabase.from(this.tables.tables).delete().eq('id', id);
    this._throwIfError(res);
  }

  // Manual sessions (report backfill)
  async addManualSession(session) {
    const insertRow = this._camelToSnake('manualSessions', session);
    const res = await this.supabase
      .from(this.tables.manualSessions)
      .insert([insertRow])
      .select('*')
      .single();
    this._throwIfError(res);
    return res.data?.id;
  }

  async getAllManualSessions() {
    // closeTime is used in DB schema; if your column differs, update here.
    const res = await this.supabase.from(this.tables.manualSessions).select('*').order('close_time', { ascending: false });
    this._throwIfError(res);
    return (res.data || []).map((r) => this._snakeToCamel('manualSessions', r));
  }

  async deleteManualSession(id) {
    const res = await this.supabase.from(this.tables.manualSessions).delete().eq('id', id);
    this._throwIfError(res);
  }

  // Sales
  async addSale(sale) {
    const insertRow = this._camelToSnake('sales', sale);
    const res = await this.supabase.from(this.tables.sales).insert([insertRow]).select('*').single();
    this._throwIfError(res);
    return res.data?.id;
  }

  async getAllSales() {
    const res = await this.supabase.from(this.tables.sales).select('*').order('sell_datetime', { ascending: false });
    this._throwIfError(res);
    return (res.data || []).map((r) => this._snakeToCamel('sales', r));
  }

  async getSale(id) {
    const res = await this.supabase.from(this.tables.sales).select('*').eq('id', id).maybeSingle();
    this._throwIfError(res);
    return res.data ? this._snakeToCamel('sales', res.data) : null;
  }

  async updateSale(sale) {
    if (!sale || sale.id == null) throw new Error('updateSale: missing id');
    const { id, ...patch } = sale;
    const updatePatch = this._camelToSnake('sales', patch);
    const res = await this.supabase.from(this.tables.sales).update(updatePatch).eq('id', id).select('*').single();
    this._throwIfError(res);
    return res.data?.id;
  }

  async deleteSale(id) {
    const res = await this.supabase.from(this.tables.sales).delete().eq('id', id);
    this._throwIfError(res);
  }

  async getUnpaidSalesByTable(tableId) {
    const res = await this.supabase
      .from(this.tables.sales)
      .select('*')
      .eq('table_id', tableId)
      .eq('is_paid', false)
      .order('sell_datetime', { ascending: true });
    this._throwIfError(res);
    return (res.data || []).map((r) => this._snakeToCamel('sales', r));
  }

  // Customers
  async addCustomer(customer) {
    const insertRow = this._camelToSnake('customers', customer);
    const res = await this.supabase.from(this.tables.customers).insert([insertRow]).select('*').single();
    this._throwIfError(res);
    return res.data?.id;
  }

  async getAllCustomers() {
    const res = await this.supabase.from(this.tables.customers).select('*').order('name', { ascending: true });
    this._throwIfError(res);
    return (res.data || []).map((r) => this._snakeToCamel('customers', r));
  }

  async getCustomer(id) {
    const res = await this.supabase.from(this.tables.customers).select('*').eq('id', id).maybeSingle();
    this._throwIfError(res);
    return res.data ? this._snakeToCamel('customers', res.data) : null;
  }

  async updateCustomer(customer) {
    if (!customer || customer.id == null) throw new Error('updateCustomer: missing id');
    const { id, ...patch } = customer;
    const updatePatch = this._camelToSnake('customers', patch);
    const res = await this.supabase.from(this.tables.customers).update(updatePatch).eq('id', id).select('*').single();
    this._throwIfError(res);
    return res.data?.id;
  }

  async deleteCustomer(id) {
    const res = await this.supabase.from(this.tables.customers).delete().eq('id', id);
    this._throwIfError(res);
  }

  async getSalesByCustomer(customerId) {
    // Used for customer detail/balance flows in app.js
    const res = await this.supabase.from(this.tables.sales).select('*').eq('customer_id', customerId).order('sell_datetime', { ascending: false });
    this._throwIfError(res);
    return (res.data || []).map((r) => this._snakeToCamel('sales', r));
  }

  // Expenses
  async addExpense(expense) {
    const insertRow = this._camelToSnake('expenses', expense);
    const res = await this.supabase.from(this.tables.expenses).insert([insertRow]).select('*').single();
    this._throwIfError(res);
    return res.data?.id;
  }

  async getAllExpenses() {
    const res = await this.supabase.from(this.tables.expenses).select('*').order('expense_date', { ascending: false });
    this._throwIfError(res);
    return (res.data || []).map((r) => this._snakeToCamel('expenses', r));
  }

  async getExpense(id) {
    const res = await this.supabase.from(this.tables.expenses).select('*').eq('id', id).maybeSingle();
    this._throwIfError(res);
    return res.data ? this._snakeToCamel('expenses', res.data) : null;
  }

  async updateExpense(expense) {
    if (!expense || expense.id == null) throw new Error('updateExpense: missing id');
    const { id, ...patch } = expense;
    const updatePatch = this._camelToSnake('expenses', patch);
    const res = await this.supabase.from(this.tables.expenses).update(updatePatch).eq('id', id).select('*').single();
    this._throwIfError(res);
    return res.data?.id;
  }

  async deleteExpense(id) {
    const res = await this.supabase.from(this.tables.expenses).delete().eq('id', id);
    this._throwIfError(res);
  }

  // Clear all data (dangerous)
  async clearAllData() {
    // NOTE: Deleting without filters requires RLS policy that allows it.
    // We do per-table deletes.
    const deleteAll = async (tableName) => {
      // Supabase requires a filter for delete in many setups; if your RLS blocks this,
      // prefer a server-side function/edge function.
      // Here we attempt best-effort "delete all rows" by deleting where id is not null.
      const res = await this.supabase.from(tableName).delete().neq('id', null);
      this._throwIfError(res);
    };

    await deleteAll(this.tables.sales);
    await deleteAll(this.tables.tables);
    await deleteAll(this.tables.products);
    await deleteAll(this.tables.customers);
    await deleteAll(this.tables.manualSessions);
  }
}

