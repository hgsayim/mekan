// IndexedDB Database Manager
class Database {
    constructor() {
        this.db = null;
        this.dbName = 'MekanAppDB';
        this.dbVersion = 3;
    }

    async init() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(this.dbName, this.dbVersion);

            request.onerror = () => {
                reject(request.error);
            };

            request.onsuccess = () => {
                this.db = request.result;
                resolve(this.db);
            };

            request.onupgradeneeded = (event) => {
                const db = event.target.result;
                const oldVersion = event.oldVersion || 0;

                // Products store
                if (!db.objectStoreNames.contains('products')) {
                    const productStore = db.createObjectStore('products', { keyPath: 'id', autoIncrement: true });
                    productStore.createIndex('name', 'name', { unique: false });
                }

                // Tables store
                if (!db.objectStoreNames.contains('tables')) {
                    const tableStore = db.createObjectStore('tables', { keyPath: 'id', autoIncrement: true });
                    tableStore.createIndex('name', 'name', { unique: false });
                    tableStore.createIndex('isActive', 'isActive', { unique: false });
                }

                // Sales store - handle creation and upgrade separately
                if (!db.objectStoreNames.contains('sales')) {
                    // Create new sales store with all indexes
                    const salesStore = db.createObjectStore('sales', { keyPath: 'id', autoIncrement: true });
                    salesStore.createIndex('tableId', 'tableId', { unique: false });
                    salesStore.createIndex('sellDateTime', 'sellDateTime', { unique: false });
                    salesStore.createIndex('isPaid', 'isPaid', { unique: false });
                    salesStore.createIndex('customerId', 'customerId', { unique: false });
                    salesStore.createIndex('isCredit', 'isCredit', { unique: false });
                } else if (oldVersion < 2 && oldVersion > 0) {
                    // Upgrade from version 1 to 2: Add new indexes to existing sales store
                    // Access the store through the transaction (must be done synchronously in onupgradeneeded)
                    try {
                        const transaction = event.target.transaction;
                        if (transaction) {
                            try {
                                const salesStore = transaction.objectStore('sales');
                                if (salesStore) {
                                    // Get existing index names
                                    let indexNames = [];
                                    try {
                                        indexNames = Array.from(salesStore.indexNames);
                                    } catch (e) {
                                        // Ignore - will try to add indexes anyway
                                    }
                                    
                                    // Add customerId index if it doesn't exist
                                    if (!indexNames.includes('customerId')) {
                                        try {
                                            salesStore.createIndex('customerId', 'customerId', { unique: false });
                                        } catch (e) {
                                            // Index might already exist or creation failed - ignore
                                            console.warn('Could not create customerId index (may already exist):', e.message || e.name);
                                        }
                                    }
                                    
                                    // Add isCredit index if it doesn't exist
                                    if (!indexNames.includes('isCredit')) {
                                        try {
                                            salesStore.createIndex('isCredit', 'isCredit', { unique: false });
                                        } catch (e) {
                                            // Index might already exist or creation failed - ignore
                                            console.warn('Could not create isCredit index (may already exist):', e.message || e.name);
                                        }
                                    }
                                }
                            } catch (storeError) {
                                console.warn('Could not access sales store during upgrade:', storeError.message || storeError.name);
                            }
                        }
                    } catch (e) {
                        // If upgrade fails, log but don't throw - app can still function without these indexes
                        console.warn('Error during sales store upgrade (non-fatal):', e.message || e.name);
                    }
                }

                // Customers store
                if (!db.objectStoreNames.contains('customers')) {
                    const customerStore = db.createObjectStore('customers', { keyPath: 'id', autoIncrement: true });
                    customerStore.createIndex('name', 'name', { unique: false });
                }

                // Manual hourly sessions store (for report backfill when device was off)
                if (!db.objectStoreNames.contains('manualSessions')) {
                    const manualStore = db.createObjectStore('manualSessions', { keyPath: 'id', autoIncrement: true });
                    manualStore.createIndex('type', 'type', { unique: false });
                    manualStore.createIndex('closeTime', 'closeTime', { unique: false });
                }
            };
        });
    }

    // Products CRUD
    async addProduct(product) {
        const transaction = this.db.transaction(['products'], 'readwrite');
        const store = transaction.objectStore('products');
        const request = store.add(product);
        
        return new Promise((resolve, reject) => {
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }

    async getAllProducts() {
        const transaction = this.db.transaction(['products'], 'readonly');
        const store = transaction.objectStore('products');
        const request = store.getAll();
        
        return new Promise((resolve, reject) => {
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }

    async getProduct(id) {
        const transaction = this.db.transaction(['products'], 'readonly');
        const store = transaction.objectStore('products');
        const request = store.get(id);
        
        return new Promise((resolve, reject) => {
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }

    async updateProduct(product) {
        const transaction = this.db.transaction(['products'], 'readwrite');
        const store = transaction.objectStore('products');
        const request = store.put(product);
        
        return new Promise((resolve, reject) => {
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }

    async deleteProduct(id) {
        const transaction = this.db.transaction(['products'], 'readwrite');
        const store = transaction.objectStore('products');
        const request = store.delete(id);
        
        return new Promise((resolve, reject) => {
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
    }

    // Tables CRUD
    async addTable(table) {
        const transaction = this.db.transaction(['tables'], 'readwrite');
        const store = transaction.objectStore('tables');
        const request = store.add(table);
        
        return new Promise((resolve, reject) => {
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }

    async getAllTables() {
        const transaction = this.db.transaction(['tables'], 'readonly');
        const store = transaction.objectStore('tables');
        const request = store.getAll();
        
        return new Promise((resolve, reject) => {
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }

    async getTable(id) {
        const transaction = this.db.transaction(['tables'], 'readonly');
        const store = transaction.objectStore('tables');
        const request = store.get(id);
        
        return new Promise((resolve, reject) => {
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }

    async updateTable(table) {
        const transaction = this.db.transaction(['tables'], 'readwrite');
        const store = transaction.objectStore('tables');
        const request = store.put(table);
        
        return new Promise((resolve, reject) => {
            let result;
            request.onsuccess = () => { result = request.result; };
            request.onerror = () => reject(request.error);
            transaction.oncomplete = () => resolve(result);
            transaction.onerror = () => reject(transaction.error || request.error);
            transaction.onabort = () => reject(transaction.error || request.error);
        });
    }

    async deleteTable(id) {
        const transaction = this.db.transaction(['tables'], 'readwrite');
        const store = transaction.objectStore('tables');
        const request = store.delete(id);
        
        return new Promise((resolve, reject) => {
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
    }

    // Manual Sessions CRUD (for reporting)
    async addManualSession(session) {
        const transaction = this.db.transaction(['manualSessions'], 'readwrite');
        const store = transaction.objectStore('manualSessions');
        const request = store.add(session);

        return new Promise((resolve, reject) => {
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }

    async getAllManualSessions() {
        const transaction = this.db.transaction(['manualSessions'], 'readonly');
        const store = transaction.objectStore('manualSessions');
        const request = store.getAll();

        return new Promise((resolve, reject) => {
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }

    async deleteManualSession(id) {
        const transaction = this.db.transaction(['manualSessions'], 'readwrite');
        const store = transaction.objectStore('manualSessions');
        const request = store.delete(id);

        return new Promise((resolve, reject) => {
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
    }

    // Sales CRUD
    async addSale(sale) {
        const transaction = this.db.transaction(['sales'], 'readwrite');
        const store = transaction.objectStore('sales');
        const request = store.add(sale);
        
        return new Promise((resolve, reject) => {
            request.onsuccess = () => {
                resolve(request.result);
            };
            request.onerror = () => {
                reject(request.error);
            };
        });
    }

    async getAllSales() {
        const transaction = this.db.transaction(['sales'], 'readonly');
        const store = transaction.objectStore('sales');
        const request = store.getAll();
        
        return new Promise((resolve, reject) => {
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }

    async getSale(id) {
        const transaction = this.db.transaction(['sales'], 'readonly');
        const store = transaction.objectStore('sales');
        const request = store.get(id);
        
        return new Promise((resolve, reject) => {
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }

    async updateSale(sale) {
        const transaction = this.db.transaction(['sales'], 'readwrite');
        const store = transaction.objectStore('sales');
        const request = store.put(sale);
        
        return new Promise((resolve, reject) => {
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }

    async deleteSale(id) {
        const transaction = this.db.transaction(['sales'], 'readwrite');
        const store = transaction.objectStore('sales');
        const request = store.delete(id);
        
        return new Promise((resolve, reject) => {
            request.onerror = () => reject(request.error);
            transaction.oncomplete = () => resolve();
            transaction.onerror = () => reject(transaction.error || request.error);
            transaction.onabort = () => reject(transaction.error || request.error);
        });
    }

    async getUnpaidSalesByTable(tableId) {
        const transaction = this.db.transaction(['sales'], 'readonly');
        const store = transaction.objectStore('sales');
        const index = store.index('tableId');
        
        return new Promise((resolve, reject) => {
            const request = index.getAll(tableId);
            request.onsuccess = () => {
                const sales = request.result.filter(sale => !sale.isPaid);
                resolve(sales);
            };
            request.onerror = () => {
                reject(request.error);
            };
        });
    }

    // Customers CRUD
    async addCustomer(customer) {
        // Check if customers store exists
        if (!this.db || !this.db.objectStoreNames || !this.db.objectStoreNames.contains('customers')) {
            throw new Error('Customers store does not exist. Please refresh the page to initialize the database.');
        }
        
        const transaction = this.db.transaction(['customers'], 'readwrite');
        const store = transaction.objectStore('customers');
        const request = store.add(customer);
        
        return new Promise((resolve, reject) => {
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => {
                console.error('Error adding customer:', request.error);
                reject(request.error);
            };
        });
    }

    async getAllCustomers() {
        // Check if customers store exists
        if (!this.db || !this.db.objectStoreNames || !this.db.objectStoreNames.contains('customers')) {
            return []; // Return empty array if store doesn't exist yet
        }
        
        const transaction = this.db.transaction(['customers'], 'readonly');
        const store = transaction.objectStore('customers');
        const request = store.getAll();
        
        return new Promise((resolve, reject) => {
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }

    async getCustomer(id) {
        // Check if customers store exists
        if (!this.db || !this.db.objectStoreNames || !this.db.objectStoreNames.contains('customers')) {
            return null; // Return null if store doesn't exist
        }
        
        const transaction = this.db.transaction(['customers'], 'readonly');
        const store = transaction.objectStore('customers');
        const request = store.get(id);
        
        return new Promise((resolve, reject) => {
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => {
                console.error('Error getting customer:', request.error);
                reject(request.error);
            };
        });
    }

    async updateCustomer(customer) {
        // Check if customers store exists
        if (!this.db || !this.db.objectStoreNames || !this.db.objectStoreNames.contains('customers')) {
            throw new Error('Customers store does not exist. Please refresh the page to initialize the database.');
        }
        
        const transaction = this.db.transaction(['customers'], 'readwrite');
        const store = transaction.objectStore('customers');
        const request = store.put(customer);
        
        return new Promise((resolve, reject) => {
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => {
                console.error('Error updating customer:', request.error);
                reject(request.error);
            };
        });
    }

    async deleteCustomer(id) {
        // Check if customers store exists
        if (!this.db || !this.db.objectStoreNames || !this.db.objectStoreNames.contains('customers')) {
            throw new Error('Customers store does not exist. Please refresh the page to initialize the database.');
        }
        
        const transaction = this.db.transaction(['customers'], 'readwrite');
        const store = transaction.objectStore('customers');
        const request = store.delete(id);
        
        return new Promise((resolve, reject) => {
            request.onsuccess = () => resolve();
            request.onerror = () => {
                console.error('Error deleting customer:', request.error);
                reject(request.error);
            };
        });
    }

    async getSalesByCustomer(customerId) {
        // Check if sales store and customerId index exist
        if (!this.db || !this.db.objectStoreNames || !this.db.objectStoreNames.contains('sales')) {
            return [];
        }
        
        const transaction = this.db.transaction(['sales'], 'readonly');
        const store = transaction.objectStore('sales');
        
        // Check if customerId index exists, if not, filter manually
        try {
            const index = store.index('customerId');
            const request = index.getAll(customerId);
            
            return new Promise((resolve, reject) => {
                request.onsuccess = () => resolve(request.result);
                request.onerror = () => {
                    // If index doesn't exist, filter manually
                    const getAllRequest = store.getAll();
                    getAllRequest.onsuccess = () => {
                        const allSales = getAllRequest.result;
                        const filtered = allSales.filter(sale => sale.customerId === customerId);
                        resolve(filtered);
                    };
                    getAllRequest.onerror = () => reject(getAllRequest.error);
                };
            });
        } catch (e) {
            // Index doesn't exist, filter manually
            const request = store.getAll();
            return new Promise((resolve, reject) => {
                request.onsuccess = () => {
                    const allSales = request.result;
                    const filtered = allSales.filter(sale => sale.customerId === customerId);
                    resolve(filtered);
                };
                request.onerror = () => reject(request.error);
            });
        }
    }

    // Clear all data from all stores
    async clearAllData() {
        const stores = ['products', 'tables', 'sales', 'customers'];
        const promises = stores.map(storeName => {
            return new Promise((resolve, reject) => {
                // Check if store exists before trying to clear it
                if (!this.db.objectStoreNames.contains(storeName)) {
                    resolve(); // Store doesn't exist, nothing to clear
                    return;
                }
                
                try {
                    const transaction = this.db.transaction([storeName], 'readwrite');
                    const store = transaction.objectStore(storeName);
                    const request = store.clear();
                    
                    request.onsuccess = () => resolve();
                    request.onerror = () => reject(request.error);
                } catch (e) {
                    console.warn(`Could not clear store ${storeName}:`, e);
                    resolve(); // Continue even if one store fails
                }
            });
        });
        
        await Promise.all(promises);
    }
}

// Export for use in other files
window.Database = Database;
