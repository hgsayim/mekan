// Main Application Logic
// Loaded as a module (see index.html) for Supabase ESM import.

import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './supabase-config.js';
import { SupabaseDatabase } from './supabase-db.js';

function setAuthError(message) {
    const el = document.getElementById('auth-error');
    if (!el) return;
    if (!message) {
        el.style.display = 'none';
        el.textContent = '';
        return;
    }
    el.style.display = 'block';
    el.textContent = message;
}

function showAuthModal(show) {
    const modal = document.getElementById('auth-modal');
    if (!modal) return;
    modal.style.display = show ? 'block' : 'none';
    if (show) {
        modal.classList.add('active');
    } else {
        modal.classList.remove('active');
        setAuthError('');
    }
}

async function ensureSignedIn(supabase) {
    const { data, error } = await supabase.auth.getSession();
    if (error) {
        console.error('Auth session error:', error);
    }
    const session = data?.session || null;
    if (session) return session;

    showAuthModal(true);

    const loginBtn = document.getElementById('auth-login-btn');
    const loginText = document.getElementById('auth-login-text');
    const loginSpinner = document.getElementById('auth-login-spinner');
    const emailEl = document.getElementById('auth-email');
    const passEl = document.getElementById('auth-password');
    const formEl = document.getElementById('auth-form');
    const toggleBtn = document.getElementById('auth-toggle-password');

    return await new Promise((resolve) => {
        const handler = async () => {
            const email = (emailEl?.value || '').trim();
            const password = passEl?.value || '';
            if (!email || !password) {
                setAuthError('Email ve şifre girin.');
                return;
            }
            setAuthError('');
            loginBtn.disabled = true;
            if (loginSpinner) loginSpinner.style.display = 'inline-block';
            if (loginText) loginText.textContent = 'Giriş yapılıyor...';
            try {
                const { data: signInData, error: signInError } = await supabase.auth.signInWithPassword({ email, password });
                if (signInError) {
                    setAuthError(signInError.message || 'Giriş başarısız.');
                    loginBtn.disabled = false;
                    if (loginSpinner) loginSpinner.style.display = 'none';
                    if (loginText) loginText.textContent = 'Giriş Yap';
                    return;
                }
                showAuthModal(false);
                resolve(signInData.session);
            } catch (e) {
                setAuthError(e?.message || 'Giriş başarısız.');
                loginBtn.disabled = false;
                if (loginSpinner) loginSpinner.style.display = 'none';
                if (loginText) loginText.textContent = 'Giriş Yap';
            }
        };

        if (toggleBtn && passEl) {
            toggleBtn.addEventListener('click', () => {
                const isHidden = passEl.type === 'password';
                passEl.type = isHidden ? 'text' : 'password';
                toggleBtn.textContent = isHidden ? 'Gizle' : 'Göster';
            });
        }

        if (formEl) {
            formEl.addEventListener('submit', (e) => {
                e.preventDefault();
                handler();
            });
        }
        // Keep click too (in case form is not found)
        if (loginBtn) loginBtn.addEventListener('click', handler);

        // Also allow Enter key
        const keyHandler = (e) => {
            if (e.key === 'Enter') handler();
        };
        if (emailEl) emailEl.addEventListener('keydown', keyHandler);
        if (passEl) passEl.addEventListener('keydown', keyHandler);
    });
}

class MekanApp {
    constructor() {
        this.supabase = window.supabase;
        this.db = new SupabaseDatabase(this.supabase);
        this.currentView = 'tables';
        this.currentTableId = null;
        this.pendingDelayedStartTableId = null;
        this._dialog = null;
        this._dialogResolver = null;
        this.hourlyUpdateInterval = null;
        this.tableCardUpdateInterval = null;
        this.footerTimeUpdateInterval = null;
        this.dailyResetInterval = null;
        this.init();
    }

    async init() {
        try {
            await this.db.init();
            this.setupEventListeners();
            await this.loadInitialData();
            this.startFooterUpdates();
            this.startDailyReset();
            
            // Handle page visibility changes (screen lock/unlock on tablets)
            document.addEventListener('visibilitychange', () => {
                if (!document.hidden) {
                    // Page is now visible - refresh data
                    this.handlePageVisible();
        }
            });
            
            // Also handle focus/blur for additional reliability
            window.addEventListener('focus', () => {
                this.handlePageVisible();
            });
            
            // Clean up intervals on page unload
            window.addEventListener('beforeunload', () => {
                this.stopTableCardPriceUpdates();
                if (this.hourlyUpdateInterval) {
                    clearInterval(this.hourlyUpdateInterval);
                }
                if (this.footerTimeUpdateInterval) {
                    clearInterval(this.footerTimeUpdateInterval);
                }
                if (this.dailyResetInterval) {
                    clearInterval(this.dailyResetInterval);
                }
            });
            
            // Sample data initialization removed - add tables and products manually
        } catch (error) {
            console.error('Uygulama başlatılırken hata:', error);
            await this.appAlert('Uygulama başlatılırken hata oluştu: ' + error.message + '. Lütfen sayfayı yenileyin.', 'Hata');
        }
    }

    // Clear all data from database
    async clearAllData() {
        if (!(await this.appConfirm('TÜM verileri silmek istediğinize emin misiniz? Bu işlem geri alınamaz.', { title: 'Silme Onayı', confirmText: 'Sil', cancelText: 'Vazgeç', confirmVariant: 'danger' }))) {
            return;
        }

        try {
            await this.db.clearAllData();
            await this.appAlert('Tüm veriler başarıyla temizlendi!', 'Başarılı');
            // Reload views to reflect empty state
            await this.reloadViews(['tables', 'products', 'sales', 'daily']);
        } catch (error) {
            console.error('Veri temizlenirken hata:', error);
            await this.appAlert('Veri temizlenirken hata oluştu. Lütfen tekrar deneyin.', 'Hata');
        }
    }

    setupEventListeners() {
        this.initAppDialog();

        // Header logo/title click - go to tables view
        const headerTitle = document.querySelector('header h1');
        if (headerTitle) {
            headerTitle.style.cursor = 'pointer';
            headerTitle.addEventListener('click', () => {
                this.switchView('tables');
            });
        }

        // Add Table button
        const addTableBtn = document.getElementById('add-table-btn');
        if (addTableBtn) {
            addTableBtn.addEventListener('click', () => {
            this.openTableFormModal();
        });
        }

        // Add Product button
        const addProductBtn = document.getElementById('add-product-btn');
        if (addProductBtn) {
            addProductBtn.addEventListener('click', () => {
            this.openProductFormModal();
        });
        }

        // Menu toggle
        const menuToggle = document.getElementById('menu-toggle');
        const menuDropdown = document.getElementById('menu-dropdown');
        if (menuToggle && menuDropdown) {
            menuToggle.addEventListener('click', (e) => {
                e.stopPropagation();
                menuDropdown.classList.toggle('show');
            });
            
            // Close menu when clicking outside
            document.addEventListener('click', (e) => {
                if (!menuToggle.contains(e.target) && !menuDropdown.contains(e.target)) {
                    menuDropdown.classList.remove('show');
                }
            });
        }

        // Navigation buttons (compact menu)
        document.querySelectorAll('.nav-btn-compact').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const viewName = e.target.getAttribute('data-view');
                if (viewName) {
                    // Close menu after selection
                    if (menuDropdown) {
                        menuDropdown.classList.remove('show');
                    }
                    this.switchView(viewName);
                }
            });
        });

        // Add Customer button
        const addCustomerBtn = document.getElementById('add-customer-btn');
        if (addCustomerBtn) {
            addCustomerBtn.addEventListener('click', () => {
                this.openCustomerFormModal();
            });
        }

        // Table form
        const tableForm = document.getElementById('table-form');
        if (tableForm) {
            tableForm.addEventListener('submit', (e) => {
            e.preventDefault();
            this.saveTable();
        });
        }

        // Product form
        const productForm = document.getElementById('product-form');
        if (productForm) {
            productForm.addEventListener('submit', (e) => {
            e.preventDefault();
            this.saveProduct();
        });
        }

        // Add product to table form
        const addProductTableForm = document.getElementById('add-product-table-form');
        if (addProductTableForm) {
            addProductTableForm.addEventListener('submit', async (e) => {
            e.preventDefault();
                e.stopPropagation();
                await this.addProductToTable();
        });
        }

        // Table type change handler
        const tableType = document.getElementById('table-type');
        if (tableType) {
            tableType.addEventListener('change', (e) => {
            const hourlyRateLabel = document.getElementById('hourly-rate-label');
                const hourlyRateInput = document.getElementById('table-hourly-rate');
                const iconLabel = document.getElementById('table-icon-label');
                const iconSelect = document.getElementById('table-icon');
                
            if (e.target.value === 'hourly') {
                    if (hourlyRateLabel) hourlyRateLabel.style.display = 'block';
                    if (hourlyRateInput) hourlyRateInput.required = true;
                    // Icon label is always visible now
            } else {
                    if (hourlyRateLabel) hourlyRateLabel.style.display = 'none';
                    if (hourlyRateInput) hourlyRateInput.required = false;
                    // Icon label is always visible now
            }
        });
        }

        // Close modals
        document.querySelectorAll('.close').forEach(closeBtn => {
            closeBtn.addEventListener('click', (e) => {
                const modal = e.target.closest('.modal');
                // App dialog has its own close logic (must resolve promise)
                if (modal && modal.id === 'app-dialog') {
                    return;
                }
                if (modal && modal.id === 'table-modal') {
                    this.closeTableModal();
                } else if (modal && modal.id === 'add-product-table-modal') {
                    this.closeAddProductModal();
                } else if (modal) {
                    modal.classList.remove('active');
                }
            });
        });

        // Cancel buttons
        const cancelProductBtn = document.getElementById('cancel-product-btn');
        if (cancelProductBtn) {
            cancelProductBtn.addEventListener('click', () => {
                const productModal = document.getElementById('product-modal');
                if (productModal) productModal.classList.remove('active');
        });
        }

        // Delayed start (hourly tables)
        const delayedStartConfirmBtn = document.getElementById('delayed-start-confirm-btn');
        if (delayedStartConfirmBtn) {
            delayedStartConfirmBtn.addEventListener('click', async () => {
                await this.applyDelayedStart();
            });
        }

        const delayedStartCancelBtn = document.getElementById('delayed-start-cancel-btn');
        if (delayedStartCancelBtn) {
            delayedStartCancelBtn.addEventListener('click', () => {
                this.closeDelayedStartModal();
            });
        }

        // Manual session (report backfill)
        const addManualSessionBtn = document.getElementById('add-manual-session-btn');
        if (addManualSessionBtn) {
            addManualSessionBtn.addEventListener('click', async () => {
                await this.openManualSessionModal();
            });
        }

        const manualSessionCancelBtn = document.getElementById('manual-session-cancel-btn');
        if (manualSessionCancelBtn) {
            manualSessionCancelBtn.addEventListener('click', () => {
                this.closeManualSessionModal();
            });
        }

        const manualSessionForm = document.getElementById('manual-session-form');
        if (manualSessionForm) {
            manualSessionForm.addEventListener('submit', async (e) => {
                e.preventDefault();
                await this.saveManualSession();
            });
        }

        const manualSessionTableSelect = document.getElementById('manual-session-table');
        if (manualSessionTableSelect) {
            manualSessionTableSelect.addEventListener('change', async () => {
                await this.onManualSessionTableChanged();
            });
        }

        ['manual-session-start', 'manual-session-end', 'manual-session-auto-amount']
            .forEach((id) => {
                const el = document.getElementById(id);
                if (el) {
                    el.addEventListener('change', () => this.recalculateManualAmount());
                    el.addEventListener('input', () => this.recalculateManualAmount());
                }
            });

        const cancelTableFormBtn = document.getElementById('cancel-table-form-btn');
        if (cancelTableFormBtn) {
            cancelTableFormBtn.addEventListener('click', () => {
                const tableFormModal = document.getElementById('table-form-modal');
                if (tableFormModal) tableFormModal.classList.remove('active');
        });
        }

        const cancelAddProductTableBtn = document.getElementById('cancel-add-product-table-btn');
        if (cancelAddProductTableBtn) {
            cancelAddProductTableBtn.addEventListener('click', () => {
                this.closeAddProductModal();
            });
        }

        // Table actions (open-table-btn removed - hourly tables now use double-tap on card)
        const payTableBtn = document.getElementById('pay-table-btn');
        if (payTableBtn) {
            payTableBtn.addEventListener('click', () => {
                this.payTable();
            });
        }

        const creditTableBtn = document.getElementById('credit-table-btn');
        if (creditTableBtn) {
            creditTableBtn.addEventListener('click', () => {
                this.creditTable();
            });
        }

        const cancelHourlyBtn = document.getElementById('cancel-hourly-btn');
        if (cancelHourlyBtn) {
            cancelHourlyBtn.addEventListener('click', async (e) => {
                e.preventDefault();
                e.stopPropagation();
                await this.cancelHourlyGame();
            });
        }

        // Receipt modal buttons
        const cancelReceiptBtn = document.getElementById('cancel-receipt-btn');
        if (cancelReceiptBtn) {
            cancelReceiptBtn.addEventListener('click', () => {
                const receiptModal = document.getElementById('receipt-modal');
                if (receiptModal) receiptModal.classList.remove('active');
        });
        }

        const confirmPaymentBtn = document.getElementById('confirm-payment-btn');
        if (confirmPaymentBtn) {
            confirmPaymentBtn.addEventListener('click', () => {
                this.processPayment();
            });
        }

        const confirmCreditBtn = document.getElementById('confirm-credit-btn');
        if (confirmCreditBtn) {
            confirmCreditBtn.addEventListener('click', () => {
                this.openCustomerSelectionModalForReceipt();
            });
        }

        // Close receipt modal on X click
        const receiptModal = document.getElementById('receipt-modal');
        if (receiptModal) {
            const receiptCloseBtn = receiptModal.querySelector('.close');
            if (receiptCloseBtn) {
                receiptCloseBtn.addEventListener('click', () => {
                    receiptModal.classList.remove('active');
                });
            }
        }

        // Customer form
        const customerForm = document.getElementById('customer-form');
        if (customerForm) {
            customerForm.addEventListener('submit', (e) => {
                e.preventDefault();
                this.saveCustomer();
            });
        }

        // Customer payment form
        const customerPaymentForm = document.getElementById('customer-payment-form');
        if (customerPaymentForm) {
            customerPaymentForm.addEventListener('submit', (e) => {
                e.preventDefault();
                this.processCustomerPayment();
        });
        }

        // Cancel customer button
        const cancelCustomerBtn = document.getElementById('cancel-customer-btn');
        if (cancelCustomerBtn) {
            cancelCustomerBtn.addEventListener('click', () => {
                const customerModal = document.getElementById('customer-modal');
                if (customerModal) customerModal.classList.remove('active');
            });
        }

        // Pay full amount button
        const payFullAmountBtn = document.getElementById('pay-full-amount-btn');
        if (payFullAmountBtn) {
            payFullAmountBtn.addEventListener('click', () => {
                this.payFullCustomerBalance();
        });
        }

        // Cancel customer payment button
        const cancelCustomerPaymentBtn = document.getElementById('cancel-customer-payment-btn');
        if (cancelCustomerPaymentBtn) {
            cancelCustomerPaymentBtn.addEventListener('click', () => {
                const customerPaymentModal = document.getElementById('customer-payment-modal');
                if (customerPaymentModal) customerPaymentModal.classList.remove('active');
        });
        }

        // Report date range controls
        const reportApplyBtn = document.getElementById('report-apply-btn');
        const reportTodayBtn = document.getElementById('report-today-btn');
        
        if (reportApplyBtn) {
            reportApplyBtn.addEventListener('click', () => {
                this.loadDailyDashboard();
            });
        }
        
        if (reportTodayBtn) {
            reportTodayBtn.addEventListener('click', () => {
                this.setTodayDateRange();
                this.loadDailyDashboard();
        });
        }
        
        // Initialize date inputs with today's range
        this.setTodayDateRange();

        // Product select change handler
        const productSelect = document.getElementById('product-select');
        if (productSelect) {
            productSelect.addEventListener('change', async (e) => {
            const productId = e.target.value;
            if (productId) {
                    try {
                const product = await this.db.getProduct(productId);
                const stockInfo = document.getElementById('product-stock-info');
                        const productAmount = document.getElementById('product-amount');
                        if (product && stockInfo) {
                            if (!this.tracksStock(product)) {
                                stockInfo.innerHTML = `<p style="color: var(--success-color);">Stock: ∞</p>`;
                                if (productAmount) productAmount.removeAttribute('max');
                            } else if (product.stock > 0) {
                        stockInfo.innerHTML = `<p style="color: var(--success-color);">Stock: ${product.stock}</p>`;
                                if (productAmount) productAmount.max = product.stock;
                    } else {
                        stockInfo.innerHTML = `<p style="color: var(--danger-color);">Out of stock!</p>`;
                                if (productAmount) productAmount.max = 0;
                    }
                        }
                    } catch (error) {
                        console.error('Error loading product:', error);
                }
            }
        });
        }

        // Sales filters
        const salesTableFilter = document.getElementById('sales-table-filter');
        if (salesTableFilter) {
            salesTableFilter.addEventListener('change', () => {
            this.filterSales();
        });
        }

        const salesStatusFilter = document.getElementById('sales-status-filter');
        if (salesStatusFilter) {
            salesStatusFilter.addEventListener('change', () => {
            this.filterSales();
        });
        }

        // Close modal on outside click
        window.addEventListener('click', (e) => {
            if (e.target.classList.contains('modal')) {
                if (e.target.id === 'app-dialog') {
                    // Handled by app dialog itself
                    return;
                }
                if (e.target.id === 'table-modal') {
                    this.closeTableModal();
                } else {
                    e.target.classList.remove('active');
                }
            }
        });

        // Close customer selection modal on close button click
        document.querySelectorAll('.modal .close').forEach(closeBtn => {
            closeBtn.addEventListener('click', (e) => {
                const modal = e.target.closest('.modal');
                if (modal && modal.id === 'app-dialog') {
                    // Handled by app dialog itself
                    return;
                }
                if (modal) {
                    modal.classList.remove('active');
                }
            });
        });
    }

    initAppDialog() {
        if (this._dialog) return;
        const modal = document.getElementById('app-dialog');
        const titleEl = document.getElementById('app-dialog-title');
        const messageEl = document.getElementById('app-dialog-message');
        const confirmBtn = document.getElementById('app-dialog-confirm-btn');
        const cancelBtn = document.getElementById('app-dialog-cancel-btn');
        const closeBtn = document.getElementById('app-dialog-close');
        if (!modal || !titleEl || !messageEl || !confirmBtn || !cancelBtn || !closeBtn) return;

        this._dialog = { modal, titleEl, messageEl, confirmBtn, cancelBtn, closeBtn };

        const closeWith = (value) => {
            if (!this._dialogResolver) return;
            const resolver = this._dialogResolver;
            this._dialogResolver = null;
            // Avoid aria-hidden warning: blur focus inside modal before hiding it
            try {
                const activeEl = document.activeElement;
                if (activeEl && modal.contains(activeEl)) {
                    activeEl.blur();
                }
            } catch (e) {
                // ignore
            }
            modal.classList.remove('active');
            modal.setAttribute('aria-hidden', 'true');
            resolver(value);
        };

        confirmBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            closeWith(true);
        });
        cancelBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            closeWith(false);
        });
        closeBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            closeWith(false);
        });
        modal.addEventListener('click', (e) => {
            // Clicking backdrop closes like cancel
            if (e.target === modal) closeWith(false);
        });
        window.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && modal.classList.contains('active')) {
                closeWith(false);
            }
        });
    }

    async appAlert(message, title = 'Uyarı') {
        await this.appDialog({ mode: 'alert', title, message });
    }

    async appConfirm(message, { title = 'Onay', confirmText = 'Evet', cancelText = 'Vazgeç', confirmVariant = 'primary' } = {}) {
        return await this.appDialog({ mode: 'confirm', title, message, confirmText, cancelText, confirmVariant });
    }

    appDialog({ mode = 'alert', title = 'Uyarı', message = '', confirmText = 'Tamam', cancelText = 'İptal', confirmVariant = 'primary' } = {}) {
        this.initAppDialog();
        if (!this._dialog) return Promise.resolve(mode === 'confirm' ? false : true);
        const { modal, titleEl, messageEl, confirmBtn, cancelBtn } = this._dialog;

        // Reset buttons
        confirmBtn.classList.remove('btn-danger', 'btn-primary');
        confirmBtn.classList.add(confirmVariant === 'danger' ? 'btn-danger' : 'btn-primary');
        confirmBtn.textContent = confirmText;
        cancelBtn.textContent = cancelText;
        cancelBtn.style.display = mode === 'confirm' ? 'inline-flex' : 'none';

        titleEl.textContent = title;
        messageEl.textContent = message;

        modal.classList.add('active');
        modal.setAttribute('aria-hidden', 'false');

        return new Promise((resolve) => {
            this._dialogResolver = resolve;
        });
    }

    async loadInitialData() {
        try {
            await this.ensureInstantSaleTable();
            await this.reloadViews(['tables', 'products', 'customers', 'sales']);
            
            // Start auto-update for table cards if we're on the tables view (default view)
            if (this.currentView === 'tables') {
                this.startTableCardPriceUpdates();
            }
        } catch (error) {
            console.error('Error loading initial data:', error, error?.message, error?.details, error?.hint, error?.code);
            // Continue anyway - some data might still load
        }
    }

    async ensureInstantSaleTable() {
        // Check if "ANLIK SATIŞ" table exists
        const tables = await this.db.getAllTables();
        const instantTable = tables.find(t => t.name === 'ANLIK SATIŞ');
        
        if (!instantTable) {
            // Create instant sale table
            const instantTableData = {
                name: 'ANLIK SATIŞ',
                type: 'instant',
                icon: '⚡',
                isActive: false,
                salesTotal: 0,
                checkTotal: 0,
                hourlyRate: 0,
                hourlyTotal: 0
            };
            await this.db.addTable(instantTableData);
        }
    }

    switchView(viewName) {
        // Update navigation (compact menu)
        document.querySelectorAll('.nav-btn-compact').forEach(btn => {
            btn.classList.remove('active');
        });
        const navBtn = document.querySelector(`[data-view="${viewName}"]`);
        if (navBtn) {
            navBtn.classList.add('active');
        }

        // Update views
        document.querySelectorAll('.view').forEach(view => {
            view.classList.remove('active');
        });
        const viewElement = document.getElementById(`${viewName}-view`);
        if (viewElement) {
            viewElement.classList.add('active');
        }

        this.currentView = viewName;

        // Load data for the view
        if (viewName === 'tables') {
            this.loadTables();
            // Start auto-update for table cards when on tables view
            this.startTableCardPriceUpdates();
        } else if (viewName === 'customers') {
            this.loadCustomers();
            // Stop auto-update when not on tables view
            this.stopTableCardPriceUpdates();
        } else if (viewName === 'sales') {
            this.loadSales();
            // Stop auto-update when not on tables view
            this.stopTableCardPriceUpdates();
        } else if (viewName === 'daily') {
            this.loadDailyDashboard();
            // Stop auto-update when not on tables view
            this.stopTableCardPriceUpdates();
        } else {
            // Stop auto-update for other views
            this.stopTableCardPriceUpdates();
        }
    }

    // Tables Management
    async loadTables() {
        let tables = await this.db.getAllTables();
        const container = document.getElementById('tables-container');
        
        if (!container) {
            console.error('Tables container not found');
            return;
        }
        
        if (tables.length === 0) {
            container.innerHTML = '<div class="empty-state"><h3>No tables found</h3><p>Add a new table to get started</p></div>';
            return;
        }

        // Sort tables: instant table first, then hourly tables, then regular tables
        tables.sort((a, b) => {
            // Instant table always first
            if (a.type === 'instant' && b.type !== 'instant') return -1;
            if (a.type !== 'instant' && b.type === 'instant') return 1;
            
            // If both are instant, keep order
            if (a.type === 'instant' && b.type === 'instant') {
                return a.name === 'ANLIK SATIŞ' ? -1 : 1;
            }
            
            // Then hourly tables before regular
            if (a.type === 'hourly' && b.type !== 'hourly') return -1;
            if (a.type !== 'hourly' && b.type === 'hourly') return 1;
            
            // If same type, sort alphabetically by name
            return a.name.localeCompare(b.name, 'tr', { sensitivity: 'base' });
        });

        // Sync each table's status with unpaid sales - but hourly tables must be manually opened
        for (const table of tables) {
            const unpaidSales = await this.db.getUnpaidSalesByTable(table.id);
            let tableUpdated = false;
            
            if (unpaidSales.length > 0 && !table.isActive) {
                // Table has products but is not active - activate it only for regular tables
                // Hourly tables must be manually opened via "Open Table" button
                if (table.type !== 'hourly') {
                    table.isActive = true;
                    tableUpdated = true;
                }
            } else if (unpaidSales.length === 0 && table.isActive) {
                // Table has no unpaid sales - must be inactive
                // BUT for hourly tables that were manually opened (have openTime), keep them active
                if (table.type === 'hourly' && table.openTime) {
                    // Manually opened hourly table - keep it active, just update totals
                    table.hourlyTotal = this.calculateHourlyTotal(table);
                    table.checkTotal = this.calculateCheckTotal(table);
                    tableUpdated = true;
                } else {
                    // Regular table or auto-activated table - deactivate
                    table.isActive = false;
                    table.salesTotal = 0;
                    if (table.type === 'hourly') {
                        table.hourlyTotal = 0;
                        table.openTime = null;
                    }
                    table.checkTotal = 0;
                    tableUpdated = true;
                }
            } else if (unpaidSales.length === 0 && !table.isActive && (table.salesTotal > 0 || table.hourlyTotal > 0)) {
                // Table is inactive but has totals - reset them
                // BUT don't reset if it's a manually opened hourly table (shouldn't happen but safety check)
                if (table.type !== 'hourly' || !table.openTime) {
                    table.salesTotal = 0;
                    table.hourlyTotal = 0;
                    table.checkTotal = 0;
                    table.openTime = null;
                    tableUpdated = true;
                }
            }
            
            if (tableUpdated) {
                await this.db.updateTable(table);
                // Reload table to get updated data
                const updatedTable = await this.db.getTable(table.id);
                Object.assign(table, updatedTable);
            }
        }

        // Create table cards - need to await async createTableCard
        const tableCards = await Promise.all(tables.map(table => this.createTableCard(table)));
        container.innerHTML = tableCards.join('');
        
        // Add click listeners - special handling for hourly tables
        tables.forEach(table => {
            const card = document.getElementById(`table-${table.id}`);
            if (!card) return;

            // Delayed start icon (hourly tables)
            const delayBtn = card.querySelector('.table-delay-btn');
            if (delayBtn) {
                delayBtn.addEventListener('click', async (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    await this.openDelayedStartModal(table.id);
                });
            }
            
            // Long press (3 seconds) to delete table
            let pressTimer = null;
            let hasLongPressed = false;
            const longPressDelay = 3000; // 3 seconds
            
            const startLongPress = () => {
                hasLongPressed = false;
                // Don't allow deleting instant sale table
                if (table.type === 'instant') {
                    return;
                }
                pressTimer = setTimeout(async () => {
                    hasLongPressed = true;
                    if (await this.appConfirm(`"${table.name}" masasını silmek istediğinize emin misiniz?`, { title: 'Masa Sil', confirmText: 'Sil', cancelText: 'Vazgeç', confirmVariant: 'danger' })) {
                        try {
                            await this.db.deleteTable(table.id);
                            await this.loadTables();
                            if (this.currentView === 'daily') {
                                await this.loadDailyDashboard();
                            }
                        } catch (error) {
                            console.error('Masa silinirken hata:', error);
                            await this.appAlert('Masa silinirken hata oluştu. Lütfen tekrar deneyin.', 'Hata');
                        }
                    }
                    // Reset flag after a short delay to allow cleanup
                    setTimeout(() => {
                        hasLongPressed = false;
                    }, 100);
                }, longPressDelay);
            };
            
            const cancelLongPress = () => {
                if (pressTimer) {
                    clearTimeout(pressTimer);
                    pressTimer = null;
                }
            };
            
            // Support both touch and mouse events for long press
            card.addEventListener('touchstart', startLongPress, { passive: true });
            card.addEventListener('touchend', cancelLongPress);
            card.addEventListener('touchcancel', cancelLongPress);
            card.addEventListener('mousedown', startLongPress);
            card.addEventListener('mouseup', cancelLongPress);
            card.addEventListener('mouseleave', cancelLongPress);
            
            if (table.type === 'hourly') {
                // Hourly tables: double-tap to open when closed, single-tap to open modal when open
                let tapTimer = null;
                let tapCount = 0;
                const tapDelay = 300; // 300ms window for double tap
                
                card.addEventListener('click', async (e) => {
                    // Don't trigger click if long press was triggered
                    if (hasLongPressed) {
                        hasLongPressed = false;
                        return;
                    }
                    
                    // Cancel any pending long press
                    cancelLongPress();
                    
                    e.preventDefault();
                    
                    // Check current table state first
                    const currentTable = await this.db.getTable(table.id);
                    
                    // If table is already open, open modal immediately on single tap
                    if (currentTable && currentTable.isActive && currentTable.openTime) {
                        clearTimeout(tapTimer);
                        tapCount = 0;
                    this.openTableModal(table.id);
                        return;
                    }
                    
                    // Table is closed - use double-tap detection
                    tapCount++;
                    
                    if (tapCount === 1) {
                        // First tap - wait to see if second tap comes
                        tapTimer = setTimeout(() => {
                            // Single tap detected but table is closed - do nothing
                            tapCount = 0;
                        }, tapDelay);
                    } else if (tapCount === 2) {
                        // Double tap detected - open the table
                        clearTimeout(tapTimer);
                        tapCount = 0;
                        
                        this.currentTableId = table.id;
                        await this.openTable();
                    }
                });
            } else {
                // Regular tables: single tap to open modal
                card.addEventListener('click', (e) => {
                    // Don't trigger click if long press was triggered
                    if (hasLongPressed) {
                        hasLongPressed = false;
                        return;
                    }
                    
                    // Cancel any pending long press
                    cancelLongPress();
                    
                    this.openTableModal(table.id);
                });
            }
        });
        
        // Update prices immediately (the interval will handle ongoing updates)
        if (this.currentView === 'tables') {
            this.updateTableCardPrices();
        }
    }

    async updateTableCardPrices() {
        // Only update if we're on the tables view
        if (this.currentView !== 'tables') {
            return;
        }

        const tables = await this.db.getAllTables();
        
        // Only update if there are active tables
        const hasActiveTables = tables.some(table => table.isActive);
        if (!hasActiveTables) {
            return;
        }
        
        // Update each table card's price
        for (const table of tables) {
            const card = document.getElementById(`table-${table.id}`);
            if (!card) continue;

            // Calculate current price
            let displayTotal = table.checkTotal;
            
            if (table.type === 'hourly' && table.isActive && table.openTime) {
                // For hourly tables, include hourly total
                displayTotal = this.calculateCheckTotal(table);
            } else if (table.type === 'instant') {
                // For instant sale table, show today's paid sales total
                displayTotal = await this.getInstantTableDailyTotal(table.id);
            }

            // Update the price element
            const priceElement = card.querySelector('.table-price');
            if (priceElement) {
                priceElement.textContent = `${Math.round(displayTotal)} ₺`;
            }
        }
    }

    startTableCardPriceUpdates() {
        // Clear any existing interval
        if (this.tableCardUpdateInterval) {
            clearInterval(this.tableCardUpdateInterval);
        }
        
        // Update table card prices every 1 minute
        this.tableCardUpdateInterval = setInterval(() => {
            this.updateTableCardPrices();
        }, 60000); // 60 seconds = 1 minute
    }

    stopTableCardPriceUpdates() {
        if (this.tableCardUpdateInterval) {
            clearInterval(this.tableCardUpdateInterval);
            this.tableCardUpdateInterval = null;
        }
    }

    async createTableCard(table) {
        // Instant sale table is always active
        const statusClass = (table.type === 'instant' || table.isActive) ? 'active' : 'inactive';
        
        // Calculate check total for display
        let displayTotal = table.checkTotal;
        
        if (table.type === 'hourly' && table.isActive && table.openTime) {
            // For hourly tables, include hourly total
            const hoursUsed = this.calculateHoursUsed(table.openTime);
            const hourlyTotal = hoursUsed * table.hourlyRate;
            displayTotal = hourlyTotal + table.salesTotal;
        } else if (table.type === 'instant') {
            // For instant sale table, show today's paid sales total
            displayTotal = await this.getInstantTableDailyTotal(table.id);
        }

        // Get icon from table data, or use default
        let icon = table.icon || (table.type === 'hourly' ? '🎱' : '🪑'); // Use stored icon or default based on type

        // Add instant class for instant sale table
        const instantClass = table.type === 'instant' ? 'instant-table' : '';

        // Show delayed-start button only when hourly table is CLOSED (not active/open)
        const delayedStartBtn = (table.type === 'hourly' && !(table.isActive && table.openTime))
            ? `<button class="table-delay-btn" data-table-id="${table.id}" title="Gecikmeli Başlat">⏱</button>`
            : '';

        return `
            <div class="table-card ${statusClass} ${instantClass}" id="table-${table.id}">
                ${delayedStartBtn}
                <div class="table-icon">${icon}</div>
                    <h3>${table.name}</h3>
                <div class="table-price">${Math.round(displayTotal)} ₺</div>
            </div>
        `;
    }

    async getInstantTableDailyTotal(tableId) {
        try {
            const allSales = await this.db.getAllSales();
            const today = new Date();
            today.setHours(0, 0, 0, 0);
            
            const todaySales = allSales.filter(sale => {
                if (sale.tableId !== tableId || !sale.isPaid) return false;
                const saleDate = new Date(sale.paymentTime || sale.sellDateTime);
                saleDate.setHours(0, 0, 0, 0);
                return saleDate.getTime() === today.getTime();
            });
            
            return todaySales.reduce((total, sale) => total + sale.saleTotal, 0);
        } catch (error) {
            console.error('Error calculating instant table daily total:', error);
            return 0;
        }
    }

    async resetInstantSaleTable() {
        try {
            const tables = await this.db.getAllTables();
            const instantTable = tables.find(t => t.type === 'instant');
            
            if (instantTable) {
                instantTable.salesTotal = 0;
                instantTable.checkTotal = 0;
                instantTable.isActive = false;
                await this.db.updateTable(instantTable);
                
                // Reload tables if we're on tables view
                if (this.currentView === 'tables') {
                    await this.loadTables();
                }
            }
        } catch (error) {
            console.error('Error resetting instant sale table:', error);
        }
    }

    startDailyReset() {
        // Check if it's 08:00 and reset if needed
        const checkAndReset = async () => {
            const now = new Date();
            const currentHour = now.getHours();
            const currentMinute = now.getMinutes();
            
            // Reset at 08:00
            if (currentHour === 8 && currentMinute === 0) {
                await this.resetInstantSaleTable();
            }
        };
        
        // Check immediately
        checkAndReset();
        
        // Check every minute
        this.dailyResetInterval = setInterval(checkAndReset, 60000); // Check every minute
    }

    async openTableFormModal(table = null) {
        const modal = document.getElementById('table-form-modal');
        const title = document.getElementById('table-form-modal-title');
        const form = document.getElementById('table-form');
        
        if (table) {
            // Don't allow editing instant sale table
            if (table.type === 'instant') {
            await this.appAlert('"ANLIK SATIŞ" masası düzenlenemez.', 'Uyarı');
                return;
            }
            title.textContent = 'Masayı Düzenle';
            document.getElementById('table-id').value = table.id;
            document.getElementById('table-name').value = table.name;
            document.getElementById('table-type').value = table.type;
            document.getElementById('table-hourly-rate').value = table.hourlyRate || 0;
            document.getElementById('table-icon').value = table.icon || (table.type === 'hourly' ? '🎱' : '🪑');
            
            const hourlyRateLabel = document.getElementById('hourly-rate-label');
            if (table.type === 'hourly') {
                if (hourlyRateLabel) hourlyRateLabel.style.display = 'block';
            } else {
                if (hourlyRateLabel) hourlyRateLabel.style.display = 'none';
            }
            // Icon label is always visible now
        } else {
            title.textContent = 'Masa Ekle';
            form.reset();
            document.getElementById('table-id').value = '';
            document.getElementById('hourly-rate-label').style.display = 'none';
            document.getElementById('table-icon').value = '🪑'; // Default icon for new tables
            // Icon label is always visible now
        }
        
        modal.classList.add('active');
    }

    async saveTable() {
        const id = document.getElementById('table-id').value;
        const name = document.getElementById('table-name').value;
        const type = document.getElementById('table-type').value;
        const hourlyRate = parseFloat(document.getElementById('table-hourly-rate').value) || 0;
        const icon = document.getElementById('table-icon').value || '🎱';

        const tableData = {
            name,
            type,
            hourlyRate: type === 'hourly' ? hourlyRate : 0,
            icon: icon || (type === 'hourly' ? '🎱' : '🪑'), // Store icon for all tables
            openTime: null,
            closeTime: null,
            sales: [],
            isActive: false,
            checkTotal: 0,
            hourlyTotal: 0,
            salesTotal: 0
        };

        try {
            if (id) {
                const existingTable = await this.db.getTable(id);
                tableData.id = existingTable.id;
                tableData.isActive = existingTable.isActive;
                tableData.openTime = existingTable.openTime;
                tableData.closeTime = existingTable.closeTime;
                tableData.sales = existingTable.sales;
                tableData.checkTotal = existingTable.checkTotal;
                tableData.hourlyTotal = existingTable.hourlyTotal;
                tableData.salesTotal = existingTable.salesTotal;
                // Update icon for all tables
                tableData.icon = icon || (type === 'hourly' ? '🎱' : '🪑');
                await this.db.updateTable(tableData);
            } else {
                await this.db.addTable(tableData);
            }
            
            document.getElementById('table-form-modal').classList.remove('active');
            await this.loadTables();
        } catch (error) {
            console.error('Masa kaydedilirken hata:', error, error?.message, error?.details, error?.hint, error?.code);
            await this.appAlert('Masa kaydedilirken hata oluştu. Lütfen tekrar deneyin.', 'Hata');
        }
    }

    async openTableModal(tableId) {
        // Clear any existing interval
        if (this.hourlyUpdateInterval) {
            clearInterval(this.hourlyUpdateInterval);
            this.hourlyUpdateInterval = null;
        }

        let table = await this.db.getTable(tableId);
        if (!table) return;

        this.currentTableId = tableId;

        // Get all unpaid sales for this table
        const unpaidSales = await this.db.getUnpaidSalesByTable(tableId);

        // Sync table active status with unpaid sales - but hourly tables must be manually opened
        let tableUpdated = false;
        
        if (unpaidSales.length > 0 && !table.isActive) {
            // Table has products but is not active - activate it only for regular tables
            // Hourly tables must be manually opened via "Open Table" button
            if (table.type !== 'hourly') {
                table.isActive = true;
                tableUpdated = true;
            }
        } else if (unpaidSales.length === 0 && table.isActive) {
            // Table has no unpaid sales - must be inactive (deactivate it)
            // BUT for hourly tables that were manually opened (have openTime), keep them active until manually closed
            if (table.type === 'hourly' && table.openTime) {
                // Hourly table is manually opened - keep it active even without unpaid sales
                // Don't deactivate it, just update the check total
                const hoursUsed = this.calculateHoursUsed(table.openTime);
                table.hourlyTotal = hoursUsed * table.hourlyRate;
                table.checkTotal = table.hourlyTotal + table.salesTotal;
                tableUpdated = true;
            } else {
                // Regular table or hourly table without openTime (auto-activated) - deactivate
                table.isActive = false;
                table.salesTotal = 0;
                if (table.type === 'hourly') {
                    table.hourlyTotal = 0;
                    table.openTime = null;
                }
                table.checkTotal = 0;
                tableUpdated = true;
            }
        } else if (unpaidSales.length === 0 && !table.isActive && (table.salesTotal > 0 || (table.hourlyTotal > 0 && (!table.openTime || table.type !== 'hourly')))) {
            // Table is inactive but has totals - reset them (this handles cases where payment was processed)
            // BUT don't reset if it's a manually opened hourly table (with openTime)
            if (table.type !== 'hourly' || !table.openTime) {
                table.salesTotal = 0;
                table.hourlyTotal = 0;
                table.checkTotal = 0;
                table.openTime = null;
                tableUpdated = true;
            }
        }
        
        if (tableUpdated) {
            await this.db.updateTable(table);
            // Reload table to get updated data
            table = await this.db.getTable(tableId);
        }

        // Calculate check total (for hourly tables, include real-time hourly calculation)
        const checkTotal = this.calculateCheckTotal(table);
        
        // Update modal title with table name only
        const modalTitle = document.getElementById('table-modal-title');
        modalTitle.textContent = table.name;
        
        // Update modal content
        // Hourly table info
        const hourlyInfo = document.getElementById('hourly-info');
        const regularInfo = document.getElementById('regular-info');
        const openBtn = document.getElementById('open-table-btn');
        const payBtn = document.getElementById('pay-table-btn');
        const creditBtn = document.getElementById('credit-table-btn');
        const cancelHourlyBtn = document.getElementById('cancel-hourly-btn');
        const productsSection = document.getElementById('table-products-section');

        if (table.type === 'hourly') {
            hourlyInfo.style.display = 'flex';
            regularInfo.style.display = 'none';
            
            if (table.isActive && table.openTime) {
                document.getElementById('modal-open-time').textContent = this.formatTimeOnly(table.openTime);
                
                const hoursUsed = this.calculateHoursUsed(table.openTime);
                const hourlyTotal = hoursUsed * table.hourlyRate;
                document.getElementById('modal-hourly-total').textContent = Math.round(hourlyTotal);
                document.getElementById('modal-sales-total').textContent = Math.round(table.salesTotal);
                
                // Update check total with real-time hourly calculation
                table.checkTotal = hourlyTotal + table.salesTotal;
                document.getElementById('modal-check-total').textContent = Math.round(table.checkTotal);
                
                // Update hourly total in real-time every minute
                if (this.hourlyUpdateInterval) {
                    clearInterval(this.hourlyUpdateInterval);
                }
                this.hourlyUpdateInterval = setInterval(async () => {
                    const updatedTable = await this.db.getTable(tableId);
                    if (updatedTable && updatedTable.isActive && updatedTable.openTime) {
                        const hoursUsed = this.calculateHoursUsed(updatedTable.openTime);
                        const hourlyTotal = hoursUsed * updatedTable.hourlyRate;
                        document.getElementById('modal-hourly-total').textContent = Math.round(hourlyTotal);
                        document.getElementById('modal-sales-total').textContent = Math.round(updatedTable.salesTotal);
                        updatedTable.checkTotal = hourlyTotal + updatedTable.salesTotal;
                        document.getElementById('modal-check-total').textContent = Math.round(updatedTable.checkTotal);
                    }
                }, 60000); // Update every minute
                
                // Table is open - show products section
                if (productsSection) {
                    productsSection.style.display = 'block';
                }
                // Hide open button for hourly tables (now handled by double-tap on card)
                if (openBtn) {
                openBtn.style.display = 'none';
                }

                // Show cancel button only for active hourly tables
                if (cancelHourlyBtn) {
                    cancelHourlyBtn.style.display = 'inline-flex';
                }
            } else {
                document.getElementById('modal-open-time').textContent = 'Açılmadı';
                document.getElementById('modal-hourly-total').textContent = '0';
                document.getElementById('modal-sales-total').textContent = Math.round(table.salesTotal);
                table.checkTotal = table.salesTotal;
                document.getElementById('modal-check-total').textContent = Math.round(table.checkTotal);
                
                // Table is not open - hide products section
                if (productsSection) {
                    productsSection.style.display = 'none';
                }
                // Hide open button for hourly tables (now handled by double-tap on card)
                if (openBtn) {
                    openBtn.style.display = 'none';
                }
                if (this.hourlyUpdateInterval) {
                    clearInterval(this.hourlyUpdateInterval);
                }

                if (cancelHourlyBtn) {
                    cancelHourlyBtn.style.display = 'none';
                }
            }
        } else {
            hourlyInfo.style.display = 'none';
            regularInfo.style.display = 'flex';
            table.checkTotal = table.salesTotal;
            document.getElementById('modal-check-total-regular').textContent = Math.round(table.checkTotal);
            if (openBtn) {
            openBtn.style.display = 'none';
            }
            // Regular tables always show products section
            if (productsSection) {
                productsSection.style.display = 'block';
            }
            if (this.hourlyUpdateInterval) {
                clearInterval(this.hourlyUpdateInterval);
            }

            if (cancelHourlyBtn) {
                cancelHourlyBtn.style.display = 'none';
            }
        }

        // Show pay button if there are unpaid sales OR if there's a check total (for hourly tables with only time charges)
        // For hourly tables, also show if table is open (has openTime)
        if (unpaidSales.length === 0 && table.checkTotal === 0 && !(table.type === 'hourly' && table.isActive && table.openTime)) {
            payBtn.style.display = 'none';
        } else {
            payBtn.style.display = 'inline-block';
        }

        // Show/hide credit button based on unpaid sales
        if (creditBtn) {
            const hasUnpaidSales = unpaidSales.length > 0;
            const hasCheckTotal = table.checkTotal > 0 || (table.type === 'hourly' && table.isActive && table.openTime);
            
            if (hasUnpaidSales || hasCheckTotal) {
                creditBtn.style.display = 'inline-block';
            } else {
                creditBtn.style.display = 'none';
            }
        }

        // Load products for selection
        await this.loadTableProducts(tableId);

        // Load sales for this table
        await this.loadTableSales(tableId);

        document.getElementById('table-modal').classList.add('active');
    }

    async cancelHourlyGame() {
        if (!this.currentTableId) return;

        const tableId = this.currentTableId;
        const table = await this.db.getTable(tableId);
        if (!table || table.type !== 'hourly') return;

        // Only meaningful if table is open
        if (!table.isActive || !table.openTime) {
            await this.appAlert('Bu süreli masa açık değil.', 'Uyarı');
            return;
        }

        if (!(await this.appConfirm('Oyunu iptal etmek istiyor musunuz?\nHesap sıfırlanacak, masa kapanacak ve rapora yazılmayacak.', { title: 'Oyunu İptal Et', confirmText: 'İptal Et', cancelText: 'Vazgeç', confirmVariant: 'danger' }))) {
            return;
        }

        try {
            // Make UI responsive immediately
            const cancelBtn = document.getElementById('cancel-hourly-btn');
            const prevCancelText = cancelBtn ? cancelBtn.textContent : null;
            if (cancelBtn) {
                cancelBtn.disabled = true;
                cancelBtn.textContent = 'İptal ediliyor...';
            }

            // Close modal ASAP so user sees result even if DB ops take time
            this.closeTableModal();
            this.currentTableId = null;

            const unpaidSales = await this.db.getUnpaidSalesByTable(tableId);

            // Delete unpaid sales (and restore stock) so nothing remains on the table
            for (const sale of unpaidSales) {
                if (sale?.items?.length) {
                    for (const item of sale.items) {
                        if (!item || item.isCancelled) continue;
                        const product = await this.db.getProduct(item.productId);
                        if (product && this.tracksStock(product)) {
                            product.stock += item.amount;
                            await this.db.updateProduct(product);
                        }
                    }
                }
                // Remove sale completely so it won't appear anywhere
                if (sale?.id) {
                    await this.db.deleteSale(sale.id);
                }
            }

            // Close and reset hourly table WITHOUT recording any session for reporting
            // IMPORTANT: re-fetch latest to avoid writing stale state
            const latestTable = await this.db.getTable(tableId);
            if (latestTable) {
                const updatedTable = {
                    ...latestTable,
                    isActive: false,
                    openTime: null,
                    closeTime: null,
                    hourlyTotal: 0,
                    salesTotal: 0,
                    checkTotal: 0
                };
                await this.db.updateTable(updatedTable);

                // Verify (some devices can have timing quirks with IndexedDB writes)
                const verify = await this.db.getTable(tableId);
                if (verify && (verify.isActive || verify.openTime)) {
                    verify.isActive = false;
                    verify.openTime = null;
                    verify.closeTime = null;
                    verify.hourlyTotal = 0;
                    verify.salesTotal = 0;
                    verify.checkTotal = 0;
                    await this.db.updateTable(verify);
                }
            }

            // Refresh views (stock/sales/tables) + daily if open
            const views = ['tables', 'sales'];
            if (this.currentView === 'products') views.push('products');
            if (this.currentView === 'daily') views.push('daily');
            await this.reloadViews(views);

            // Ensure tables view reflects final state
            await this.loadTables();

            if (cancelBtn) {
                cancelBtn.disabled = false;
                cancelBtn.textContent = prevCancelText || '✖ İptal';
                cancelBtn.style.display = 'none';
            }

            // Success: no alert (keep UX quiet)
        } catch (err) {
            console.error('Süreli oyun iptal edilirken hata:', err);
            await this.appAlert('Oyunu iptal ederken hata oluştu. Lütfen tekrar deneyin.', 'Hata');
        }
    }

    // Clean up interval when modal is closed
    closeTableModal() {
        if (this.hourlyUpdateInterval) {
            clearInterval(this.hourlyUpdateInterval);
            this.hourlyUpdateInterval = null;
        }
        document.getElementById('table-modal').classList.remove('active');
    }

    async loadTableProducts(tableId) {
        const products = await this.db.getAllProducts();
        const container = document.getElementById('table-products-grid');
        if (!container) return;

        if (products.length === 0) {
            container.innerHTML = '<div class="empty-state"><p>Ürün bulunamadı</p></div>';
            return;
        }

        container.innerHTML = products.map(product => this.createTableProductCard(product, tableId)).join('');
        
            // Add event listeners for product cards
            products.forEach(product => {
                const card = document.getElementById(`table-product-card-${product.id}`);
                const addBtn = document.getElementById(`add-product-btn-${product.id}`);
                const quantityInput = document.getElementById(`product-quantity-${product.id}`);
                const plusBtn = document.getElementById(`quantity-plus-${product.id}`);
                const minusBtn = document.getElementById(`quantity-minus-${product.id}`);
                const tracksStock = this.tracksStock(product);
                
            if (card && tracksStock && product.stock === 0) {
                card.classList.add('out-of-stock');
            }
            
            // Plus button for quantity
            if (plusBtn) {
                plusBtn.addEventListener('click', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    if (quantityInput && !quantityInput.disabled) {
                        const currentValue = parseInt(quantityInput.value) || 1;
                        if (tracksStock) {
                            const maxStock = product.stock;
                            const newValue = Math.min(currentValue + 1, maxStock);
                            quantityInput.value = newValue;
                        } else {
                            quantityInput.value = currentValue + 1;
                        }
                    }
                });
            }
            
            // Minus button for quantity
            if (minusBtn) {
                minusBtn.addEventListener('click', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    if (quantityInput && !quantityInput.disabled) {
                        const currentValue = parseInt(quantityInput.value) || 1;
                        const newValue = Math.max(currentValue - 1, 1);
                        quantityInput.value = newValue;
                    }
                });
            }
            
            // Add product button (top right corner)
            if (addBtn) {
                addBtn.addEventListener('click', async (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    const amount = parseInt(quantityInput.value) || 1;
                    if (amount > 0) {
                        if (!this.tracksStock(product) || amount <= product.stock) {
                            await this.addProductToTableFromModal(tableId, product.id, amount);
                            // Reset quantity input
                            quantityInput.value = 1;
                        } else {
                            await this.appAlert(`Yetersiz stok. Mevcut: ${product.stock}`, 'Uyarı');
                        }
                    } else {
                        await this.appAlert('Lütfen geçerli bir miktar girin', 'Uyarı');
                    }
                });
            }
        });
    }

    createTableProductCard(product, tableId) {
        const tracksStock = this.tracksStock(product);
        const isOutOfStock = tracksStock && product.stock === 0;
        const stockText = !tracksStock ? 'Stok: ∞' : (isOutOfStock ? 'Stokta Yok' : `Stok: ${product.stock}`);
        const stockClass = isOutOfStock ? 'stock-out' : (!tracksStock ? 'stock-high' : (product.stock < 10 ? 'stock-low' : 'stock-high'));

        return `
            <div class="product-card-mini ${isOutOfStock ? 'out-of-stock' : ''}" id="table-product-card-${product.id}">
                <button 
                    class="product-add-btn-top" 
                    id="add-product-btn-${product.id}" 
                    ${isOutOfStock ? 'disabled' : ''}
                    title="Ekle"
                >+</button>
                <h4>${product.name}</h4>
                <div class="product-price-mini">${Math.round(product.price)} ₺</div>
                <div class="product-stock-mini ${stockClass}">${stockText}</div>
                <div class="quantity-controls">
                    <button 
                        class="quantity-btn quantity-minus" 
                        id="quantity-minus-${product.id}"
                        ${isOutOfStock ? 'disabled' : ''}
                    >-</button>
                    <input 
                        type="number" 
                        class="product-quantity-input" 
                        id="product-quantity-${product.id}" 
                        value="1" 
                        min="1" 
                        max="${product.stock}"
                        ${isOutOfStock ? 'disabled' : ''}
                        readonly
                        style="text-align: center;"
                    >
                    <button 
                        class="quantity-btn quantity-plus" 
                        id="quantity-plus-${product.id}"
                        ${isOutOfStock ? 'disabled' : ''}
                    >+</button>
                </div>
            </div>
        `;
    }

    async loadTableSales(tableId) {
        // Only show unpaid sales (paid sales should not be visible in the table modal)
        const unpaidSales = await this.db.getUnpaidSalesByTable(tableId);
        const container = document.getElementById('table-sales-list');
        
        if (unpaidSales.length === 0) {
            container.innerHTML = '<div class="empty-state"><h3>Eklenen ürün yok</h3></div>';
            return;
        }

        // Sort by date (newest first)
        unpaidSales.sort((a, b) => new Date(b.sellDateTime) - new Date(a.sellDateTime));

        container.innerHTML = unpaidSales.map(sale => this.createTableSaleItem(sale)).join('');
        
        // Add delete, pay, and credit listeners for each item
        unpaidSales.forEach(sale => {
            sale.items.forEach((item, index) => {
                const deleteBtn = document.getElementById(`delete-sale-item-${sale.id}-${index}`);
                const payBtn = document.getElementById(`pay-sale-item-${sale.id}-${index}`);
                const creditBtn = document.getElementById(`credit-sale-item-${sale.id}-${index}`);
                
            if (deleteBtn) {
                deleteBtn.addEventListener('click', () => {
                        this.deleteItemFromSale(sale.id, index);
                    });
                }
                
                if (payBtn) {
                    payBtn.addEventListener('click', () => {
                        this.payItemFromSale(sale.id, index);
                    });
                }
                
                if (creditBtn) {
                    creditBtn.addEventListener('click', () => {
                        this.creditItemFromSale(sale.id, index);
                    });
                }
            });
        });
    }

    formatDateTimeWithoutSeconds(dateString) {
        const date = new Date(dateString);
        const day = String(date.getDate()).padStart(2, '0');
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const year = date.getFullYear();
        const hours = String(date.getHours()).padStart(2, '0');
        const minutes = String(date.getMinutes()).padStart(2, '0');
        return `${day}.${month}.${year} ${hours}:${minutes}`;
    }

    formatTimeOnly(dateString) {
        const date = new Date(dateString);
        const hours = String(date.getHours()).padStart(2, '0');
        const minutes = String(date.getMinutes()).padStart(2, '0');
        return `${hours}:${minutes}`;
    }

    formatHoursToReadable(hours) {
        if (!hours || hours === 0) return '0 dk';
        
        const totalMinutes = Math.round(hours * 60);
        const hoursPart = Math.floor(totalMinutes / 60);
        const minutesPart = totalMinutes % 60;
        
        if (hoursPart === 0) {
            return `${minutesPart} dk`;
        } else if (minutesPart === 0) {
            return `${hoursPart} saat`;
        } else {
            return `${hoursPart} saat ${minutesPart} dk`;
        }
    }

    createTableSaleItem(sale) {
        const items = sale.items.map((item, index) => {
            const buttons = !sale.isPaid ? `
                <button class="btn btn-danger btn-icon" id="delete-sale-item-${sale.id}-${index}" title="Sil">×</button>
                <button class="btn btn-success btn-icon" id="pay-sale-item-${sale.id}-${index}" title="Öde">₺</button>
                <button class="btn btn-info btn-icon" id="credit-sale-item-${sale.id}-${index}" title="Veresiye">💳</button>
            ` : '';
            
            return `<span class="sale-item-product"><strong>${item.name}</strong> x${item.amount} = ${Math.round(item.price * item.amount)} ₺${buttons}</span>`;
        }).join(' <span class="sale-item-separator">•</span> ');
        
        const saleDate = new Date(sale.sellDateTime);
        const hours = String(saleDate.getHours()).padStart(2, '0');
        const minutes = String(saleDate.getMinutes()).padStart(2, '0');
        const timeOnly = `${hours}:${minutes}`;
        
        return `
            <div class="sale-item-row">
                <div class="sale-item-content">
                    <div class="sale-item-info">
                    ${items}
                        <span class="sale-item-separator">•</span>
                        <span class="sale-item-total">Toplam: ${Math.round(sale.saleTotal)} ₺</span>
                        <span class="sale-item-separator">•</span>
                        <span class="sale-item-time">${timeOnly}</span>
                </div>
                </div>
            </div>
        `;
    }

    async deleteItemFromSale(saleId, itemIndex) {
        if (!(await this.appConfirm('Bu ürünü iptal etmek istediğinize emin misiniz?', { title: 'İptal Onayı', confirmText: 'İptal Et', cancelText: 'Vazgeç', confirmVariant: 'danger' }))) return;

        try {
            const sale = await this.db.getSale(saleId);
            if (!sale) return;

            const item = sale.items[itemIndex];
            if (!item) return;

            // Restore product stock
            const product = await this.db.getProduct(item.productId);
            if (product) {
                if (this.tracksStock(product)) {
                    product.stock += item.amount;
                    await this.db.updateProduct(product);
                }
            }

            // Mark item as cancelled instead of deleting
            item.isCancelled = true;

            // Recalculate sale total (exclude cancelled items)
            sale.saleTotal = sale.items
                .filter(item => !item.isCancelled)
                .reduce((sum, item) => sum + (item.price * item.amount), 0);

            // Mark sale as paid and cancelled if all items are cancelled
            // But keep the sale for history
            sale.isCancelled = sale.items.every(item => item.isCancelled);
            if (sale.isCancelled) {
                sale.isPaid = true;
                sale.paymentTime = new Date().toISOString();
            }

            // Update sale
            await this.db.updateSale(sale);

            const table = await this.db.getTable(sale.tableId);
            if (table) {
                // Recalculate table totals
                const unpaidSales = await this.db.getUnpaidSalesByTable(sale.tableId);
                table.salesTotal = unpaidSales.reduce((sum, s) => sum + s.saleTotal, 0);
                table.checkTotal = table.hourlyTotal + table.salesTotal;
                await this.db.updateTable(table);
            }

            await this.loadTableProducts(sale.tableId);
            await this.loadTableSales(sale.tableId);
            
            // Update table totals in modal
            const updatedTable = await this.db.getTable(sale.tableId);
            let checkTotal = updatedTable.checkTotal;
            if (updatedTable.type === 'hourly' && updatedTable.isActive && updatedTable.openTime) {
                const hoursUsed = this.calculateHoursUsed(updatedTable.openTime);
                const hourlyTotal = hoursUsed * updatedTable.hourlyRate;
                checkTotal = hourlyTotal + updatedTable.salesTotal;
            }
            
            // Update sales total and check total based on table type
            if (updatedTable.type === 'hourly') {
                const modalSalesTotal = document.getElementById('modal-sales-total');
                if (modalSalesTotal) modalSalesTotal.textContent = Math.round(updatedTable.salesTotal);
                const modalCheckTotal = document.getElementById('modal-check-total');
                if (updatedTable.isActive && updatedTable.openTime) {
                    const hoursUsed = this.calculateHoursUsed(updatedTable.openTime);
                    const hourlyTotal = hoursUsed * updatedTable.hourlyRate;
                    const newCheckTotal = hourlyTotal + updatedTable.salesTotal;
                    if (modalCheckTotal) modalCheckTotal.textContent = Math.round(newCheckTotal);
                } else {
                    if (modalCheckTotal) modalCheckTotal.textContent = Math.round(updatedTable.salesTotal);
                }
            } else {
                const modalCheckTotalRegular = document.getElementById('modal-check-total-regular');
                if (modalCheckTotalRegular) modalCheckTotalRegular.textContent = Math.round(updatedTable.salesTotal);
            }
            
            await this.loadTables();
            
            // Update products view if it's currently active (to show updated stock)
            if (this.currentView === 'products') {
                await this.loadProducts();
            }
        } catch (error) {
            console.error('Error deleting item:', error);
            await this.appAlert('Ürün silinirken hata oluştu. Lütfen tekrar deneyin.', 'Hata');
        }
    }

    async payItemFromSale(saleId, itemIndex) {
        if (!(await this.appConfirm('Bu ürünü ödemek istediğinize emin misiniz?', { title: 'Ödeme Onayı', confirmText: 'Öde', cancelText: 'Vazgeç' }))) return;

        try {
            const sale = await this.db.getSale(saleId);
            if (!sale || sale.isPaid) return;

            const item = sale.items[itemIndex];
            if (!item) return;

            // Create a new sale for just this item (paid)
            const newSale = {
                tableId: sale.tableId,
                items: [item],
                sellDateTime: sale.sellDateTime,
                saleTotal: item.price * item.amount,
                isPaid: true,
                isCredit: false,
                customerId: null,
                paymentTime: new Date().toISOString()
            };
            await this.db.addSale(newSale);

            // Remove item from original sale
            sale.items.splice(itemIndex, 1);
            sale.saleTotal = sale.items.reduce((sum, item) => sum + (item.price * item.amount), 0);

            // If no items left, delete the original sale
            if (sale.items.length === 0) {
                await this.db.deleteSale(saleId);
            } else {
                await this.db.updateSale(sale);
            }

            // Update table totals
            const table = await this.db.getTable(sale.tableId);
            if (table) {
                const unpaidSales = await this.db.getUnpaidSalesByTable(sale.tableId);
                table.salesTotal = unpaidSales.reduce((sum, s) => sum + s.saleTotal, 0);
                table.checkTotal = table.hourlyTotal + table.salesTotal;
                await this.db.updateTable(table);
            }

            await this.loadTableProducts(sale.tableId);
            await this.openTableModal(sale.tableId);
            await this.loadTables();
            
            if (this.currentView === 'daily') {
                await this.loadDailyDashboard();
            }
        } catch (error) {
            console.error('Error paying item:', error);
            await this.appAlert('Ürün ödenirken hata oluştu. Lütfen tekrar deneyin.', 'Hata');
        }
    }

    async creditItemFromSale(saleId, itemIndex) {
        if (!this.currentTableId) return;

        // Store saleId and itemIndex for later use after customer selection
        this.pendingCreditSaleId = saleId;
        this.pendingCreditItemIndex = itemIndex;
        
        // Open customer selection modal
        await this.openCustomerSelectionModalForItem();
    }

    async openCustomerSelectionModalForItem() {
        const customers = await this.db.getAllCustomers();
        const modal = document.getElementById('customer-selection-modal');
        const container = document.getElementById('customer-selection-buttons');
        
        if (!modal || !container) {
            await this.appAlert('Müşteri seçim ekranı bulunamadı', 'Hata');
            return;
        }

        if (customers.length === 0) {
            await this.appAlert('Önce bir müşteri eklemeniz gerekiyor', 'Uyarı');
            return;
        }

        // Create customer buttons
        container.innerHTML = customers.map(customer => {
            const balance = customer.balance || 0;
            const balanceText = balance > 0 ? `<small style="display: block; color: #e74c3c; margin-top: 5px;">${Math.round(balance)} ₺</small>` : '';
            return `
                <button class="customer-selection-btn" data-customer-id="${customer.id}">
                    <strong>${customer.name}</strong>
                    ${balanceText}
                </button>
            `;
        }).join('');

        // Add click listeners to customer buttons
        container.querySelectorAll('.customer-selection-btn').forEach(btn => {
            btn.addEventListener('click', async () => {
                const customerId = btn.getAttribute('data-customer-id');
                const modal = document.getElementById('customer-selection-modal');
                if (modal) {
                    modal.classList.remove('active');
                }
                await this.processCreditItemFromSale(customerId);
            });
        });

        modal.classList.add('active');
    }

    async processCreditItemFromSale(selectedCustomerId) {
        const saleId = this.pendingCreditSaleId;
        const itemIndex = this.pendingCreditItemIndex;
        
        if (!saleId || itemIndex === undefined) return;

        const customer = await this.db.getCustomer(selectedCustomerId);
        if (!customer) {
            await this.appAlert('Müşteri bulunamadı', 'Hata');
            return;
        }

        if (!(await this.appConfirm(`Bu ürünü ${customer.name} müşterisine veresiye olarak yazmak istediğinize emin misiniz?`, { title: 'Veresiye Onayı', confirmText: 'Veresiye Yaz', cancelText: 'Vazgeç' }))) return;

        try {
            const sale = await this.db.getSale(saleId);
            if (!sale || sale.isPaid) return;

            const item = sale.items[itemIndex];
            if (!item) return;

            const itemTotal = item.price * item.amount;

            // Create a new sale for just this item (credit)
            const newSale = {
                tableId: sale.tableId,
                items: [item],
                sellDateTime: sale.sellDateTime,
                saleTotal: itemTotal,
                isPaid: true,
                isCredit: true,
                customerId: selectedCustomerId,
                paymentTime: new Date().toISOString()
            };
            await this.db.addSale(newSale);

            // Update customer balance
            customer.balance = (customer.balance || 0) + itemTotal;
            await this.db.updateCustomer(customer);

            // Remove item from original sale
            sale.items.splice(itemIndex, 1);
            sale.saleTotal = sale.items.reduce((sum, item) => sum + (item.price * item.amount), 0);

            // If no items left, delete the original sale
            if (sale.items.length === 0) {
                await this.db.deleteSale(saleId);
            } else {
                await this.db.updateSale(sale);
            }

            // Update table totals
            const table = await this.db.getTable(sale.tableId);
            if (table) {
                const unpaidSales = await this.db.getUnpaidSalesByTable(sale.tableId);
                table.salesTotal = unpaidSales.reduce((sum, s) => sum + s.saleTotal, 0);
                table.checkTotal = table.hourlyTotal + table.salesTotal;
                await this.db.updateTable(table);
            }

            await this.loadTableProducts(sale.tableId);
            await this.openTableModal(sale.tableId);
            await this.loadTables();
            await this.loadCustomers();
            
            if (this.currentView === 'daily') {
                await this.loadDailyDashboard();
            }
        } catch (error) {
            console.error('Error crediting item:', error);
            await this.appAlert('Ürün veresiye yazılırken hata oluştu. Lütfen tekrar deneyin.', 'Hata');
        }
    }

    calculateHoursUsed(openTime) {
        if (!openTime) return 0;
        const now = new Date();
        const opened = new Date(openTime);
        const diffMs = now - opened;
        return diffMs / (1000 * 60 * 60); // Convert to hours
    }

    calculateHoursBetween(startTime, endTime) {
        if (!startTime || !endTime) return 0;
        const start = new Date(startTime);
        const end = new Date(endTime);
        const diffMs = end - start;
        return Math.max(0, diffMs / (1000 * 60 * 60));
    }

    closeDelayedStartModal() {
        const modal = document.getElementById('delayed-start-modal');
        if (modal) modal.classList.remove('active');
        this.pendingDelayedStartTableId = null;
        const hidden = document.getElementById('delayed-start-table-id');
        if (hidden) hidden.value = '';
    }

    async openDelayedStartModal(tableId) {
        const modal = document.getElementById('delayed-start-modal');
        const timeInput = document.getElementById('delayed-start-time');
        const hidden = document.getElementById('delayed-start-table-id');
        if (!modal || !timeInput || !hidden) {
            await this.appAlert('Gecikmeli başlatma ekranı bulunamadı.', 'Hata');
            return;
        }

        const table = await this.db.getTable(tableId);
        if (!table || table.type !== 'hourly') return;

        this.pendingDelayedStartTableId = tableId;
        hidden.value = String(tableId);

        // Prefill with current open time if already active, otherwise now
        const defaultIso = (table.isActive && table.openTime) ? table.openTime : new Date().toISOString();
        timeInput.value = this.formatTimeOnly(defaultIso);

        modal.classList.add('active');
    }

    async applyDelayedStart() {
        const hidden = document.getElementById('delayed-start-table-id');
        const timeInput = document.getElementById('delayed-start-time');
        if (!hidden || !timeInput) return;

        const tableId = hidden.value || this.pendingDelayedStartTableId;
        if (!tableId) return;

        const timeStr = (timeInput.value || '').trim(); // HH:MM
        if (!timeStr) {
            await this.appAlert('Başlama saati seçin.', 'Uyarı');
            return;
        }

        const [hhStr, mmStr] = timeStr.split(':');
        const hh = parseInt(hhStr, 10);
        const mm = parseInt(mmStr, 10);
        if (Number.isNaN(hh) || Number.isNaN(mm)) {
            await this.appAlert('Geçersiz saat formatı.', 'Uyarı');
            return;
        }

        const now = new Date();
        const start = new Date(now);
        start.setHours(hh, mm, 0, 0);
        if (start > now) {
            await this.appAlert('Başlama saati gelecekte olamaz.', 'Uyarı');
            return;
        }

        const table = await this.db.getTable(tableId);
        if (!table || table.type !== 'hourly') return;

        // Persist legacy last closed session into hourlySessions so it won't be overwritten
        table.hourlySessions = Array.isArray(table.hourlySessions) ? table.hourlySessions : [];
        if (table.closeTime && table.openTime) {
            const alreadyRecorded = table.hourlySessions.some(
                (s) => s && s.openTime === table.openTime && s.closeTime === table.closeTime
            );
            if (!alreadyRecorded) {
                const hoursUsed = this.calculateHoursBetween(table.openTime, table.closeTime);
                const hourlyTotal = (table.hourlyTotal || 0) > 0 ? table.hourlyTotal : (hoursUsed * table.hourlyRate);
                table.hourlySessions.push({
                    openTime: table.openTime,
                    closeTime: table.closeTime,
                    hoursUsed,
                    hourlyTotal,
                    paymentTime: table.closeTime,
                    isCredit: false
                });
            }
        }

        table.isActive = true;
        table.openTime = start.toISOString();
        table.closeTime = null;
        table.hourlyTotal = 0; // live-calculated while active
        table.checkTotal = table.salesTotal || 0;

        try {
            await this.db.updateTable(table);

            this.closeDelayedStartModal();

            await this.loadTables();
            if (this.currentView === 'daily') {
                await this.loadDailyDashboard();
            }

            // If table modal is open for this table, refresh it
            const tableModal = document.getElementById('table-modal');
            if (tableModal && tableModal.classList.contains('active') && this.currentTableId === tableId) {
                await this.openTableModal(tableId);
            }
        } catch (error) {
            console.error('Gecikmeli başlat uygulanırken hata:', error, error?.message, error?.details, error?.hint, error?.code);
            await this.appAlert(`Gecikmeli başlat uygulanamadı: ${error?.message || 'Bilinmeyen hata'}`, 'Hata');
        }
    }

    closeManualSessionModal() {
        const modal = document.getElementById('manual-session-modal');
        if (modal) modal.classList.remove('active');
    }

    getManualSessionBaseDate() {
        // Use currently selected report start date as the base day, fallback to today.
        const reportStart = document.getElementById('report-start-date');
        if (reportStart && reportStart.value) {
            return reportStart.value; // YYYY-MM-DD
        }
        const now = new Date();
        const yyyy = now.getFullYear();
        const mm = String(now.getMonth() + 1).padStart(2, '0');
        const dd = String(now.getDate()).padStart(2, '0');
        return `${yyyy}-${mm}-${dd}`;
    }

    async openManualSessionModal() {
        const modal = document.getElementById('manual-session-modal');
        const select = document.getElementById('manual-session-table');
        const startInput = document.getElementById('manual-session-start');
        const endInput = document.getElementById('manual-session-end');
        const amountInput = document.getElementById('manual-session-amount');
        const autoChk = document.getElementById('manual-session-auto-amount');
        if (!modal || !select || !startInput || !endInput || !amountInput || !autoChk) {
            await this.appAlert('Manuel oyun ekranı bulunamadı.', 'Hata');
            return;
        }

        const tables = await this.db.getAllTables();
        const hourlyTables = tables.filter((t) => t.type === 'hourly');
        select.innerHTML = hourlyTables
            .map((t) => `<option value="${t.id}" data-rate="${t.hourlyRate || 0}">${t.name}</option>`)
            .join('');

        const now = new Date();
        // Default: last 1 hour
        const endTime = this.formatTimeOnly(now.toISOString());
        const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
        const startTime = this.formatTimeOnly(oneHourAgo.toISOString());
        startInput.value = startTime;
        endInput.value = endTime;

        autoChk.checked = true;
        await this.onManualSessionTableChanged();
        this.recalculateManualAmount();

        modal.classList.add('active');
    }

    async onManualSessionTableChanged() {
        const select = document.getElementById('manual-session-table');
        if (!select) return;
        this.recalculateManualAmount();
    }

    recalculateManualAmount() {
        const autoChk = document.getElementById('manual-session-auto-amount');
        const tableSelect = document.getElementById('manual-session-table');
        const startInput = document.getElementById('manual-session-start');
        const endInput = document.getElementById('manual-session-end');
        const amountInput = document.getElementById('manual-session-amount');
        if (!autoChk || !tableSelect || !startInput || !endInput || !amountInput) return;
        if (!autoChk.checked) return;

        const startStr = startInput.value;
        const endStr = endInput.value;
        const opt = tableSelect.selectedOptions && tableSelect.selectedOptions[0];
        const rate = opt ? (parseFloat(opt.getAttribute('data-rate') || '0') || 0) : 0;
        if (!startStr || !endStr || rate <= 0) return;

        const baseDate = this.getManualSessionBaseDate();
        const start = new Date(`${baseDate}T${startStr}:00`);
        let end = new Date(`${baseDate}T${endStr}:00`);
        // Support overnight sessions: if end <= start, treat as next day
        if (end <= start) {
            end = new Date(end.getTime() + 24 * 60 * 60 * 1000);
        }
        const hours = Math.max(0, (end - start) / (1000 * 60 * 60));
        const amount = hours * rate;
        amountInput.value = String(Math.round(amount));
    }

    async saveManualSession() {
        const modal = document.getElementById('manual-session-modal');
        const select = document.getElementById('manual-session-table');
        const startInput = document.getElementById('manual-session-start');
        const endInput = document.getElementById('manual-session-end');
        const amountInput = document.getElementById('manual-session-amount');
        if (!modal || !select || !startInput || !endInput || !amountInput) return;

        const dateStr = this.getManualSessionBaseDate();
        const startStr = startInput.value;
        const endStr = endInput.value;
        if (!dateStr || !startStr || !endStr) {
            await this.appAlert('Başlangıç / bitiş doldurun.', 'Uyarı');
            return;
        }

        const start = new Date(`${dateStr}T${startStr}:00`);
        let end = new Date(`${dateStr}T${endStr}:00`);
        // Support overnight sessions
        if (end <= start) {
            end = new Date(end.getTime() + 24 * 60 * 60 * 1000);
        }

        const opt = select.selectedOptions && select.selectedOptions[0];
        const rate = opt ? (parseFloat(opt.getAttribute('data-rate') || '0') || 0) : 0;
        const amount = parseFloat(amountInput.value || '0') || 0;
        if (amount <= 0) {
            await this.appAlert('Alınan tutar 0 olamaz.', 'Uyarı');
            return;
        }

        const tableId = select.value;
        if (!tableId) return;
        const table = await this.db.getTable(tableId);
        const tableName = table?.name || `Masa ${tableId}`;

        const hoursUsed = Math.max(0, (end - start) / (1000 * 60 * 60));
        const session = {
            type: 'hourly',
            tableId,
            tableName,
            openTime: start.toISOString(),
            closeTime: end.toISOString(),
            hoursUsed,
            hourlyRate: rate,
            amount,
            createdAt: new Date().toISOString()
        };

        try {
            await this.db.addManualSession(session);
            modal.classList.remove('active');
            await this.loadDailyDashboard();
        } catch (err) {
            console.error('Manuel oyun kaydı eklenirken hata:', err);
            await this.appAlert('Manuel oyun kaydı eklenirken hata oluştu.', 'Hata');
        }
    }

    // Helper: Calculate hourly total for a table
    calculateHourlyTotal(table) {
        if (table.type !== 'hourly' || !table.isActive || !table.openTime) return 0;
        const hoursUsed = this.calculateHoursUsed(table.openTime);
        return hoursUsed * table.hourlyRate;
    }

    // Helper: Calculate check total for a table
    calculateCheckTotal(table) {
        const hourlyTotal = this.calculateHourlyTotal(table);
        return hourlyTotal + (table.salesTotal || 0);
    }

    // Helper: Update modal totals (reduces DOM queries)
    updateModalTotals(table) {
        if (table.type === 'hourly') {
            const modalSalesTotal = document.getElementById('modal-sales-total');
            const modalCheckTotal = document.getElementById('modal-check-total');
            if (modalSalesTotal) modalSalesTotal.textContent = Math.round(table.salesTotal);
            if (modalCheckTotal) {
                const checkTotal = this.calculateCheckTotal(table);
                modalCheckTotal.textContent = Math.round(checkTotal);
            }
        } else {
            const modalCheckTotalRegular = document.getElementById('modal-check-total-regular');
            if (modalCheckTotalRegular) modalCheckTotalRegular.textContent = Math.round(table.salesTotal);
        }
    }

    // Helper: Reload multiple views in parallel
    async reloadViews(views = ['tables']) {
        const promises = [];
        if (views.includes('tables')) promises.push(this.loadTables());
        if (views.includes('products')) promises.push(this.loadProducts());
        if (views.includes('sales')) promises.push(this.loadSales());
        if (views.includes('customers')) promises.push(this.loadCustomers());
        if (views.includes('daily') && this.currentView === 'daily') {
            promises.push(this.loadDailyDashboard());
        }
        await Promise.all(promises);
    }

    // Helper: Check if product tracks stock
    tracksStock(product) {
        return product.trackStock !== false && product.stock !== null && product.stock !== undefined;
    }

    async openTable(tableId = null) {
        const targetTableId = tableId || this.currentTableId;
        if (!targetTableId) {
            console.error('Masa ID bulunamadı');
            return;
        }
        
        const table = await this.db.getTable(targetTableId);
        if (!table) {
            await this.appAlert('Masa bulunamadı.', 'Hata');
            return;
        }
        
        if (table.type !== 'hourly') {
            await this.appAlert('Bu masa saatlik ücretli masa değil.', 'Uyarı');
            return;
        }

        if (table.isActive && table.openTime) {
            // Table is already open, just reload tables
            await this.loadTables();
            return;
        }

        try {
            // If table has legacy single-session hourly data, persist it into hourlySessions
            // so it won't be overwritten when we start a new session.
            table.hourlySessions = Array.isArray(table.hourlySessions) ? table.hourlySessions : [];
            if (table.closeTime && table.openTime) {
                const alreadyRecorded = table.hourlySessions.some(
                    (s) => s && s.openTime === table.openTime && s.closeTime === table.closeTime
                );
                if (!alreadyRecorded) {
                    const hoursUsed = this.calculateHoursBetween(table.openTime, table.closeTime);
                    const hourlyTotal = (table.hourlyTotal || 0) > 0 ? table.hourlyTotal : (hoursUsed * table.hourlyRate);
                    table.hourlySessions.push({
                        openTime: table.openTime,
                        closeTime: table.closeTime,
                        hoursUsed,
                        hourlyTotal,
                        paymentTime: table.closeTime,
                        isCredit: false
                    });
                }
            }

            table.isActive = true;
            table.openTime = new Date().toISOString();
            table.closeTime = null; // Critical: prevent report from reading previous closeTime with reset totals
            table.hourlyTotal = 0; // Reset hourly total when opening
            table.checkTotal = table.salesTotal; // Update check total
        
        await this.db.updateTable(table);
            
            // Reload tables (don't close modal if it's not open)
        await this.loadTables();
        } catch (error) {
            console.error('Masayı açarken hata:', error, error?.message, error?.details, error?.hint, error?.code);
            await this.appAlert('Masayı açarken hata oluştu. Lütfen tekrar deneyin.', 'Hata');
        }
    }


    // Helper function to close add product modal
    closeAddProductModal() {
        const modal = document.getElementById('add-product-table-modal');
        if (modal) {
            modal.classList.remove('active');
            modal.style.setProperty('display', 'none', 'important');
            modal.style.setProperty('visibility', 'hidden', 'important');
            modal.style.setProperty('opacity', '0', 'important');
            const modalContent = modal.querySelector('.modal-content');
            if (modalContent) {
                modalContent.style.setProperty('display', 'none', 'important');
            }
        }
    }

    async openAddProductToTableModal() {
        const products = await this.db.getAllProducts();
        const select = document.getElementById('product-select');
        const currentTableId = this.currentTableId;
        
        document.getElementById('current-table-id').value = currentTableId;
        document.getElementById('product-amount').value = 1;

        const availableProducts = products.filter(p => !this.tracksStock(p) || p.stock > 0);
        
        if (availableProducts.length === 0) {
            select.innerHTML = '<option value="">No products available</option>';
        } else {
        select.innerHTML = '<option value="">Select a product</option>' +
                availableProducts.map(p => {
                    const stockText = this.tracksStock(p) ? `Stock: ${p.stock}` : 'Stock: ∞';
                    return `<option value="${p.id}">${p.name} - ${Math.round(p.price)} ₺ (${stockText})</option>`;
                }).join('');
        }

        if (availableProducts.length === 0) {
            select.innerHTML = '<option value="">No products available</option>';
        }

        document.getElementById('product-stock-info').innerHTML = '';
        const modal = document.getElementById('add-product-table-modal');
        if (modal) {
            modal.classList.add('active');
            modal.style.removeProperty('display');
            modal.style.removeProperty('visibility');
            modal.style.removeProperty('opacity');
        }
    }

    async addProductToTable() {
        const tableIdInput = document.getElementById('current-table-id');
        const productSelect = document.getElementById('product-select');
        const amountInput = document.getElementById('product-amount');
        
        if (!tableIdInput || !productSelect || !amountInput) return;
        
        const tableId = tableIdInput.value;
        const productId = productSelect.value;
        const amount = parseInt(amountInput.value);

        if (!tableId || !productId || !amount) {
            await this.appAlert('Lütfen tüm alanları doldurun', 'Uyarı');
            return;
        }

        await this.addProductToTableFromModal(tableId, productId, amount);
    }

    async addProductToTableFromModal(tableId, productId, amount) {
        if (!tableId || !productId || !amount) return;

        try {
            const table = await this.db.getTable(tableId);
            const product = await this.db.getProduct(productId);

            if (!table || !product) {
                await this.appAlert('Masa veya ürün bulunamadı', 'Hata');
                return;
            }

            if (this.tracksStock(product) && product.stock < amount) {
                await this.appAlert(`Yetersiz stok. Mevcut: ${product.stock}`, 'Uyarı');
                return;
            }

            const isInstant = table.type === 'instant';

            // Create sale
            const sale = {
                tableId: tableId,
                items: [{
                    productId: productId,
                    name: product.name,
                    price: product.price,
                    arrivalPrice: product.arrivalPrice || 0,
                    amount: amount
                }],
                sellDateTime: new Date().toISOString(),
                saleTotal: product.price * amount,
                isPaid: isInstant,
                isCredit: false,
                customerId: null,
                paymentTime: isInstant ? new Date().toISOString() : null
            };

            await this.db.addSale(sale);

            // Update product stock
            if (this.tracksStock(product)) {
            product.stock -= amount;
            await this.db.updateProduct(product);
            }

            // Handle instant sale table
            if (isInstant) {
                table.checkTotal = 0;
                table.salesTotal = 0;
                await this.db.updateTable(table);
                this.closeAddProductModal();
                
                if (this.currentTableId === tableId) {
                    await this.loadTableSales(tableId);
                }
                
                const tableModal = document.getElementById('table-modal');
                if (tableModal) tableModal.classList.remove('active');
                this.currentTableId = null;
                
                await Promise.all([this.loadTables(), this.loadSales()]);
                return;
            }

            // Update table totals for regular tables
            table.salesTotal += sale.saleTotal;
            
            if (!table.isActive && table.type !== 'hourly') {
                table.isActive = true;
            }
            if (table.type === 'hourly' && table.openTime && !table.isActive) {
                table.isActive = true;
            }
            
            if (table.type === 'hourly' && table.isActive && table.openTime) {
                const hoursUsed = this.calculateHoursUsed(table.openTime);
                table.hourlyTotal = hoursUsed * table.hourlyRate;
            }
            table.checkTotal = table.hourlyTotal + table.salesTotal;
            await this.db.updateTable(table);

            // Close modal immediately before reload
            this.closeAddProductModal();

            // Reload modal content in parallel
            await Promise.all([
                this.loadTableProducts(tableId),
                this.loadTableSales(tableId)
            ]);
            
            // Update table totals in modal
            const updatedTable = await this.db.getTable(tableId);
            this.updateModalTotals(updatedTable);
            
            // Reload views in parallel
            const reloadPromises = [this.loadTables()];
            if (this.currentView === 'products') reloadPromises.push(this.loadProducts());
            if (this.currentView === 'daily') reloadPromises.push(this.loadDailyDashboard());
            await Promise.all(reloadPromises);
        } catch (error) {
            console.error('Ürün eklenirken hata:', error);
            await this.appAlert('Ürün eklenirken hata oluştu. Lütfen tekrar deneyin.', 'Hata');
            this.closeAddProductModal();
        }
    }

    async deleteSaleFromTable(saleId) {
        if (!(await this.appConfirm('Bu satışı silmek istediğinize emin misiniz?', { title: 'Satış Sil', confirmText: 'Sil', cancelText: 'Vazgeç', confirmVariant: 'danger' }))) return;

        try {
            const sale = await this.db.getSale(saleId);
            if (!sale) return;

            const table = await this.db.getTable(sale.tableId);
            if (!table) return;

            // Restore product stock
            for (const item of sale.items) {
                const product = await this.db.getProduct(item.productId);
                if (product) {
                    product.stock += item.amount;
                    await this.db.updateProduct(product);
                }
            }

            // Update table totals
            table.salesTotal -= sale.saleTotal;
            table.checkTotal = table.hourlyTotal + table.salesTotal;

            // Delete sale first
            await this.db.deleteSale(saleId);

            // Check if table still has unpaid sales after deletion
            const remainingUnpaidSales = await this.db.getUnpaidSalesByTable(sale.tableId);
            
            // Auto-deactivate table if no products (unpaid sales) remain
            // BUT for hourly tables that were manually opened (have openTime), keep them active
            if (remainingUnpaidSales.length === 0 && table.isActive) {
                if (table.type === 'hourly' && table.openTime) {
                    // Manually opened hourly table - keep it active, just update salesTotal and checkTotal
                    table.salesTotal = 0;
                    // Update check total with real-time hourly calculation
                    const hoursUsed = this.calculateHoursUsed(table.openTime);
                    table.hourlyTotal = hoursUsed * table.hourlyRate;
                    table.checkTotal = table.hourlyTotal;
                } else {
                    // Regular table or auto-activated table - deactivate
                    table.isActive = false;
                    table.salesTotal = 0;
                    if (table.type === 'hourly') {
                        table.hourlyTotal = 0;
                        table.openTime = null;
                    }
                    table.checkTotal = 0;
                }
            } else if (remainingUnpaidSales.length === 0 && !table.isActive) {
                // Table is inactive and no unpaid sales - ensure totals are reset
                // BUT don't reset if it's a manually opened hourly table (shouldn't happen but safety check)
                if (table.type !== 'hourly' || !table.openTime) {
                    table.salesTotal = 0;
                    if (table.type === 'hourly') {
                        table.hourlyTotal = 0;
                        table.openTime = null;
                    }
                    table.checkTotal = 0;
                }
            }
            
            await this.db.updateTable(table);

            // Reload products list in the modal and refresh modal content
            await this.loadTableProducts(sale.tableId);
            await this.openTableModal(sale.tableId);
            await this.loadTables();
            
            // Update products view if it's currently active (to show updated stock)
            if (this.currentView === 'products') {
            await this.loadProducts();
            }
            
            // Always reload daily dashboard when sale is deleted (data has changed)
            await this.loadDailyDashboard();
        } catch (error) {
            console.error('Satış silinirken hata:', error);
            await this.appAlert('Satış silinirken hata oluştu. Lütfen tekrar deneyin.', 'Hata');
        }
    }

    async payTable() {
        if (!this.currentTableId) return;

        const table = await this.db.getTable(this.currentTableId);
        if (!table) return;

        const unpaidSales = await this.db.getUnpaidSalesByTable(this.currentTableId);
        
        // Calculate final check total (for hourly tables, include real-time calculation)
        let finalCheckTotal = table.checkTotal;
        if (table.type === 'hourly' && table.isActive && table.openTime) {
            const hoursUsed = this.calculateHoursUsed(table.openTime);
            const hourlyTotal = hoursUsed * table.hourlyRate;
            finalCheckTotal = hourlyTotal + table.salesTotal;
        }
        
        if (unpaidSales.length === 0 && finalCheckTotal === 0) {
            await this.appAlert('Bu masa için ödenecek ürün yok.', 'Uyarı');
            return;
        }

        // Show receipt modal instead of confirm
        await this.showReceiptModal(table, unpaidSales);
    }

    async showReceiptModal(table, unpaidSales, isCreditMode = false) {
        const modal = document.getElementById('receipt-modal');
        const receiptBody = document.getElementById('receipt-body');
        const receiptDateTime = document.getElementById('receipt-date-time');
        const confirmPaymentBtn = document.getElementById('confirm-payment-btn');
        const confirmCreditBtn = document.getElementById('confirm-credit-btn');
        
        if (!modal || !receiptBody) return;

        // Set date and time
        const now = new Date();
        receiptDateTime.textContent = this.formatDateTimeWithoutSeconds(now.toISOString());

        // Show/hide buttons based on mode
        if (isCreditMode) {
            if (confirmPaymentBtn) confirmPaymentBtn.style.display = 'none';
            if (confirmCreditBtn) confirmCreditBtn.style.display = 'inline-block';
        } else {
            if (confirmPaymentBtn) confirmPaymentBtn.style.display = 'inline-block';
            if (confirmCreditBtn) confirmCreditBtn.style.display = 'none';
        }

        // Group products by name
        const productGroups = {};
        unpaidSales.forEach(sale => {
            sale.items.forEach(item => {
                if (!productGroups[item.name]) {
                    productGroups[item.name] = {
                        name: item.name,
                        amount: 0,
                        price: item.price,
                        total: 0
                    };
                }
                productGroups[item.name].amount += item.amount;
                productGroups[item.name].total += item.price * item.amount;
            });
        });

        // Calculate totals
        let hourlyTotal = 0;
        let hoursUsed = 0;
        let hourlyMinutes = 0;
        let productTotal = 0;

        if (table.type === 'hourly' && table.isActive && table.openTime) {
            hoursUsed = this.calculateHoursUsed(table.openTime);
            hourlyTotal = hoursUsed * table.hourlyRate;
            hourlyMinutes = Math.round(hoursUsed * 60);
        }

        Object.values(productGroups).forEach(group => {
            productTotal += group.total;
        });

        const finalTotal = hourlyTotal + productTotal;

        // Build receipt HTML
        let receiptHTML = `<div class="receipt-section">`;
        receiptHTML += `<div style="margin-bottom: 10px; font-weight: bold; font-size: 1.1rem;">Masa: ${table.name}</div>`;
        receiptHTML += `</div>`;

        // Hourly section
        if (table.type === 'hourly' && table.isActive && table.openTime) {
            receiptHTML += `<div class="receipt-section">`;
            receiptHTML += `<div class="receipt-section-title">OYUN</div>`;
            receiptHTML += `<div class="receipt-item">`;
            receiptHTML += `<div class="receipt-item-name">Süre: ${this.formatHoursToReadable(hoursUsed)}</div>`;
            receiptHTML += `<div class="receipt-item-price">${Math.round(hourlyTotal)} ₺</div>`;
            receiptHTML += `</div>`;
            receiptHTML += `</div>`;
        }

        // Products section
        if (Object.keys(productGroups).length > 0) {
            receiptHTML += `<div class="receipt-section">`;
            receiptHTML += `<div class="receipt-section-title">ÜRÜNLER</div>`;
            Object.values(productGroups).forEach(group => {
                receiptHTML += `<div class="receipt-item">`;
                receiptHTML += `<div class="receipt-item-name">${group.name} x${group.amount}</div>`;
                receiptHTML += `<div class="receipt-item-price">${Math.round(group.total)} ₺</div>`;
                receiptHTML += `</div>`;
            });
            receiptHTML += `</div>`;
        }

        // Total section
        receiptHTML += `<div class="receipt-total">`;
        if (table.type === 'hourly' && table.isActive && table.openTime && Object.keys(productGroups).length > 0) {
            receiptHTML += `<div class="receipt-total-row">`;
            receiptHTML += `<span>Oyun Toplam:</span>`;
            receiptHTML += `<span>${Math.round(hourlyTotal)} ₺</span>`;
            receiptHTML += `</div>`;
            receiptHTML += `<div class="receipt-total-row">`;
            receiptHTML += `<span>Ürün Toplam:</span>`;
            receiptHTML += `<span>${Math.round(productTotal)} ₺</span>`;
            receiptHTML += `</div>`;
        }
        receiptHTML += `<div class="receipt-total-row final">`;
        receiptHTML += `<span>GENEL TOPLAM:</span>`;
        receiptHTML += `<span>${Math.round(finalTotal)} ₺</span>`;
        receiptHTML += `</div>`;
        receiptHTML += `</div>`;

        receiptBody.innerHTML = receiptHTML;
        modal.classList.add('active');
    }

    async processPayment() {
        if (!this.currentTableId) return;

        const table = await this.db.getTable(this.currentTableId);
        if (!table) return;

        const unpaidSales = await this.db.getUnpaidSalesByTable(this.currentTableId);

        try {
            // Mark all unpaid sales as paid and record payment time
            const paymentTime = new Date().toISOString();
            for (const sale of unpaidSales) {
                sale.isPaid = true;
                sale.paymentTime = paymentTime; // Track when payment was made
                await this.db.updateSale(sale);
            }

            // For hourly tables, close it and finalize hourly charges (Pay = Close for hourly tables)
            if (table.type === 'hourly' && table.isActive && table.openTime) {
                const closeTimeISO = new Date().toISOString();
                // Eğer hiç ürün yoksa süre fark etmeksizin ücretsiz kapat (dükkan sahibi kaybetti)
                if (unpaidSales.length === 0 && table.salesTotal === 0) {
                    // Hiç ürün olmadan kapanırsa 0 TL (süre fark etmez)
                    table.hourlyTotal = 0;
                } else {
                    // Normal hesaplama
                    const hoursUsed = this.calculateHoursUsed(table.openTime);
                    table.hourlyTotal = hoursUsed * table.hourlyRate;
                }
                
                // Persist this session so reopening the table doesn't overwrite report history
                table.hourlySessions = Array.isArray(table.hourlySessions) ? table.hourlySessions : [];
                const sessionHoursUsed = this.calculateHoursBetween(table.openTime, closeTimeISO);
                const sessionHourlyTotal = (table.hourlyTotal || 0) > 0 ? table.hourlyTotal : (sessionHoursUsed * table.hourlyRate);
                table.hourlySessions.push({
                    openTime: table.openTime,
                    closeTime: closeTimeISO,
                    hoursUsed: sessionHoursUsed,
                    hourlyTotal: sessionHourlyTotal,
                    paymentTime,
                    isCredit: false
                });

                table.isActive = false;
                table.closeTime = closeTimeISO;
                // Keep openTime/closeTime as last-session snapshot; detailed history is in hourlySessions
            }

            // Reset totals but keep hourlyTotal and closeTime for daily reporting
            table.salesTotal = 0;
            table.checkTotal = 0;
            // Note: hourlyTotal and closeTime are kept for daily dashboard reporting
            
            await this.db.updateTable(table);

            // Close receipt modal
            const receiptModal = document.getElementById('receipt-modal');
            if (receiptModal) receiptModal.classList.remove('active');

            this.closeTableModal();
            await this.loadTables();
            await this.loadSales();
            
            // Always reload daily dashboard when table is closed/paid (data has changed)
            await this.loadDailyDashboard();
        } catch (error) {
            console.error('Ödeme işlenirken hata:', error);
            await this.appAlert('Ödeme işlenirken hata oluştu. Lütfen tekrar deneyin.', 'Hata');
        }
    }

    async creditTable() {
        if (!this.currentTableId) return;

        const table = await this.db.getTable(this.currentTableId);
        if (!table) return;

        const unpaidSales = await this.db.getUnpaidSalesByTable(this.currentTableId);
        
        // Show receipt modal first (in credit mode)
        await this.showReceiptModal(table, unpaidSales, true);
    }

    async openCustomerSelectionModal() {
        const customers = await this.db.getAllCustomers();
        const modal = document.getElementById('customer-selection-modal');
        const container = document.getElementById('customer-selection-buttons');
        
        if (!modal || !container) {
            await this.appAlert('Müşteri seçim ekranı bulunamadı', 'Hata');
            return;
        }

        if (customers.length === 0) {
            await this.appAlert('Önce bir müşteri eklemeniz gerekiyor', 'Uyarı');
            return;
        }

        // Create customer buttons
        container.innerHTML = customers.map(customer => {
            const balance = customer.balance || 0;
            const balanceText = balance > 0 ? `<small style="display: block; color: #e74c3c; margin-top: 5px;"> ${Math.round(balance)} ₺</small>` : '';
            return `
                <button class="customer-selection-btn" data-customer-id="${customer.id}">
                    <strong>${customer.name}</strong>
                    ${balanceText}
                </button>
            `;
        }).join('');

        // Add click listeners to customer buttons
        container.querySelectorAll('.customer-selection-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const customerId = btn.getAttribute('data-customer-id');
                this.processCreditTable(customerId);
            });
        });

        modal.classList.add('active');
    }

    async openCustomerSelectionModalForReceipt() {
        // Close receipt modal first
        const receiptModal = document.getElementById('receipt-modal');
        if (receiptModal) {
            receiptModal.classList.remove('active');
        }

        const customers = await this.db.getAllCustomers();
        const modal = document.getElementById('customer-selection-modal');
        const container = document.getElementById('customer-selection-buttons');
        
        if (!modal || !container) {
            await this.appAlert('Müşteri seçim ekranı bulunamadı', 'Hata');
            return;
        }

        if (customers.length === 0) {
            await this.appAlert('Önce bir müşteri eklemeniz gerekiyor', 'Uyarı');
            // Reopen receipt modal if no customers
            if (receiptModal) receiptModal.classList.add('active');
            return;
        }

        // Create customer buttons
        container.innerHTML = customers.map(customer => {
            const balance = customer.balance || 0;
            const balanceText = balance > 0 ? `<small style="display: block; color: #e74c3c; margin-top: 5px;"> ${Math.round(balance)} ₺</small>` : '';
            return `
                <button class="customer-selection-btn" data-customer-id="${customer.id}">
                    <strong>${customer.name}</strong>
                    ${balanceText}
                </button>
            `;
        }).join('');

        // Add click listeners to customer buttons
        container.querySelectorAll('.customer-selection-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const customerId = btn.getAttribute('data-customer-id');
                this.processCreditTable(customerId);
            });
        });

        modal.classList.add('active');
    }

    async processCreditTable(selectedCustomerId) {
        if (!this.currentTableId) return;

        const table = await this.db.getTable(this.currentTableId);
        if (!table) return;

        const customer = await this.db.getCustomer(selectedCustomerId);
        if (!customer) {
            await this.appAlert('Müşteri bulunamadı', 'Hata');
            return;
        }

        // Close customer selection modal
        const customerModal = document.getElementById('customer-selection-modal');
        if (customerModal) {
            customerModal.classList.remove('active');
        }

        const unpaidSales = await this.db.getUnpaidSalesByTable(this.currentTableId);
        
        // Calculate final check total (for hourly tables, include real-time calculation)
        let finalCheckTotal = table.checkTotal;
        if (table.type === 'hourly' && table.isActive && table.openTime) {
            // Normal hesaplama - oyun ücreti her zaman hesaplanmalı
            const hoursUsed = this.calculateHoursUsed(table.openTime);
            const hourlyTotal = hoursUsed * table.hourlyRate;
            finalCheckTotal = hourlyTotal + table.salesTotal;
        }
        
        // Allow credit if there's a check total (even if no unpaid sales - for hourly tables with only game charges)
        if (finalCheckTotal === 0) {
            await this.appAlert('Bu masa için veresiye yazılacak tutar yok.', 'Uyarı');
            return;
        }

        try {
            // Mark all unpaid sales as credit (paid but on credit)
            const creditTime = new Date().toISOString();
            for (const sale of unpaidSales) {
                sale.isPaid = true;
                sale.isCredit = true;
                sale.customerId = selectedCustomerId;
                sale.paymentTime = creditTime; // Track when credit was given
                await this.db.updateSale(sale);
            }

            // Update customer balance
            customer.balance = (customer.balance || 0) + finalCheckTotal;
            await this.db.updateCustomer(customer);

            // For hourly tables, close it and finalize hourly charges
            if (table.type === 'hourly' && table.isActive && table.openTime) {
                const closeTimeISO = new Date().toISOString();
                // Eğer hiç ürün yoksa süre fark etmeksizin ücretsiz kapat (dükkan sahibi kaybetti)
                if (unpaidSales.length === 0 && table.salesTotal === 0) {
                    // Hiç ürün olmadan kapanırsa 0 TL (süre fark etmez)
            table.hourlyTotal = 0;
                } else {
                    // Normal hesaplama
                    const hoursUsed = this.calculateHoursUsed(table.openTime);
                    table.hourlyTotal = hoursUsed * table.hourlyRate;
                }

                // Persist this session so reopening the table doesn't overwrite report history
                table.hourlySessions = Array.isArray(table.hourlySessions) ? table.hourlySessions : [];
                const sessionHoursUsed = this.calculateHoursBetween(table.openTime, closeTimeISO);
                const sessionHourlyTotal = (table.hourlyTotal || 0) > 0 ? table.hourlyTotal : (sessionHoursUsed * table.hourlyRate);
                table.hourlySessions.push({
                    openTime: table.openTime,
                    closeTime: closeTimeISO,
                    hoursUsed: sessionHoursUsed,
                    hourlyTotal: sessionHourlyTotal,
                    paymentTime: creditTime,
                    isCredit: true,
                    customerId: selectedCustomerId
                });
                
                table.isActive = false;
                table.closeTime = closeTimeISO;
            }

            // Reset totals but keep hourlyTotal and closeTime for daily reporting
            table.salesTotal = 0;
            table.checkTotal = 0;
            
            await this.db.updateTable(table);

            this.closeTableModal();
            await this.loadTables();
            await this.loadCustomers();
            await this.loadSales();
            
            // Always reload daily dashboard when table is closed/paid (data has changed)
            await this.loadDailyDashboard();
        } catch (error) {
            console.error('Veresiye yazılırken hata:', error);
            await this.appAlert('Veresiye yazılırken hata oluştu. Lütfen tekrar deneyin.', 'Hata');
        }
    }

    // Products Management
    async loadProducts() {
        const products = await this.db.getAllProducts();
        const container = document.getElementById('products-container');
        
        if (!container) {
            console.error('Products container not found');
            return;
        }
        
        if (products.length === 0) {
            container.innerHTML = '<div class="empty-state"><h3>Ürün bulunamadı</h3><p>Başlamak için yeni bir ürün ekleyin</p></div>';
            return;
        }

        container.innerHTML = products.map(product => this.createProductCard(product)).join('');
        
        // Use event delegation for better reliability
        container.addEventListener('click', (e) => {
            const target = e.target.closest('[id^="edit-product-"], [id^="delete-product-"]');
            if (!target) return;

            const extractId = (prefix) => {
                if (!target.id.startsWith(prefix)) return null;
                const idPart = target.id.slice(prefix.length);
                return idPart || null;
            };

            const editPrefix = 'edit-product-';
            const deletePrefix = 'delete-product-';

            if (target.id.startsWith(editPrefix)) {
                const id = extractId(editPrefix);
                if (!id) return;
                const product = products.find(p => String(p.id) === String(id));
                if (product) {
                    this.openProductFormModal(product);
                }
            } else if (target.id.startsWith(deletePrefix)) {
                const id = extractId(deletePrefix);
                if (!id) return;
                this.deleteProduct(id);
            }
        });
    }

    createProductCard(product) {
        const tracksStock = this.tracksStock(product);
        let stockClass = 'stock-high';
        let stockText = '';
        
        if (!tracksStock) {
            stockClass = 'stock-high';
            stockText = 'Stok: ∞';
        } else if (product.stock === 0) {
            stockClass = 'stock-out';
            stockText = 'Stokta Yok';
        } else if (product.stock < 10) {
            stockClass = 'stock-low';
            stockText = `Düşük Stok: ${product.stock}`;
        } else {
            stockText = `Stok: ${product.stock}`;
        }

        return `
            <div class="product-card">
                <div class="product-card-icon">📦</div>
                <div class="product-card-content">
                <h3>${product.name}</h3>
                    <div class="product-card-details">
                        <span><strong>Fiyat:</strong> ${Math.round(product.price)} ₺</span>
                        <span class="product-stock ${stockClass}">${stockText}</span>
                    </div>
                </div>
                <div class="product-actions">
                    <button class="btn btn-primary btn-icon" id="edit-product-${product.id}" title="Düzenle">✎</button>
                    <button class="btn btn-danger btn-icon" id="delete-product-${product.id}" title="Sil">×</button>
                </div>
            </div>
        `;
    }

    openProductFormModal(product = null) {
        const modal = document.getElementById('product-modal');
        const title = document.getElementById('product-modal-title');
        const form = document.getElementById('product-form');
        
        const trackStockCheckbox = document.getElementById('product-track-stock');
        const stockLabel = document.getElementById('product-stock-label');
        const stockInput = document.getElementById('product-stock');
        
        // Handle track stock checkbox change
        const handleTrackStockChange = () => {
            const stockInputGroup = stockLabel.querySelector('.stock-input-group');
            if (trackStockCheckbox.checked) {
                if (stockInputGroup) stockInputGroup.style.display = 'flex';
                stockInput.required = true;
            } else {
                if (stockInputGroup) stockInputGroup.style.display = 'none';
                stockInput.required = false;
                stockInput.value = 0;
            }
        };
        
        // Remove existing listeners to avoid duplicates
        const newCheckbox = trackStockCheckbox.cloneNode(true);
        trackStockCheckbox.parentNode.replaceChild(newCheckbox, trackStockCheckbox);
        document.getElementById('product-track-stock').addEventListener('change', handleTrackStockChange);
        
        if (product) {
            title.textContent = 'Ürünü Düzenle';
            document.getElementById('product-id').value = product.id;
            document.getElementById('product-name').value = product.name;
            document.getElementById('product-price').value = product.price;
            document.getElementById('product-arrival-price').value = product.arrivalPrice || 0;
            
            // Check if product tracks stock
            const trackStockCheckboxElement = document.getElementById('product-track-stock');
            const tracksStock = this.tracksStock(product);
            if (trackStockCheckboxElement) trackStockCheckboxElement.checked = tracksStock;
            const stockInputGroup = stockLabel.querySelector('.stock-input-group');
            if (tracksStock) {
                document.getElementById('product-stock').value = product.stock || 0;
                if (stockInputGroup) stockInputGroup.style.display = 'flex';
                stockInput.required = true;
        } else {
                if (stockInputGroup) stockInputGroup.style.display = 'none';
                stockInput.required = false;
                stockInput.value = 0;
            }
        } else {
            title.textContent = 'Ürün Ekle';
            form.reset();
            document.getElementById('product-id').value = '';
            const trackStockCheckboxElement = document.getElementById('product-track-stock');
            if (trackStockCheckboxElement) trackStockCheckboxElement.checked = true;
            const stockInputGroup = stockLabel.querySelector('.stock-input-group');
            if (stockInputGroup) stockInputGroup.style.display = 'flex';
            stockInput.required = true;
        }
        
        modal.classList.add('active');
    }

    async saveProduct() {
        const id = document.getElementById('product-id').value;
        const name = document.getElementById('product-name').value;
        const price = parseFloat(document.getElementById('product-price').value);
        const arrivalPrice = parseFloat(document.getElementById('product-arrival-price').value) || 0;
        const trackStock = document.getElementById('product-track-stock').checked;
        const stock = trackStock ? parseInt(document.getElementById('product-stock').value) : null;

        const productData = { name, price, arrivalPrice, stock, trackStock };

        try {
            if (id) {
                productData.id = id;
                await this.db.updateProduct(productData);
            } else {
                await this.db.addProduct(productData);
            }
            
            document.getElementById('product-modal').classList.remove('active');
            await this.loadProducts();
        } catch (error) {
            console.error('Ürün kaydedilirken hata:', error);
            await this.appAlert('Ürün kaydedilirken hata oluştu. Lütfen tekrar deneyin.', 'Hata');
        }
    }

    async deleteProduct(id) {
        if (!(await this.appConfirm('Bu ürünü silmek istediğinize emin misiniz?', { title: 'Ürün Sil', confirmText: 'Sil', cancelText: 'Vazgeç', confirmVariant: 'danger' }))) return;

        try {
            await this.db.deleteProduct(id);
            await this.loadProducts();
        } catch (error) {
            console.error('Ürün silinirken hata:', error);
            await this.appAlert('Ürün silinirken hata oluştu. Lütfen tekrar deneyin.', 'Hata');
        }
    }

    // Customers Management
    async loadCustomers() {
        try {
            const customers = await this.db.getAllCustomers();
            const container = document.getElementById('customers-container');
            
            if (!container) {
                console.error('Customers container not found');
                return;
            }
            
            if (customers.length === 0) {
                container.innerHTML = '<div class="empty-state"><h3>Müşteri bulunamadı</h3><p>Başlamak için yeni bir müşteri ekleyin</p></div>';
                return;
            }

            container.innerHTML = customers.map(customer => this.createCustomerCard(customer)).join('');
            
            // Add event listeners
            customers.forEach(customer => {
                const editBtn = document.getElementById(`edit-customer-${customer.id}`);
                const deleteBtn = document.getElementById(`delete-customer-${customer.id}`);
                const payBtn = document.getElementById(`pay-customer-${customer.id}`);
                
                if (editBtn) {
                    editBtn.addEventListener('click', () => {
                        this.openCustomerFormModal(customer);
                    });
                }
                
                if (deleteBtn) {
                    deleteBtn.addEventListener('click', () => {
                        this.deleteCustomer(customer.id);
                    });
                }
                
                if (payBtn) {
                    payBtn.addEventListener('click', () => {
                        this.openCustomerPaymentModal(customer);
                    });
                }
            });
        } catch (error) {
            console.error('Error loading customers:', error);
            const container = document.getElementById('customers-container');
            if (container) {
                container.innerHTML = '<div class="empty-state"><h3>Müşteriler yüklenirken hata oluştu</h3><p>Lütfen sayfayı yenileyin</p></div>';
            }
        }
    }

    createCustomerCard(customer) {
        const balance = customer.balance || 0;
        const balanceClass = balance > 0 ? 'balance-negative' : 'balance-positive';
        const balanceText = balance > 0 ? `${Math.round(balance)} ₺` : '0 ₺';

        return `
            <div class="customer-card">
                <div class="customer-card-icon">👤</div>
                <div class="customer-card-content">
                    <h3>${customer.name}</h3>
                    <div class="customer-card-balance ${balanceClass}">
                        ${balanceText}
                    </div>
                </div>
                <div class="customer-actions">
                    <button class="btn btn-primary btn-icon" id="edit-customer-${customer.id}" title="Düzenle">✎</button>
                    ${balance > 0 ? `<button class="btn btn-success btn-icon" id="pay-customer-${customer.id}" title="Ödeme Al">₺</button>` : ''}
                    <button class="btn btn-danger btn-icon" id="delete-customer-${customer.id}" title="Sil">×</button>
                </div>
            </div>
        `;
    }

    openCustomerFormModal(customer = null) {
        const modal = document.getElementById('customer-modal');
        const title = document.getElementById('customer-modal-title');
        const form = document.getElementById('customer-form');
        
        if (customer) {
            title.textContent = 'Müşteriyi Düzenle';
            document.getElementById('customer-id').value = customer.id;
            document.getElementById('customer-name').value = customer.name;
        } else {
            title.textContent = 'Müşteri Ekle';
            form.reset();
            document.getElementById('customer-id').value = '';
        }
        
        modal.classList.add('active');
    }

    async saveCustomer() {
        const id = document.getElementById('customer-id').value;
        const name = document.getElementById('customer-name').value.trim();

        if (!name) {
            await this.appAlert('Müşteri adı boş olamaz', 'Uyarı');
            return;
        }

        try {
            if (id) {
                const existingCustomer = await this.db.getCustomer(id);
                if (!existingCustomer) {
                    await this.appAlert('Müşteri bulunamadı. Lütfen tekrar deneyin.', 'Hata');
                    return;
                }
                const customerData = {
                    id: id,
                    name: name,
                    balance: existingCustomer.balance || 0
                };
                await this.db.updateCustomer(customerData);
            } else {
                const customerData = {
                    name: name,
                    balance: 0
                };
                await this.db.addCustomer(customerData);
            }
            
            document.getElementById('customer-modal').classList.remove('active');
            await this.loadCustomers();
        } catch (error) {
            console.error('Müşteri kaydedilirken hata:', error);
            const errorMessage = error.message || 'Bilinmeyen bir hata oluştu';
            await this.appAlert(`Müşteri kaydedilirken hata oluştu: ${errorMessage}. Lütfen sayfayı yenileyin ve tekrar deneyin.`, 'Hata');
        }
    }

    async deleteCustomer(id) {
        const customer = await this.db.getCustomer(id);
        if (!customer) return;

        if (customer.balance > 0) {
            if (!(await this.appConfirm(`${customer.name} müşterisinin ${Math.round(customer.balance)} ₺ veresiye bakiyesi var. Yine de silmek istiyor musunuz?`, { title: 'Müşteri Sil', confirmText: 'Sil', cancelText: 'Vazgeç', confirmVariant: 'danger' }))) {
                return;
            }
        } else if (!(await this.appConfirm('Bu müşteriyi silmek istediğinize emin misiniz?', { title: 'Müşteri Sil', confirmText: 'Sil', cancelText: 'Vazgeç', confirmVariant: 'danger' }))) {
            return;
        }

        try {
            await this.db.deleteCustomer(id);
            await this.loadCustomers();
        } catch (error) {
            console.error('Müşteri silinirken hata:', error);
            await this.appAlert('Müşteri silinirken hata oluştu. Lütfen tekrar deneyin.', 'Hata');
        }
    }

    openCustomerPaymentModal(customer) {
        const modal = document.getElementById('customer-payment-modal');
        const title = document.getElementById('customer-payment-title');
        const customerName = document.getElementById('payment-customer-name');
        const customerBalance = document.getElementById('payment-customer-balance');
        const customerIdInput = document.getElementById('payment-customer-id');
        const paymentAmount = document.getElementById('payment-amount');
        
        title.textContent = `${customer.name} - Ödeme`;
        customerName.textContent = customer.name;
        customerBalance.textContent = `${Math.round(customer.balance || 0)} ₺`;
        customerIdInput.value = customer.id;
        paymentAmount.value = '';
        paymentAmount.max = customer.balance || 0;
        
        modal.classList.add('active');
    }

    async processCustomerPayment() {
        const customerId = document.getElementById('payment-customer-id').value;
        const paymentAmount = parseFloat(document.getElementById('payment-amount').value);

        if (!customerId || !paymentAmount || paymentAmount <= 0) {
            await this.appAlert('Lütfen geçerli bir ödeme miktarı girin', 'Uyarı');
            return;
        }

        try {
            const customer = await this.db.getCustomer(customerId);
            if (!customer) {
                await this.appAlert('Müşteri bulunamadı', 'Hata');
                return;
            }

            const currentBalance = customer.balance || 0;
            if (paymentAmount > currentBalance) {
                await this.appAlert(`Ödeme miktarı veresiye bakiyesinden fazla olamaz. Bakiye: ${Math.round(currentBalance)} ₺`, 'Uyarı');
                return;
            }

            // Update customer balance
            customer.balance = Math.max(0, currentBalance - paymentAmount);
            await this.db.updateCustomer(customer);

            // Create a payment record sale
            const paymentSale = {
                tableId: null,
                customerId: customerId,
                items: [],
                sellDateTime: new Date().toISOString(),
                saleTotal: paymentAmount,
                isPaid: true,
                isCredit: false, // This is a payment, not credit
                paymentTime: new Date().toISOString()
            };
            await this.db.addSale(paymentSale);

            await this.appAlert(`Ödeme başarıyla alındı! Kalan bakiye: ${Math.round(customer.balance)} ₺`, 'Başarılı');
            
            document.getElementById('customer-payment-modal').classList.remove('active');
            await this.loadCustomers();
            
            if (this.currentView === 'daily') {
                await this.loadDailyDashboard();
            }
        } catch (error) {
            console.error('Ödeme işlenirken hata:', error);
            await this.appAlert('Ödeme işlenirken hata oluştu. Lütfen tekrar deneyin.', 'Hata');
        }
    }

    async payFullCustomerBalance() {
        const customerId = document.getElementById('payment-customer-id').value;
        if (!customerId) return;

        try {
            const customer = await this.db.getCustomer(customerId);
            if (!customer) {
                await this.appAlert('Müşteri bulunamadı', 'Hata');
                return;
            }

            const fullBalance = customer.balance || 0;
            if (fullBalance <= 0) {
                await this.appAlert('Veresiye bakiyesi yok', 'Uyarı');
                return;
            }

            // Set payment amount to full balance (rounded)
            const roundedBalance = Math.round(fullBalance * 100) / 100;
            document.getElementById('payment-amount').value = roundedBalance;
            
            // Process payment
            await this.processCustomerPayment();
        } catch (error) {
            console.error('Tamamını ödeme işlenirken hata:', error);
            await this.appAlert('Tamamını ödeme işlenirken hata oluştu. Lütfen tekrar deneyin.', 'Hata');
        }
    }

    // Sales History
    async loadSales() {
        const tables = await this.db.getAllTables();
        const sales = await this.db.getAllSales();
        
        // Update table filter
        const tableFilter = document.getElementById('sales-table-filter');
        tableFilter.innerHTML = '<option value="">Tüm Masalar</option>' +
            tables.map(t => `<option value="${t.id}">${t.name}</option>`).join('');

        await this.filterSales();
    }

    async filterSales() {
        const tableFilter = document.getElementById('sales-table-filter').value || null;
        const statusFilter = document.getElementById('sales-status-filter').value;
        
        let sales = await this.db.getAllSales();
        
        // Filter by table
        if (tableFilter) {
            sales = sales.filter(s => String(s.tableId) === String(tableFilter));
        }
        
        // Filter by status
        if (statusFilter === 'paid') {
            sales = sales.filter(s => s.isPaid);
        } else if (statusFilter === 'unpaid') {
            sales = sales.filter(s => !s.isPaid);
        }
        
        // Sort by date (newest first)
        sales.sort((a, b) => new Date(b.sellDateTime) - new Date(a.sellDateTime));
        
        const container = document.getElementById('sales-container');
        
        if (sales.length === 0) {
            container.innerHTML = '<div class="empty-state"><h3>Satış bulunamadı</h3></div>';
            return;
        }

        // Get table names for display
        const tables = await this.db.getAllTables();
        const tableMap = {};
        tables.forEach(t => tableMap[t.id] = t.name);

        container.innerHTML = await Promise.all(sales.map(async (sale) => {
            const tableName = sale.tableId ? (tableMap[sale.tableId] || 'Bilinmeyen Masa') : null;
            return await this.createSaleCard(sale, tableName);
        })).then(cards => cards.join(''));
    }

    async createSaleCard(sale, tableName) {
        // Group items by name and sum amounts (only non-cancelled items)
        const itemGroups = {};
        const cancelledGroups = {};
        
        sale.items.forEach(item => {
            if (item.isCancelled) {
                if (!cancelledGroups[item.name]) {
                    cancelledGroups[item.name] = {
                        name: item.name,
                        amount: 0,
                        price: item.price,
                        total: 0
                    };
                }
                cancelledGroups[item.name].amount += item.amount;
                cancelledGroups[item.name].total += item.price * item.amount;
            } else {
                if (!itemGroups[item.name]) {
                    itemGroups[item.name] = {
                        name: item.name,
                        amount: 0,
                        price: item.price,
                        total: 0
                    };
                }
                itemGroups[item.name].amount += item.amount;
                itemGroups[item.name].total += item.price * item.amount;
            }
        });
        
        // Build items HTML
        let items = '';
        
        // Add grouped items
        Object.values(itemGroups).forEach(group => {
            items += `<div class="sale-item">${group.name} x${group.amount} @ ${Math.round(group.price)} ₺ = ${Math.round(group.total)} ₺</div>`;
        });
        
        // Add cancelled items (grouped)
        Object.values(cancelledGroups).forEach(group => {
            items += `<div class="sale-item" style="opacity: 0.5; text-decoration: line-through;">${group.name} x${group.amount} @ ${Math.round(group.price)} ₺ = ${Math.round(group.total)} ₺ (İptal)</div>`;
        });
        
        let statusBadge = '';
        let customerInfo = '';
        
        if (sale.isCancelled) {
            statusBadge = '<span class="table-badge" style="background: #95a5a6; color: white;">İptal Edildi</span>';
        } else if (sale.isCredit) {
            statusBadge = '<span class="table-badge" style="background: #3498db; color: white;">Veresiye</span>';
        } else if (sale.isPaid) {
            statusBadge = '<span class="table-badge badge-success">Ödendi</span>';
        } else {
            statusBadge = '<span class="table-badge badge-danger">Ödenmedi</span>';
        }
        
        if (sale.customerId) {
            const customer = await this.db.getCustomer(sale.customerId);
            if (customer) {
                customerInfo = `Müşteri: ${customer.name}`;
            }
        }

        return `
            <div class="sale-card">
                <div class="sale-card-icon">💰</div>
                <div class="sale-card-content">
                <div class="sale-header">
                        <h3>${tableName || 'Ödeme'}</h3>
                        <div class="sale-header-meta">
                            <span>${this.formatDateTimeWithoutSeconds(sale.sellDateTime)}</span>
                            ${customerInfo ? `<span style="color: #3498db;">${customerInfo}</span>` : ''}
                        ${statusBadge}
                            <span class="sale-header-amount">${Math.round(sale.saleTotal)} ₺</span>
                    </div>
                </div>
                    ${items ? `<div class="sale-items">${items}</div>` : ''}
                </div>
            </div>
        `;
    }

    // Daily Dashboard
    getTodayStartTime() {
        const now = new Date();
        const todayStart = new Date(now);
        todayStart.setHours(8, 0, 0, 0); // Today at 08:00
        
        // If current time is before 08:00, use yesterday's 08:00
        if (now.getHours() < 8) {
            todayStart.setDate(todayStart.getDate() - 1);
        }
        
        return todayStart;
    }

    setTodayDateRange() {
        const startDateInput = document.getElementById('report-start-date');
        const endDateInput = document.getElementById('report-end-date');
        
        if (startDateInput && endDateInput) {
            const today = new Date();
            const todayStart = this.getTodayStartTime();
            
            // Format dates as YYYY-MM-DD for input type="date"
            const formatDateForInput = (date) => {
                const year = date.getFullYear();
                const month = String(date.getMonth() + 1).padStart(2, '0');
                const day = String(date.getDate()).padStart(2, '0');
                return `${year}-${month}-${day}`;
            };
            
            startDateInput.value = formatDateForInput(todayStart);
            endDateInput.value = formatDateForInput(today);
        }
    }

    getReportDateRange() {
        const startDateInput = document.getElementById('report-start-date');
        const endDateInput = document.getElementById('report-end-date');
        
        if (startDateInput && endDateInput && startDateInput.value && endDateInput.value) {
            const startDate = new Date(startDateInput.value + 'T08:00:00'); // Start at 08:00
            const endDate = new Date(endDateInput.value + 'T23:59:59'); // End at end of day
            
            // Ensure end date is not in the future
            const now = new Date();
            if (endDate > now) {
                endDate.setTime(now.getTime());
            }
            
            return { startDate, endDate };
        }
        
        // Fallback to today if no dates selected
        const todayStart = this.getTodayStartTime();
        const now = new Date();
        return { startDate: todayStart, endDate: now };
    }

    isDateRangeToday(startDate, endDate) {
        const todayStart = this.getTodayStartTime();
        const now = new Date();
        
        // Check if start date is today's start and end date is today
        const startDateStr = startDate.toDateString();
        const endDateStr = endDate.toDateString();
        const todayStartStr = todayStart.toDateString();
        const todayStr = now.toDateString();
        
        // If both dates are on the same day (today), it's a daily report
        // Also check if the date range is exactly one day
        const isSameDay = startDateStr === endDateStr;
        const isToday = startDateStr === todayStartStr && endDateStr === todayStr;
        
        return isSameDay && isToday;
    }

    async loadDailyDashboard() {
        const { startDate, endDate } = this.getReportDateRange();

        // Get all paid sales in date range - use paymentTime if available, otherwise use sellDateTime
        const allSales = await this.db.getAllSales();
        const periodPaidSales = allSales.filter(sale => {
            if (!sale.isPaid) return false;
            // Exclude cancelled sales from income calculations
            if (sale.isCancelled) return false;
            // Use paymentTime if available (when payment was made), otherwise use sellDateTime
            const paymentDate = sale.paymentTime ? new Date(sale.paymentTime) : new Date(sale.sellDateTime);
            return paymentDate >= startDate && paymentDate <= endDate;
        });

        // Manual sessions (report backfill)
        const allManualSessions = await this.db.getAllManualSessions();
        const periodManualSessions = (allManualSessions || []).filter((s) => {
            if (!s || s.type !== 'hourly' || !s.closeTime) return false;
            const closeTime = new Date(s.closeTime);
            return closeTime >= startDate && closeTime <= endDate;
        });

        // Get all tables to check hourly table sessions
        const allTables = await this.db.getAllTables();
        const hourlyAggByTableId = new Map();
        let totalTableHours = 0;
        let totalHourlyIncome = 0;

        const upsertHourlyAgg = (tableId, name, hoursToAdd, incomeToAdd, isActive) => {
            const existing = hourlyAggByTableId.get(tableId) || { name, hours: 0, income: 0, isActive: false };
            existing.hours += hoursToAdd;
            existing.income += incomeToAdd;
            existing.isActive = existing.isActive || isActive;
            hourlyAggByTableId.set(tableId, existing);
        };

        const manualAggByName = new Map();
        const upsertManualAgg = (name, hoursToAdd, incomeToAdd) => {
            const existing = manualAggByName.get(name) || { name, hours: 0, income: 0, isActive: false };
            existing.hours += hoursToAdd;
            existing.income += incomeToAdd;
            manualAggByName.set(name, existing);
        };

        for (const table of allTables) {
            if (table.type !== 'hourly') continue;

            // Closed sessions (paid/credited) - stored as history so they don't get overwritten
            const sessions = Array.isArray(table.hourlySessions) ? [...table.hourlySessions] : [];

            // Backward compatibility: if old single-session fields exist, treat them as one session
            if (table.closeTime && table.openTime) {
                const legacyExists = sessions.some((s) => s && s.openTime === table.openTime && s.closeTime === table.closeTime);
                if (!legacyExists) {
                    sessions.push({
                        openTime: table.openTime,
                        closeTime: table.closeTime,
                        hourlyTotal: table.hourlyTotal
                    });
                }
            }

            for (const session of sessions) {
                if (!session || !session.closeTime) continue;
                const closeTime = new Date(session.closeTime);
                if (closeTime < startDate || closeTime > endDate) continue;

                const openTime = session.openTime ? new Date(session.openTime) : null;
                const startTime = openTime && openTime >= startDate ? openTime : startDate;
                const hoursUsed = openTime ? Math.max(0, (closeTime - startTime) / (1000 * 60 * 60)) : 0;
                if (hoursUsed <= 0) continue;

                // If session started before selected period, only count the portion inside the period
                const hourlyIncome =
                    openTime && openTime < startDate
                        ? (hoursUsed * table.hourlyRate)
                        : ((session.hourlyTotal || 0) > 0 ? session.hourlyTotal : (hoursUsed * table.hourlyRate));

                totalTableHours += hoursUsed;
                totalHourlyIncome += hourlyIncome;
                upsertHourlyAgg(table.id, table.name, hoursUsed, hourlyIncome, false);
            }

            // Active session (not paid yet): show hours + estimated income, but DON'T count in income totals
            if (table.isActive && table.openTime) {
                const openTime = new Date(table.openTime);
                if (openTime >= startDate && openTime <= endDate) {
                    const startTime = openTime >= startDate ? openTime : startDate;
                    const endTime = new Date() > endDate ? endDate : new Date();
                    const hoursUsed = Math.max(0, (endTime - startTime) / (1000 * 60 * 60));
                    const estimatedIncome = hoursUsed * table.hourlyRate;
                    totalTableHours += hoursUsed;
                    upsertHourlyAgg(table.id, table.name, hoursUsed, estimatedIncome, true);
                }
            }
        }

        // Apply manual sessions into totals and usage list (these are already-paid game income)
        for (const s of periodManualSessions) {
            const name = s.tableName || 'Manuel';
            const hours = typeof s.hoursUsed === 'number' ? s.hoursUsed : 0;
            const income = typeof s.amount === 'number' ? s.amount : 0;
            totalTableHours += hours;
            totalHourlyIncome += income;
            upsertManualAgg(name, hours, income);
        }

        const hourlyTablesToday = [
            ...Array.from(hourlyAggByTableId.values()),
            ...Array.from(manualAggByName.values())
        ];

        // Calculate product sales statistics and profit
        let totalProductIncome = 0;
        let totalProductCost = 0;
        let totalProductsSold = 0;
        let totalCreditGiven = 0; // Total amount given as credit today
        const productCounts = {};

        periodPaidSales.forEach(sale => {
            // Only count non-credit sales in income (credit sales are not actual income yet)
            if (!sale.isCredit) {
                totalProductIncome += sale.saleTotal;
            }
            
            // Count credit sales separately
            if (sale.isCredit) {
                totalCreditGiven += sale.saleTotal;
            }
            
            sale.items.forEach(item => {
                // Skip cancelled items
                if (item.isCancelled) return;
                
                totalProductsSold += item.amount;
                // Calculate product cost (arrival price * amount) - only for non-credit sales
                if (!sale.isCredit) {
                    const itemCost = (item.arrivalPrice || 0) * item.amount;
                    totalProductCost += itemCost;
                }
                if (!productCounts[item.name]) {
                    productCounts[item.name] = 0;
                }
                productCounts[item.name] += item.amount;
            });
        });

        // Calculate profits
        const productProfit = totalProductIncome - totalProductCost; // Profit from products (sale price - arrival price)
        const gameProfit = totalHourlyIncome; // 100% profit from game hours (all hourly income is profit)
        const totalProfit = productProfit + gameProfit; // Total profit

        const totalDailyIncome = totalProductIncome + totalHourlyIncome;
        const transactionsCount = periodPaidSales.length;

        // Calculate total credit balance (all customers)
        const allCustomers = await this.db.getAllCustomers();
        const totalCreditBalance = allCustomers.reduce((sum, customer) => sum + (customer.balance || 0), 0);

        // Check if date range is today (single day)
        const isToday = this.isDateRangeToday(startDate, endDate);
        const periodLabel = isToday ? 'Günlük' : '';
        const todayLabel = isToday ? 'Bugün' : '';
        
        // Update stat card labels dynamically
        const dailyIncomeLabel = document.querySelector('#daily-income').parentElement.querySelector('h3');
        if (dailyIncomeLabel) {
            dailyIncomeLabel.textContent = periodLabel ? `${periodLabel} Gelir` : 'Gelir';
        }
        
        const creditGivenLabel = document.querySelector('#credit-given-today')?.parentElement?.querySelector('h3');
        if (creditGivenLabel) {
            creditGivenLabel.textContent = todayLabel ? `${todayLabel} Verilen Veresiye` : 'Verilen Veresiye';
        }
        
        // Update stats cards
        document.getElementById('daily-income').textContent = `${Math.round(totalDailyIncome)} ₺`;
        document.getElementById('products-sold').textContent = totalProductsSold;
        document.getElementById('table-hours').textContent = this.formatHoursToReadable(totalTableHours);
        document.getElementById('hourly-income').textContent = `${Math.round(totalHourlyIncome)} ₺`;
        document.getElementById('product-income').textContent = `${Math.round(totalProductIncome)} ₺`;
        document.getElementById('transactions-count').textContent = transactionsCount;
        document.getElementById('product-profit').textContent = `${Math.round(productProfit)} ₺`;
        document.getElementById('game-profit').textContent = `${Math.round(gameProfit)} ₺`;
        document.getElementById('total-profit').textContent = `${Math.round(totalProfit)} ₺`;
        
        // Update credit info if element exists
        const creditGivenEl = document.getElementById('credit-given-today');
        if (creditGivenEl) {
            creditGivenEl.textContent = `${Math.round(totalCreditGiven)} ₺`;
        }
        const creditBalanceEl = document.getElementById('total-credit-balance');
        if (creditBalanceEl) {
            creditBalanceEl.textContent = `${Math.round(totalCreditBalance)} ₺`;
        }

        // Update charts
        this.updateIncomeChart(totalHourlyIncome, totalProductIncome);
        this.updateProductsChart(productCounts);

        // Update table usage list
        this.updateTableUsageList(hourlyTablesToday);

        // Update manual sessions list
        this.updateManualSessionsList(periodManualSessions);
    }

    updateManualSessionsList(sessions) {
        const container = document.getElementById('manual-sessions-list');
        if (!container) return;

        if (!sessions || sessions.length === 0) {
            container.innerHTML = '<div class="empty-state"><p>Seçilen dönemde manuel oyun kaydı yok</p></div>';
            return;
        }

        const sorted = [...sessions].sort((a, b) => new Date(b.closeTime) - new Date(a.closeTime));
        container.innerHTML = sorted.map((s) => {
            const name = s.tableName || 'Manuel';
            const startStr = s.openTime ? this.formatDateTimeWithoutSeconds(s.openTime) : '--';
            const endStr = s.closeTime ? this.formatDateTimeWithoutSeconds(s.closeTime) : '--';
            const hoursReadable = this.formatHoursToReadable(s.hoursUsed || 0);
            const amount = Math.round(s.amount || 0);
            return `
                <div class="usage-item">
                    <div class="usage-info">
                        <strong>${name} <span style="color:#e74c3c; font-weight:800;">(Manuel)</span></strong>
                        <span>${startStr} → ${endStr} • ${hoursReadable}</span>
                    </div>
                    <div class="manual-session-actions">
                        <div class="usage-income">${amount} ₺</div>
                        <button class="manual-delete-btn" data-manual-id="${s.id}" title="Sil">×</button>
                    </div>
                </div>
            `;
        }).join('');

        container.querySelectorAll('.manual-delete-btn').forEach((btn) => {
            btn.addEventListener('click', async (e) => {
                e.preventDefault();
                e.stopPropagation();
                const id = btn.getAttribute('data-manual-id');
                if (!id) return;
                if (!(await this.appConfirm('Bu manuel oyun kaydını silmek istiyor musunuz?', { title: 'Manuel Kayıt Sil', confirmText: 'Sil', cancelText: 'Vazgeç', confirmVariant: 'danger' }))) return;
                try {
                    await this.db.deleteManualSession(id);
                    await this.loadDailyDashboard();
                } catch (err) {
                    console.error('Manuel kayıt silinirken hata:', err);
                    await this.appAlert('Manuel kayıt silinirken hata oluştu.', 'Hata');
                }
            });
        });
    }

    updateIncomeChart(hourlyIncome, productIncome) {
        const container = document.getElementById('income-chart-container');
        if (!container) return;

        // Destroy existing chart if it exists
        if (this.incomeChart) {
            this.incomeChart.destroy();
            this.incomeChart = null;
        }

        // If no income, show empty state
        if (hourlyIncome === 0 && productIncome === 0) {
            container.innerHTML = '<p style="text-align: center; padding: 40px; color: #7f8c8d;">Seçilen dönemde gelir yok</p>';
            return;
        }

        // Ensure canvas exists
        let ctx = document.getElementById('income-chart');
        if (!ctx || !container.querySelector('canvas')) {
            container.innerHTML = '<canvas id="income-chart"></canvas>';
            ctx = document.getElementById('income-chart');
            if (!ctx) return;
        }

        this.incomeChart = new Chart(ctx, {
            type: 'doughnut',
            data: {
                labels: ['Saatlik Gelir', 'Ürün Geliri'],
                datasets: [{
                    data: [hourlyIncome, productIncome],
                    backgroundColor: [
                        'rgba(255, 159, 64, 0.8)',
                        'rgba(54, 162, 235, 0.8)'
                    ],
                    borderColor: [
                        'rgba(255, 159, 64, 1)',
                        'rgba(54, 162, 235, 1)'
                    ],
                    borderWidth: 2
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: true,
                plugins: {
                    legend: {
                        position: 'bottom'
                    },
                    tooltip: {
                        callbacks: {
                            label: function(context) {
                                return context.label + ': ' + Math.round(context.parsed) + ' ₺';
                            }
                        }
                    }
                }
            }
        });
    }

    updateProductsChart(productCounts) {
        const container = document.getElementById('products-chart-container');
        if (!container) return;

        // Destroy existing chart if it exists
        if (this.productsChart) {
            this.productsChart.destroy();
            this.productsChart = null;
        }

        const productNames = Object.keys(productCounts);
        const productValues = Object.values(productCounts);

        if (productNames.length === 0) {
            // Show empty state
            container.innerHTML = '<p style="text-align: center; padding: 40px; color: #7f8c8d;">Seçilen dönemde satılan ürün yok</p>';
            return;
        }

        // Ensure canvas exists
        let ctx = document.getElementById('products-chart');
        if (!ctx || !container.querySelector('canvas')) {
            container.innerHTML = '<canvas id="products-chart"></canvas>';
            ctx = document.getElementById('products-chart');
            if (!ctx) return;
        }

        this.productsChart = new Chart(ctx, {
            type: 'bar',
            data: {
                labels: productNames,
                datasets: [{
                    label: 'Satılan Miktar',
                    data: productValues,
                    backgroundColor: 'rgba(46, 204, 113, 0.8)',
                    borderColor: 'rgba(46, 204, 113, 1)',
                    borderWidth: 1
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: true,
                plugins: {
                    legend: {
                        display: false
                    }
                },
                scales: {
                    y: {
                        beginAtZero: true,
                        ticks: {
                            stepSize: 1
                        }
                    }
                }
            }
        });
    }

    updateTableUsageList(tables) {
        const container = document.getElementById('table-usage-list');
        if (!container) return;

        if (tables.length === 0) {
            container.innerHTML = '<div class="empty-state"><p>Seçilen dönemde kullanılan saatlik masa yok</p></div>';
            return;
        }

        container.innerHTML = tables.map(table => `
            <div class="usage-item">
                <div class="usage-info">
                    <strong>${table.name}</strong>
                    <span>${this.formatHoursToReadable(table.hours)} ${table.isActive ? '(Aktif)' : ''}</span>
                </div>
                <div class="usage-income">${Math.round(table.income)} ₺</div>
            </div>
        `).join('');
    }

    updateFooter() {
        try {
            // Update date and time
            const now = new Date();
            const day = String(now.getDate()).padStart(2, '0');
            const month = String(now.getMonth() + 1).padStart(2, '0');
            const year = now.getFullYear();
            const hours = String(now.getHours()).padStart(2, '0');
            const minutes = String(now.getMinutes()).padStart(2, '0');
            
            const dateTimeEl = document.getElementById('footer-date-time');
            if (dateTimeEl) {
                dateTimeEl.textContent = `${day}.${month}.${year} ${hours}:${minutes}`;
            }
        } catch (error) {
            console.error('Footer güncellenirken hata:', error);
        }
    }

    startFooterUpdates() {
        // Update immediately
        this.updateFooter();
        // Update time every minute
        this.footerTimeUpdateInterval = setInterval(() => {
            this.updateFooter();
        }, 60000); // 60 seconds = 1 minute
    }

    async handlePageVisible() {
        // Page is now visible - refresh all data
        try {
            // Update footer immediately
            this.updateFooter();
            
            // Reload current view
            if (this.currentView === 'tables') {
                await this.loadTables();
                this.startTableCardPriceUpdates();
            } else if (this.currentView === 'products') {
                await this.loadProducts();
            } else if (this.currentView === 'sales') {
                await this.loadSales();
            } else if (this.currentView === 'customers') {
                await this.loadCustomers();
            } else if (this.currentView === 'daily') {
                await this.loadDailyDashboard();
            }
            
            // If table modal is open, refresh it
            const tableModal = document.getElementById('table-modal');
            if (tableModal && tableModal.classList.contains('active') && this.currentTableId) {
                await this.openTableModal(this.currentTableId);
            }
            
            // Restart footer updates (in case interval was stopped)
            if (!this.footerTimeUpdateInterval) {
                this.startFooterUpdates();
            }
            
            // Restart table card updates if on tables view
            if (this.currentView === 'tables') {
                if (!this.tableCardUpdateInterval) {
                    this.startTableCardPriceUpdates();
                }
            }
        } catch (error) {
            console.error('Sayfa görünür olduğunda veri güncellenirken hata:', error);
        }
    }
}

// Register Service Worker for PWA (only on HTTP/HTTPS, not file://)
// Service Worker is optional - app works without it
if ('serviceWorker' in navigator && (location.protocol === 'http:' || location.protocol === 'https:')) {
    window.addEventListener('load', () => {
        // Try to register service worker, but don't fail if it doesn't work
        navigator.serviceWorker.register('service-worker.js', { scope: './' })
            .then((registration) => {
                console.log('ServiceWorker registered successfully');
            })
            .catch((error) => {
                // Silently ignore - app works without service worker
                console.log('ServiceWorker not available (app will work normally)');
            });
    });
}

// Bootstrap Supabase + Auth + App
document.addEventListener('DOMContentLoaded', async () => {
    // Create global supabase client (frontend-safe: anon key only)
    window.supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

    // Require login before app boot (RLS will enforce anyway, but this improves UX)
    await ensureSignedIn(window.supabase);

    window.app = new MekanApp();
});
