// Main Application Logic — MekanApp
// Modüller: src/constants.js, src/auth.js, src/modules/*.js

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './supabase-config.js';
import { HybridDatabase } from './hybrid-db.js';
import { debounce, throttle } from './src/utils/performance.js';
import { formatDateTimeWithoutSeconds, formatTimeOnly, formatHoursToReadable } from './src/utils/formatters.js';
import { calculateHoursUsed, calculateHoursBetween } from './src/utils/calculators.js';
import { debugLog, debugWarn } from './src/constants.js';
import { ensureSignedIn } from './src/auth.js';
import * as dialogsModule from './src/modules/dialogs.js';

/**
 * MekanApp — Ana uygulama sınıfı.
 * Modüller: src/constants.js (debug), src/auth.js (giriş), src/modules/dialogs.js (alert/confirm/loading).
 * Bu dosyada kategoriler:
 * - Auth & kullanıcı (getUserRole, isAdmin, updateMenuVisibility)
 * - Init & event dinleyiciler (init, setupEventListeners)
 * - Sync & realtime (startPollSync, handleRealtimeChange, reloadViews)
 * - Görünüm & navigasyon (switchView, loadInitialData, header/loading)
 * - Masalar liste & kartlar (loadTables, createTableCard, setTableCardState, ...)
 * - Masa modalı (openTableModal, loadTableProducts, payTable, ...)
 * - Masa formu & aç/kapa (openTable, _closeTableSafely, saveTable, delayed start)
 * - Ürünler (loadProducts, openProductFormModal, ...)
 * - Müşteriler (loadCustomers, openCustomerFormModal, ...)
 * - Satış geçmişi (loadSales, filterSales, ...)
 * - Giderler (loadExpenses, ...)
 * - Günlük rapor (loadDailyDashboard, charts)
 * - Tema & footer (initDarkMode, updateFooter)
 */
class MekanApp {
    constructor() {
        this.supabase = window.supabase;
        // Hybrid DB: Supabase + IndexedDB cache (instant reads + periodic sync)
        this.db = new HybridDatabase(this.supabase);
        this.currentView = 'tables';
        this.currentTableId = null;
        this.incomeChart = null;
        this.productsChart = null;
        this.pendingDelayedStartTableId = null;
        this._dialog = null;
        this._dialogResolver = null;
        this._settlingTables = new Map(); // tableId -> expiry timestamp (ms)
        this._openingTables = new Map(); // tableId -> { until: ms, openTime: iso }
        this._closingTablesCount = 0; // Count of tables currently being closed (for DB refresh management)
        this._openingTablesCount = 0; // Count of tables currently being opened (for DB refresh management)
        // Prevent race conditions on fast-tap product adds (stock decrement must be accurate).
        // key: `${tableId}:${productId}` -> { pending: number, timer: any, chain: Promise }
        this._quickAddState = new Map();
        this.hourlyUpdateInterval = null;
        this.tableCardUpdateInterval = null;
        this.footerTimeUpdateInterval = null;
        this.dailyResetInterval = null;
        this.deferredPwaPrompt = null;
        this._realtimeChannel = null;
        this._realtimeRefreshTimer = null;
        this._realtimePendingViews = new Set();
        this._productsDelegationBound = false;
        this._pollSyncInterval = null;
        this._cachedProducts = null; // Cache products to avoid reloading on every modal open
        this._productsPageSize = 20; // Items per page for lazy loading
        this._productsCurrentPage = 0;
        this._productsAllLoaded = false;
        this._productsObserver = null; // Intersection Observer for infinite scroll
        this._salesPageSize = 30; // Items per page for virtual scrolling
        this._salesCurrentPage = 0;
        this._salesAllData = null;
        this._salesObserver = null;
        this._customersPageSize = 30;
        this._customersCurrentPage = 0;
        this._customersAllData = null;
        this._customersObserver = null;
        // Prefetch cache for table modal data (table, products, sales)
        this._tableModalPrefetchCache = new Map(); // tableId -> { table, products, sales, timestamp }
        this._tableModalPrefetchTimeout = 10000; // Cache expires after 10 seconds
        this._tableModalForceRefreshIds = new Set(); // after transfer, next open of target must skip cache
        this._transferCardStateCache = new Map(); // tableId -> { until, state } – prevent realtime/interval from overwriting for a few sec
        this._loadTablesInProgress = false; // Tek seferde bir loadTables; senkronizasyon için
        this._debouncedLoadTables = null; // Arka arkaya ürün eklerken loadTables tek seferde
        this.currentUser = null;
        this.userRole = null; // 'admin' or 'garson'
        this._hapticEnabled = 'vibrate' in navigator;
        this.init();
    }

    // Haptic feedback for mobile devices
    hapticFeedback(pattern = 'light') {
        if (!this._hapticEnabled) return;
        
        try {
            const patterns = {
                light: 10,      // Light tap
                medium: 20,     // Medium tap
                heavy: 30,      // Heavy tap
                success: [10, 50, 10],  // Success pattern
                error: [20, 50, 20, 50, 20],  // Error pattern
                warning: [10, 30, 10]   // Warning pattern
            };
            
            const vibration = patterns[pattern] || patterns.light;
            navigator.vibrate(vibration);
        } catch (e) {
            // Silently fail if vibration is not supported
        }
    }

    // ---------- Auth & kullanıcı ----------
    async getUserRole() {
        try {
            const { data: { user }, error } = await this.supabase.auth.getUser();
            if (error || !user) {
                console.error('Error getting user:', error);
                return null;
            }
            
            this.currentUser = user;
            
            // Get user role from user metadata
            // Default to 'garson' for security if role not found
            this.userRole = user.user_metadata?.role || 'garson';
            
            return this.userRole;
        } catch (error) {
            console.error('Error getting user role:', error);
            return null;
        }
    }

    // Check if current user is admin
    isAdmin() {
        return this.userRole === 'admin' || this.userRole === 'yönetici';
    }

    // Check if current user is garson
    isGarson() {
        return this.userRole === 'garson';
    }

    // Update menu visibility based on user role
    updateMenuVisibility() {
        const isAdmin = this.isAdmin();
        
        // Hide/show menu items
        const productsBtn = document.querySelector('.nav-btn-compact[data-view="products"]');
        const customersBtn = document.querySelector('.nav-btn-compact[data-view="customers"]');
        const expensesBtn = document.querySelector('.nav-btn-compact[data-view="expenses"]');
        const salesBtn = document.querySelector('.nav-btn-compact[data-view="sales"]');
        const dailyBtn = document.querySelector('.nav-btn-compact[data-view="daily"]');
        
        // Garson can only see tables and sales
        if (!isAdmin) {
            if (productsBtn) productsBtn.style.display = 'none';
            if (customersBtn) customersBtn.style.display = 'none';
            if (expensesBtn) expensesBtn.style.display = 'none';
            if (dailyBtn) dailyBtn.style.display = 'none';
            // Sales is visible for garson
        } else {
            // Admin sees all
            if (productsBtn) productsBtn.style.display = '';
            if (customersBtn) customersBtn.style.display = '';
            if (expensesBtn) expensesBtn.style.display = '';
            if (dailyBtn) dailyBtn.style.display = '';
        }
        
        // Hide add buttons for garson
        const addTableBtn = document.getElementById('add-table-btn');
        const addProductBtn = document.getElementById('add-product-btn');
        const addCustomerBtn = document.getElementById('add-customer-btn');
        const addExpenseBtn = document.getElementById('add-expense-btn');
        
        if (!isAdmin) {
            if (addTableBtn) addTableBtn.style.display = 'none';
            if (addProductBtn) addProductBtn.style.display = 'none';
            if (addCustomerBtn) addCustomerBtn.style.display = 'none';
            if (addExpenseBtn) addExpenseBtn.style.display = 'none';
        } else {
            if (addTableBtn) addTableBtn.style.display = '';
            if (addProductBtn) addProductBtn.style.display = '';
            if (addCustomerBtn) addCustomerBtn.style.display = '';
            if (addExpenseBtn) addExpenseBtn.style.display = '';
        }
    }

    // Utility functions are now imported from src/utils/

    // Batch + serialize product additions per table/product to avoid stock races on rapid taps.
    // ---------- Init & başlatma ----------
    queueQuickAddToTable(tableId, productId, deltaAmount = 1) {
        if (!tableId || !productId) return;
        const key = `${String(tableId)}:${String(productId)}`;
        const state = this._quickAddState.get(key) || { pending: 0, timer: null, chain: Promise.resolve() };
        state.pending += (Number(deltaAmount) || 0);
        if (state.pending <= 0) {
            this._quickAddState.set(key, state);
            return;
        }

        const scheduleFlush = (delayMs = 120) => {
            if (state.timer) return;
            state.timer = setTimeout(() => {
                state.timer = null;
                const amount = state.pending;
                state.pending = 0;
                if (amount <= 0) return;

                // Serialize remote writes (Supabase) + local cache updates (IDB)
                state.chain = state.chain
                    .then(() => this.addProductToTableFromModal(tableId, productId, amount))
                    .catch(() => { /* keep chain alive */ })
                    .finally(() => {
                        // If more clicks came in while in-flight, flush again soon
                        if (state.pending > 0) scheduleFlush(80);
                    });
            }, delayMs);
        };

        scheduleFlush(120);
        this._quickAddState.set(key, state);
    }

    async init() {
        try {
            // Get user role first
            await this.getUserRole();
            
            // Initialize dark mode from localStorage
            this.initDarkMode();
            
            // Ensure header is visible (session exists at this point)
            // Remove any auth-related classes that might hide the header
            const authModal = document.getElementById('auth-modal');
            if (authModal) {
                authModal.classList.remove('active');
                authModal.style.display = 'none';
            }
            document.body.classList.remove('auth-open');
            const header = document.getElementById('main-header');
            if (header) {
                header.style.display = '';
            }
            
            // Hide menu items based on role
            this.updateMenuVisibility();
            
            // Initialize database with timeout protection
            try {
                await Promise.race([
                    this.db.init(),
                    new Promise((_, reject) => setTimeout(() => reject(new Error('Database init timeout')), 15000))
                ]);
            } catch (dbError) {
                console.error('Database init error (app will continue with limited functionality):', dbError);
                // Continue anyway - some features may not work but app won't be completely broken
            }
            
            this.setupEventListeners();
            this.updateHeaderViewTitle(this.currentView);
            
            // Load initial data with error handling
            try {
                await Promise.race([
                    this.loadInitialData(),
                    new Promise((_, reject) => setTimeout(() => reject(new Error('Load initial data timeout')), 10000))
                ]);
            } catch (loadError) {
                console.error('Load initial data error (app will continue):', loadError);
                // Continue anyway - user can manually refresh
            }
            
            // Pre-load products cache for instant modal display (non-blocking)
            this.refreshProductsCache().catch(err => {
                console.error('Error pre-loading products cache:', err);
                // Non-critical - cache will be loaded on first modal open
            });
            
            // Start background services (non-critical if they fail)
            try {
            this.startDailyReset();
            } catch (e) {
                console.error('Error starting daily reset:', e);
            }
            
            try {
            this.startRealtimeSubscriptions();
            } catch (e) {
                console.error('Error starting realtime subscriptions:', e);
            }
            
            try {
                this.startPollSync();
            } catch (e) {
                console.error('Error starting poll sync:', e);
            }
            
            try {
                this.setupOrientationLock();
            } catch (e) {
                console.error('Error setting up orientation lock:', e);
            }
            
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
                this.stopRealtimeSubscriptions();
                this.stopPollSync();
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

    _syncHourlyRateFieldForTableType(type) {
        const hourlyRateLabel = document.getElementById('hourly-rate-label');
        const hourlyRateInput = document.getElementById('table-hourly-rate');
        if (!hourlyRateInput) return;

        const isHourly = String(type) === 'hourly';
        if (hourlyRateLabel) hourlyRateLabel.style.display = isHourly ? 'block' : 'none';

        // Critical: hidden + required => "invalid form control not focusable" in Chrome.
        hourlyRateInput.required = isHourly;
        hourlyRateInput.disabled = !isHourly;
        if (!isHourly) {
            hourlyRateInput.value = '';
        } else if (!hourlyRateInput.value) {
            // reasonable default
            hourlyRateInput.value = '0';
        }
    }

    setupOrientationLock() {
        // Best-effort: keep app in portrait (especially for "Add to Home Screen" standalone).
        // Some browsers require a user gesture to lock; we try on init and on first interaction.
        const tryLock = async () => {
            try {
                if (screen?.orientation?.lock) {
                    await screen.orientation.lock('portrait');
                }
            } catch (e) {
                // ignore (not supported / not allowed)
            }
        };

        tryLock();
        const once = () => {
            document.removeEventListener('click', once, true);
            document.removeEventListener('touchstart', once, true);
            tryLock();
        };
        document.addEventListener('click', once, true);
        document.addEventListener('touchstart', once, true);
    }

    startPollSync() {
        // Keep local IndexedDB cache continuously up-to-date
        if (this._pollSyncInterval) return;
        const tick = async () => {
            try {
                if (typeof this.db?.syncNow !== 'function') return;

                // While the table detail modal is open, avoid background DB refresh/re-render.
                // The user is interacting inside the modal; periodic refresh here causes jank.
                const tableModal = document.getElementById('table-modal');
                const isModalOpen = Boolean(tableModal && tableModal.classList.contains('active') && this.currentTableId);
                if (isModalOpen) return;

                const changedDelta = await this.db.syncNow();
                // Tables closing/opening must propagate reliably across devices.
                // Some schemas don't maintain tables.updated_at, so do a cheap tables-only full sync + diff.
                const changedTables = (typeof this.db?.syncTablesFull === 'function')
                    ? await this.db.syncTablesFull()
                    : false;
                const changed = Boolean(changedDelta || changedTables);
                if (!changed) return;

                // Refresh UI only when needed (avoid unnecessary re-renders)
                const views = [];
                if (this.currentView === 'tables') views.push('tables');
                if (this.currentView === 'sales') views.push('sales');

                if (views.length > 0) {
                    await this.reloadViews(Array.from(new Set(views)));
                }
            } catch (e) {
                // silent best-effort
            }
        };

        // Masalar görünümündeyken daha sık sync (süreli masa kapanışı diğer cihaza hızlı yansısın)
        const pollMs = this.currentView === 'tables' ? 1500 : 3000;
        tick();
        const runTick = () => {
            tick().then(() => {
                this._pollSyncInterval = setTimeout(runTick, this.currentView === 'tables' ? 1500 : 3000);
            }).catch(() => {
                this._pollSyncInterval = setTimeout(runTick, 3000);
            });
        };
        this._pollSyncInterval = setTimeout(runTick, pollMs);
    }

    stopPollSync() {
        if (this._pollSyncInterval) {
            clearTimeout(this._pollSyncInterval);
            this._pollSyncInterval = null;
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

    // ---------- Sync & realtime ----------
    updateSyncIndicator(state = null) {
        const indicator = document.getElementById('sync-indicator');
        if (!indicator) return;

        const statusEl = indicator.querySelector('.sync-status');
        if (!statusEl) return;

        if (state) {
            this._syncState = state;
        }

        // Remove all state classes
        indicator.classList.remove('syncing', 'error', 'offline');
        
        switch (this._syncState) {
            case 'syncing':
                indicator.classList.add('syncing');
                statusEl.textContent = 'Senkronize ediliyor...';
                break;
            case 'error':
                indicator.classList.add('error');
                statusEl.textContent = 'Hata';
                break;
            case 'offline':
                indicator.classList.add('offline');
                statusEl.textContent = 'Çevrimdışı';
                break;
            default:
                statusEl.textContent = 'Senkronize';
        }
    }

    setupEventListeners() {
        this.initAppDialog();

        // PWA install (Android Chrome home screen)
        const installBtn = document.getElementById('pwa-install-btn');
        window.addEventListener('beforeinstallprompt', (e) => {
            e.preventDefault();
            this.deferredPwaPrompt = e;
            if (installBtn) {
                installBtn.style.display = 'inline-flex';
            }
        });
        window.addEventListener('appinstalled', () => {
            this.deferredPwaPrompt = null;
            if (installBtn) {
                installBtn.style.display = 'none';
            }
        });
        if (installBtn) {
            installBtn.addEventListener('click', async () => {
                if (!this.deferredPwaPrompt) return;
                this.deferredPwaPrompt.prompt();
                try {
                    await this.deferredPwaPrompt.userChoice;
                } catch (_) {
                    // ignore
                } finally {
                    this.deferredPwaPrompt = null;
                    installBtn.style.display = 'none';
                }
            });
        }

        // Header logo/title click - go to tables view
        const headerTitle = document.querySelector('header h1');
        if (headerTitle) {
            headerTitle.style.cursor = 'pointer';
            headerTitle.addEventListener('click', () => {
                this.switchView('tables');
                // Also force a DB refresh (background) so other-device changes appear immediately
                // without requiring the user to do another action.
                this.refreshAllFromDb();
            });
        }

        // Add Table button
        const addTableBtn = document.getElementById('add-table-btn');
        if (addTableBtn) {
            addTableBtn.addEventListener('click', () => {
                this.hapticFeedback('light');
                this.openTableFormModal();
        });
        }

        // Add Product button
        const addProductBtn = document.getElementById('add-product-btn');
        if (addProductBtn) {
            addProductBtn.addEventListener('click', () => {
                this.hapticFeedback('light');
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

        // Dark mode toggle
        const darkModeToggle = document.getElementById('dark-mode-toggle');
        if (darkModeToggle) {
            darkModeToggle.addEventListener('click', (e) => {
                e.stopPropagation();
                this.toggleDarkMode();
                if (menuDropdown) {
                    menuDropdown.classList.remove('show');
                }
            });
        }

        // Add Customer button
        const addCustomerBtn = document.getElementById('add-customer-btn');
        if (addCustomerBtn) {
            addCustomerBtn.addEventListener('click', () => {
                this.hapticFeedback('light');
                this.openCustomerFormModal();
            });
        }

        // Instant sale button (header)
        const instantSaleBtn = document.getElementById('instant-sale-btn');
        if (instantSaleBtn) {
            instantSaleBtn.addEventListener('click', async () => {
                this.hapticFeedback('medium');
                await this.openInstantSaleTable();
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
                this._syncHourlyRateFieldForTableType(e.target.value);
        });
        }

        // Close modals (kayarak kapansın - closeFormModal/closeTableModal kullan)
        const formModalIdsForClose = ['table-form-modal', 'product-modal', 'customer-modal', 'expense-form-modal', 'customer-detail-modal', 'customer-payment-modal', 'customer-credit-add-modal', 'add-product-table-modal', 'receipt-modal', 'customer-selection-modal', 'transfer-target-modal'];
        document.querySelectorAll('.close').forEach(closeBtn => {
            closeBtn.addEventListener('click', (e) => {
                const modal = e.target.closest('.modal');
                if (modal && modal.id === 'app-dialog') return;
                if (modal && modal.id === 'table-modal') {
                    this.closeTableModal();
                } else if (modal && modal.id === 'add-product-table-modal') {
                    this.closeAddProductModal();
                } else if (modal && formModalIdsForClose.includes(modal.id)) {
                    this.closeFormModal(modal.id);
                } else if (modal) {
                    modal.classList.remove('active');
                }
            });
        });

        // Cancel buttons
        const cancelProductBtn = document.getElementById('cancel-product-btn');
        if (cancelProductBtn) cancelProductBtn.addEventListener('click', () => this.closeFormModal('product-modal'));

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


        const cancelTableFormBtn = document.getElementById('cancel-table-form-btn');
        if (cancelTableFormBtn) cancelTableFormBtn.addEventListener('click', () => this.closeFormModal('table-form-modal'));

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
            cancelReceiptBtn.addEventListener('click', () => this.closeFormModal('receipt-modal'));
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

        const receiptModal = document.getElementById('receipt-modal');
        if (receiptModal) {
            const receiptCloseBtn = receiptModal.querySelector('.close');
            if (receiptCloseBtn) receiptCloseBtn.addEventListener('click', () => this.closeFormModal('receipt-modal'));
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

        const cancelCustomerBtn = document.getElementById('cancel-customer-btn');
        if (cancelCustomerBtn) cancelCustomerBtn.addEventListener('click', () => this.closeFormModal('customer-modal'));

        // Pay full amount button
        const payFullAmountBtn = document.getElementById('pay-full-amount-btn');
        if (payFullAmountBtn) {
            payFullAmountBtn.addEventListener('click', () => {
                this.payFullCustomerBalance();
        });
        }

        const cancelCustomerPaymentBtn = document.getElementById('cancel-customer-payment-btn');
        if (cancelCustomerPaymentBtn) cancelCustomerPaymentBtn.addEventListener('click', () => this.closeFormModal('customer-payment-modal'));

        // Manual credit add (customer)
        const creditAddForm = document.getElementById('customer-credit-add-form');
        if (creditAddForm) {
            creditAddForm.addEventListener('submit', async (e) => {
                e.preventDefault();
                await this.processCustomerCreditAdd();
            });
        }
        const cancelCustomerCreditAddBtn = document.getElementById('cancel-customer-credit-add-btn');
        if (cancelCustomerCreditAddBtn) cancelCustomerCreditAddBtn.addEventListener('click', () => this.closeFormModal('customer-credit-add-modal'));

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

        // Expense form
        const expenseForm = document.getElementById('expense-form');
        if (expenseForm) {
            expenseForm.addEventListener('submit', (e) => {
                e.preventDefault();
                this.saveExpense();
            });
        }

        // Add expense button - now handled by add-card in loadExpenses()

        const cancelExpenseBtn = document.getElementById('cancel-expense-btn');
        if (cancelExpenseBtn) cancelExpenseBtn.addEventListener('click', () => this.closeFormModal('expense-form-modal'));

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

        // Sales filters with debounce for better performance
        const salesTableFilter = document.getElementById('sales-table-filter');
        if (salesTableFilter) {
            salesTableFilter.addEventListener('change', debounce(() => {
            this.filterSales();
            }, 300));
        }

        const salesStatusFilter = document.getElementById('sales-status-filter');
        if (salesStatusFilter) {
            salesStatusFilter.addEventListener('change', debounce(() => {
            this.filterSales();
            }, 300));
        }

        const moveTableBtn = document.getElementById('move-table-btn');
        if (moveTableBtn) {
            moveTableBtn.addEventListener('click', () => {
                if (this.currentTableId) this.openTransferTargetModal('table');
            });
        }
        const transferTargetConfirm = document.getElementById('transfer-target-confirm-btn');
        const transferTargetCancel = document.getElementById('transfer-target-cancel-btn');
        if (transferTargetConfirm) transferTargetConfirm.addEventListener('click', () => this.doTransferToTarget());
        if (transferTargetCancel) transferTargetCancel.addEventListener('click', () => this.closeFormModal('transfer-target-modal'));

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
                e.preventDefault();
                e.stopPropagation();
                const modal = e.target.closest('.modal');
                if (modal && modal.id === 'app-dialog') {
                    // Handled by app dialog itself
                    return;
                }
                if (modal && modal.id === 'table-modal') {
                    this.closeTableModal();
                } else if (modal) {
                    // Use closeFormModal for form modals, direct remove for others
                    const formModalIds = ['table-form-modal', 'product-modal', 'customer-modal', 'expense-form-modal', 'customer-detail-modal', 'customer-payment-modal', 'customer-credit-add-modal', 'add-product-table-modal', 'receipt-modal', 'customer-selection-modal', 'transfer-target-modal'];
                    if (formModalIds.includes(modal.id)) {
                        this.closeFormModal(modal.id);
                    } else {
                    modal.classList.remove('active');
                    }
                }
            });
        });
    }

    // ---------- Görünüm & navigasyon ----------
    async loadInitialData() {
        try {
            // İlk açılış: sadece masa listesi + hesap totalleri + açıklık (local veri) – ekran hemen açılsın
            await this.loadTablesLight().catch(err => {
                console.error('Error loading tables (light):', err);
            });
            if (this.currentView === 'tables') {
                try {
                    this.startTableCardPriceUpdates();
                } catch (err) {
                    console.error('Error starting table card updates:', err);
                }
            }
            // Diğer verileri arka planda çek; bitince sync + tam masa listesi
            this.loadRestOfInitialDataAsync();
        } catch (error) {
            console.error('Error loading initial data:', error, error?.message, error?.details, error?.hint, error?.code);
        }
    }

    /** Arka planda: anlık satış masası, ürünler, müşteriler, satışlar; sonra sync + tam loadTables */
    loadRestOfInitialDataAsync() {
        Promise.all([
            this.ensureInstantSaleTable().catch(err => {
                console.error('Error ensuring instant sale table:', err);
                return null;
            }),
            this.loadProducts().catch(err => {
                console.error('Error loading products:', err);
                return false;
            }),
            this.loadCustomers().catch(err => {
                console.error('Error loading customers:', err);
                return false;
            }),
            this.loadSales().catch(err => {
                console.error('Error loading sales:', err);
                return false;
            })
        ]).then(() => {
            if (typeof this.db?.syncTablesFull === 'function') {
                return this.db.syncTablesFull().catch(() => {}).then(() => this.loadTables());
            }
            return this.loadTables();
        }).catch(err => {
            console.error('Error in loadRestOfInitialDataAsync:', err);
        });
    }

    async ensureInstantSaleTable() {
        const tables = await this.db.getAllTables();
        const instantTables = (tables || []).filter(t => t.type === 'instant');
        if (instantTables.length > 1) {
            const keep = instantTables.find(t => t.name === 'ANLIK SATIŞ') || instantTables[0];
            for (const t of instantTables) {
                if (t.id === keep.id) continue;
                try {
                    await this.db.deleteTable(t.id);
                } catch (_) {
                    // Satışı olan masalar silinmeyebilir (foreign key); yoksay
                }
            }
            return;
        }
        if (instantTables.length === 1) return;
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

    async switchView(viewName) {
        this.updateHeaderViewTitle(viewName);

        // Update navigation (compact menu + bottom nav)
        document.querySelectorAll('.nav-btn-compact').forEach(btn => {
            btn.classList.remove('active');
        });
        document
            .querySelectorAll(`.nav-btn-compact[data-view="${viewName}"]`)
            .forEach((btn) => btn.classList.add('active'));

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
            // Diğer cihazda kapanan süreli masaların bu cihazda da kapalı görünmesi için girişte sync
            if (typeof this.db?.syncTablesFull === 'function') {
                this.db.syncTablesFull().then(() => this.loadTables()).catch(() => this.loadTables());
            } else {
                this.loadTables();
            }
            // Start auto-update for table cards when on tables view
            this.startTableCardPriceUpdates();
        } else if (viewName === 'products') {
            // Stop auto-update when not on tables view
            this.stopTableCardPriceUpdates();
            // When entering from the menu, force a delta sync so the list is fresh
            this.syncAndReloadView(viewName);
        } else if (viewName === 'customers') {
            // Stop auto-update when not on tables view
            this.stopTableCardPriceUpdates();
            // When entering from the menu, force a delta sync so the list is fresh
            this.syncAndReloadView(viewName);
        } else if (viewName === 'expenses') {
            // Stop auto-update when not on tables view
            this.stopTableCardPriceUpdates();
            await this.loadExpenses();
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

    // Force-refresh local cache from Supabase, then reload the selected view from local DB.
    // Designed for manual navigation (menu click) so users always see up-to-date products/customers.
    async syncAndReloadView(viewName) {
        const token = (this._viewSyncToken = (this._viewSyncToken || 0) + 1);
        try {
            if (this.db?.syncNow) {
                await this.db.syncNow({ force: true });
            }
        } catch (_) {
            // Offline / transient errors: fall back to whatever is in local DB
        }

        // Ignore if user already navigated elsewhere
        if (token !== this._viewSyncToken || this.currentView !== viewName) return;

        if (viewName === 'products') {
            await this.loadProducts(true); // Reset pagination
        } else if (viewName === 'customers') {
            await this.loadCustomers(true); // Reset pagination
        }
    }

    updateHeaderViewTitle(viewName) {
        const el = document.getElementById('header-view-title');
        if (!el) return;
        const map = {
            tables: 'Masalar',
            products: 'Ürünler',
            customers: 'Müşteriler',
            expenses: 'Giderler',
            sales: 'Geçmiş',
            daily: 'Rapor'
        };
        const label = map[viewName] || 'Masalar';
        el.textContent = label;
    }

    /** Header şimşek butonundaki açık masalar toplamını günceller (xxxx ₺). */
    updateHeaderOpenTablesTotal(total) {
        const el = document.getElementById('header-open-total');
        if (!el) return;
        const value = Number(total);
        el.textContent = Number.isFinite(value) ? `${Math.round(value)} ₺` : '0 ₺';
    }

    /** Açık masaların (anlık satış hariç: açık süreli + satışı olan normal) check toplamını hesaplar. */
    sumOpenTablesCheckTotal(tables) {
        if (!Array.isArray(tables) || tables.length === 0) return 0;
        let sum = 0;
        for (const t of tables) {
            if (t.type === 'instant') continue;
            const isClosed = t.type === 'hourly' && !t.openTime;
            const isOpen = t.type === 'hourly'
                ? (t.isActive && t.openTime)
                : (t.isActive || (Number(t._computedSalesTotal) || 0) > 0);
            if (!isOpen) continue;
            const check = t._computedCheckTotal != null ? t._computedCheckTotal : (t.checkTotal || 0);
            sum += Number(check) || 0;
        }
        return sum;
    }

    setTablesLoading(isLoading) {
        const container = document.getElementById('tables-container');
        if (!container) return;
        if (isLoading) {
            const hasAnyCard = container.querySelector('.table-card');
            if (!hasAnyCard) {
                container.classList.add('is-loading');
                container.innerHTML = this.createTablesLoadingScreen();
            }
        } else {
            container.classList.remove('is-loading');
        }
    }

    /** Tam sayfa: "Masalar & hesaplar yükleniyor..." + spinner + progress bar */
    createTablesLoadingScreen() {
        return `
            <div class="tables-loading-screen" aria-live="polite" aria-busy="true">
                <div class="tables-loading-spinner" aria-hidden="true"></div>
                <p class="tables-loading-message">Masalar & hesaplar yükleniyor...</p>
            </div>
        `;
    }

    createTableSkeletonCards(count = 12) {
        const n = Math.max(6, Number(count) || 12);
        return Array.from({ length: n })
            .map(
                () => `
                <div class="table-card skeleton" aria-hidden="true">
                    <div class="table-icon" style="opacity:0;">🪑</div>
                    <h3 style="opacity:0;">&nbsp;</h3>
                    <div class="table-price" style="opacity:0;">&nbsp;</div>
                </div>
            `
            )
            .join('');
    }

    /** Boş görünüm mesajı (masalar, ürünler vb.) */
    createEmptyState(viewKey) {
        const messages = {
            tables: '<div class="empty-state"><p>Henüz masa yok. Masa ekleyin.</p></div>',
            products: '<div class="empty-state"><p>Ürün bulunamadı</p></div>',
            customers: '<div class="empty-state"><p>Müşteri bulunamadı</p></div>',
            sales: '<div class="empty-state"><p>Satış bulunamadı</p></div>',
            expenses: '<div class="empty-state"><p>Gider bulunamadı</p></div>',
            daily: '<div class="empty-state"><p>Veri yok</p></div>'
        };
        return messages[viewKey] || '<div class="empty-state"><p>Veri yok</p></div>';
    }

    // ---------- Tables (liste ve kartlar) ----------
    /** İlk açılışta hızlı ekran: sadece local masalar + hesap totalleri + açıklık. Sync ve diğer veriler sonra. */
    async loadTablesLight() {
        const container = document.getElementById('tables-container');
        if (!container) return;
        this.setTablesLoading(true);
        try {
            // İlk açılışta (local DB boşsa veya sadece instant table varsa) önce Supabase'den çek
            let tables = await this.db.getAllTables() || [];
            const isFirstLoad = tables.length === 0 || (tables.length === 1 && tables.find(t => t.type === 'instant'));
            
            if (isFirstLoad && typeof this.db?.syncTablesFull === 'function') {
                try {
                    // İlk açılışta direkt Supabase'den çek (local değil) - her zaman güncel veri
                    await Promise.race([
                        this.db.syncTablesFull(),
                        new Promise((r) => setTimeout(r, 5000))
                    ]).catch(() => {});
                    tables = await this.db.getAllTables() || [];
                } catch (_) {}
            } else if (!isFirstLoad && typeof this.db?.syncTablesFull === 'function') {
                // Sonraki açılışlarda: önce local göster, arka planda sync yap (hızlı açılış)
                // Local veriler zaten yüklendi, sync arka planda devam edecek
            }
            if (tables.length === 0) {
                this.updateHeaderOpenTablesTotal(0);
                container.innerHTML = this.createEmptyState('tables') + this.createAddTableCard();
                const addCard = document.getElementById('add-table-card');
                if (addCard) addCard.onclick = () => this.openTableFormModal();
                return;
            }
            const instantTable = tables.find(t => t.type === 'instant');
            tables = tables.filter(t => t.type !== 'instant');
            tables.sort((a, b) => {
                if (a.type === 'hourly' && b.type !== 'hourly') return -1;
                if (a.type !== 'hourly' && b.type === 'hourly') return 1;
                const iconA = a.icon || (a.type === 'hourly' ? '🎱' : '🪑');
                const iconB = b.icon || (b.type === 'hourly' ? '🎱' : '🪑');
                if (iconA !== iconB) return iconA.localeCompare(iconB);
                return a.name.localeCompare(b.name, 'tr', { sensitivity: 'base' });
            });
            // Tüm unpaid sales'leri bir kerede çek (her masa için ayrı çağrı yerine)
            let allUnpaidSales = [];
            try {
                const allSales = await this.db.getAllSales() || [];
                allUnpaidSales = allSales.filter(s => !s.isPaid);
            } catch (_) {}
            
            // Masalara göre grupla
            const salesByTableId = new Map();
            for (const sale of allUnpaidSales) {
                if (!sale.tableId) continue;
                const tableId = String(sale.tableId);
                if (!salesByTableId.has(tableId)) {
                    salesByTableId.set(tableId, []);
                }
                salesByTableId.get(tableId).push(sale);
            }
            
            for (const table of tables) {
                if (this._isTableSettling(table.id)) continue;
                const unpaidSales = salesByTableId.get(String(table.id)) || [];
                const computedSalesTotal = unpaidSales.reduce((sum, s) => sum + (Number(s?.saleTotal) || 0), 0);
                table._computedSalesTotal = computedSalesTotal;
                if (table.type === 'hourly' && table.isActive && table.openTime) {
                    const hoursUsed = calculateHoursUsed(table.openTime);
                    table._computedHourlyTotal = hoursUsed * (table.hourlyRate || 0);
                    table._computedCheckTotal = table._computedHourlyTotal + computedSalesTotal;
                } else {
                    table._computedHourlyTotal = 0;
                    table._computedCheckTotal = computedSalesTotal;
                }
                if (unpaidSales.length > 0 && table.type !== 'hourly') table.isActive = true;
            }
            for (const t of tables) {
                if (t.type !== 'hourly' && t.type !== 'instant' && (Number(t._computedSalesTotal) || 0) > 0) t.isActive = true;
            }
            const headerTotal = this.sumOpenTablesCheckTotal(tables);
            this.updateHeaderOpenTablesTotal(headerTotal);
            const tableCards = await Promise.all(tables.map(table => this.createTableCard(table)));
            container.innerHTML = tableCards.join('') + this.createAddTableCard();
            const addCard = document.getElementById('add-table-card');
            if (addCard) addCard.onclick = () => this.openTableFormModal();
            tables.forEach(table => {
                const card = document.getElementById(`table-${table.id}`);
                if (!card) return;
                this.setupSwipeGesture(card, table);
                const delayBtn = card.querySelector('.table-delay-btn');
                if (delayBtn) delayBtn.addEventListener('click', async (e) => { e.preventDefault(); e.stopPropagation(); await this.openDelayedStartModal(table.id); });
                let pressTimer = null, hasLongPressed = false;
                const startLongPress = () => {
                    hasLongPressed = false;
                    if (table.type === 'instant') return;
                    pressTimer = setTimeout(async () => {
                        hasLongPressed = true;
                        if (await this.appConfirm(`"${table.name}" masasını silmek istediğinize emin misiniz?`, { title: 'Masa Sil', confirmText: 'Sil', cancelText: 'Vazgeç', confirmVariant: 'danger' })) {
                            this.showTableCardProcessing(table.id, 'Siliniyor...', 'cancel');
                            try {
                                await this.db.deleteTable(table.id);
                                await this.loadTables();
                                if (this.currentView === 'daily') await this.loadDailyDashboard();
                            } catch (err) {
                                console.error('Masa silinirken hata:', err);
                                this.hideTableCardProcessing(table.id);
                                await this.appAlert('Masa silinirken hata oluştu.', 'Hata');
                            } finally {
                                this.hideTableCardProcessing(table.id);
                            }
                        }
                        setTimeout(() => { hasLongPressed = false; }, 100);
                    }, 3000);
                };
                const cancelLongPress = () => { if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; } };
                const prefetchTableData = async () => {
                    const cached = this._tableModalPrefetchCache.get(table.id);
                    const now = Date.now();
                    if (!cached || (now - cached.timestamp) >= this._tableModalPrefetchTimeout) {
                        Promise.all([
                            this.db.getTable(table.id).catch(() => null),
                            this.db.getUnpaidSalesByTable(table.id).catch(() => []),
                            this.db.getAllProducts().then(products => this.sortProductsByStock(products)).catch(() => [])
                        ]).then(([tableData, sales, products]) => {
                            if (tableData) this._tableModalPrefetchCache.set(table.id, { table: tableData, sales, products, timestamp: now });
                        }).catch(() => {});
                    }
                };
                card.addEventListener('touchstart', () => { startLongPress(); prefetchTableData(); }, { passive: true });
                card.addEventListener('touchend', cancelLongPress);
                card.addEventListener('touchcancel', cancelLongPress);
                card.addEventListener('mousedown', () => { startLongPress(); prefetchTableData(); });
                card.addEventListener('mouseup', cancelLongPress);
                card.addEventListener('mouseleave', cancelLongPress);
                if (table.type === 'hourly') {
                    let tapTimer = null, tapCount = 0;
                    card.addEventListener('click', async (e) => {
                        if (hasLongPressed) { hasLongPressed = false; return; }
                        cancelLongPress();
                        e.preventDefault();
                        const current = await this.db.getTable(table.id);
                        if (current && current.openTime) {
                            clearTimeout(tapTimer);
                            tapCount = 0;
                            this.openTableModal(table.id, { preSync: true });
                            return;
                        }
                        tapCount++;
                        if (tapCount === 1) {
                            tapTimer = setTimeout(() => { tapCount = 0; }, 300);
                        } else if (tapCount === 2) {
                            clearTimeout(tapTimer);
                            tapCount = 0;
                            this.currentTableId = table.id;
                            this.setTableCardOpening(table.id, true);
                            const startTime = Date.now();
                            try {
                                await this.openTable();
                            } finally {
                                const elapsed = Date.now() - startTime;
                                if (elapsed < 2000) await new Promise(r => setTimeout(r, 2000 - elapsed));
                                else await new Promise(r => setTimeout(r, 50));
                                this.setTableCardOpening(table.id, false);
                                try {
                                    const updatedTable = await this.db.getTable(table.id);
                                    if (updatedTable) {
                                        this.setTableCardState(table.id, { isActive: true, type: 'hourly', openTime: updatedTable.openTime || new Date().toISOString(), hourlyRate: updatedTable.hourlyRate || 0, salesTotal: updatedTable.salesTotal || 0, checkTotal: updatedTable.checkTotal || 0 });
                                        if (this.refreshSingleTableCard) await this.refreshSingleTableCard(table.id);
                                    }
                                } catch (err) {}
                            }
                        }
                    });
                } else {
                    card.addEventListener('click', (e) => {
                        if (hasLongPressed) { hasLongPressed = false; return; }
                        cancelLongPress();
                        this.openTableModal(table.id, { preSync: true });
                    });
                }
            });
            if (this.currentView === 'tables') this.updateTableCardPrices();
        } finally {
            this.setTablesLoading(false);
        }
    }

    async loadTables() {
        const container = document.getElementById('tables-container');
        if (!container) {
            console.error('Tables container not found');
            return;
        }
        if (this._loadTablesInProgress) return;
        this._loadTablesInProgress = true;
        this.setTablesLoading(true);

        try {
            // Masaları göstermeden önce mutlaka remote'dan tam liste çek: diğer cihazda kapanan masa
            // bu cihazda açık görünmesin ve updateTable ile tekrar açılmasın.
            if (typeof this.db?.syncTablesFull === 'function') {
                await Promise.race([
                    this.db.syncTablesFull(),
                    new Promise((r) => setTimeout(r, 8000))
                ]).catch(() => {});
            } else if (typeof this.db?.syncNow === 'function') {
                await Promise.race([
                    this.db.syncNow({ force: true, forceFull: true }),
                    new Promise((r) => setTimeout(r, 6000))
                ]).catch(() => {});
            }

            let tables = [];
            tables = await this.db.getAllTables();
            
            if (tables.length === 0) {
                this.updateHeaderOpenTablesTotal(0);
                container.innerHTML = this.createEmptyState('tables') + this.createAddTableCard();
                const addCard = document.getElementById('add-table-card');
                if (addCard) addCard.onclick = () => this.openTableFormModal();
                return;
            }

        // Filter out instant sale table from tables list (it will be in header)
        const instantTable = tables.find(t => t.type === 'instant');
        tables = tables.filter(t => t.type !== 'instant');
        
        // Sıralama: 1-süreli, 2-aynı ikondan fazla olanlar (ikon gruplu), 3-alfabetik (açıklık yok)
        tables.sort((a, b) => {
            if (a.type === 'hourly' && b.type !== 'hourly') return -1;
            if (a.type !== 'hourly' && b.type === 'hourly') return 1;
            const iconA = a.icon || (a.type === 'hourly' ? '🎱' : '🪑');
            const iconB = b.icon || (b.type === 'hourly' ? '🎱' : '🪑');
            if (iconA !== iconB) return iconA.localeCompare(iconB);
            return a.name.localeCompare(b.name, 'tr', { sensitivity: 'base' });
        });

        // Sync each table's status with unpaid sales - but hourly tables must be manually opened
        for (const table of tables) {
            // Süreli masada kapalı = openTime yok (closeTime sadece son kapanış zamanı, tekrar açılabilir).
            // CRITICAL: If table is settling (just closed), skip all updates to prevent race conditions
            // This prevents DB refresh from overwriting closure state
            const isSettling = this._isTableSettling(table.id);
            if (isSettling) {
                debugLog(`Table ${table.id} is settling, skipping loadTables update to prevent race condition`);
                // Still render the card but don't update DB state
                continue;
            }
            
            let unpaidSales = await this.db.getUnpaidSalesByTable(table.id);
            let tableUpdatedFromRemote = false;
            // When local has no sales for a regular table, always try remote (e.g. after transfer on another device or stale local)
            if (unpaidSales.length === 0 && table.type !== 'hourly' && table.type !== 'instant' && typeof this.db.getUnpaidSalesByTableFromRemote === 'function') {
                try {
                    const fromRemote = await this.db.getUnpaidSalesByTableFromRemote(table.id);
                    if (fromRemote && fromRemote.length > 0) {
                        unpaidSales = fromRemote;
                        table.isActive = true;
                        tableUpdatedFromRemote = true;
                        if (typeof this.db.upsertSalesToLocal === 'function') {
                            await this.db.upsertSalesToLocal(fromRemote).catch(() => {});
                        }
                    }
                } catch (_) {}
            }
            // Compute totals from sales to avoid cross-device race conditions on aggregated columns
            const computedSalesTotal = (unpaidSales || []).reduce((sum, s) => sum + (Number(s?.saleTotal) || 0), 0);
            table._computedSalesTotal = computedSalesTotal;

            // Compute check total (hourly tables include time when open)
            // Süreli masada kapalı = openTime yok; açıkken süre toplamı hesaplanır.
            if (table.type === 'hourly' && table.isActive && table.openTime) {
                const hoursUsed = calculateHoursUsed(table.openTime);
                table._computedHourlyTotal = hoursUsed * (table.hourlyRate || 0);
                table._computedCheckTotal = table._computedHourlyTotal + computedSalesTotal;
            } else {
                table._computedHourlyTotal = 0;
                table._computedCheckTotal = computedSalesTotal;
            }
            let tableUpdated = tableUpdatedFromRemote;
            
            if (unpaidSales.length > 0 && !table.isActive) {
                // Table has products but is not active - activate it only for regular tables
                // Hourly tables must be manually opened via "Open Table" button
                if (!isSettling && table.type !== 'hourly') {
                    table.isActive = true;
                    tableUpdated = true;
                }
            } else if (unpaidSales.length === 0 && table.isActive) {
                // Table has no unpaid sales.
                // Süreli masada openTime yoksa kapalı tutulur.
                if (table.type === 'hourly' && !table.openTime) {
                    table.isActive = false;
                    table.hourlyTotal = 0;
                    table.salesTotal = 0;
                    table.checkTotal = 0;
                    tableUpdated = true;
                } else if (table.type === 'hourly' && table.openTime) {
                    // Hourly tables: if manually opened (have openTime), keep active and update totals.
                    // Regular tables: DO NOT auto-deactivate. They can be "occupied" with zero products,
                    // and that state must sync across devices (açılış / boş-dolu).
                    if (isSettling) {
                        // Recent settle: prefer showing as closed while DB catches up
                        // (do not write to DB here; payment flow will persist state)
                    } else {
                    // Manually opened hourly table - keep it active, just update totals
                    table.hourlyTotal = this.calculateHourlyTotal(table);
                    table.checkTotal = this.calculateCheckTotal(table);
                    tableUpdated = true;
                    }
                }
            } else if (unpaidSales.length === 0 && !table.isActive && (table.salesTotal > 0 || table.hourlyTotal > 0 || table.checkTotal > 0)) {
                // Table is inactive but has totals - reset them
                // Süreli masada kapalı (openTime yok) ise toplamları sıfırla (geçmiş hourlySessions'ta).
                if (table.type === 'hourly' && !table.openTime) {
                    table.salesTotal = 0;
                    table.hourlyTotal = 0;
                    table.checkTotal = 0;
                    tableUpdated = true;
                } else if (table.type !== 'hourly' || !table.openTime) {
                    // Regular table or hourly table without openTime
                    table.salesTotal = 0;
                    table.hourlyTotal = 0;
                    table.checkTotal = 0;
                    table.openTime = null;
                    tableUpdated = true;
                }
            }
            
            if (tableUpdated) {
                await this.db.updateTable(table);
                const updatedTable = await this.db.getTable(table.id);
                Object.assign(table, updatedTable);
                // Re-attach computed fields after refresh
                table._computedSalesTotal = computedSalesTotal;
                table._computedHourlyTotal = table._computedHourlyTotal || 0;
                table._computedCheckTotal = table._computedCheckTotal || computedSalesTotal;
                // getTable bazen güncel isActive dönmeyebilir; satış varsa kartı açık göster
                if (unpaidSales.length > 0 && table.type !== 'hourly' && table.type !== 'instant') {
                    table.isActive = true;
                }
            }
        }

        // Tek kaynak: satış varsa masa açık (DB isActive bazen gecikmeli)
        for (const t of tables) {
            if (t.type !== 'hourly' && t.type !== 'instant' && (Number(t._computedSalesTotal) || 0) > 0) {
                t.isActive = true;
            }
        }

        const headerTotal = this.sumOpenTablesCheckTotal(tables);
        this.updateHeaderOpenTablesTotal(headerTotal);

        // Create table cards - need to await async createTableCard
        const tableCards = await Promise.all(tables.map(table => this.createTableCard(table)));
        container.innerHTML = tableCards.join('') + this.createAddTableCard();

        const addCard = document.getElementById('add-table-card');
        if (addCard) addCard.onclick = () => this.openTableFormModal();
        
        // Setup long press for delete (old way - 3 seconds)
        // Add click listeners - special handling for hourly tables
        tables.forEach(table => {
            const card = document.getElementById(`table-${table.id}`);
            if (!card) return;

            // Add swipe gesture for closing table (mobile)
            this.setupSwipeGesture(card, table);

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
                        this.showTableCardProcessing(table.id, 'Siliniyor...', 'cancel');
                        try {
                            await this.db.deleteTable(table.id);
                            await this.loadTables();
                            if (this.currentView === 'daily') {
                                await this.loadDailyDashboard();
                            }
                        } catch (error) {
                            console.error('Masa silinirken hata:', error);
                            this.hideTableCardProcessing(table.id);
                            await this.appAlert('Masa silinirken hata oluştu. Lütfen tekrar deneyin.', 'Hata');
                        } finally {
                            this.hideTableCardProcessing(table.id);
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
            
            // Prefetch table data on touchstart/mousedown for faster modal opening
            const prefetchTableData = async () => {
                // Only prefetch if not already cached or cache expired
                const cached = this._tableModalPrefetchCache.get(table.id);
                const now = Date.now();
                if (!cached || (now - cached.timestamp) >= this._tableModalPrefetchTimeout) {
                    // Prefetch in background (don't await - non-blocking)
                    Promise.all([
                        this.db.getTable(table.id).catch(() => null),
                        this.db.getUnpaidSalesByTable(table.id).catch(() => []),
                        this.db.getAllProducts().then(products => this.sortProductsByStock(products)).catch(() => [])
                    ]).then(([tableData, sales, products]) => {
                        if (tableData) {
                            this._tableModalPrefetchCache.set(table.id, {
                                table: tableData,
                                sales: sales,
                                products: products,
                                timestamp: now
                            });
                            debugLog(`Prefetched data for table ${table.id}`);
                        }
                    }).catch(err => {
                        console.error('Prefetch error:', err);
                    });
                }
            };
            
            // Support both touch and mouse events for long press + prefetch
            card.addEventListener('touchstart', (e) => {
                startLongPress();
                prefetchTableData(); // Prefetch on touchstart
            }, { passive: true });
            card.addEventListener('touchend', cancelLongPress);
            card.addEventListener('touchcancel', cancelLongPress);
            card.addEventListener('mousedown', (e) => {
                startLongPress();
                prefetchTableData(); // Prefetch on mousedown
            });
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
                    
                    // openTime varsa masa açık: gecikmeli başlat ikonu olmaz, tek tıklamayla detay açılır
                    const current = await this.db.getTable(table.id);
                    if (current && current.openTime) {
                        clearTimeout(tapTimer);
                        tapCount = 0;
                        this.openTableModal(table.id, { preSync: true });
                        return;
                    }
                    
                    // openTime yok - çift tıklama ile süre başlat
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
                        // Show loading state before opening
                        this.setTableCardOpening(table.id, true);
                        const startTime = Date.now();
                        try {
                        await this.openTable();
                        } finally {
                            // CRITICAL: Always wait exactly 2 seconds before clearing loading state
                            // This ensures "Süre başlatılıyor" message is always visible for 2 seconds
                            const elapsed = Date.now() - startTime;
                            const minDisplayTime = 2000; // Always 2 seconds
                            if (elapsed < minDisplayTime) {
                                await new Promise(resolve => setTimeout(resolve, minDisplayTime - elapsed));
                            } else {
                                // If already past 2 seconds, still wait a tiny bit to ensure smooth transition
                                await new Promise(resolve => setTimeout(resolve, 50));
                            }
                            
                            // CRITICAL: DO NOT update table state while message is showing
                            // setTableCardState would interfere with "Süre başlatılıyor..." message
                            // Clear loading state FIRST, then update state
                            this.setTableCardOpening(table.id, false);
                            
                            // NOW update the card state after message is cleared; sonra kartı DB'den yenile (gecikmeli başlat ikonu kalksın, tıklama detay açsın)
                            try {
                                const updatedTable = await this.db.getTable(table.id);
                                if (updatedTable) {
                                    this.setTableCardState(table.id, {
                                        isActive: true,
                                        type: 'hourly',
                                        openTime: updatedTable.openTime || new Date().toISOString(),
                                        hourlyRate: updatedTable.hourlyRate || 0,
                                        salesTotal: updatedTable.salesTotal || 0,
                                        checkTotal: updatedTable.checkTotal || 0
                                    });
                                    if (this.refreshSingleTableCard) {
                                        await this.refreshSingleTableCard(table.id);
                                    }
                                }
                            } catch (e) {
                                console.error('Error updating table state after clearing loading:', e);
                            }
                        }
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
                    
                    this.openTableModal(table.id, { preSync: true });
                });
            }
        });
        
        // Update prices immediately (the interval will handle ongoing updates)
        if (this.currentView === 'tables') {
            this.updateTableCardPrices();
            const now = Date.now();
            for (const [tid, entry] of this._transferCardStateCache.entries()) {
                if (entry.until > now) this.setTableCardState(tid, entry.state);
                else this._transferCardStateCache.delete(tid);
            }
        }
        } finally {
            this.setTablesLoading(false);
            this._loadTablesInProgress = false;
        }
    }

    // Setup swipe gesture for table cards (mobile)
    setupSwipeGesture(card, table) {
        let touchStartX = 0;
        let touchStartY = 0;
        let touchEndX = 0;
        let touchEndY = 0;
        let isSwiping = false;
        let swipeThreshold = 50; // Minimum swipe distance in pixels
        let swipeVelocity = 0;

        card.addEventListener('touchstart', (e) => {
            touchStartX = e.touches[0].clientX;
            touchStartY = e.touches[0].clientY;
            isSwiping = false;
            swipeVelocity = 0;
        }, { passive: true });

        card.addEventListener('touchmove', (e) => {
            if (!touchStartX || !touchStartY) return;
            
            touchEndX = e.touches[0].clientX;
            touchEndY = e.touches[0].clientY;
            
            const deltaX = touchEndX - touchStartX;
            const deltaY = touchEndY - touchStartY;
            
            // Check if horizontal swipe is dominant
            if (Math.abs(deltaX) > Math.abs(deltaY) && Math.abs(deltaX) > 10) {
                isSwiping = true;
                swipeVelocity = deltaX;
                
                // Visual feedback: move card slightly
                const translateX = Math.max(-100, Math.min(0, deltaX));
                card.style.transform = `translateX(${translateX}px)`;
                card.style.transition = 'none';
                
                // Add visual indicator (red background on right side)
                if (deltaX < -30) {
                    card.style.opacity = '0.8';
                }
            }
        }, { passive: true });

        card.addEventListener('touchend', async (e) => {
            if (!touchStartX || !touchStartY) return;
            
            const deltaX = touchEndX - touchStartX;
            const deltaY = touchEndY - touchStartY;
            const distance = Math.abs(deltaX);
            
            // Reset visual state
            card.style.transition = 'all 0.3s ease';
            card.style.opacity = '';
            
            // Check if swipe is valid (left swipe, sufficient distance, fast enough)
            if (isSwiping && deltaX < -swipeThreshold && Math.abs(deltaX) > Math.abs(deltaY) && 
                (distance > 80 || Math.abs(swipeVelocity) > 0.5)) {
                
                // Swipe to close - only for active tables
                if (table.isActive) {
                    e.preventDefault();
                    e.stopPropagation();
                    
                    // Animate card out
                    card.style.transform = 'translateX(-100%)';
                    card.style.opacity = '0';
                    
                    // Close table after animation
                    setTimeout(async () => {
                        // Check if table is still active (might have been closed by another action)
                        const currentTable = await this.db.getTable(table.id);
                        if (currentTable && currentTable.isActive) {
                            // For hourly tables, show cancel confirmation
                            if (table.type === 'hourly') {
                                const confirmed = await this.appConfirm(
                                    'Masayı kapatmak istediğinize emin misiniz?',
                                    { title: 'Masa Kapat', confirmText: 'Kapat', cancelText: 'İptal', confirmVariant: 'danger' }
                                );
                                if (confirmed) {
                                    await this.cancelHourlyGame(table.id);
                                } else {
                                    // Reset card position if cancelled
                                    card.style.transform = '';
                                    card.style.opacity = '';
                                }
                            } else {
                                // Regular table - just close
                                this.currentTableId = table.id;
                                await this.processPayment();
                            }
                        }
                        
                        // Reset card position
                        card.style.transform = '';
                        card.style.opacity = '';
                    }, 300);
                }
            } else {
                // Reset card position if swipe was not valid
                card.style.transform = '';
            }
            
            // Reset touch tracking
            touchStartX = 0;
            touchStartY = 0;
            touchEndX = 0;
            touchEndY = 0;
            isSwiping = false;
        }, { passive: false });
    }

    // Setup bottom sheet swipe down to close (closeCallback: optional, else closeTableModal)
    // Scroll container: içeride kaydırılan eleman. Sadece en üstteyken + belirgin aşağı çekince kapat (kasılmayı önlemek için eşik).
    setupBottomSheetSwipe(modalEl, closeCallback) {
        const modalContent = modalEl.querySelector('.modal-content');
        if (!modalContent) return;

        const DRAG_THRESHOLD_PX = 18;  // Bu kadar px aşağı çekmeden "kapat" başlamaz; yavaş scroll takılmaz
        const CLOSE_THRESHOLD_PX = 100;

        const getScrollContainer = () => {
            if (modalEl.id === 'table-modal') {
                const body = document.getElementById('table-modal-body');
                return body || modalContent;
            }
            const cards = modalEl.querySelector('.transfer-target-cards');
            return cards || modalContent;
        };

        let touchStartY = null;
        let touchCurrentY = 0;
        let isDragging = false;
        let scrollContainer = null;  // Gesture başına bir kez al, touchmove'da tekrar DOM sorgulama (jank azaltır)

        modalContent.addEventListener('touchstart', (e) => {
            scrollContainer = getScrollContainer();
            const isTouchInScrollArea = scrollContainer && scrollContainer.contains(e.target);
            const atTop = isTouchInScrollArea ? scrollContainer.scrollTop <= 2 : true;
            touchStartY = e.touches[0].clientY;
            touchCurrentY = touchStartY;
            isDragging = false;
            if (!atTop) scrollContainer = null;  // En üstte değilse bu gesture'da kapatma yok
        }, { passive: true });

        modalContent.addEventListener('touchmove', (e) => {
            if (touchStartY == null) return;
            touchCurrentY = e.touches[0].clientY;
            const deltaY = touchCurrentY - touchStartY;
            if (!scrollContainer) return;  // Zaten aşağıda scroll vardı, dokunmayı scroll'a bırak
            const atTop = scrollContainer.scrollTop <= 2;
            // Belirgin aşağı çekmeden kapatma başlatma; böylece yavaş scroll kasılmaz
            if (atTop && deltaY > DRAG_THRESHOLD_PX) {
                if (!isDragging) modalContent.style.willChange = 'transform';
                isDragging = true;
                e.preventDefault();
                const translateY = Math.max(0, deltaY);
                modalContent.style.transform = `translateY(${translateY}px)`;
                modalContent.style.transition = 'none';
            }
        }, { passive: false });

        modalContent.addEventListener('touchend', () => {
            if (!isDragging || touchStartY == null) {
                touchStartY = null;
                scrollContainer = null;
                return;
            }
            const deltaY = touchCurrentY - touchStartY;
            if (deltaY > CLOSE_THRESHOLD_PX) {
                modalContent.style.willChange = '';
                if (typeof closeCallback === 'function') closeCallback();
                else this.closeTableModal();
            } else {
                modalContent.style.transition = 'transform 0.375s cubic-bezier(0.32, 0.72, 0, 1)';
                modalContent.style.transform = 'translateY(0)';
            }
            modalContent.style.willChange = '';
            touchStartY = null;
            touchCurrentY = 0;
            isDragging = false;
            scrollContainer = null;
        }, { passive: true });
    }

    // Mobilde bottom-sheet modallarını alttan aç (ürün/müşteri/gider/detay vb.)
    runBottomSheetOpen(modalEl) {
        if (!modalEl || !modalEl.classList.contains('modal-bottom-sheet') || window.innerWidth > 768) return;
        const modalContent = modalEl.querySelector('.modal-content');
        if (!modalContent) return;
        modalContent.style.transform = 'translate3d(0, 100%, 0)';
        modalContent.style.transition = 'transform 0.375s cubic-bezier(0.32, 0.72, 0, 1)';
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                modalContent.style.transform = 'translate3d(0, 0, 0)';
            });
        });
        this.setupBottomSheetSwipe(modalEl, () => this.closeFormModal(modalEl.id));
    }

    createAddTableCard() {
        return `
            <div class="table-card add-card" id="add-table-card" title="Masa Ekle">
                <div class="add-card-icon">＋</div>
                <h3>Masa Ekle</h3>
                <div class="add-card-sub">Yeni masa</div>
            </div>
        `;
    }

    async updateTableCardPrices() {
        // Only update if we're on the tables view
        if (this.currentView !== 'tables') {
            return;
        }

        const tables = await this.db.getAllTables();
        const now = Date.now();
        for (const table of tables) {
            const cached = this._transferCardStateCache?.get(table.id) || this._transferCardStateCache?.get(String(table.id));
            if (cached && cached.until > now) continue;
            const card = document.getElementById(`table-${table.id}`);
            if (!card) continue;

            const isClosed = table.type === 'hourly' && !table.openTime;
            let isActive = table.type === 'instant' 
                ? true 
                : (table.type === 'hourly' 
                    ? (table.isActive && table.openTime)
                    : table.isActive);

            let displayTotal = 0;
            if (table.type === 'instant') {
                displayTotal = await this.getInstantTableDailyTotal(table.id);
            } else {
                const unpaid = await this.db.getUnpaidSalesByTable(table.id);
                const salesTotal = (unpaid || []).reduce((sum, s) => sum + (Number(s?.saleTotal) || 0), 0);
                if (table.type === 'hourly' && table.isActive && table.openTime) {
                    displayTotal = calculateHoursUsed(table.openTime) * (table.hourlyRate || 0) + salesTotal;
                } else {
                    displayTotal = salesTotal;
                    if (table.type !== 'hourly' && salesTotal > 0) isActive = true;
                }
            }

            const priceElement = card.querySelector('.table-price');
            if (priceElement) priceElement.textContent = `${Math.round(displayTotal)} ₺`;
            card.classList.toggle('active', Boolean(isActive) || table.type === 'instant');
            card.classList.toggle('inactive', !Boolean(isActive) && table.type !== 'instant');
        }
        // Header toplamını sadece loadTables günceller; burada güncelleme yapma.
        // Aksi halde 10 sn'lik interval farklı anlık veriyle toplamı değiştirip "arada değişiyor sonra düzeliyor" hissi veriyor.
    }

    startTableCardPriceUpdates() {
        // Clear any existing interval
        if (this.tableCardUpdateInterval) {
            clearInterval(this.tableCardUpdateInterval);
        }
        
        // Update table card prices frequently so hourly tables increase without waiting.
        // (No network: uses local cache + computed totals)
        this.tableCardUpdateInterval = setInterval(() => {
            this.updateTableCardPrices();
        }, 10000); // 10 seconds
    }

    stopTableCardPriceUpdates() {
        if (this.tableCardUpdateInterval) {
            clearInterval(this.tableCardUpdateInterval);
            this.tableCardUpdateInterval = null;
        }
    }

    async createTableCard(table) {
        // Süreli masada openTime bazen getAllTables ile gecikmeli gelir; ikon yanlış çıkmasın diye tekrar oku
        if (table?.type === 'hourly' && !table.openTime) {
            const fresh = await this.db.getTable(table.id);
            if (fresh && fresh.openTime) table = { ...table, openTime: fresh.openTime };
        }
        // If user just opened an hourly table, keep it visually open for a couple seconds
        const opening = (table?.type === 'hourly') ? this._getTableOpening(table.id) : null;
        const isClosed = table?.type === 'hourly' && !table.openTime;
        const effectiveTable = (opening && !isClosed)
            ? { ...table, isActive: true, openTime: opening.openTime || table.openTime }
            : table;

        // Instant sale table is always active
        // Süreli masada açık = openTime var; normal masalar: satış varsa açık göster.
        const isActive = effectiveTable.type === 'instant' 
            ? true 
            : (effectiveTable.type === 'hourly' 
                ? (effectiveTable.isActive && effectiveTable.openTime)
                : (effectiveTable.isActive || (Number(effectiveTable._computedSalesTotal) || 0) > 0));
        const statusClass = (effectiveTable.type === 'instant' || isActive) ? 'active' : 'inactive';
        
        // Calculate check total for display (prefer computed totals from unpaid sales)
        // CRITICAL: If table is closed, always show 0 total (regardless of unpaid sales)
        let displayTotal = 0;
        if (isActive) {
            const computedSalesTotal = Number(effectiveTable._computedSalesTotal);
            const salesTotal = Number.isFinite(computedSalesTotal) ? computedSalesTotal : (effectiveTable.salesTotal || 0);
            displayTotal = (effectiveTable._computedCheckTotal != null) ? effectiveTable._computedCheckTotal : (effectiveTable.checkTotal || 0);
            
            // For hourly tables: only calculate hourly total if table is actually active (not closed)
            if (effectiveTable.type === 'hourly' && isActive && effectiveTable.openTime) {
            // For hourly tables, include hourly total
            const hoursUsed = calculateHoursUsed(effectiveTable.openTime);
            const hourlyTotal = hoursUsed * effectiveTable.hourlyRate;
                displayTotal = hourlyTotal + salesTotal;
        } else if (effectiveTable.type === 'instant') {
            // For instant sale table, show today's paid sales total
            displayTotal = await this.getInstantTableDailyTotal(effectiveTable.id);
            } else {
                // Regular tables: sum of unpaid sales
                displayTotal = salesTotal;
            }
        }

        // Get icon from table data, or use default
        let icon = effectiveTable.icon || (effectiveTable.type === 'hourly' ? '🎱' : '🪑'); // Use stored icon or default based on type

        // Add instant class for instant sale table
        const instantClass = effectiveTable.type === 'instant' ? 'instant-table' : '';

        // Gecikmeli başlat ikonu: sadece openTime yoksa
        const delayedStartBtn = (effectiveTable.type === 'hourly' && !effectiveTable.openTime)
            ? `<button class="table-delay-btn" data-table-id="${effectiveTable.id}" title="Gecikmeli Başlat">⏱</button>`
            : '';

        return `
            <div class="table-card ${statusClass} ${instantClass}" id="table-${effectiveTable.id}">
                ${delayedStartBtn}
                <div class="table-icon">${icon}</div>
                    <h3>${effectiveTable.name}</h3>
                <div class="table-price">${Math.round(displayTotal)} ₺</div>
            </div>
        `;
    }

    // Optimistic UI helpers (avoid waiting for DB before updating the screen)
    getTableCardEl(tableId) {
        return document.getElementById(`table-${tableId}`);
    }

    setTableCardLoading(tableId, isLoading) {
        const card = this.getTableCardEl(tableId);
        if (!card) return;
        if (isLoading) {
            if (card.querySelector('.table-card-loading')) return;
            const overlay = document.createElement('div');
            overlay.className = 'table-card-loading';
            overlay.innerHTML = `<div class="table-card-loading-spinner" aria-hidden="true"></div>`;
            card.appendChild(overlay);
        } else {
            card.querySelectorAll('.table-card-loading').forEach((el) => el.remove());
        }
    }

    setTableCardOpening(tableId, isOpening) {
        const card = this.getTableCardEl(tableId);
        if (!card) return;
        
        if (isOpening) {
            // Disable card interactions
            card.style.pointerEvents = 'none';
            card.classList.add('table-card-opening');
            
            // Show "Süre başlatılıyor..." message
            const priceEl = card.querySelector('.table-price');
            if (priceEl) {
                priceEl.dataset.originalText = priceEl.textContent;
                priceEl.textContent = 'Süre başlatılıyor...';
                priceEl.style.fontSize = '0.85rem';
                priceEl.style.fontWeight = '600';
            }
        } else {
            // Re-enable card interactions
            card.style.pointerEvents = '';
            card.classList.remove('table-card-opening');
            
            // Immediately restore price text and styles when loading state ends
            // This ensures "Süre başlatılıyor..." disappears as soon as green border is removed
            const priceEl = card.querySelector('.table-price');
            if (priceEl && priceEl.dataset.originalText) {
                // Reset styles immediately
                priceEl.style.fontSize = '';
                priceEl.style.fontWeight = '';
                // setTableCardState will update the text with correct values
                delete priceEl.dataset.originalText;
            }
        }
    }

    setTableCardState(tableId, { isActive, type = null, openTime = null, hourlyRate = 0, salesTotal = 0, checkTotal = 0 } = {}) {
        const card = this.getTableCardEl(tableId);
        if (!card) return;

        // Classes
        card.classList.toggle('active', Boolean(isActive) || type === 'instant');
        card.classList.toggle('inactive', !Boolean(isActive) && type !== 'instant');

        // Gecikmeli başlat ikonu: sadece openTime yoksa. openTime varsa hiçbir yoldan ikon gelmemeli.
        const existingDelayBtn = card.querySelector('.table-delay-btn');
        const shouldShowDelay = type === 'hourly' && !openTime;
        if (shouldShowDelay && !existingDelayBtn) {
            const btn = document.createElement('button');
            btn.className = 'table-delay-btn';
            btn.setAttribute('data-table-id', String(tableId));
            btn.setAttribute('title', 'Gecikmeli Başlat');
            btn.textContent = '⏱';
            btn.addEventListener('click', async (e) => {
                e.preventDefault();
                e.stopPropagation();
                await this.openDelayedStartModal(tableId);
            });
            card.prepend(btn);
            // Stale openTime ile ikon eklendiyse DB’yi kontrol et; openTime varsa ikonu kaldır
            this.db.getTable(tableId).then((fresh) => {
                if (fresh && fresh.openTime && card.parentNode) {
                    const added = card.querySelector('.table-delay-btn');
                    if (added) added.remove();
                }
            }).catch(() => {});
        } else if (!shouldShowDelay && existingDelayBtn) {
            existingDelayBtn.remove();
        }

        // Price display
        const priceEl = card.querySelector('.table-price');
        if (!priceEl) return;

        // CRITICAL: If table is in opening state, NEVER update price (keep "Süre başlatılıyor..." message)
        // This check must be absolute - don't update anything if opening state is active
        if (card.classList.contains('table-card-opening')) {
            return;
        }

        // CRITICAL: If table is closed (not active), always show 0 total
        // This ensures cancelled/closed tables show 0 immediately on all devices
        let displayTotal = 0;
        if (isActive) {
            displayTotal = checkTotal;
        if (type === 'hourly' && isActive && openTime) {
            const hoursUsed = calculateHoursUsed(openTime);
            displayTotal = (hoursUsed * (hourlyRate || 0)) + (salesTotal || 0);
            }
        }
        priceEl.textContent = `${Math.round(displayTotal)} ₺`;
    }

    // Recompute a single table card total from unpaid sales (for realtime multi-device updates)
    async refreshSingleTableCard(tableId) {
        if (!tableId) return;
        if (this.currentView !== 'tables') return;
        const card = this.getTableCardEl(tableId);
        if (!card) return;
        const key = String(tableId);
        const cached = this._transferCardStateCache.get(tableId) || this._transferCardStateCache.get(key);
        if (cached && cached.until > Date.now()) return;

        // If table is in opening state, don't update (keep "Süre başlatılıyor..." message)
        if (card.classList.contains('table-card-opening')) {
            return;
        }

        try {
            const table = await this.db.getTable(tableId);
            if (!table) return;
            
            // CRITICAL: If table was cancelled or closed (has closeTime, not active), keep it closed
            // This prevents cancelled/closed tables from being reopened by realtime updates
            // Also check if table is currently being settled (prevent race conditions)
            const isSettling = this._isTableSettling(tableId);
            
            // CRITICAL: If table is being settled, don't update it (prevent race conditions)
            // This check must come FIRST to prevent any updates during closure
            if (isSettling) {
                debugLog(`Table ${tableId} is being settled, skipping refresh to prevent race condition`);
                return;
            }
            
            // Taşınan masa: DB'de isActive false görünüyor olabilir; remote'ta satış varsa açık yap
            if (table.type !== 'hourly' && table.type !== 'instant' && !table.isActive && !table.closeTime && typeof this.db.getUnpaidSalesByTableFromRemote === 'function') {
                try {
                    const fromRemote = await this.db.getUnpaidSalesByTableFromRemote(tableId);
                    if (fromRemote?.length > 0) {
                        if (typeof this.db.upsertSalesToLocal === 'function') await this.db.upsertSalesToLocal(fromRemote).catch(() => {});
                        table.isActive = true;
                        await this.db.updateTable(table);
                    }
                } catch (_) {}
            }
            
            // Süreli masada kapalı = openTime yok. Normal masada closeTime veya !isActive = kapalı.
            const isTableClosed = table.type === 'hourly'
                ? !table.openTime
                : (table.closeTime || !table.isActive);
            
            if (isTableClosed) {
                // openTime varsa gecikmeli başlat hiç gelmemeli: Kart zaten açık görünüyorsa (ikona yok) stale read ile üzerine yazma
                if (table.type === 'hourly' && !table.openTime && card && !card.querySelector('.table-delay-btn')) {
                    return;
                }
                // Table was cancelled/closed - keep it closed, show 0 total
                if (table.isActive || (table.type === 'hourly' && table.openTime)) {
                    // Table state in DB doesn't match closed state - force close
                    debugLog(`Table ${tableId} state mismatch: DB shows open but should be closed, forcing close`);
                    const forceClosed = {
                        ...table,
                        isActive: false,
                        openTime: null,
                        closeTime: table.closeTime || new Date().toISOString(),
                        salesTotal: 0,
                        checkTotal: 0
                    };
                    if (forceClosed.type === 'hourly') {
                        forceClosed.hourlyTotal = 0;
                    }
                    await this.db.updateTable(forceClosed);
                } else if (table.type === 'hourly' && table.openTime && table.closeTime) {
                    // Eski oturum: hem openTime hem closeTime var; openTime null yap (session hourlySessions'ta).
                    debugLog(`Table ${tableId} has old openTime with closeTime, cleaning up`);
                    table.openTime = null;
                    table.hourlyTotal = 0;
                    table.salesTotal = 0;
                    table.checkTotal = 0;
                    await this.db.updateTable(table);
                }
                
                this.setTableCardState(tableId, {
                    isActive: false,
                    type: table.type,
                    openTime: null, // CRITICAL: Always null for closed tables
                    hourlyRate: table.hourlyRate || 0,
                    salesTotal: 0,
                    checkTotal: 0
                });
                return;
            }
            
            let unpaidSales = await this.db.getUnpaidSalesByTable(tableId);
            if (unpaidSales.length === 0 && table.type !== 'hourly' && table.type !== 'instant' && typeof this.db.getUnpaidSalesByTableFromRemote === 'function') {
                try {
                    const fromRemote = await this.db.getUnpaidSalesByTableFromRemote(tableId);
                    if (fromRemote?.length > 0) {
                        unpaidSales = fromRemote;
                        if (typeof this.db.upsertSalesToLocal === 'function') await this.db.upsertSalesToLocal(fromRemote).catch(() => {});
                        table.isActive = true;
                        await this.db.updateTable(table);
                    }
                } catch (_) {}
            }
            
            // Calculate isActive state (we already checked isClosed above, so table is open here)
            const isActive =
                table.type === 'instant' ||
                (table.type === 'hourly'
                    ? Boolean(table.isActive && table.openTime)
                    : (Boolean(table.isActive) || unpaidSales.length > 0));

            // CRITICAL: If table is closed, always show 0 total (regardless of unpaid sales)
            // This fixes the issue where cancelled tables show totals on other devices
            let checkTotal = 0;
            if (isActive) {
                const salesTotal = (unpaidSales || []).reduce((sum, s) => sum + (Number(s?.saleTotal) || 0), 0);
                checkTotal = salesTotal;
                if (table.type === 'hourly' && table.isActive && table.openTime) {
                    const hoursUsed = calculateHoursUsed(table.openTime);
                    const hourlyTotal = hoursUsed * (table.hourlyRate || 0);
                    checkTotal = hourlyTotal + salesTotal;
                }
            } else {
                // CRITICAL: If table is closed (cancelled) and has unpaid sales, clean them up on this device
                // This fixes the issue where cancelled tables still have sales on other devices
                if (unpaidSales.length > 0 && (table.type === 'hourly' ? !table.openTime : table.closeTime)) {
                    // Table was cancelled/closed - clean up unpaid sales on this device
                    debugLog(`Table ${tableId} was cancelled, cleaning up ${unpaidSales.length} unpaid sales on this device`);
                    for (const sale of unpaidSales) {
                        if (sale?.items?.length) {
                            for (const item of sale.items) {
                                if (!item || item.isCancelled) continue;
                                if (item.productId == null) continue;
                                const product = await this.db.getProduct(item.productId);
                                if (product && this.tracksStock(product)) {
                                    product.stock += item.amount;
                                    await this.db.updateProduct(product);
                                }
                            }
                        }
                        if (sale?.id) {
                            await this.db.deleteSale(sale.id);
                        }
                    }
                    // After cleaning up sales, re-read to ensure totals are 0
                    const remainingUnpaidSales = await this.db.getUnpaidSalesByTable(tableId);
                    if (remainingUnpaidSales.length === 0) {
                        // All sales cleaned up - force totals to 0
                        checkTotal = 0;
                    }
                }
                // CRITICAL: If table is closed, always show 0 total regardless of unpaid sales
                // This ensures cancelled tables show 0 on all devices immediately
                checkTotal = 0;
            }

            this.setTableCardState(tableId, {
                isActive,
                type: table.type,
                openTime: table.openTime,
                hourlyRate: table.hourlyRate || 0,
                salesTotal: isActive ? ((unpaidSales || []).reduce((sum, s) => sum + (Number(s?.saleTotal) || 0), 0)) : 0,
                checkTotal
            });
        } catch (e) {
            // ignore
        }
    }

    _markTableSettling(tableId, ms = 5000) {
        // 5 seconds is sufficient now that DB refresh is stopped during closure
        // This prevents realtime updates from interfering immediately after closure
        if (tableId == null) return;
        this._settlingTables.set(String(tableId), Date.now() + ms);
    }

    _isTableSettling(tableId) {
        const key = String(tableId);
        const until = this._settlingTables.get(key);
        if (!until) return false;
        if (Date.now() > until) {
            this._settlingTables.delete(key);
            return false;
        }
        return true;
    }

    _markTableOpening(tableId, openTimeISO, ms = 2500) {
        if (tableId == null) return;
        this._openingTables.set(String(tableId), { until: Date.now() + ms, openTime: openTimeISO });
    }

    _getTableOpening(tableId) {
        const key = String(tableId);
        const entry = this._openingTables.get(key);
        if (!entry) return null;
        if (Date.now() > entry.until) {
            this._openingTables.delete(key);
            return null;
        }
        return entry;
    }

    showTableSettlementEffect(tableId, variant = 'Hesap Alındı') {
        const card = this.getTableCardEl(tableId);
        if (!card) return;

        // Remove any existing overlay
        const existing = card.querySelector('.table-settle-overlay');
        if (existing) existing.remove();

        const overlay = document.createElement('div');
        overlay.className = 'table-settle-overlay';
        overlay.textContent = variant;
        card.appendChild(overlay);

        window.setTimeout(() => {
            overlay.remove();
        }, 2400);
    }

    showTableCardProcessing(tableId, message, type = 'pay') {
        // type: 'cancel' (red), 'pay' (green), 'credit' (orange)
        const card = this.getTableCardEl(tableId);
        if (!card) return;

        // Remove any existing processing overlay
        const existing = card.querySelector('.table-processing-overlay');
        if (existing) existing.remove();

        // Disable card interactions
        card.style.pointerEvents = 'none';
        card.classList.add('table-card-processing');

        const overlay = document.createElement('div');
        overlay.className = `table-processing-overlay table-processing-${type}`;
        overlay.textContent = message;
        card.appendChild(overlay);
    }

    hideTableCardProcessing(tableId) {
        const card = this.getTableCardEl(tableId);
        if (!card) return;

        // Remove processing overlay
        const existing = card.querySelector('.table-processing-overlay');
        if (existing) existing.remove();

        // Re-enable card interactions
        card.style.pointerEvents = '';
        card.classList.remove('table-card-processing');
    }

    showProductCardFeedback(card, amount, productName) {
        if (!card) return;
        
        // Remove any existing feedback
        const existing = card.querySelector('.product-card-feedback');
        if (existing) existing.remove();
        
        // Add success class for green background
        card.classList.add('product-card-success');
        
        // Create feedback message overlay
        const feedback = document.createElement('div');
        feedback.className = 'product-card-feedback';
        feedback.textContent = `${amount} adet ${productName} eklendi`;
        card.appendChild(feedback);
        
        // Remove feedback after 1.5 seconds
        setTimeout(() => {
            card.classList.remove('product-card-success');
            const feedbackEl = card.querySelector('.product-card-feedback');
            if (feedbackEl) feedbackEl.remove();
        }, 1500);
    }

    async getInstantTableDailyTotal(tableId) {
        try {
            const allSales = await this.db.getAllSales();
            // Business day: 08:00 -> next day 08:00
            const start = this.getTodayStartTime();
            const end = new Date(start);
            end.setDate(end.getDate() + 1);
            
            const todaySales = allSales.filter((sale) => {
                if (sale.tableId !== tableId || !sale.isPaid) return false;
                const paymentDate = new Date(sale.paymentTime || sale.sellDateTime);
                return paymentDate >= start && paymentDate < end;
            });
            
            return todaySales.reduce((total, sale) => total + sale.saleTotal, 0);
        } catch (error) {
            console.error('Error calculating instant table daily total:', error);
            return 0;
        }
    }

    async openInstantSaleTable() {
        try {
            // Ensure instant sale table exists
            await this.ensureInstantSaleTable();
            
            // Find instant sale table
            const tables = await this.db.getAllTables();
            const instantTable = tables.find(t => t.type === 'instant' && t.name === 'ANLIK SATIŞ');
            
            if (!instantTable) {
                await this.appAlert('Anlık satış masası bulunamadı.', 'Hata');
                return;
            }
            
            // Open the instant sale table modal
            await this.openTableModal(instantTable.id, { preSync: true });
        } catch (error) {
            console.error('Error opening instant sale table:', error);
            await this.appAlert('Anlık satış masası açılırken hata oluştu. Lütfen tekrar deneyin.', 'Hata');
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

    // ---------- Masa formu (ekleme/düzenleme) ----------
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
            this._syncHourlyRateFieldForTableType(table.type);
        } else {
            title.textContent = 'Masa Ekle';
            form.reset();
            document.getElementById('table-id').value = '';
            // Reset hourly fields reliably (form.reset doesn't reset "required" flags we toggled previously)
            document.getElementById('table-type').value = 'regular';
            this._syncHourlyRateFieldForTableType('regular');
            document.getElementById('table-icon').value = '🪑'; // Default icon for new tables
            // Icon label is always visible now
        }
        
        // iOS-like opening animation
        if (modal.classList.contains('closing')) {
            modal.classList.remove('closing');
        }
        modal.classList.add('active');
        if (modal.classList.contains('modal-bottom-sheet') && window.innerWidth <= 768) {
            this.runBottomSheetOpen(modal);
        } else {
            requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                    const modalContent = modal.querySelector('.modal-content');
                    if (modalContent) {
                        modalContent.style.transform = 'scale(1)';
                        modalContent.style.opacity = '1';
                    }
                });
            });
        }
    }
    
    closeFormModal(modalId) {
        const modal = document.getElementById(modalId);
        if (!modal) return;
        
        if (modal.classList.contains('closing')) return;
        modal.classList.add('closing');
        
        const modalContent = modal.querySelector('.modal-content');
        const isBottomSheet = modal.classList.contains('modal-bottom-sheet');
        
        if (modalContent && isBottomSheet) {
            modalContent.style.transition = 'transform 0.375s cubic-bezier(0.32, 0.72, 0, 1)';
            modalContent.style.transform = 'translateY(100%)';
            setTimeout(() => {
                modal.classList.remove('active', 'closing');
                modalContent.style.transform = '';
                modalContent.style.transition = '';
            }, 300);
        } else if (modalContent) {
            requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                    modalContent.style.transform = 'scale(0.85)';
                    modalContent.style.opacity = '0';
                    setTimeout(() => {
                        modal.classList.remove('active', 'closing');
                        modalContent.style.transform = '';
                        modalContent.style.opacity = '';
                    }, 437);
                });
            });
        } else {
            setTimeout(() => modal.classList.remove('active', 'closing'), 312);
        }
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
            
            this.closeFormModal('table-form-modal');
            await this.loadTables();
        } catch (error) {
            console.error('Masa kaydedilirken hata:', error, error?.message, error?.details, error?.hint, error?.code);
            await this.appAlert('Masa kaydedilirken hata oluştu. Lütfen tekrar deneyin.', 'Hata');
        }
    }

    // ---------- Masa modalı (detay, ürün ekleme, ödeme) ----------
    async openTableModal(tableId, opts = {}) {
        const { preSync = false } = opts || {};
        
        // If modal is closing, cancel the closing animation and reset state
        let tableModalEl = document.getElementById('table-modal');
        if (tableModalEl && tableModalEl.classList.contains('closing')) {
            // Cancel closing animation
            const modalContent = tableModalEl.querySelector('.modal-content');
            if (modalContent) {
                modalContent.style.transition = '';
                modalContent.style.transform = '';
                modalContent.style.opacity = '';
                modalContent.style.transformOrigin = '';
            }
            tableModalEl.classList.remove('active', 'closing');
            document.body.classList.remove('table-modal-open');
        }
        
        // Clear any existing interval
        if (this.hourlyUpdateInterval) {
            clearInterval(this.hourlyUpdateInterval);
            this.hourlyUpdateInterval = null;
        }

        this.currentTableId = tableId;

        // Get table card position for animation
        const tableCard = this.getTableCardEl(tableId);
        let cardRect = null;
        let animationOrigin = { x: '50%', y: '50%' };
        
        if (tableCard) {
            cardRect = tableCard.getBoundingClientRect();
            animationOrigin = {
                x: `${cardRect.left + cardRect.width / 2}px`,
                y: `${cardRect.top + cardRect.height / 2}px`
            };
        } else {
            // For instant sale (no table card), use header button position
            const instantSaleBtn = document.getElementById('instant-sale-btn');
            if (instantSaleBtn) {
                const btnRect = instantSaleBtn.getBoundingClientRect();
                animationOrigin = {
                    x: `${btnRect.left + btnRect.width / 2}px`,
                    y: `${btnRect.top + btnRect.height / 2}px`
                };
            }
        }

        // Open modal shell immediately
        tableModalEl = document.getElementById('table-modal');
        if (tableModalEl) {
            const modalContent = tableModalEl.querySelector('.modal-content');
            const isMobile = window.innerWidth <= 768;
            
            if (modalContent) {
                if (isMobile) {
                    // Bottom sheet: start from bottom
                    modalContent.style.transform = 'translateY(100%)';
                    modalContent.style.transition = 'transform 0.375s cubic-bezier(0.32, 0.72, 0, 1)';
                } else {
                    // Desktop: scale animation from card
                    modalContent.style.transformOrigin = `${animationOrigin.x} ${animationOrigin.y}`;
                    modalContent.style.transform = `scale(0.1) translate(0, 0)`;
                    modalContent.style.opacity = '0';
                }
            }
            tableModalEl.classList.add('active');
            // Trigger animation after a tiny delay
            requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                    if (modalContent) {
                        if (isMobile) {
                            modalContent.style.transform = 'translateY(0)';
                        } else {
                            modalContent.style.transition = 'transform 0.5s cubic-bezier(0.32, 0.72, 0, 1), opacity 0.5s cubic-bezier(0.32, 0.72, 0, 1)';
                            modalContent.style.transform = 'scale(1) translate(0, 0)';
                            modalContent.style.opacity = '1';
                        }
                    }
                });
            });
            
            // Add swipe down to close on mobile
            if (isMobile) {
                this.setupBottomSheetSwipe(tableModalEl);
            }
        }
        document.body.classList.add('table-modal-open');

        // Hide title initially - will show after loading
        const modalTitleEl = document.getElementById('table-modal-title');
        if (modalTitleEl) {
            modalTitleEl.textContent = 'Yükleniyor...';
        }

        // Set pay button text to "Yükleniyor..." immediately (before any data loads)
        const payBtnTxtEl = document.getElementById('pay-table-btn')?.querySelector?.('.btn-txt') || null;
        if (payBtnTxtEl) {
            payBtnTxtEl.textContent = 'Yükleniyor...';
        }

        // Show loading overlay immediately - hide all content until fully loaded
        const modalBodyEl = document.getElementById('table-modal-body');
        if (modalBodyEl) {
            modalBodyEl.classList.add('is-loading');
            // Hide all child sections - don't clear innerHTML to preserve structure
            const productsSection = document.getElementById('table-products-section');
            if (productsSection) productsSection.style.display = 'none';
            const salesListEl = document.getElementById('table-sales-list');
            if (salesListEl) {
                salesListEl.innerHTML = '';
                salesListEl.style.display = 'none';
            }
            // Hide all footer info sections during loading (will be shown based on table type later)
            const hourlyInfo = document.getElementById('hourly-info');
            const regularInfo = document.getElementById('regular-info');
            const instantInfo = document.getElementById('instant-info');
            if (hourlyInfo) hourlyInfo.style.display = 'none';
            if (regularInfo) regularInfo.style.display = 'none';
            if (instantInfo) instantInfo.style.display = 'none';
        }

        const footerBtns = [
            document.getElementById('pay-table-btn'),
            document.getElementById('credit-table-btn'),
            document.getElementById('cancel-hourly-btn')
        ].filter(Boolean);
        footerBtns.forEach((b) => { try { b.disabled = true; } catch (e) {} });

        // Track if modal data is fully loaded
        let modalDataReady = false;

        const unlockModal = () => {
            if (modalBodyEl) modalBodyEl.classList.remove('is-loading');
            // Only enable buttons if data is ready AND table is still open
            if (modalDataReady) {
                footerBtns.forEach((b) => { try { b.disabled = false; } catch (e) {} });
            }
        };

        let table = null;
        try {
            // Check prefetch cache first (skip if this table was just a transfer target)
            const forceRefresh = this._tableModalForceRefreshIds.has(tableId) || this._tableModalForceRefreshIds.has(String(tableId)) || this._tableModalForceRefreshIds.has(Number(tableId));
            if (forceRefresh) {
                this._tableModalForceRefreshIds.delete(tableId);
                this._tableModalForceRefreshIds.delete(String(tableId));
                this._tableModalForceRefreshIds.delete(Number(tableId));
                this._tableModalPrefetchCache.delete(tableId);
                this._tableModalPrefetchCache.delete(Number(tableId));
                this._tableModalPrefetchCache.delete(String(tableId));
            }
            const cachedData = this._tableModalPrefetchCache.get(tableId) || this._tableModalPrefetchCache.get(Number(tableId)) || this._tableModalPrefetchCache.get(String(tableId));
            const now = Date.now();
            let useCache = false;
            
            if (!forceRefresh && cachedData && (now - cachedData.timestamp) < this._tableModalPrefetchTimeout) {
                // Cache is valid - use it
                useCache = true;
                table = cachedData.table;
                debugLog(`Using prefetched data for table ${tableId}`);
            } else {
                // Cache expired or not available - fetch fresh data (or force refresh after transfer)
                if (cachedData) {
                    this._tableModalPrefetchCache.delete(tableId);
                    this._tableModalPrefetchCache.delete(Number(tableId));
                    this._tableModalPrefetchCache.delete(String(tableId));
                }
                
                // Sync first when force refresh (e.g. after transfer) or preSync requested, so target table has latest sales
                const shouldSync = forceRefresh || preSync;
                if (shouldSync && typeof this.db?.syncNow === 'function') {
                    try {
                        await this.db.syncNow();
                        if (typeof this.db?.syncTablesFull === 'function') {
                            await this.db.syncTablesFull();
                        }
                    } catch (_) {}
                }

                // Fetch table data
                table = await this.db.getTable(tableId);
                
                // If table is active but openTime is missing, wait a moment and retry (sync delay)
                if (table && table.isActive && table.type === 'hourly' && !table.openTime) {
                    await new Promise(resolve => setTimeout(resolve, 500));
                    table = await this.db.getTable(tableId);
                }
            }
            if (!table) {
                unlockModal();
                await this.appAlert('Masa bulunamadı.', 'Hata');
                this.closeTableModal();
                return;
            }

            // Track current table type for UI behaviors (e.g. instant sale qty)
            this.currentTableType = table.type;

            // Anlık satış için header'daki qty kontrollerini gizle (artık her kartta kendi kontrolleri var)
            this.setInstantSaleQtyControlsVisible?.(false);

        // Get all unpaid sales for this table and compute totals from sales (avoid stale table aggregates)
        // ALWAYS fetch fresh unpaid sales - don't use cache to avoid stale data causing button visibility issues
        const unpaidSales = await this.db.getUnpaidSalesByTable(tableId);
        const computedSalesTotal = (unpaidSales || []).reduce((sum, s) => sum + (Number(s?.saleTotal) || 0), 0);

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
            // Table has no unpaid sales.
            // Hourly tables: if manually opened (have openTime), keep active and update totals.
            // Regular tables: Auto-close if no unpaid sales and checkTotal is 0
            if (table.type === 'hourly' && table.openTime) {
                const hoursUsed = calculateHoursUsed(table.openTime);
                table.hourlyTotal = hoursUsed * table.hourlyRate;
                table.checkTotal = table.hourlyTotal + table.salesTotal;
                tableUpdated = true;
            } else if (table.type !== 'hourly' && table.type !== 'instant') {
                // Regular tables: close if no unpaid sales and totals are 0
                if (computedSalesTotal === 0 && table.checkTotal === 0) {
                table.isActive = false;
                    table.openTime = null;
                    table.closeTime = table.closeTime || new Date().toISOString();
                    table.salesTotal = 0;
                table.checkTotal = 0;
                tableUpdated = true;
                }
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
        // Don't show total yet - wait until all data is loaded
        const checkTotal = this.calculateCheckTotal(table);
        
        // Update modal title with table name only
        const modalTitle = document.getElementById('table-modal-title');
        modalTitle.textContent = table.name;

        // Pay button text is already set to "Yükleniyor..." above, no need to set again
        
        // Update modal content
        // Hourly table info
        const hourlyInfo = document.getElementById('hourly-info');
        const regularInfo = document.getElementById('regular-info');
        const instantInfo = document.getElementById('instant-info');
        const openBtn = document.getElementById('open-table-btn');
        const payBtn = document.getElementById('pay-table-btn');
        const creditBtn = document.getElementById('credit-table-btn');
        const cancelHourlyBtn = document.getElementById('cancel-hourly-btn');
        const productsSection = document.getElementById('table-products-section');

        if (table.type === 'hourly') {
            // Use grid so mobile stays single-row (CSS sets the grid template)
            hourlyInfo.style.display = 'grid';
            regularInfo.style.display = 'none';
            // Hide instant info for hourly tables
            if (instantInfo) instantInfo.style.display = 'none';
            
            if (table.isActive && table.openTime) {
                document.getElementById('modal-open-time').textContent = formatTimeOnly(table.openTime);
                
                const hoursUsed = calculateHoursUsed(table.openTime);
                const hourlyTotal = hoursUsed * table.hourlyRate;
                document.getElementById('modal-hourly-total').textContent = Math.round(hourlyTotal);
                document.getElementById('modal-sales-total').textContent = Math.round(computedSalesTotal);
                
                // Update check total with real-time hourly calculation
                table.checkTotal = hourlyTotal + computedSalesTotal;
                document.getElementById('modal-check-total').textContent = Math.round(table.checkTotal);
                if (payBtnTxtEl) payBtnTxtEl.textContent = `${Math.round(table.checkTotal)} ₺`;
                
                // Update hourly total in real-time every minute
                if (this.hourlyUpdateInterval) {
                    clearInterval(this.hourlyUpdateInterval);
                }
                this.hourlyUpdateInterval = setInterval(async () => {
                    const updatedTable = await this.db.getTable(tableId);
                    if (updatedTable && updatedTable.isActive && updatedTable.openTime) {
                        // Update open time immediately when it becomes available
                        const openTimeEl = document.getElementById('modal-open-time');
                        if (openTimeEl) {
                            openTimeEl.textContent = formatTimeOnly(updatedTable.openTime);
                        }
                        
                        const unpaid = await this.db.getUnpaidSalesByTable(tableId);
                        const salesTotal = (unpaid || []).reduce((sum, s) => sum + (Number(s?.saleTotal) || 0), 0);
                        const hoursUsed = calculateHoursUsed(updatedTable.openTime);
                        const hourlyTotal = hoursUsed * updatedTable.hourlyRate;
                        document.getElementById('modal-hourly-total').textContent = Math.round(hourlyTotal);
                        document.getElementById('modal-sales-total').textContent = Math.round(salesTotal);
                        updatedTable.checkTotal = hourlyTotal + salesTotal;
                        document.getElementById('modal-check-total').textContent = Math.round(updatedTable.checkTotal);
                        if (payBtnTxtEl) payBtnTxtEl.textContent = `${Math.round(updatedTable.checkTotal)} ₺`;
                    }
                }, 1000); // Update every second to catch openTime sync delay
                
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
                // If table is active but openTime is missing, start interval to check for it
                const openTimeEl = document.getElementById('modal-open-time');
                if (table.isActive && openTimeEl) {
                    openTimeEl.textContent = 'Yükleniyor...';
                    
                    // Start interval to check for openTime (same as nakit button fix)
                    if (this.hourlyUpdateInterval) {
                        clearInterval(this.hourlyUpdateInterval);
                    }
                    this.hourlyUpdateInterval = setInterval(async () => {
                        const updatedTable = await this.db.getTable(tableId);
                        if (updatedTable && updatedTable.isActive && updatedTable.openTime) {
                            // Update open time immediately when it becomes available
                            if (openTimeEl) {
                                openTimeEl.textContent = formatTimeOnly(updatedTable.openTime);
                            }
                            
                            // Update other hourly info
                            const unpaid = await this.db.getUnpaidSalesByTable(tableId);
                            const salesTotal = (unpaid || []).reduce((sum, s) => sum + (Number(s?.saleTotal) || 0), 0);
                            const hoursUsed = calculateHoursUsed(updatedTable.openTime);
                            const hourlyTotal = hoursUsed * updatedTable.hourlyRate;
                            document.getElementById('modal-hourly-total').textContent = Math.round(hourlyTotal);
                            document.getElementById('modal-sales-total').textContent = Math.round(salesTotal);
                            updatedTable.checkTotal = hourlyTotal + salesTotal;
                            document.getElementById('modal-check-total').textContent = Math.round(updatedTable.checkTotal);
                            const payBtnTxt = document.getElementById('pay-table-btn')?.querySelector?.('.btn-txt');
                            if (payBtnTxt) payBtnTxt.textContent = `${Math.round(updatedTable.checkTotal)} ₺`;
                        }
                    }, 1000); // Check every second until openTime is available
                } else if (openTimeEl) {
                    openTimeEl.textContent = 'Açılmadı';
                }
                document.getElementById('modal-hourly-total').textContent = '0';
                document.getElementById('modal-sales-total').textContent = Math.round(computedSalesTotal);
                table.checkTotal = computedSalesTotal;
                document.getElementById('modal-check-total').textContent = Math.round(table.checkTotal);
                if (payBtnTxtEl) payBtnTxtEl.textContent = `${Math.round(table.checkTotal)} ₺`;
                
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
            // Ensure instant-info is hidden for hourly tables (already set above, but ensure it stays hidden)
            if (instantInfo) instantInfo.style.display = 'none';
        } else {
            hourlyInfo.style.display = 'none';
            
            // Handle instant sale table separately
            if (table.type === 'instant') {
                regularInfo.style.display = 'none';
                if (instantInfo) {
                    instantInfo.style.display = 'flex';
                    // Get today's total sales for instant sale table
                    const dailyTotal = await this.getInstantTableDailyTotal(tableId);
                    const instantTotalEl = document.getElementById('modal-instant-daily-total');
                    if (instantTotalEl) {
                        instantTotalEl.textContent = `${Math.round(dailyTotal)} ₺`;
                    }
                }
                // For instant sale, show unpaid sales total in pay button
                table.checkTotal = computedSalesTotal;
                if (payBtnTxtEl) payBtnTxtEl.textContent = `${Math.round(table.checkTotal)} ₺`;
            } else {
                // Regular tables: Total moved to header; hide footer info for regular tables to free space.
                regularInfo.style.display = 'none';
                if (instantInfo) instantInfo.style.display = 'none';
                table.checkTotal = computedSalesTotal;
            document.getElementById('modal-check-total-regular').textContent = Math.round(table.checkTotal);
                if (payBtnTxtEl) payBtnTxtEl.textContent = `${Math.round(table.checkTotal)} ₺`;
            }
            
            if (openBtn) {
            openBtn.style.display = 'none';
            }
            // Regular and instant tables always show products section
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

        // Calculate actual check total from unpaid sales and hourly (if applicable)
        let actualCheckTotal = computedSalesTotal;
        if (table.type === 'hourly' && table.isActive && table.openTime) {
            const hoursUsed = calculateHoursUsed(table.openTime);
            const hourlyTotal = hoursUsed * (table.hourlyRate || 0);
            actualCheckTotal = hourlyTotal + computedSalesTotal;
        }
        
        // Load products and sales - use cache if available, otherwise fetch in parallel
        if (useCache && cachedData.products) {
            // Render cached products immediately (kategoriye göre sıralı)
            const container = document.getElementById('table-products-grid');
            if (container && cachedData.products.length > 0) {
                const sortedProducts = this.sortProductsByCategoryThenName(cachedData.products);
                container.dataset.tableId = String(tableId);
                container.innerHTML = sortedProducts.map(product => this.createTableProductCard(product, tableId)).join('');
                // Bind event delegation if not already bound
                if (!this._tableProductsDelegationBound) {
                    this._tableProductsDelegationBound = true;
                    container.addEventListener('click', async (e) => {
                        const card = e.target.closest('.product-card-mini');
                        if (!card) return;
                        if (e.target.closest('.table-product-qty-minus')) {
                            const input = card.querySelector('.table-product-qty-input');
                            if (input) {
                                const v = Math.max(1, (parseInt(input.value, 10) || 1) - 1);
                                input.value = String(v);
                            }
                            e.stopPropagation();
                            return;
                        }
                        if (e.target.closest('.table-product-qty-plus')) {
                            const input = card.querySelector('.table-product-qty-input');
                            if (input) {
                                const v = Math.min(99, (parseInt(input.value, 10) || 1) + 1);
                                input.value = String(v);
                            }
                            e.stopPropagation();
                            return;
                        }
                        if (e.target.closest('.table-product-qty-input')) {
                            e.stopPropagation();
                            return;
                        }
                        if (card.classList.contains('out-of-stock')) return;
                        const pid = card.getAttribute('data-product-id');
                        const tid = card.closest('#table-products-grid')?.getAttribute('data-table-id');
                        if (!pid || !tid) return;
                        const input = card.querySelector('.table-product-qty-input');
                        const amount = input ? Math.max(1, Math.min(99, parseInt(input.value, 10) || 1)) : 1;
                        this.queueQuickAddToTable(tid, pid, amount);
                    });
                }
            }
            // Render cached sales immediately
            await this.loadTableSales(tableId);
        } else {
            // Fetch fresh data in parallel for better performance
            const [products, _] = await Promise.all([
                this.db.getAllProducts().then(products => {
                    products = this.sortProductsByStock(products);
                    return products;
                }),
                Promise.resolve() // Placeholder for future parallel operations
            ]);
            
            // Load products
            await this.loadTableProducts(tableId, { useCache: false });
            
            // Load sales
            await this.loadTableSales(tableId);
            
            // Update cache for next time (ürünler kategoriye göre saklansın)
            this._tableModalPrefetchCache.set(tableId, {
                table: table,
                products: this.sortProductsByCategoryThenName(products),
                sales: unpaidSales,
                timestamp: Date.now()
            });
        }

        // CRITICAL: Verify table state before enabling buttons
        // Re-read table from DB to ensure we have the latest state
        const finalTableCheck = await this.db.getTable(tableId);
        if (!finalTableCheck) {
            // Table not found - close modal
            unlockModal();
            this.closeTableModal();
            return;
        }

        // Süreli masada kapalı = openTime yok; modal kapalı masada tam açılmaz.
        const isTableClosed = finalTableCheck.type === 'hourly' && !finalTableCheck.openTime;
        
        if (isTableClosed) {
            // Table is already closed - keep buttons disabled and close modal
            unlockModal(); // Remove loading overlay
            footerBtns.forEach((b) => { try { b.disabled = true; } catch (e) {} });
            // Close modal after a brief delay to show user the table is closed
            setTimeout(() => {
                this.closeTableModal();
            }, 500);
            return;
        }

        // Table is open (or regular/instant table without closeTime) - mark data as ready and enable buttons
        // Regular/instant tables can be opened even if they have no products (user wants to add products)
        // All data is now loaded - show content and unlock modal
        
        // Update check total now that all data is loaded
        const finalCheckTotal = this.calculateCheckTotal(table);
        if (payBtnTxtEl) payBtnTxtEl.textContent = `${Math.round(finalCheckTotal || 0)} ₺`;
        
        // Update hourly info totals if needed
        if (table.type === 'hourly' && table.isActive && table.openTime) {
            const hoursUsed = calculateHoursUsed(table.openTime);
            const hourlyTotal = hoursUsed * table.hourlyRate;
            const unpaid = await this.db.getUnpaidSalesByTable(tableId);
            const salesTotal = (unpaid || []).reduce((sum, s) => sum + (Number(s?.saleTotal) || 0), 0);
            table.checkTotal = hourlyTotal + salesTotal;
            const modalCheckTotal = document.getElementById('modal-check-total');
            if (modalCheckTotal) modalCheckTotal.textContent = Math.round(table.checkTotal);
            if (payBtnTxtEl) payBtnTxtEl.textContent = `${Math.round(table.checkTotal)} ₺`;
        } else if (table.type === 'instant') {
            // For instant sale, update daily total in footer
            const dailyTotal = await this.getInstantTableDailyTotal(tableId);
            const instantTotalEl = document.getElementById('modal-instant-daily-total');
            if (instantTotalEl) {
                instantTotalEl.textContent = `${Math.round(dailyTotal)} ₺`;
            }
            // Update pay button with unpaid sales total
            const unpaid = await this.db.getUnpaidSalesByTable(tableId);
            const salesTotal = (unpaid || []).reduce((sum, s) => sum + (Number(s?.saleTotal) || 0), 0);
            table.checkTotal = salesTotal;
            if (payBtnTxtEl) payBtnTxtEl.textContent = `${Math.round(table.checkTotal)} ₺`;
        } else if (table.type !== 'hourly') {
            const unpaid = await this.db.getUnpaidSalesByTable(tableId);
            const salesTotal = (unpaid || []).reduce((sum, s) => sum + (Number(s?.saleTotal) || 0), 0);
            table.checkTotal = salesTotal;
            if (payBtnTxtEl) payBtnTxtEl.textContent = `${Math.round(table.checkTotal)} ₺`;
        }
        
        // CRITICAL: Re-fetch unpaid sales AND table data AFTER loadTableSales completes to ensure we have the latest data
        // This fixes the issue where buttons disappear and reappear after 10 seconds
        const finalUnpaidSales = await this.db.getUnpaidSalesByTable(tableId);
        const finalComputedSalesTotal = (finalUnpaidSales || []).reduce((sum, s) => sum + (Number(s?.saleTotal) || 0), 0);
        
        // CRITICAL: Re-fetch table to get latest openTime (same fix as nakit button)
        const finalTableForOpenTime = await this.db.getTable(tableId);
        if (finalTableForOpenTime && finalTableForOpenTime.type === 'hourly' && finalTableForOpenTime.isActive && finalTableForOpenTime.openTime) {
            // Update open time immediately if it's now available
            const openTimeEl = document.getElementById('modal-open-time');
            if (openTimeEl) {
                openTimeEl.textContent = formatTimeOnly(finalTableForOpenTime.openTime);
            }
            // Update table reference to use latest data
            table = finalTableForOpenTime;
        }
        
        let finalActualCheckTotal = finalComputedSalesTotal;
        // Use finalTableForOpenTime for calculations (has latest openTime)
        const finalTableForCalc = finalTableForOpenTime || table;
        if (finalTableForCalc.type === 'hourly' && finalTableForCalc.isActive && finalTableForCalc.openTime) {
            const hoursUsed = calculateHoursUsed(finalTableForCalc.openTime);
            const hourlyTotal = hoursUsed * (finalTableForCalc.hourlyRate || 0);
            finalActualCheckTotal = hourlyTotal + finalComputedSalesTotal;
        }
        
        // CRITICAL: Update modal totals (including pay button amount) with final table data
        // This ensures the cash button shows the correct amount immediately
        await this.updateModalTotals(finalTableForCalc);
        
        // Update button visibility based on final unpaid sales data
        // Re-use payBtn and creditBtn variables that were already declared above
        const finalPayBtn = document.getElementById('pay-table-btn');
        const finalCreditBtn = document.getElementById('credit-table-btn');
        if (finalPayBtn) {
            if (finalUnpaidSales.length === 0 && finalActualCheckTotal === 0 && !(finalTableForCalc.type === 'hourly' && finalTableForCalc.isActive && finalTableForCalc.openTime)) {
                finalPayBtn.style.display = 'none';
            } else {
                finalPayBtn.style.display = 'inline-block';
            }
        }
        
        if (finalCreditBtn) {
            const hasUnpaidSales = finalUnpaidSales.length > 0;
            const hasCheckTotal = finalActualCheckTotal > 0 || (finalTableForCalc.type === 'hourly' && finalTableForCalc.isActive && finalTableForCalc.openTime);
            if (hasUnpaidSales || hasCheckTotal) {
                finalCreditBtn.style.display = 'inline-block';
            } else {
                finalCreditBtn.style.display = 'none';
            }
        }
        const moveTableBtn = document.getElementById('move-table-btn');
        if (moveTableBtn) {
            const hasUnpaid = finalUnpaidSales.length > 0;
            const hourlyOpen = finalTableForCalc.type === 'hourly' && finalTableForCalc.isActive && finalTableForCalc.openTime;
            const allTables = await this.db.getAllTables();
            const otherTargetTables = (allTables || []).filter(t => String(t.id) !== String(tableId) && t.type !== 'instant');
            moveTableBtn.style.display = ((hasUnpaid || hourlyOpen) && otherTargetTables.length > 0) ? 'inline-flex' : 'none';
        }
        
        // CRITICAL: Update cancel button visibility based on final table data (same fix as other buttons)
        const finalCancelBtn = document.getElementById('cancel-hourly-btn');
        if (finalCancelBtn) {
            if (finalTableForCalc.type === 'hourly' && finalTableForCalc.isActive && finalTableForCalc.openTime) {
                finalCancelBtn.style.display = 'inline-flex';
            } else {
                finalCancelBtn.style.display = 'none';
            }
        }

        const productsSectionEl = document.getElementById('table-products-section');
        if (productsSectionEl && (finalTableForCalc.type !== 'hourly' || (finalTableForCalc.isActive && finalTableForCalc.openTime))) {
            productsSectionEl.style.display = 'block';
        }
        const salesListEl = document.getElementById('table-sales-list');
        if (salesListEl) {
            salesListEl.style.display = 'block';
        }
        
        modalDataReady = true;
        unlockModal();
        } catch (error) {
            console.error('openTableModal error:', error, error?.message, error?.details, error?.hint, error?.code);
            unlockModal();
            await this.appAlert('Masa detayları yüklenirken hata oluştu. Lütfen tekrar deneyin.', 'Hata');
        }
    }

    async cancelHourlyGame() {
        if (!this.currentTableId) return;

        const tableId = this.currentTableId;
        const table = await this.db.getTable(tableId);
        
        if (!table || table.type !== 'hourly') {
            await this.appAlert('Bu süreli masa değil.', 'Uyarı');
            return;
        }

        if (!table.isActive || !table.openTime) {
            await this.appAlert('Bu süreli masa açık değil.', 'Uyarı');
            return;
        }

        if (!(await this.appConfirm('Oyunu iptal etmek istiyor musunuz?\nHesap sıfırlanacak, masa kapanacak ve rapora yazılmayacak.', { title: 'Oyunu İptal Et', confirmText: 'İptal Et', cancelText: 'Vazgeç', confirmVariant: 'danger' }))) {
            return;
        }

        try {
            // Show processing message on table card (red background)
            this.showTableCardProcessing(tableId, 'İptal ediliyor...', 'cancel');
            
            // Close modal immediately
            this.closeTableModal();
            this.currentTableId = null;

            // Optimistic UI: mark card as closed immediately
            this.setTableCardState(tableId, {
                isActive: false,
                type: 'hourly',
                openTime: null,
                hourlyRate: table.hourlyRate || 0,
                salesTotal: 0,
                checkTotal: 0
            });

            // Use centralized closure function
            const result = await this._closeTableSafely(tableId, {
                isCancel: true
            });

            if (!result.success) {
                throw new Error(result.error || 'Masa kapatılamadı');
            }

            // Update UI with final state
            if (result.table) {
                this.setTableCardState(tableId, {
                    isActive: false,
                    type: 'hourly',
                    openTime: null,
                    hourlyRate: result.table.hourlyRate || 0,
                    salesTotal: 0,
                    checkTotal: 0
                });
            }

            // Wait for DB operations to complete
            await new Promise(resolve => setTimeout(resolve, 1500));
            
            // Hide loading overlay
            this.hideTableCardProcessing(tableId);

            // Background refresh (don't block UI)
            setTimeout(() => {
                const views = ['tables', 'sales'];
                if (this.currentView === 'products') views.push('products');
                if (this.currentView === 'daily') views.push('daily');
                this.reloadViews(views);
            }, 100);

            // Success: no alert (keep UX quiet)
        } catch (err) {
            console.error('Süreli oyun iptal edilirken hata:', err);
            this.hideTableCardProcessing(tableId);
            await this.appAlert('Oyunu iptal ederken hata oluştu. Lütfen tekrar deneyin.', 'Hata');
        }
    }

    // Clean up interval when modal is closed
    closeTableModal() {
        if (this.hourlyUpdateInterval) {
            clearInterval(this.hourlyUpdateInterval);
            this.hourlyUpdateInterval = null;
        }
        
        const tableModalEl = document.getElementById('table-modal');
        if (!tableModalEl) {
            document.body.classList.remove('table-modal-open');
            return;
        }
        if (tableModalEl.classList.contains('closing')) return;

        tableModalEl.classList.add('closing');
        const modalContent = tableModalEl.querySelector('.modal-content');
        const isBottomSheet = tableModalEl.classList.contains('modal-bottom-sheet');
        const isMobile = window.innerWidth <= 768;

        if (modalContent && isBottomSheet && isMobile) {
            modalContent.style.transition = 'transform 0.375s cubic-bezier(0.32, 0.72, 0, 1)';
            modalContent.style.transform = 'translate3d(0, 100%, 0)';
            setTimeout(() => {
                tableModalEl.classList.remove('active', 'closing');
                modalContent.style.transform = '';
                modalContent.style.transition = '';
                document.body.classList.remove('table-modal-open');
                this.refreshProductsCache();
            }, 375);
        } else if (modalContent) {
            const modalRect = modalContent.getBoundingClientRect();
            const tableCard = this.getTableCardEl(this.currentTableId);
            let originX = modalRect.left + modalRect.width / 2;
            let originY = modalRect.top + modalRect.height / 2;
            if (tableCard) {
                const cardRect = tableCard.getBoundingClientRect();
                originX = cardRect.left + cardRect.width / 2;
                originY = cardRect.top + cardRect.height / 2;
            } else {
                const instantSaleBtn = document.getElementById('instant-sale-btn');
                if (instantSaleBtn) {
                    const btnRect = instantSaleBtn.getBoundingClientRect();
                    originX = btnRect.left + btnRect.width / 2;
                    originY = btnRect.top + btnRect.height / 2;
                }
            }
            const xPx = originX - modalRect.left;
            const yPx = originY - modalRect.top;
            modalContent.style.transformOrigin = `${xPx}px ${yPx}px`;
            requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                    modalContent.style.transition = 'transform 0.375s cubic-bezier(0.32, 0.72, 0, 1), opacity 0.375s cubic-bezier(0.32, 0.72, 0, 1)';
                    modalContent.style.transform = 'scale(0.1) translate(0, 0)';
                    modalContent.style.opacity = '0';
                    setTimeout(() => {
                        tableModalEl.classList.remove('active', 'closing');
                        modalContent.style.transition = '';
                        modalContent.style.transform = '';
                        modalContent.style.opacity = '';
                        modalContent.style.transformOrigin = '';
                        document.body.classList.remove('table-modal-open');
                        this.refreshProductsCache();
                    }, 375);
                });
            });
        } else {
            setTimeout(() => {
                tableModalEl.classList.remove('active', 'closing');
                document.body.classList.remove('table-modal-open');
                this.refreshProductsCache();
            }, 312);
        }
    }

    /**
     * Refresh products cache in the background
     * Called when table modal closes to ensure products are fresh for next open
     */
    async refreshProductsCache() {
        try {
            let products = await this.db.getAllProducts();
        // Sort by sortOrder first, then by stock
        products.sort((a, b) => {
            if (a.sortOrder !== undefined && b.sortOrder !== undefined) {
                return a.sortOrder - b.sortOrder;
            }
            if (a.sortOrder !== undefined) return -1;
            if (b.sortOrder !== undefined) return 1;
            return 0; // Keep original order if no sortOrder
        });
        products = this.sortProductsByStock(products);
            this._cachedProducts = products;
            debugLog('Products cache refreshed in background');
        } catch (error) {
            console.error('Error refreshing products cache:', error);
            // Don't show error to user - this is a background operation
        }
    }

    async loadTableProducts(tableId, opts = {}) {
        const { useCache = false } = opts;
        const container = document.getElementById('table-products-grid');
        if (!container) return;

        let products = null;

        // Use cache if available and requested
        if (useCache && this._cachedProducts && this._cachedProducts.length > 0) {
            products = this._cachedProducts;
            debugLog('Using cached products for table modal');
            // Render immediately (synchronous) - no loading delay
            if (products.length === 0) {
                container.innerHTML = '<div class="empty-state"><p>Ürün bulunamadı</p></div>';
                return;
                    }
            products = this.sortProductsByCategoryThenName(products);
            container.dataset.tableId = String(tableId);
            container.innerHTML = products.map(product => this.createTableProductCard(product, tableId)).join('');
            // Bind event delegation if not already bound
            if (!this._tableProductsDelegationBound) {
                this._tableProductsDelegationBound = true;
                container.addEventListener('click', async (e) => {
                    const card = e.target.closest('.product-card-mini');
                    if (!card) return;
                    if (e.target.closest('.table-product-qty-minus')) {
                        const input = card.querySelector('.table-product-qty-input');
                        if (input) {
                            const v = Math.max(1, (parseInt(input.value, 10) || 1) - 1);
                            input.value = String(v);
                        }
                        e.stopPropagation();
                        return;
                    }
                    if (e.target.closest('.table-product-qty-plus')) {
                        const input = card.querySelector('.table-product-qty-input');
                        if (input) {
                            const v = Math.min(99, (parseInt(input.value, 10) || 1) + 1);
                            input.value = String(v);
                        }
                        e.stopPropagation();
                        return;
                    }
                    if (e.target.closest('.table-product-qty-input')) {
                        e.stopPropagation();
                        return;
                    }
                    if (card.classList.contains('out-of-stock')) return;
                    const pid = card.getAttribute('data-product-id');
                    const tid = card.closest('#table-products-grid')?.getAttribute('data-table-id');
                    if (!pid || !tid) return;
                    const input = card.querySelector('.table-product-qty-input');
                    const amount = input ? Math.max(1, Math.min(99, parseInt(input.value, 10) || 1)) : 1;
                    this.queueQuickAddToTable(tid, pid, amount);
                });
            }
            return; // Early return - no async operation needed
                        } else {
            // Load fresh products from DB
            products = this.sortProductsByStock(await this.db.getAllProducts());
            // Update cache
            this._cachedProducts = products;
            debugLog('Loaded fresh products and updated cache');
        }

        if (products.length === 0) {
            container.innerHTML = '<div class="empty-state"><p>Ürün bulunamadı</p></div>';
            return;
        }

        // Sıra: 1 alkollü, 2 meşrubat, 3 yiyecek; her grupta alfabetik
        products = this.sortProductsByCategoryThenName(products);
        container.dataset.tableId = String(tableId);
        container.innerHTML = products.map(product => this.createTableProductCard(product, tableId)).join('');

        // Bind once: event delegation
        if (!this._tableProductsDelegationBound) {
            this._tableProductsDelegationBound = true;
            container.addEventListener('click', async (e) => {
                const card = e.target.closest('.product-card-mini');
                if (!card) return;
                if (e.target.closest('.table-product-qty-minus')) {
                    const input = card.querySelector('.table-product-qty-input');
                    if (input) {
                        const v = Math.max(1, (parseInt(input.value, 10) || 1) - 1);
                        input.value = String(v);
                    }
                    e.stopPropagation();
                    return;
                }
                if (e.target.closest('.table-product-qty-plus')) {
                    const input = card.querySelector('.table-product-qty-input');
                    if (input) {
                        const v = Math.min(99, (parseInt(input.value, 10) || 1) + 1);
                        input.value = String(v);
                    }
                    e.stopPropagation();
                    return;
                }
                if (e.target.closest('.table-product-qty-input')) {
                    e.stopPropagation();
                    return;
                }
                if (card.classList.contains('out-of-stock')) return;
                const pid = card.getAttribute('data-product-id');
                const tid = card.closest('#table-products-grid')?.getAttribute('data-table-id');
                if (!pid || !tid) return;
                const input = card.querySelector('.table-product-qty-input');
                const amount = input ? Math.max(1, Math.min(99, parseInt(input.value, 10) || 1)) : 1;
                this.queueQuickAddToTable(tid, pid, amount);
            });
        }
    }

    createTableProductCard(product, tableId) {
        const tracksStock = this.tracksStock(product);
        const isOutOfStock = tracksStock && product.stock === 0;
        const catClass = this.getProductCategoryClass?.(product) || '';
        const iconHtml = this.renderProductIcon?.(product.icon) || (product.icon || '📦');
        const qtyRow = `
            <div class="product-card-mini-qty table-product-qty-controls">
                <button type="button" class="btn btn-secondary table-product-qty-minus" aria-label="Azalt">−</button>
                <input class="table-product-qty-input" type="number" min="1" max="99" value="1" inputmode="numeric" />
                <button type="button" class="btn btn-secondary table-product-qty-plus" aria-label="Arttır">+</button>
            </div>`;

        return `
            <div class="product-card-mini ${catClass} ${isOutOfStock ? 'out-of-stock' : ''}" id="table-product-card-${product.id}" data-product-id="${product.id}" title="${product.name}">
                <div class="product-mini-ico-lg" aria-hidden="true">${iconHtml}</div>
                <div class="product-mini-name">${product.name}</div>
                ${qtyRow}
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

        // Build productId -> icon map (for older sales that don't have item.icon stored)
        let iconByProductId = {};
        try {
            const products = await this.db.getAllProducts();
            (products || []).forEach((p) => {
                if (p && p.id != null) iconByProductId[String(p.id)] = p.icon || '📦';
            });
        } catch (_) {}

        // Group: same minute + same product => "3x Tuborg" instead of "1x,1x,1x"
        const groupedRows = this.groupUnpaidSalesForTableModal(unpaidSales, iconByProductId);
        container.innerHTML = groupedRows.map((row) => this.createGroupedTableSaleRow(row)).join('');
        
        // Setup long press handlers and button listeners for each product line
        this.setupSaleItemInteractions(unpaidSales);
    }

    // Convert unpaid sales list into compact rows:
    // - Row key: same local minute (YYYY-MM-DD HH:MM)
    // - Inside row: group by productId+price => "3x Tuborg"
    // Buttons are wired to the most-recent underlying sale item for that product (so existing handlers keep working).
    groupUnpaidSalesForTableModal(unpaidSales, iconByProductId = {}) {
        const rowsByMinute = new Map(); // minuteKey -> { minuteKey, timeOnly, latestTs, total, itemsByProductKey: Map }

        const toLocalMinuteKey = (iso) => {
            const d = new Date(iso);
            const yyyy = d.getFullYear();
            const mm = String(d.getMonth() + 1).padStart(2, '0');
            const dd = String(d.getDate()).padStart(2, '0');
            const hh = String(d.getHours()).padStart(2, '0');
            const mi = String(d.getMinutes()).padStart(2, '0');
            return { minuteKey: `${yyyy}-${mm}-${dd} ${hh}:${mi}`, timeOnly: `${hh}:${mi}`, ts: d.getTime() };
        };

        (unpaidSales || []).forEach((sale) => {
            if (!sale || !sale.sellDateTime || !Array.isArray(sale.items)) return;
            const { minuteKey, timeOnly, ts } = toLocalMinuteKey(sale.sellDateTime);
            let row = rowsByMinute.get(minuteKey);
            if (!row) {
                row = { minuteKey, timeOnly, latestTs: ts, total: 0, itemsByProductKey: new Map() };
                rowsByMinute.set(minuteKey, row);
            } else {
                row.latestTs = Math.max(row.latestTs, ts);
            }

            sale.items.forEach((it, idx) => {
                if (!it || it.isCancelled) return;
                const amount = Number(it.amount) || 0;
                const price = Number(it.price) || 0;
                if (amount <= 0) return;

                const productIdKey = (it.productId != null) ? String(it.productId) : '';
                const priceKey = String(price);
                const key = `${productIdKey}|${priceKey}|${it.name || ''}`;

                const icon = it.icon || iconByProductId[productIdKey] || '📦';
                const lineTotal = price * amount;

                let agg = row.itemsByProductKey.get(key);
                if (!agg) {
                    agg = {
                        // display
                        name: it.name || '',
                        icon,
                        amount: 0,
                        total: 0,
                        firstTs: ts,
                        lastTs: ts,
                        // action target (most recent underlying item)
                        actionSaleId: sale.id,
                        actionItemIndex: idx,
                        actionTs: ts,
                        actionItemAmount: amount,
                    };
                    row.itemsByProductKey.set(key, agg);
                }

                agg.amount += amount;
                agg.total += lineTotal;
                row.total += lineTotal;
                agg.firstTs = Math.min(agg.firstTs || ts, ts);
                agg.lastTs = Math.max(agg.lastTs || ts, ts);

                // Choose the most recent underlying item to attach buttons to.
                // Prefer amount=1 so "pay/cancel one" behaves as expected for tap-to-add.
                const shouldTake =
                    (ts > agg.actionTs) ||
                    (ts === agg.actionTs && agg.actionItemAmount !== 1 && amount === 1);
                if (shouldTake) {
                    agg.actionSaleId = sale.id;
                    agg.actionItemIndex = idx;
                    agg.actionTs = ts;
                    agg.actionItemAmount = amount;
                    // keep latest icon/name too (safe)
                    agg.icon = icon;
                    agg.name = it.name || agg.name;
                }
            });
        });

        const rows = Array.from(rowsByMinute.values())
            // Oldest first so "last added" ends up at the bottom of the list
            .sort((a, b) => a.latestTs - b.latestTs)
            .map((r) => {
                const items = Array.from(r.itemsByProductKey.values()).map((g) => ({
                    name: g.name,
                    icon: g.icon,
                    amount: g.amount,
                    total: g.total,
                    firstTs: g.firstTs,
                    lastTs: g.lastTs,
                    actionSaleId: g.actionSaleId,
                    actionItemIndex: g.actionItemIndex,
                }));
                // Keep add order inside the minute group: first-added first (latest at bottom)
                items.sort(
                    (a, b) =>
                        (Number(a.firstTs || 0) - Number(b.firstTs || 0)) ||
                        (Number(a.lastTs || 0) - Number(b.lastTs || 0)) ||
                        (a.name || '').localeCompare(b.name || '', 'tr', { sensitivity: 'base' })
                );
                return {
                    timeOnly: r.timeOnly,
                    minuteKey: r.minuteKey,
                    total: r.total,
                    items,
                };
            });

        return rows;
    }

    createGroupedTableSaleRow(row) {
        const rowCatKey = (row?.items?.[0]?.category != null) ? String(row.items[0].category) : '';
        const rowCatClass = this.getProductCategoryClass({ category: rowCatKey });
        
        // Create individual product lines (one per product)
        const productLinesHtml = (row.items || [])
            .map((it) => {
                const saleId = it.actionSaleId;
                const idx = it.actionItemIndex;
                const iconHtml = this.renderProductIcon(it.icon || '📦');
                const itemTime = it.firstTs ? formatTimeOnly(new Date(it.firstTs).toISOString()) : row.timeOnly;
                
                // Hidden action buttons (shown on tap)
                const buttons = `
                    <div class="sale-item-actions" data-sale-id="${saleId}" data-item-index="${idx}">
                        <button class="btn btn-danger btn-icon sale-action-btn" id="delete-sale-item-${saleId}-${idx}" title="İptal">×</button>
                        <button class="btn btn-success btn-icon sale-action-btn" id="pay-sale-item-${saleId}-${idx}" title="Nakit Öde">₺</button>
                        <button class="btn btn-info btn-icon sale-action-btn" id="credit-sale-item-${saleId}-${idx}" title="Veresiye">💳</button>
                        <button class="btn btn-icon sale-action-btn sale-action-transfer" id="transfer-sale-item-${saleId}-${idx}" title="Başka masaya taşı">➜</button>
                    </div>
                `;
                
                return `
                    <div class="sale-product-line" data-sale-id="${saleId}" data-item-index="${idx}">
                        <div class="sale-product-line-content">
                            <div class="sale-product-icon">${iconHtml}</div>
                            <div class="sale-product-details">
                                <div class="sale-product-name">${it.name || 'Ürün'}</div>
                                <div class="sale-product-meta">
                                    <span class="sale-product-amount">${Math.round(it.amount || 0)} adet</span>
                                    <span class="sale-product-total">${Math.round(it.total || 0)} ₺</span>
                                </div>
                            </div>
                        </div>
                        ${buttons}
                    </div>
                `;
            })
            .join('');

        return `
            <div class="sale-item-row ${rowCatClass}" data-time="${row.timeOnly}">
                <div class="sale-item-content">
                    <div class="sale-item-header">
                        <span class="sale-item-time-header">${row.timeOnly}</span>
                        <span class="sale-item-total-header">${Math.round(row.total || 0)} ₺</span>
                    </div>
                    <div class="sale-item-products">
                        ${productLinesHtml}
                    </div>
                </div>
            </div>
        `;
    }

    // Formatting functions are now imported from src/utils/formatters.js

    createTableSaleItem(sale, iconByProductId = {}) {
        // This function is kept for backward compatibility but should use createGroupedTableSaleRow
        // Convert single sale to grouped format
        const saleDate = new Date(sale.sellDateTime);
        const hours = String(saleDate.getHours()).padStart(2, '0');
        const minutes = String(saleDate.getMinutes()).padStart(2, '0');
        const timeOnly = `${hours}:${minutes}`;
        
        const row = {
            timeOnly,
            total: sale.saleTotal,
            items: sale.items.map((item, index) => {
                const icon = item.icon || iconByProductId[String(item.productId)] || '📦';
                return {
                    name: item.name || 'Ürün',
                    icon,
                    amount: item.amount,
                    total: item.price * item.amount,
                    firstTs: new Date(sale.sellDateTime).getTime(),
                    lastTs: new Date(sale.sellDateTime).getTime(),
                    actionSaleId: sale.id,
                    actionItemIndex: index,
                };
            }),
        };
        
        return this.createGroupedTableSaleRow(row);
    }

    setupSaleItemInteractions(unpaidSales) {
        // Close any open action menus first
        const closeAllMenus = () => {
            document.querySelectorAll('.sale-product-line.active').forEach(line => {
                line.classList.remove('active');
            });
        };

        // Setup click/tap for each product line
        unpaidSales.forEach(sale => {
            sale.items.forEach((item, index) => {
                const lineEl = document.querySelector(`.sale-product-line[data-sale-id="${sale.id}"][data-item-index="${index}"]`);
                if (!lineEl) return;

                // Toggle menu on click/tap
                const handleClick = (e) => {
                    // Don't toggle if clicking on buttons
                    if (e.target.closest('.sale-item-actions')) {
                        return;
                    }
                    
                    // If this line is already active, close it
                    if (lineEl.classList.contains('active')) {
                        lineEl.classList.remove('active');
                    } else {
                        // Close other menus first
                        closeAllMenus();
                        // Show this menu
                        lineEl.classList.add('active');
                    }
                    e.stopPropagation();
                };

                // Add click handler
                lineEl.addEventListener('click', handleClick);

                // Button click handlers
                const deleteBtn = lineEl.querySelector(`#delete-sale-item-${sale.id}-${index}`);
                const payBtn = lineEl.querySelector(`#pay-sale-item-${sale.id}-${index}`);
                const creditBtn = lineEl.querySelector(`#credit-sale-item-${sale.id}-${index}`);
                
            if (deleteBtn) {
                    deleteBtn.addEventListener('click', (e) => {
                        e.stopPropagation();
                        closeAllMenus();
                        this.deleteItemFromSale(sale.id, index);
                    });
                }
                
                if (payBtn) {
                    payBtn.addEventListener('click', (e) => {
                        e.stopPropagation();
                        closeAllMenus();
                        this.payItemFromSale(sale.id, index);
                    });
                }
                
                if (creditBtn) {
                    creditBtn.addEventListener('click', (e) => {
                        e.stopPropagation();
                        closeAllMenus();
                        this.creditItemFromSale(sale.id, index);
                    });
                }
                const transferBtn = lineEl.querySelector(`#transfer-sale-item-${sale.id}-${index}`);
                if (transferBtn) {
                    transferBtn.addEventListener('click', (e) => {
                        e.stopPropagation();
                        closeAllMenus();
                        this.openTransferTargetModal('sale', { saleId: sale.id });
                    });
                }
            });
        });

        // Close menus when clicking outside
        document.addEventListener('click', (e) => {
            if (!e.target.closest('.sale-product-line')) {
                closeAllMenus();
            }
        });

        // Close menus on scroll
        const salesListEl = document.getElementById('table-sales-list');
        if (salesListEl) {
            salesListEl.addEventListener('scroll', closeAllMenus);
        }
    }

    async deleteItemFromSale(saleId, itemIndex) {
        if (!(await this.appConfirm('Bu ürünü iptal etmek istediğinize emin misiniz?', { title: 'İptal Onayı', confirmText: 'İptal Et', cancelText: 'Vazgeç', confirmVariant: 'danger' }))) return;

        try {
            const sale = await this.db.getSale(saleId);
            if (!sale) return;

            const item = sale.items[itemIndex];
            if (!item) return;

            if (item.productId != null) {
            const product = await this.db.getProduct(item.productId);
            if (product) {
                if (this.tracksStock(product)) {
                    product.stock += item.amount;
                    await this.db.updateProduct(product);
                }
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
                await this._updateTableTotals(table, unpaidSales);

                // If last unpaid item is gone, auto-close regular tables (otherwise they stay "open" with 0₺)
                if (unpaidSales.length === 0 && table.type !== 'hourly' && table.type !== 'instant') {
                    table.isActive = false;
                    table.openTime = null;
                    table.closeTime = new Date().toISOString();
                    table.salesTotal = 0;
                    table.checkTotal = 0;
                }
                await this.db.updateTable(table);
            }

            // Refresh the open modal (this updates sales list + green total button label)
            await this.openTableModal(sale.tableId);

            // Refresh the corresponding table card immediately (avoid waiting for full reload)
            this.refreshSingleTableCard?.(sale.tableId);

            // Keep tables view consistent if we are on it
            if (this.currentView === 'tables') {
            await this.loadTables();
            }
            
            // Update products view if it's currently active (to show updated stock)
            if (this.currentView === 'products') {
                await this.loadProducts(true); // Reset pagination
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
                paymentTime: new Date().toISOString(),
                createdBy: this.currentUser?.id || this.currentUser?.email,
                createdByName: this.currentUser?.email || 'Bilinmeyen',
                createdByRole: this.userRole === 'admin' ? 'Yönetici' : 'Garson'
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
                await this._updateTableTotals(table, unpaidSales);

                // If last unpaid item is gone, auto-close regular tables
                if (unpaidSales.length === 0 && table.type !== 'hourly' && table.type !== 'instant') {
                    table.isActive = false;
                    table.openTime = null;
                    table.closeTime = new Date().toISOString();
                    table.salesTotal = 0;
                    table.checkTotal = 0;
                }
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

    async openTransferTargetModal(mode, opts = {}) {
        const modal = document.getElementById('transfer-target-modal');
        const titleEl = document.getElementById('transfer-target-modal-title');
        const cardsEl = document.getElementById('transfer-target-cards');
        if (!modal || !titleEl || !cardsEl) return;

        const tableId = this.currentTableId;
        if (!tableId) return;

        const allTables = await this.db.getAllTables();
        const targetTables = (allTables || []).filter(t => String(t.id) !== String(tableId) && t.type !== 'instant');

        if (targetTables.length === 0) {
            await this.appAlert('Hedef masa yok (anlık satış masası hedef olamaz).', 'Uyarı');
            return;
        }

        this._transferMode = mode;
        this._transferSaleId = opts.saleId || null;
        this._transferTargetTableId = null;

        titleEl.textContent = mode === 'table' ? 'Tüm masayı taşı – hedef masa seçin' : 'Satırı taşı – hedef masa seçin';

        // Taşımayla açılan masalar da doğru toplam göstersin: unpaid sales + süreli süre üzerinden hesapla (checkTotal/salesTotal bazen güncel olmuyor)
        const displayTotals = await Promise.all(targetTables.map(async (t) => {
            const unpaid = await this.db.getUnpaidSalesByTable(t.id);
            const salesTotal = (unpaid || []).reduce((sum, s) => sum + (Number(s?.saleTotal) || 0), 0);
            if (t.type === 'hourly' && t.openTime) {
                const hoursUsed = (Date.now() - new Date(t.openTime).getTime()) / (1000 * 60 * 60);
                return Math.round((hoursUsed * (t.hourlyRate || 0)) + salesTotal);
            }
            return Math.round(salesTotal);
        }));

        cardsEl.innerHTML = targetTables.map((t, i) => {
            const name = t.name || `Masa ${t.id}`;
            const icon = t.icon || (t.type === 'hourly' ? '🎱' : '🪑');
            const total = displayTotals[i] ?? 0;
            return `<div class="transfer-target-card" data-table-id="${t.id}" role="button" tabindex="0">
                <div class="transfer-target-icon">${icon}</div>
                <h4>${name}</h4>
                <div class="transfer-target-price">${total} ₺</div>
            </div>`;
        }).join('');

        cardsEl.querySelectorAll('.transfer-target-card').forEach(card => {
            card.addEventListener('click', () => {
                cardsEl.querySelectorAll('.transfer-target-card').forEach(c => c.classList.remove('selected'));
                card.classList.add('selected');
                this._transferTargetTableId = card.getAttribute('data-table-id');
            });
        });

        if (modal.classList.contains('closing')) modal.classList.remove('closing');
        modal.classList.add('active');
        if (modal.classList.contains('modal-bottom-sheet') && window.innerWidth <= 768) {
            this.runBottomSheetOpen(modal);
        } else {
            requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                    const modalContent = modal.querySelector('.modal-content');
                    if (modalContent) {
                        modalContent.style.transform = 'scale(1)';
                        modalContent.style.opacity = '1';
                    }
                });
            });
        }
    }

    async doTransferToTarget() {
        const targetId = this._transferTargetTableId;
        if (!targetId) {
            await this.appAlert('Lütfen hedef masa seçin.', 'Uyarı');
            return;
        }

        const tableId = this.currentTableId;
        if (!tableId || String(tableId) === String(targetId)) {
            this.closeFormModal('transfer-target-modal');
            return;
        }

        const modal = document.getElementById('transfer-target-modal');
        const modalContent = modal?.querySelector('.modal-content');
        const confirmBtn = document.getElementById('transfer-target-confirm-btn');
        const cancelBtn = document.getElementById('transfer-target-cancel-btn');
        let overlayEl = null;
        if (modalContent) {
            const message = this._transferMode === 'table' ? 'Masa taşınıyor...' : 'Taşınıyor...';
            overlayEl = document.createElement('div');
            overlayEl.className = 'transfer-progress-overlay';
            overlayEl.setAttribute('aria-live', 'polite');
            overlayEl.innerHTML = `
                <div class="transfer-progress-spinner"></div>
                <p class="transfer-progress-message">${message}</p>
            `;
            modalContent.style.position = 'relative';
            modalContent.appendChild(overlayEl);
            if (confirmBtn) confirmBtn.disabled = true;
            if (cancelBtn) cancelBtn.disabled = true;
        }
        const transferStartTime = Date.now();
        const TRANSFER_OVERLAY_MIN_MS = 3000;

        try {
            if (this._transferMode === 'table') {
                const sourceTable = await this.db.getTable(tableId);
                const targetTable = await this.db.getTable(targetId);
                if (!targetTable) {
                    this.closeFormModal('transfer-target-modal');
                    await this.appAlert('Hedef masa bulunamadı.', 'Hata');
                    return;
                }
                const targetTableId = targetTable.id;

                const unpaid = await this.db.getUnpaidSalesByTable(tableId);
                for (const sale of unpaid) {
                    sale.tableId = targetTableId;
                    await this.db.updateSale(sale);
                }

                let oyunUcretiTotal = 0;
                if (sourceTable && sourceTable.type === 'hourly' && sourceTable.isActive && sourceTable.openTime) {
                    const hoursUsed = calculateHoursUsed(sourceTable.openTime);
                    oyunUcretiTotal = hoursUsed * (sourceTable.hourlyRate || 0);
                    if (oyunUcretiTotal > 0) {
                        const oyunLabel = `${sourceTable?.name || 'Masa'} Oyun ücreti`;
                        const oyunSale = {
                            tableId: targetTableId,
                            items: [{ productId: null, name: oyunLabel, amount: 1, price: oyunUcretiTotal, icon: '🎱', isCancelled: false }],
                            sellDateTime: new Date().toISOString(),
                            saleTotal: oyunUcretiTotal,
                            isPaid: false,
                            isCredit: false,
                            customerId: null,
                            createdBy: this.currentUser?.id || this.currentUser?.email,
                            createdByName: this.currentUser?.email || 'Bilinmeyen',
                            createdByRole: this.userRole === 'admin' ? 'Yönetici' : 'Garson'
                        };
                        await this.db.addSale(oyunSale);
                    }
                    if (targetTable.type === 'hourly' && !targetTable.openTime) {
                        targetTable.openTime = new Date().toISOString();
                        targetTable.isActive = true;
                        targetTable.closeTime = null;
                    }
                }

                if (sourceTable) {
                    sourceTable.isActive = false;
                    sourceTable.openTime = null;
                    sourceTable.closeTime = new Date().toISOString();
                    sourceTable.salesTotal = 0;
                    sourceTable.checkTotal = 0;
                    if (sourceTable.type === 'hourly') sourceTable.hourlyTotal = 0;
                    await this.db.updateTable(sourceTable);
                }

                let unpaidTarget = await this.db.getUnpaidSalesByTable(targetTableId);
                if (targetTable.type === 'hourly' && unpaidTarget.length > 0) {
                    targetTable.closeTime = null;
                    targetTable.openTime = targetTable.openTime || new Date().toISOString();
                    targetTable.isActive = true;
                } else if (targetTable.type !== 'hourly' && targetTable.type !== 'instant' && unpaidTarget.length > 0) {
                    targetTable.isActive = true;
                }
                await this._updateTableTotals(targetTable, unpaidTarget);
                await this.db.updateTable(targetTable);

                const targetSalesTotal = (unpaidTarget || []).reduce((sum, s) => sum + (Number(s?.saleTotal) || 0), 0);
                let targetCheckTotal = targetSalesTotal;
                if (targetTable.type === 'hourly' && targetTable.isActive && targetTable.openTime) {
                    const th = calculateHoursUsed(targetTable.openTime) * (targetTable.hourlyRate || 0);
                    targetCheckTotal = th + targetSalesTotal;
                }
                const sourceCardStateFull = { isActive: false, type: sourceTable?.type, openTime: null, hourlyRate: 0, salesTotal: 0, checkTotal: 0 };
                const targetCardStateFull = { isActive: true, type: targetTable.type, openTime: targetTable.openTime, hourlyRate: targetTable.hourlyRate || 0, salesTotal: targetSalesTotal, checkTotal: targetCheckTotal };

                // Overlay kapanana kadar tüm işler bitsin: önce refresh sonra modal kapat
                await this.loadTables();
                if (this.refreshSingleTableCard) {
                    await this.refreshSingleTableCard(tableId);
                    await this.refreshSingleTableCard(targetTableId);
                }
                this.setTableCardState(tableId, sourceCardStateFull);
                this.setTableCardState(targetTableId, targetCardStateFull);
                const until = Date.now() + 6000;
                const srcEntry = { until, state: sourceCardStateFull };
                const tgtEntry = { until, state: targetCardStateFull };
                this._transferCardStateCache.set(tableId, srcEntry);
                this._transferCardStateCache.set(String(tableId), srcEntry);
                this._transferCardStateCache.set(targetTableId, tgtEntry);
                this._transferCardStateCache.set(String(targetTableId), tgtEntry);
                const elapsed = Date.now() - transferStartTime;
                if (elapsed < TRANSFER_OVERLAY_MIN_MS) {
                    await new Promise(r => setTimeout(r, TRANSFER_OVERLAY_MIN_MS - elapsed));
                }
                this.closeFormModal('transfer-target-modal');
                this.closeTableModal();
            } else {
                const saleId = this._transferSaleId;
                if (!saleId) {
                    this.closeFormModal('transfer-target-modal');
                    return;
                }
                const sale = await this.db.getSale(saleId);
                if (!sale || sale.isPaid) {
                    this.closeFormModal('transfer-target-modal');
                    return;
                }
                const targetTable = await this.db.getTable(targetId);
                if (!targetTable) {
                    this.closeFormModal('transfer-target-modal');
                    await this.appAlert('Hedef masa bulunamadı.', 'Hata');
                    return;
                }
                const targetTableId = targetTable.id;
                const saleToUpdate = { ...sale, tableId: targetTableId };
                await this.db.updateSale(saleToUpdate);

                const sourceTable = await this.db.getTable(tableId);
                if (sourceTable) {
                    const unpaidSource = await this.db.getUnpaidSalesByTable(tableId);
                    await this._updateTableTotals(sourceTable, unpaidSource);
                    if (unpaidSource.length === 0 && sourceTable.type !== 'hourly' && sourceTable.type !== 'instant') {
                        sourceTable.isActive = false;
                        sourceTable.openTime = null;
                        sourceTable.closeTime = new Date().toISOString();
                        sourceTable.salesTotal = 0;
                        sourceTable.checkTotal = 0;
                    }
                    await this.db.updateTable(sourceTable);
                }
                const unpaidTarget = await this.db.getUnpaidSalesByTable(targetTableId);
                if (targetTable.type === 'hourly' && unpaidTarget.length > 0) {
                    targetTable.closeTime = null;
                    targetTable.openTime = targetTable.openTime || new Date().toISOString();
                    targetTable.isActive = true;
                } else if (targetTable.type !== 'hourly' && targetTable.type !== 'instant' && unpaidTarget.length > 0) {
                    targetTable.isActive = true;
                }
                await this._updateTableTotals(targetTable, unpaidTarget);
                await this.db.updateTable(targetTable);

                const unpaidSourceAfter = await this.db.getUnpaidSalesByTable(tableId);
                const sourceSalesTotal = (unpaidSourceAfter || []).reduce((sum, s) => sum + (Number(s?.saleTotal) || 0), 0);
                let sourceCheckTotal = sourceSalesTotal;
                if (sourceTable && sourceTable.type === 'hourly' && sourceTable.isActive && sourceTable.openTime) {
                    sourceCheckTotal = calculateHoursUsed(sourceTable.openTime) * (sourceTable.hourlyRate || 0) + sourceSalesTotal;
                }
                const targetSalesTotal = (unpaidTarget || []).reduce((sum, s) => sum + (Number(s?.saleTotal) || 0), 0);
                let targetCheckTotal = targetSalesTotal;
                if (targetTable.type === 'hourly' && targetTable.isActive && targetTable.openTime) {
                    targetCheckTotal = calculateHoursUsed(targetTable.openTime) * (targetTable.hourlyRate || 0) + targetSalesTotal;
                }
                const sourceCardState = { isActive: unpaidSourceAfter.length > 0 || (sourceTable?.type === 'hourly' && sourceTable?.openTime), type: sourceTable?.type, openTime: sourceTable?.openTime || null, hourlyRate: sourceTable?.hourlyRate || 0, salesTotal: sourceSalesTotal, checkTotal: sourceCheckTotal };
                const targetCardState = { isActive: true, type: targetTable.type, openTime: targetTable.openTime, hourlyRate: targetTable.hourlyRate || 0, salesTotal: targetSalesTotal, checkTotal: targetCheckTotal };

                this._tableModalPrefetchCache.delete(targetTableId);
                this._tableModalPrefetchCache.delete(tableId);
                this._tableModalForceRefreshIds.add(targetTableId);
                this._tableModalForceRefreshIds.add(String(targetTableId));
                this._tableModalForceRefreshIds.add(Number(targetTableId));
                // Overlay kapanana kadar tüm işler bitsin: önce refresh sonra modal kapat
                if (unpaidSourceAfter.length > 0) {
                    await this.loadTableProducts(tableId);
                }
                await this.loadTables();
                if (this.refreshSingleTableCard) {
                    await this.refreshSingleTableCard(tableId);
                    await this.refreshSingleTableCard(targetTableId);
                }
                this.setTableCardState(tableId, sourceCardState);
                this.setTableCardState(targetTableId, targetCardState);
                const until = Date.now() + 6000;
                const srcEntry = { until, state: sourceCardState };
                const tgtEntry = { until, state: targetCardState };
                this._transferCardStateCache.set(tableId, srcEntry);
                this._transferCardStateCache.set(String(tableId), srcEntry);
                this._transferCardStateCache.set(targetTableId, tgtEntry);
                this._transferCardStateCache.set(String(targetTableId), tgtEntry);
                const elapsedItem = Date.now() - transferStartTime;
                if (elapsedItem < TRANSFER_OVERLAY_MIN_MS) {
                    await new Promise(r => setTimeout(r, TRANSFER_OVERLAY_MIN_MS - elapsedItem));
                }
                this.closeFormModal('transfer-target-modal');
                if (unpaidSourceAfter.length > 0) {
                    await this.openTableModal(tableId);
                } else {
                    this.closeTableModal();
                }
            }
        } catch (err) {
            console.error('Transfer error:', err);
            await this.appAlert('Taşıma sırasında hata oluştu.', 'Hata');
        } finally {
            if (overlayEl && overlayEl.parentNode) overlayEl.remove();
            if (confirmBtn) confirmBtn.disabled = false;
            if (cancelBtn) cancelBtn.disabled = false;
            this._transferMode = null;
            this._transferSaleId = null;
            this._transferTargetTableId = null;
        }
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

        if (modal.classList.contains('closing')) modal.classList.remove('closing');
        modal.classList.add('active');
        if (modal.classList.contains('modal-bottom-sheet') && window.innerWidth <= 768) {
            this.runBottomSheetOpen(modal);
        } else {
            requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                    const modalContent = modal.querySelector('.modal-content');
                    if (modalContent) {
                        modalContent.style.transform = 'scale(1)';
                        modalContent.style.opacity = '1';
                    }
                });
            });
        }
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
                paymentTime: new Date().toISOString(),
                createdBy: this.currentUser?.id || this.currentUser?.email,
                createdByName: this.currentUser?.email || 'Bilinmeyen',
                createdByRole: this.userRole === 'admin' ? 'Yönetici' : 'Garson'
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
                await this._updateTableTotals(table, unpaidSales);

                // If last unpaid item is gone, auto-close regular tables
                if (unpaidSales.length === 0 && table.type !== 'hourly' && table.type !== 'instant') {
                    table.isActive = false;
                    table.openTime = null;
                    table.closeTime = new Date().toISOString();
                    table.salesTotal = 0;
                    table.checkTotal = 0;
                await this.db.updateTable(table);
                    
                    // Close modal if it's open for this table
                    if (this.currentTableId === sale.tableId) {
                        this.closeTableModal();
                    }
                    
                    // Update UI immediately
                    this.setTableCardState(sale.tableId, {
                        isActive: false,
                        salesTotal: 0,
                        checkTotal: 0,
                        openTime: null
                    });
                } else {
                    await this.db.updateTable(table);
                }
            }

            // Only reload and reopen modal if table is still active
            if (table && table.isActive) {
            await this.loadTableProducts(sale.tableId);
            await this.openTableModal(sale.tableId);
            } else {
                // Table is closed, just refresh the view
                this.closeTableModal();
            }
            
            await this.loadTables();
            await this.loadCustomers(true); // Reset pagination
            
            if (this.currentView === 'daily') {
                await this.loadDailyDashboard();
            }
        } catch (error) {
            console.error('Error crediting item:', error);
            await this.appAlert('Ürün veresiye yazılırken hata oluştu. Lütfen tekrar deneyin.', 'Hata');
        }
    }

    // Calculation functions are now imported from src/utils/calculators.js

    /**
     * CRITICAL: Central table closure function - ensures atomic, synchronized table closure
     * This function handles all table closure operations (payment, credit, cancel) in a consistent way
     * 
     * @param {number} tableId - Table ID to close
     * @param {Object} options - Closure options
     * @param {string} options.paymentTime - ISO timestamp for payment/credit/cancel
     * @param {boolean} options.isCredit - Whether this is a credit payment
     * @param {string|null} options.customerId - Customer ID for credit payments
     * @param {boolean} options.isCancel - Whether this is a cancellation (no payment)
     * @returns {Promise<{success: boolean, error?: string, table?: Object}>}
     */
    async _closeTableSafely(tableId, options = {}) {
        const { paymentTime, isCredit = false, customerId = null, isCancel = false } = options;
        if (tableId == null || String(tableId) === 'null' || String(tableId) === '') {
            return { success: false, error: 'Geçersiz masa' };
        }
        // Step 1: Validate table state and prevent concurrent closures
        if (this._isTableSettling(tableId)) {
            debugLog(`Table ${tableId} is already being settled, skipping`);
            return { success: false, error: 'Table is already being settled' };
        }

        // Step 1.5: Stop DB refresh to prevent race conditions during closure
        // Use counter to handle multiple concurrent closures
        const wasPolling = this._pollSyncInterval !== null;
        this._closingTablesCount++;
        if (wasPolling && this._closingTablesCount === 1) {
            // Only stop on first closure
            this.stopPollSync();
            debugLog(`Stopped DB refresh for table closures (count: ${this._closingTablesCount})`);
        }

        // Step 2: Re-read table from DB to ensure we have the latest state
        let table = await this.db.getTable(tableId);
        if (!table) {
            // Decrement closing counter on error
            this._closingTablesCount = Math.max(0, this._closingTablesCount - 1);
            // Restart polling if it was running and no other operations are in progress
            if (wasPolling && this._openingTablesCount === 0 && this._closingTablesCount === 0) {
                this.startPollSync();
            }
            return { success: false, error: 'Table not found' };
        }

        // Step 3: Validate table can be closed
        if (table.type === 'hourly') {
            if (!table.isActive || !table.openTime) {
                // Decrement closing counter on validation error
                this._closingTablesCount = Math.max(0, this._closingTablesCount - 1);
                if (wasPolling && this._openingTablesCount === 0 && this._closingTablesCount === 0) {
                    this.startPollSync();
                }
                return { success: false, error: 'Hourly table is not open' };
            }
            // Süreli masada closeTime tekrar kapanmayı engellemez (önceki oturum). Sadece openTime yoksa kapalıyız (yukarıda return edildi).
            if (table.type !== 'hourly' && table.closeTime) {
                this._closingTablesCount = Math.max(0, this._closingTablesCount - 1);
                if (wasPolling && this._openingTablesCount === 0 && this._closingTablesCount === 0) {
                    this.startPollSync();
                }
                return { success: false, error: 'Table is already closed' };
            }
        } else {
            if (!table.isActive) {
                // Decrement closing counter on validation error
                this._closingTablesCount = Math.max(0, this._closingTablesCount - 1);
                if (wasPolling && this._openingTablesCount === 0 && this._closingTablesCount === 0) {
                    this.startPollSync();
                }
                return { success: false, error: 'Table is not active' };
            }
        }

        // Step 4: Mark as settling IMMEDIATELY to prevent race conditions
        // Note: DB refresh is stopped during closure, so shorter settling time is sufficient
        this._markTableSettling(tableId, 5000); // 5 seconds is enough now that we stop refresh during closure

        try {
            // Step 5: Get unpaid sales BEFORE closing table
            const unpaidSales = await this.db.getUnpaidSalesByTable(tableId);

            // Step 6: Prepare table closure state
            const closeTimeISO = paymentTime || new Date().toISOString();
            const updatedTable = { ...table };

            if (table.type === 'hourly') {
                // Calculate hourly total
                let finalHourlyTotal = 0;
                if (!isCancel && (unpaidSales.length > 0 || table.salesTotal > 0)) {
                    const hoursUsed = calculateHoursUsed(table.openTime);
                    finalHourlyTotal = hoursUsed * table.hourlyRate;
                }

                // Persist session to hourlySessions
                updatedTable.hourlySessions = Array.isArray(table.hourlySessions) ? table.hourlySessions : [];
                const sessionHoursUsed = calculateHoursBetween(table.openTime, closeTimeISO);
                const sessionHourlyTotal = finalHourlyTotal > 0 ? finalHourlyTotal : (sessionHoursUsed * table.hourlyRate);
                
                const session = {
                    openTime: table.openTime,
                    closeTime: closeTimeISO,
                    hoursUsed: sessionHoursUsed,
                    hourlyTotal: sessionHourlyTotal,
                    paymentTime: closeTimeISO,
                    isCredit,
                    isCancelled: isCancel // Mark cancelled sessions
                };
                if (customerId) session.customerId = customerId;
                
                updatedTable.hourlySessions.push(session);

                // Close hourly table: önce openTime null (oturum bitti), sonra closeTime kaydı
                updatedTable.isActive = false;
                updatedTable.openTime = null;
                updatedTable.closeTime = closeTimeISO;
                updatedTable.hourlyTotal = 0;
            } else {
                // Close regular/instant table
                updatedTable.isActive = false;
            }

            // Reset totals
            updatedTable.salesTotal = 0;
            updatedTable.checkTotal = 0;

            // Step 7: Write table closure to DB FIRST (atomic operation)
            // This ensures other devices see the table as closed immediately
            await this.db.updateTable(updatedTable);
            
            // CRITICAL: Update UI immediately after DB write (before sales processing)
            // This ensures table card shows 0 immediately when reopened
            this.setTableCardState(tableId, {
                isActive: false,
                type: table.type,
                openTime: null,
                hourlyRate: table.hourlyRate || 0,
                salesTotal: 0,
                checkTotal: 0
            });

            // Step 8: Wait a moment for DB write to propagate
            await new Promise(resolve => setTimeout(resolve, 100));

            // Step 9: Handle sales based on closure type
            if (isCancel) {
                // Cancel: Delete all unpaid sales and restore stock (Oyun ücreti satırında productId null olabilir)
                for (const sale of unpaidSales) {
                    if (sale?.items?.length) {
                        for (const item of sale.items) {
                            if (!item || item.isCancelled) continue;
                            if (item.productId == null) continue;
                            const product = await this.db.getProduct(item.productId);
                            if (product && this.tracksStock(product)) {
                                product.stock += item.amount;
                                await this.db.updateProduct(product);
                            }
                        }
                    }
                    if (sale?.id) {
                        await this.db.deleteSale(sale.id);
                    }
                }
            } else {
                // Payment/Credit: Mark sales as paid
                for (const sale of unpaidSales) {
                    sale.isPaid = true;
                    sale.paymentTime = closeTimeISO;
                    if (isCredit) {
                        sale.isCredit = true;
                        sale.customerId = customerId;
                    }
                    // Update user info for payment/credit operations
                    sale.createdBy = sale.createdBy || (this.currentUser?.id || this.currentUser?.email);
                    sale.createdByName = sale.createdByName || (this.currentUser?.email || 'Bilinmeyen');
                    sale.createdByRole = sale.createdByRole || (this.userRole === 'admin' ? 'Yönetici' : 'Garson');
                    await this.db.updateSale(sale);
                }

                // Note: Customer balance update is handled by the caller (processCreditTable)
                // to ensure accurate calculation before table closure
            }

            // Step 10: Multiple verification passes to ensure table stays closed
            // This prevents race conditions where realtime updates reopen the table
            // Extended verification period to catch delayed realtime updates
            for (let verifyAttempt = 0; verifyAttempt < 5; verifyAttempt++) {
                await new Promise(resolve => setTimeout(resolve, 300)); // Wait between attempts
                
                const verifyTable = await this.db.getTable(tableId);
                if (verifyTable && (verifyTable.isActive || (verifyTable.type === 'hourly' && verifyTable.openTime))) {
                    // Force close if verification fails
                    debugLog(`Verification attempt ${verifyAttempt + 1}: Table ${tableId} was reopened, forcing close again`);
                    verifyTable.isActive = false;
                    verifyTable.openTime = null;
                    verifyTable.closeTime = verifyTable.closeTime || closeTimeISO;
                    verifyTable.salesTotal = 0;
                    verifyTable.checkTotal = 0;
                    if (verifyTable.type === 'hourly') {
                        verifyTable.hourlyTotal = 0;
                    }
                    await this.db.updateTable(verifyTable);
                } else {
                    // Table is properly closed, but continue verification to catch delayed updates
                    if (verifyAttempt >= 2) {
                        // After 2 successful checks, we can be more confident
                        break;
                    }
                }
            }

            // Step 11: Final verification - ensure table is closed
            const finalVerifyTable = await this.db.getTable(tableId);
            if (finalVerifyTable && (finalVerifyTable.isActive || (finalVerifyTable.type === 'hourly' && finalVerifyTable.openTime))) {
                // Last attempt: force close
                debugLog(`Final verification: Table ${tableId} still open, forcing close`);
                finalVerifyTable.isActive = false;
                finalVerifyTable.openTime = null;
                finalVerifyTable.closeTime = finalVerifyTable.closeTime || closeTimeISO;
                finalVerifyTable.salesTotal = 0;
                finalVerifyTable.checkTotal = 0;
                if (finalVerifyTable.type === 'hourly') {
                    finalVerifyTable.hourlyTotal = 0;
                }
                await this.db.updateTable(finalVerifyTable);
            }

            // Step 12: Verify no unpaid sales remain
            const remainingUnpaidSales = await this.db.getUnpaidSalesByTable(tableId);
            if (remainingUnpaidSales.length > 0) {
                debugWarn(`Warning: ${remainingUnpaidSales.length} unpaid sales still exist after closure`);
                // Force update table totals
                const finalTable = await this.db.getTable(tableId);
                if (finalTable) {
                    finalTable.salesTotal = 0;
                    finalTable.checkTotal = 0;
                    if (finalTable.type === 'hourly') {
                        finalTable.hourlyTotal = 0;
                    }
                    await this.db.updateTable(finalTable);
                }
            }

            // Step 13: Return final verified table state
            const finalTableState = await this.db.getTable(tableId);
            
            // Step 14: Decrement closing counter
            this._closingTablesCount = Math.max(0, this._closingTablesCount - 1);
            
            // Step 15: Wait a moment for DB write to fully propagate
            await new Promise(resolve => setTimeout(resolve, 500));
            
            // Step 16: Restart DB refresh only when ALL operations (opening + closing) are complete
            if (wasPolling && this._openingTablesCount === 0 && this._closingTablesCount === 0) {
                this.startPollSync();
                debugLog(`Restarted DB refresh after all table operations completed`);
            }
            
            // Step 17: Keep table marked as settling for a short time after closure
            // This prevents realtime updates from interfering immediately after closure
            this._markTableSettling(tableId, 5000); // 5 seconds is enough now that we stopped refresh
            
            return { success: true, table: finalTableState || updatedTable };
        } catch (error) {
            console.error('Error closing table:', error);
            
            // Decrement closing counter on error
            this._closingTablesCount = Math.max(0, this._closingTablesCount - 1);
            
            // Restart polling on error only if no other operations are in progress
            if (wasPolling && this._openingTablesCount === 0 && this._closingTablesCount === 0) {
                this.startPollSync();
            }
            
            // Rollback: try to reopen table
            try {
                const rollbackTable = await this.db.getTable(tableId);
                if (rollbackTable) {
                    rollbackTable.isActive = true;
                    if (rollbackTable.type === 'hourly' && table.openTime) {
                        rollbackTable.openTime = table.openTime;
                        rollbackTable.closeTime = null;
                    }
                    await this.db.updateTable(rollbackTable);
                }
            } catch (rollbackError) {
                console.error('Error rolling back table state:', rollbackError);
            }
            return { success: false, error: error.message || 'Unknown error' };
        }
    }

    /**
     * Helper: Update table totals from unpaid sales (used in multiple places)
     * @param {Object} table - Table object
     * @param {Array} unpaidSales - Array of unpaid sales
     */
    async _updateTableTotals(table, unpaidSales) {
        if (!table) return;
        
        const salesTotal = (unpaidSales || []).reduce((sum, s) => sum + (Number(s?.saleTotal) || 0), 0);
        table.salesTotal = salesTotal;
        
        if (table.type === 'hourly' && table.isActive && table.openTime) {
            const hoursUsed = calculateHoursUsed(table.openTime);
            table.hourlyTotal = hoursUsed * table.hourlyRate;
            table.checkTotal = table.hourlyTotal + salesTotal;
        } else {
            table.checkTotal = salesTotal;
        }
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
        timeInput.value = formatTimeOnly(defaultIso);

        // iOS-like opening animation
        if (modal.classList.contains('closing')) {
            modal.classList.remove('closing');
        }
        modal.classList.add('active');
        
        // Trigger animation
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                const modalContent = modal.querySelector('.modal-content');
                if (modalContent) {
                    modalContent.style.transform = 'scale(1)';
                    modalContent.style.opacity = '1';
                }
            });
        });
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
                const hoursUsed = calculateHoursBetween(table.openTime, table.closeTime);
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


    // Helper: Calculate hourly total for a table
    calculateHourlyTotal(table) {
        if (table.type !== 'hourly' || !table.isActive || !table.openTime) return 0;
        const hoursUsed = calculateHoursUsed(table.openTime);
        return hoursUsed * table.hourlyRate;
    }

    // Helper: Calculate check total for a table
    calculateCheckTotal(table) {
        const hourlyTotal = this.calculateHourlyTotal(table);
        return hourlyTotal + (table.salesTotal || 0);
    }

    // Helper: Update modal totals (reduces DOM queries)
    async updateModalTotals(table) {
        // Keep the green pay button label in sync (show amount only)
        const payBtn = document.getElementById('pay-table-btn');
        const creditBtn = document.getElementById('credit-table-btn');
        const payTxt = payBtn?.querySelector?.('.btn-txt') || null;
        
        // Get unpaid sales to determine button visibility - always fetch fresh data
        let unpaidSales = [];
        try {
            unpaidSales = await this.db.getUnpaidSalesByTable(table.id || this.currentTableId);
        } catch (e) {
            console.error('Error fetching unpaid sales:', e);
        }
        
        // Calculate actual totals from unpaid sales (not from stale table.checkTotal)
        const computedSalesTotal = (unpaidSales || []).reduce((sum, s) => sum + (Number(s?.saleTotal) || 0), 0);
        let actualCheckTotal = computedSalesTotal;
        if (table.type === 'hourly' && table.isActive && table.openTime) {
            const hoursUsed = calculateHoursUsed(table.openTime);
            const hourlyTotal = hoursUsed * (table.hourlyRate || 0);
            actualCheckTotal = hourlyTotal + computedSalesTotal;
        }
        
        if (table.type === 'hourly') {
            const modalSalesTotal = document.getElementById('modal-sales-total');
            const modalCheckTotal = document.getElementById('modal-check-total');
            if (modalSalesTotal) modalSalesTotal.textContent = Math.round(computedSalesTotal);
            if (modalCheckTotal) {
                modalCheckTotal.textContent = Math.round(actualCheckTotal);
                if (payTxt) payTxt.textContent = `${Math.round(actualCheckTotal)} ₺`;
            }
        } else {
            const modalCheckTotalRegular = document.getElementById('modal-check-total-regular');
            if (modalCheckTotalRegular) modalCheckTotalRegular.textContent = Math.round(computedSalesTotal);
            if (payTxt) payTxt.textContent = `${Math.round(actualCheckTotal)} ₺`;
        }
        
        // Update button visibility based on unpaid sales and actual check total
        if (payBtn) {
            const hasUnpaidSales = unpaidSales.length > 0;
            const hasCheckTotal = actualCheckTotal > 0 || (table.type === 'hourly' && table.isActive && table.openTime);
            if (hasUnpaidSales || hasCheckTotal) {
                payBtn.style.display = 'inline-block';
            } else {
                payBtn.style.display = 'none';
            }
        }
        
        if (creditBtn) {
            const hasUnpaidSales = unpaidSales.length > 0;
            const hasCheckTotal = actualCheckTotal > 0 || (table.type === 'hourly' && table.isActive && table.openTime);
            if (hasUnpaidSales || hasCheckTotal) {
                creditBtn.style.display = 'inline-block';
            } else {
                creditBtn.style.display = 'none';
            }
        }
    }

    // Helper: Reload multiple views in parallel
    async reloadViews(views = ['tables']) {
        const promises = [];
        if (views.includes('tables')) promises.push(this.loadTables());
        if (views.includes('products')) promises.push(this.loadProducts());
        if (views.includes('sales')) promises.push(this.loadSales());
        if (views.includes('customers')) promises.push(this.loadCustomers());
        if (views.includes('expenses')) promises.push(this.loadExpenses());
        if (views.includes('daily') && this.currentView === 'daily') {
            promises.push(this.loadDailyDashboard());
        }
        await Promise.all(promises);
    }

    async refreshAllFromDb() {
        // Background refresh: sync local cache from Supabase and refresh UI.
        try {
            // Update footer immediately (nice feedback)
            this.updateFooter?.();

            if (typeof this.db?.syncNow === 'function') {
                await this.db.syncNow({ force: true, forceFull: true });
            }

            // Reload common data sets
            await this.reloadViews(['tables', 'products', 'customers', 'sales']);

            // If a table modal is open, do NOT refresh it here (user requested no DB refresh while inside)
        } catch (e) {
            // Silent: refresh is best-effort
            debugLog('DB refresh skipped:', e?.message || e);
        }
    }

    startRealtimeSubscriptions() {
        // Supabase Realtime (Postgres changes). Makes multi-device updates visible without refresh.
        if (!this.supabase || this._realtimeChannel) return;

        const onChange = (tableName, payload) => {
            try {
                this.handleRealtimeChange(tableName, payload);
            } catch (e) {
                console.error('Realtime handler error:', e);
            }
        };

        this._realtimeChannel = this.supabase
            .channel('mekanapp-realtime')
            .on('postgres_changes', { event: '*', schema: 'public', table: 'tables' }, (p) => onChange('tables', p))
            .on('postgres_changes', { event: '*', schema: 'public', table: 'products' }, (p) => onChange('products', p))
            .on('postgres_changes', { event: '*', schema: 'public', table: 'sales' }, (p) => onChange('sales', p))
            .on('postgres_changes', { event: '*', schema: 'public', table: 'customers' }, (p) => onChange('customers', p))
            .on('postgres_changes', { event: '*', schema: 'public', table: 'expenses' }, (p) => onChange('expenses', p))
            .subscribe((status) => {
                // statuses: SUBSCRIBED, TIMED_OUT, CLOSED, CHANNEL_ERROR
                if (status !== 'SUBSCRIBED') {
                    // keep quiet; network may be flaky on tablets
                }
            });
    }

    stopRealtimeSubscriptions() {
        if (this._realtimeRefreshTimer) {
            clearTimeout(this._realtimeRefreshTimer);
            this._realtimeRefreshTimer = null;
        }
        this._realtimePendingViews?.clear?.();
        if (this._realtimeChannel && this.supabase) {
            try {
                this.supabase.removeChannel(this._realtimeChannel);
            } catch (e) {
                // ignore
            }
        }
        this._realtimeChannel = null;
    }

    async handleRealtimeChange(tableName, payload) {
        // Decide which screens to refresh (debounced)
        const views = new Set();
        const current = this.currentView;

        if (tableName === 'tables') {
            views.add('tables');
            // Sales view uses table names mapping
            if (current === 'sales') views.add('sales');
            // Daily uses tables for hourly aggregation
            if (current === 'daily') views.add('daily');
        } else if (tableName === 'products') {
            if (current === 'products') views.add('products');
            // Table modal product stock/price can be impacted; simplest is refresh tables if viewing
            if (current === 'tables') views.add('tables');
            if (current === 'daily') views.add('daily');
        } else if (tableName === 'sales') {
            // Sales affect tables, sales history, and reports
            views.add('tables');
            views.add('sales');
            if (current === 'daily') views.add('daily');
            if (current === 'customers') views.add('customers');
        } else if (tableName === 'customers') {
            if (current === 'customers') views.add('customers');
            if (current === 'sales') views.add('sales');
            if (current === 'daily') views.add('daily');
        } else if (tableName === 'expenses') {
            if (current === 'expenses') views.add('expenses');
            if (current === 'daily') views.add('daily');
        }

        // Identify impacted tableId (sales payload id is sale id; we need table_id)
        const tableModal = document.getElementById('table-modal');
        const changedTableId =
            (tableName === 'sales')
                ? (payload?.new?.table_id || payload?.old?.table_id || payload?.new?.tableId || payload?.old?.tableId || null)
                : (payload?.new?.id || payload?.old?.id || null);
        const shouldRefreshModal = Boolean(
            tableModal &&
            tableModal.classList.contains('active') &&
            this.currentTableId &&
            changedTableId &&
            String(changedTableId) === String(this.currentTableId)
        );

        const schedule = async () => {
        this.scheduleRealtimeRefresh(Array.from(views), shouldRefreshModal);
            // Additionally update the one changed card instantly while on tables view
            if ((tableName === 'sales' || tableName === 'tables') && changedTableId) {
                // CRITICAL: If table was cancelled (has closeTime, no openTime, not active),
                // don't refresh the card - it should remain closed
                // This prevents cancelled tables from being reopened by realtime updates
                if (tableName === 'tables') {
                    try {
                        const updatedTable = this.db.getTable ? await this.db.getTable(changedTableId) : null;
                        // Check if table is currently being settled (prevent interference during closure)
                        const isSettling = this._isTableSettling(changedTableId);
                        
                        // If table is being settled, skip refresh to prevent race conditions
                        if (isSettling) {
                            debugLog(`Realtime: Table ${changedTableId} is being settled, skipping card refresh`);
                            return;
                        }
                        
                        // Süreli masada kapalı = openTime yok. Normal masada closeTime veya !isActive = kapalı.
                        const isClosed = updatedTable && (updatedTable.type === 'hourly'
                            ? !updatedTable.openTime
                            : (updatedTable.closeTime || !updatedTable.isActive));
                        
                        if (isClosed) {
                            // Table was cancelled/closed - don't refresh, keep it closed
                            debugLog(`Realtime: Table ${changedTableId} was closed, skipping card refresh to keep it closed`);
                            
                            // Force close if DB state doesn't match (defensive)
                            if (updatedTable.isActive || (updatedTable.type === 'hourly' && updatedTable.openTime)) {
                                debugLog(`Realtime: Table ${changedTableId} DB state mismatch, forcing close`);
                                const forceClosed = {
                                    ...updatedTable,
                                    isActive: false,
                                    openTime: null,
                                    closeTime: updatedTable.closeTime || new Date().toISOString(),
                                    salesTotal: 0,
                                    checkTotal: 0
                                };
                                if (forceClosed.type === 'hourly') {
                                    forceClosed.hourlyTotal = 0;
                                }
                                await this.db.updateTable(forceClosed);
                            }
                            
                            // Ensure UI shows closed state
                            this.setTableCardState(changedTableId, {
                                isActive: false,
                                type: updatedTable.type,
                                openTime: null,
                                hourlyRate: updatedTable.hourlyRate || 0,
                                salesTotal: 0,
                                checkTotal: 0
                            });
                            return;
                        }
                    } catch (e) {
                        // If we can't check, proceed with refresh (better to show stale data than nothing)
                        console.error('Error checking table state in realtime handler:', e);
                    }
                }
                this.refreshSingleTableCard(changedTableId);
            }
        };

        // Apply change to local cache first, then schedule UI refresh (prevents race where UI reloads before IDB upsert).
        try {
            // CRITICAL: Wait for applyRealtimeChange to complete before scheduling UI refresh
            // This ensures IndexedDB is updated before we read from it
            const changeApplied = await this.db?.applyRealtimeChange?.(tableName, payload);
            if (changeApplied) {
                // Tables: remote'tan tüm masaları çekip local'i güncelle (süreli kapanış diğer cihazda kesin yansısın)
                if (tableName === 'tables' && typeof this.db?.syncTablesFull === 'function') {
                    await this.db.syncTablesFull().catch((e) => console.warn('Realtime tables syncTablesFull:', e));
                }
                // Small delay so IndexedDB commit is visible before we read
                await new Promise(resolve => setTimeout(resolve, 150));
                
                // Additional cleanup for cancelled tables (before scheduling UI refresh)
                if (tableName === 'tables' && changedTableId) {
                    try {
                        const updatedTable = await this.db.getTable(changedTableId);
                        // Check if table is currently being settled (prevent interference during closure)
                        const isSettling = this._isTableSettling(changedTableId);
                        
                        // Süreli masada kapalı = openTime yok. Normal masada closeTime veya !isActive = kapalı.
                        const isTableClosed = updatedTable && (updatedTable.type === 'hourly'
                            ? !updatedTable.openTime
                            : (updatedTable.closeTime || !updatedTable.isActive));
                        
                        if (isTableClosed) {
                            // Table was closed - if realtime update tries to reopen it, force it closed again
                            // Check if payload tries to reopen the table
                            const payloadTriesToReopen = payload?.new?.isActive || 
                                (payload?.new?.openTime && !payload?.new?.closeTime && updatedTable.type === 'hourly');
                            
                            if (isSettling || payloadTriesToReopen) {
                                debugLog(`Realtime: Preventing closed table ${changedTableId} from being reopened (isSettling: ${isSettling}, payloadReopen: ${payloadTriesToReopen})`);
                                // Force close again - don't use _closeTableSafely to avoid recursion
                                const forceClosed = {
                                    ...updatedTable,
                                    isActive: false,
                                    openTime: null,
                                    closeTime: updatedTable.closeTime || new Date().toISOString(),
                                    salesTotal: 0,
                                    checkTotal: 0
                                };
                                if (forceClosed.type === 'hourly') {
                                    forceClosed.hourlyTotal = 0;
                                }
                                await this.db.updateTable(forceClosed);
                                // Update UI to show closed state
                                this.setTableCardState(changedTableId, {
                                    isActive: false,
                                    type: forceClosed.type,
                                    openTime: null,
                                    hourlyRate: forceClosed.hourlyRate || 0,
                                    salesTotal: 0,
                                    checkTotal: 0
                                });
                                return; // Don't proceed with cleanup or refresh
                            }
                            
                            // Table was closed - clean up any remaining unpaid sales on this device
                            const unpaidSales = await this.db.getUnpaidSalesByTable(changedTableId);
                            if (unpaidSales.length > 0) {
                                debugLog(`Realtime: Table ${changedTableId} was closed, cleaning up ${unpaidSales.length} unpaid sales on this device`);
                                for (const sale of unpaidSales) {
                                    if (sale?.items?.length) {
                                        for (const item of sale.items) {
                                            if (!item || item.isCancelled) continue;
                                            if (item.productId == null) continue;
                                            const product = await this.db.getProduct(item.productId);
                                            if (product && this.tracksStock(product)) {
                                                product.stock += item.amount;
                                                await this.db.updateProduct(product);
                                            }
                                        }
                                    }
                                    if (sale?.id) {
                                        await this.db.deleteSale(sale.id);
                                    }
                                }
                                // Update UI to show closed state with 0 totals
                                this.setTableCardState(changedTableId, {
                                    isActive: false,
                                    type: updatedTable.type,
                                    openTime: null,
                                    hourlyRate: updatedTable.hourlyRate || 0,
                                    salesTotal: 0,
                                    checkTotal: 0
                                });
                            }
                        }
                    } catch (e) {
                        console.error('Error cleaning up sales in realtime handler:', e);
                    }
                }
                
                // Now schedule UI refresh after cache is updated and cleanup is done
                await schedule();
                return;
            }
        } catch (e) {
            console.error('Error applying realtime change:', e);
        }
        // Fallback: schedule even if applyRealtimeChange failed
        await schedule();
    }

    scheduleRealtimeRefresh(views, refreshModal) {
        (views || []).forEach((v) => this._realtimePendingViews.add(v));
        if (refreshModal) this._realtimePendingViews.add('__modal__');

        // Debounce bursts (multiple rows changes)
        if (this._realtimeRefreshTimer) return;
        this._realtimeRefreshTimer = setTimeout(async () => {
            this._realtimeRefreshTimer = null;
            const pending = Array.from(this._realtimePendingViews);
            this._realtimePendingViews.clear();

            const viewsToReload = pending.filter((v) => v !== '__modal__');
            const modalRequested = pending.includes('__modal__');

            try {
                if (viewsToReload.length > 0) {
                    await this.reloadViews(viewsToReload);
                }
                // While table modal is open, avoid auto re-rendering it from realtime bursts.
                // applyRealtimeChange already updated IndexedDB; user prefers a stable modal UI.
            } catch (e) {
                console.error('Realtime refresh failed:', e);
            }
        }, 350);
    }

    // ---------- Ürünler (yardımcılar) ----------
    tracksStock(product) {
        return product.trackStock !== false && product.stock !== null && product.stock !== undefined;
    }

    // --- Product categories (Cafe defaults) ---
    getProductCategoryKey(product) {
        const raw = (product && product.category != null) ? String(product.category) : '';
        const v = raw.trim().toLowerCase();
        if (v === 'alkollu' || v === 'alkollü' || v === 'alkollu_icecekler' || v === 'alkollü içecekler' || v === 'alcohol') return 'alcohol';
        if (v === 'mesrubat' || v === 'meşrubat' || v === 'mesrubatlar' || v === 'meşrubatlar' || v === 'soft') return 'soft';
        if (v === 'yiyecek' || v === 'yiyecekler' || v === 'food') return 'food';
        return 'soft';
    }

    getProductCategoryLabel(catKey) {
        const k = String(catKey || '');
        if (k === 'alcohol') return 'Alkollü İçecekler';
        if (k === 'soft') return 'Meşrubatlar';
        if (k === 'food') return 'Yiyecekler';
        return 'Meşrubatlar';
    }

    getProductCategoryClass(product) {
        const k = this.getProductCategoryKey(product);
        if (k === 'alcohol') return 'cat-alcohol';
        if (k === 'soft') return 'cat-soft';
        if (k === 'food') return 'cat-food';
        return 'cat-soft';
    }

    /** Masa detayı ürün sırası: 1 alkollü, 2 meşrubat, 3 yiyecek; her grupta alfabetik */
    sortProductsByCategoryThenName(products) {
        const order = { alcohol: 0, soft: 1, food: 2 };
        const arr = Array.isArray(products) ? [...products] : [];
        arr.sort((a, b) => {
            const catA = order[this.getProductCategoryKey(a)] ?? 1;
            const catB = order[this.getProductCategoryKey(b)] ?? 1;
            if (catA !== catB) return catA - catB;
            return String(a?.name || '').localeCompare(String(b?.name || ''), 'tr', { sensitivity: 'base' });
        });
        return arr;
    }

    // --- Product icons (built-in) ---
    renderProductIcon(iconValue) {
        const v = (iconValue == null) ? '' : String(iconValue);
        const key = v.startsWith('ico:') ? v.slice(4) : v;
        const supported = new Set(['tuborg', 'carlsberg', 'kasar', 'ayran', 'cola', 'sigara', 'cay', 'nescafe', 'soda', 'meyveli-soda', 'su', 'viski']);
        if (supported.has(key)) {
            return `<span class="app-ico" data-ico="${key}" aria-hidden="true"></span>`;
        }
        // Backward compat: existing emoji/icon strings
        return `<span class="app-ico-text" aria-hidden="true">${v || '📦'}</span>`;
    }

    sortProductsByStock(products) {
        const arr = Array.isArray(products) ? [...products] : [];
        arr.sort((a, b) => {
            const aTracked = this.tracksStock(a);
            const bTracked = this.tracksStock(b);
            if (aTracked !== bTracked) return aTracked ? -1 : 1; // tracked first
            if (aTracked && bTracked) {
                const as = Number(a?.stock ?? 0);
                const bs = Number(b?.stock ?? 0);
                if (as !== bs) return bs - as; // higher stock first
            }
            // stable-ish secondary sort
            return String(a?.name || '').localeCompare(String(b?.name || ''), 'tr', { sensitivity: 'base' });
        });
        return arr;
    }

    // --- Instant sale qty controls (header, instant table only) ---
    setupInstantSaleQtyControls() {
        if (this._instantQtyBound) return;
        this._instantQtyBound = true;

        const root = document.getElementById('instant-qty-controls');
        const minusBtn = document.getElementById('instant-qty-minus');
        const plusBtn = document.getElementById('instant-qty-plus');
        const input = document.getElementById('instant-qty-input');
        if (!root || !minusBtn || !plusBtn || !input) return;

        const clamp = (n) => {
            const x = Number(n);
            if (!Number.isFinite(x)) return 1;
            return Math.max(1, Math.min(99, Math.round(x)));
        };

        minusBtn.addEventListener('click', () => {
            input.value = String(clamp(Number(input.value || 1) - 1));
        });
        plusBtn.addEventListener('click', () => {
            input.value = String(clamp(Number(input.value || 1) + 1));
        });
        input.addEventListener('input', () => {
            // keep numeric
            input.value = String(clamp(input.value));
        });
    }

    setInstantSaleQtyControlsVisible(visible) {
        const root = document.getElementById('instant-qty-controls');
        if (!root) return;
        root.style.display = visible ? 'inline-flex' : 'none';

        // Toggle a class to allow CSS to optimize header layout only for instant sale
        const titlebar = document.querySelector('.table-modal-titlebar');
        if (titlebar) {
            titlebar.classList.toggle('instant-mode', Boolean(visible));
        }
    }

    setInstantSaleQty(n) {
        const input = document.getElementById('instant-qty-input');
        if (!input) return;
        const x = Number(n);
        input.value = String(Number.isFinite(x) ? Math.max(1, Math.min(99, Math.round(x))) : 1);
    }

    getInstantSaleQty() {
        const input = document.getElementById('instant-qty-input');
        const raw = input ? Number(input.value) : 1;
        if (!Number.isFinite(raw)) return 1;
        return Math.max(1, Math.min(99, Math.round(raw)));
    }

    async openTable(tableId = null) {
        const targetTableId = tableId || this.currentTableId;
        if (!targetTableId) {
            console.error('Masa ID bulunamadı');
            return;
        }

        // CRITICAL: Check if table is already being opened to prevent concurrent opens
        const existingOpening = this._getTableOpening(targetTableId);
        if (existingOpening) {
            debugLog(`Table ${targetTableId} is already being opened, skipping`);
            return;
        }

        // CRITICAL: Stop DB refresh during table opening to prevent race conditions
        const wasPolling = this._pollSyncInterval !== null;
        this._openingTablesCount++;
        if (wasPolling && this._openingTablesCount === 1) {
            this.stopPollSync();
            debugLog(`Stopped DB refresh for table opening (count: ${this._openingTablesCount})`);
        }

        // Optimistic UI: show as opening immediately (avoid perceived lag)
        const optimisticOpenTime = new Date().toISOString();
        this._markTableOpening(targetTableId, optimisticOpenTime);
        // Don't call setTableCardState here - it will interfere with loading state
        // Loading state is already set by the caller, and we'll update after DB write

        let table = await this.db.getTable(targetTableId);
        if (!table) {
            // Clear opening state on error
            this.setTableCardOpening(targetTableId, false);
            this._openingTables.delete(String(targetTableId));
            await this.appAlert('Masa bulunamadı.', 'Hata');
            return;
        }
        
        if (table.type !== 'hourly') {
            // Clear opening state on error
            this.setTableCardOpening(targetTableId, false);
            this._openingTables.delete(String(targetTableId));
            await this.appAlert('Bu masa saatlik ücretli masa değil.', 'Uyarı');
            return;
        }

        if (table.isActive && table.openTime) {
            // Table is already open, just update UI quickly
            this.setTableCardState(table.id, table);
            // Clear opening state if it exists
            this.setTableCardOpening(targetTableId, false);
            this._openingTables.delete(String(targetTableId));
            return;
        }

        // Süreli masada açık oturum varsa (openTime) zaten açık; yoksa açacağız. closeTime tekrar açmayı engellemez.
        if (table.type === 'hourly' && table.openTime) {
            this._openingTablesCount = Math.max(0, this._openingTablesCount - 1);
            if (wasPolling && this._openingTablesCount === 0 && this._closingTablesCount === 0) {
                this.startPollSync();
            }
            this.setTableCardOpening(targetTableId, false);
            this._openingTables.delete(String(targetTableId));
            await this.appAlert('Bu masa zaten açık.', 'Uyarı');
            return;
        }

        try {
            // CRITICAL: Re-read table from DB right before opening to ensure we have latest state
            // This prevents old data from DB refresh from interfering
            const freshTable = await this.db.getTable(targetTableId);
            if (!freshTable) {
                // Decrement opening counter and restart polling
                this._openingTablesCount = Math.max(0, this._openingTablesCount - 1);
                if (wasPolling && this._openingTablesCount === 0 && this._closingTablesCount === 0) {
                    this.startPollSync();
                }
                this.setTableCardOpening(targetTableId, false);
                this._openingTables.delete(String(targetTableId));
                await this.appAlert('Masa bulunamadı.', 'Hata');
                return;
            }
            
            // CRITICAL: If table was recently closed (settling), wait longer and force aggressive cleanup
            const isSettling = this._isTableSettling(targetTableId);
            if (isSettling) {
                debugLog(`Table ${targetTableId} is settling, waiting longer and forcing aggressive cleanup`);
                // Wait longer for closure to fully complete
                await new Promise(resolve => setTimeout(resolve, 800));
                // Clear settling state to allow opening
                this._settlingTables.delete(String(targetTableId));
            }
            
            // CRITICAL: Always check for old data and clean up aggressively
            // Re-read table after waiting (if settling) to get latest state
            let tableToClean = isSettling ? await this.db.getTable(targetTableId) : freshTable;
            if (!tableToClean) {
                tableToClean = freshTable;
            }
            
            const hasOldData = tableToClean.closeTime || !tableToClean.isActive || (tableToClean.openTime && !tableToClean.isActive);
            
            if (hasOldData || isSettling) {
                debugLog(`Table ${targetTableId} has old data (closeTime: ${tableToClean.closeTime}, openTime: ${tableToClean.openTime}, isActive: ${tableToClean.isActive}, isSettling: ${isSettling}), cleaning ALL data before opening`);
                
                // AGGRESSIVE CLEANUP: Clear everything - multiple passes
                for (let attempt = 0; attempt < 3; attempt++) {
                    tableToClean.openTime = null;
                    tableToClean.closeTime = null;
                    tableToClean.hourlyTotal = 0;
                    tableToClean.salesTotal = 0;
                    tableToClean.checkTotal = 0;
                    tableToClean.isActive = false;
                    await this.db.updateTable(tableToClean);
                    
                    // Wait for each cleanup to propagate
                    await new Promise(resolve => setTimeout(resolve, 200));
                    
                    // Re-read to verify cleanup
                    const verifyTable = await this.db.getTable(targetTableId);
                    if (verifyTable) {
                        // Check if cleanup was successful
                        const stillHasOldData = verifyTable.closeTime || verifyTable.openTime || verifyTable.isActive;
                        if (!stillHasOldData) {
                            debugLog(`Table ${targetTableId} cleanup successful on attempt ${attempt + 1}`);
                            table = verifyTable;
                            break;
                        } else {
                            debugLog(`Table ${targetTableId} still has old data after attempt ${attempt + 1}, retrying...`);
                            tableToClean = verifyTable;
                        }
                    } else {
                        table = tableToClean;
                        break;
                    }
                }
                
                // Final verification - if still has old data, force one more time
                const finalTable = await this.db.getTable(targetTableId);
                if (finalTable && (finalTable.closeTime || finalTable.openTime || finalTable.isActive)) {
                    debugLog(`Table ${targetTableId} final cleanup attempt`);
                    finalTable.openTime = null;
                    finalTable.closeTime = null;
                    finalTable.hourlyTotal = 0;
                    finalTable.salesTotal = 0;
                    finalTable.checkTotal = 0;
                    finalTable.isActive = false;
                    await this.db.updateTable(finalTable);
                    table = finalTable;
                } else if (finalTable) {
                    table = finalTable;
                } else {
                    table = tableToClean;
                }
            } else {
                // Use fresh table data
                table = tableToClean;
            }
            
            // If table has legacy single-session hourly data, persist it into hourlySessions
            // so it won't be overwritten when we start a new session.
            table.hourlySessions = Array.isArray(table.hourlySessions) ? table.hourlySessions : [];
            // CRITICAL: Only process legacy data if table actually has both closeTime and openTime
            // After aggressive cleanup, this should not happen, but check anyway
            if (table.closeTime && table.openTime && table.isActive === false) {
                const alreadyRecorded = table.hourlySessions.some(
                    (s) => s && s.openTime === table.openTime && s.closeTime === table.closeTime
                );
                if (!alreadyRecorded) {
                    const hoursUsed = calculateHoursBetween(table.openTime, table.closeTime);
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

            // CRITICAL: Ensure all old data is cleared before opening new session
            // Force reset all values to ensure no old data remains
            table.isActive = true;
            table.openTime = new Date().toISOString();
            table.closeTime = null; // Critical: prevent report from reading previous closeTime with reset totals
            table.hourlyTotal = 0; // Reset hourly total when opening
            table.salesTotal = 0; // CRITICAL: Reset sales total (old unpaid sales should be cleaned up)
            table.checkTotal = 0; // CRITICAL: Reset check total to 0

            // Write to DB in foreground, but do NOT block UI with expensive reloads
            await this.db.updateTable(table);
            
            // Wait a moment for DB write to propagate
            await new Promise(resolve => setTimeout(resolve, 300));
            
            // CRITICAL: Verify the write was successful and table is correctly opened
            const verifyTable = await this.db.getTable(targetTableId);
            if (verifyTable) {
                // If verification shows old data, force update again
                if (verifyTable.closeTime || !verifyTable.isActive || (verifyTable.openTime && verifyTable.openTime !== table.openTime)) {
                    debugLog(`Table ${targetTableId} verification failed, forcing update again`);
                    verifyTable.isActive = true;
                    verifyTable.openTime = new Date().toISOString();
                    verifyTable.closeTime = null;
                    verifyTable.hourlyTotal = 0;
                    verifyTable.salesTotal = 0;
                    verifyTable.checkTotal = 0;
                    await this.db.updateTable(verifyTable);
                    table = verifyTable;
                } else {
                    table = verifyTable;
                }
            }
            
            // Decrement opening counter
            this._openingTablesCount = Math.max(0, this._openingTablesCount - 1);
            
            // Restart DB refresh only when ALL operations (opening + closing) are complete
            if (wasPolling && this._openingTablesCount === 0 && this._closingTablesCount === 0) {
                this.startPollSync();
                debugLog(`Restarted DB refresh after table ${targetTableId} opening`);
            }
            
            // DB confirmed; opening flicker guard no longer needed
            this._openingTables.delete(String(table.id));

            // Don't update UI state here if in opening state
            // The opening state will be cleared in the finally block of the caller, and state will be updated there
            // This prevents the table from appearing closed during the loading animation

            // Süreli masa açıldıktan sonra tables view tam yeniden yüklenmesin: tek kart zaten setTableCardState + refreshSingleTableCard ile güncellendi; full loadTables bazen DB gecikmesiyle kartı "kapalı" okuyup gecikmeli başlat ikonunu geri getiriyor. Sadece daily güncellensin.
            setTimeout(() => {
                const views = [];
                if (this.currentView === 'daily') views.push('daily');
                if (views.length) this.reloadViews(views);
            }, 0);
        } catch (error) {
            console.error('Masayı açarken hata:', error, error?.message, error?.details, error?.hint, error?.code);
            // Clear opening state immediately on error
            this.setTableCardOpening(targetTableId, false);
            this._openingTables.delete(String(targetTableId));
            
            // Revert UI best-effort
            try {
                const fresh = await this.db.getTable(targetTableId);
                if (fresh) this.setTableCardState(fresh.id, fresh);
            } catch (e) {
                // Ignore revert errors
            }
            await this.appAlert('Masayı açarken hata oluştu. Lütfen tekrar deneyin.', 'Hata');
        } finally {
            // Always clear opening state when done (even if no error)
            this.setTableCardOpening(targetTableId, false);
            this._openingTables.delete(String(targetTableId));
        }
    }


    closeAddProductModal() {
        this.closeFormModal('add-product-table-modal');
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
            if (modal.classList.contains('closing')) modal.classList.remove('closing');
            modal.classList.add('active');
            if (modal.classList.contains('modal-bottom-sheet') && window.innerWidth <= 768) {
                this.runBottomSheetOpen(modal);
            } else {
                requestAnimationFrame(() => {
                    requestAnimationFrame(() => {
                        const modalContent = modal.querySelector('.modal-content');
                        if (modalContent) {
                            modalContent.style.transform = 'scale(1)';
                            modalContent.style.opacity = '1';
                        }
                    });
                });
            }
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

        // Card-level loading so the whole tables grid doesn't get blurred
        this.setTableCardLoading(tableId, true);
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
                    icon: product.icon || '📦',
                    category: this.getProductCategoryKey(product),
                    price: product.price,
                    arrivalPrice: product.arrivalPrice || 0,
                    amount: amount
                }],
                sellDateTime: new Date().toISOString(),
                saleTotal: product.price * amount,
                isPaid: isInstant,
                isCredit: false,
                customerId: null,
                paymentTime: isInstant ? new Date().toISOString() : null,
                createdBy: this.currentUser?.id || this.currentUser?.email,
                createdByName: this.currentUser?.email || 'Bilinmeyen',
                createdByRole: this.userRole === 'admin' ? 'Yönetici' : 'Garson'
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
                
                // Important: close via helper so body.table-modal-open is removed (otherwise header stays hidden on mobile)
                this.closeTableModal();
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
                const hoursUsed = calculateHoursUsed(table.openTime);
                table.hourlyTotal = hoursUsed * table.hourlyRate;
            }
            table.checkTotal = table.hourlyTotal + table.salesTotal;
            await this.db.updateTable(table);

            // Modal açık kalsın; sadece satış listesi ve toplam güncellensin (takılma azalsın)
            await this.loadTableSales(tableId);
            const updatedTable = await this.db.getTable(tableId);
            try {
                const unpaid = await this.db.getUnpaidSalesByTable(tableId);
                const salesTotal = (unpaid || []).reduce((sum, s) => sum + (Number(s?.saleTotal) || 0), 0);
                updatedTable.salesTotal = salesTotal;
                if (updatedTable.type === 'hourly' && updatedTable.isActive && updatedTable.openTime) {
                    const hoursUsed = calculateHoursUsed(updatedTable.openTime);
                    updatedTable.hourlyTotal = hoursUsed * (updatedTable.hourlyRate || 0);
                } else {
                    updatedTable.hourlyTotal = updatedTable.hourlyTotal || 0;
                }
                updatedTable.checkTotal = (updatedTable.hourlyTotal || 0) + salesTotal;
            } catch (_) {}
            await this.updateModalTotals(updatedTable);
            if (this.currentTableId === tableId) {
                const payBtn = document.getElementById('pay-table-btn');
                const creditBtn = document.getElementById('credit-table-btn');
                if (payBtn && updatedTable.checkTotal > 0) payBtn.style.display = 'inline-block';
                if (creditBtn && updatedTable.checkTotal > 0) creditBtn.style.display = 'inline-block';
                // Eklenen ürün kartındaki adeti varsayılan 1 yap ve geri bildirim göster
                const card = document.querySelector(`#table-products-grid .product-card-mini[data-product-id="${productId}"]`);
                const qtyInput = card?.querySelector('.table-product-qty-input');
                if (qtyInput) qtyInput.value = '1';
                if (card) {
                    this.showProductCardFeedback(card, amount, product.name);
                }
            }
            // Masalar listesini debounce ile güncelle (arka arkaya eklemede tek seferde)
            if (!this._debouncedLoadTables) this._debouncedLoadTables = debounce(() => this.loadTables(), 400);
            this._debouncedLoadTables();
            if (this.currentView === 'products') this.loadProducts().catch(() => {});
            if (this.currentView === 'daily') this.loadDailyDashboard().catch(() => {});
        } catch (error) {
            console.error('Ürün eklenirken hata:', error);
            await this.appAlert('Ürün eklenirken hata oluştu. Lütfen tekrar deneyin.', 'Hata');
            this.closeAddProductModal();
        } finally {
            this.setTableCardLoading(tableId, false);
        }
    }

    async deleteSaleFromTable(saleId) {
        if (!(await this.appConfirm('Bu satışı silmek istediğinize emin misiniz?', { title: 'Satış Sil', confirmText: 'Sil', cancelText: 'Vazgeç', confirmVariant: 'danger' }))) return;

        try {
            const sale = await this.db.getSale(saleId);
            if (!sale) return;

            const table = await this.db.getTable(sale.tableId);
            if (!table) return;

            // Restore product stock (Oyun ücreti satırında productId null olabilir)
            for (const item of sale.items) {
                if (item.productId == null) continue;
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
                    const hoursUsed = calculateHoursUsed(table.openTime);
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

            // Hemen masa kartını güncelle (loadTables çağrısından önce - geçici kapanma görünmesin)
            const remainingUnpaidSalesAfterUpdate = await this.db.getUnpaidSalesByTable(sale.tableId);
            const computedSalesTotal = remainingUnpaidSalesAfterUpdate.reduce((sum, s) => sum + (Number(s?.saleTotal) || 0), 0);
            let computedHourlyTotal = 0;
            let computedCheckTotal = computedSalesTotal;
            if (table.type === 'hourly' && table.isActive && table.openTime) {
                const hoursUsed = calculateHoursUsed(table.openTime);
                computedHourlyTotal = hoursUsed * (table.hourlyRate || 0);
                computedCheckTotal = computedHourlyTotal + computedSalesTotal;
            }
            const isTableActive = remainingUnpaidSalesAfterUpdate.length > 0 || (table.type === 'hourly' && table.openTime);
            this.setTableCardState(sale.tableId, {
                isActive: isTableActive,
                type: table.type,
                openTime: table.openTime,
                hourlyRate: table.hourlyRate || 0,
                salesTotal: computedSalesTotal,
                checkTotal: computedCheckTotal
            });

            // Reload products list in the modal and refresh modal content
            // Don't use cache here - we need fresh data after deleting a product
            await this.loadTableProducts(sale.tableId, { useCache: false });
            await this.openTableModal(sale.tableId);
            // loadTables'ı debounce ile çağır (kart zaten güncellendi)
            if (!this._debouncedLoadTables) this._debouncedLoadTables = debounce(() => this.loadTables(), 400);
            this._debouncedLoadTables();
            
            // Update products view if it's currently active (to show updated stock)
            if (this.currentView === 'products') {
            await this.loadProducts(true); // Reset pagination
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
            const hoursUsed = calculateHoursUsed(table.openTime);
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
        receiptDateTime.textContent = formatDateTimeWithoutSeconds(now.toISOString());

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
            hoursUsed = calculateHoursUsed(table.openTime);
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
            receiptHTML += `<div class="receipt-item-name">Süre: ${formatHoursToReadable(hoursUsed)}</div>`;
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
        if (modal.classList.contains('closing')) modal.classList.remove('closing');
        modal.classList.add('active');
        if (modal.classList.contains('modal-bottom-sheet') && window.innerWidth <= 768) {
            this.runBottomSheetOpen(modal);
        } else {
            requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                    const modalContent = modal.querySelector('.modal-content');
                    if (modalContent) {
                        modalContent.style.transform = 'scale(1)';
                        modalContent.style.opacity = '1';
                    }
                });
            });
        }
    }

    async processPayment() {
        if (!this.currentTableId) return;

        const tableId = this.currentTableId;
        const table = await this.db.getTable(tableId);
        if (!table) return;

        // Validate table can be closed
        if (table.type === 'hourly' && (!table.isActive || !table.openTime)) {
            debugLog(`Table ${tableId} is already closed (no open session), skipping`);
            return;
        }
        if (table.type !== 'hourly' && !table.isActive) {
            debugLog(`Table ${tableId} is already closed, skipping`);
            return;
        }

        // Store original table state for rollback
        const originalTableState = { ...table };
        
        try {
            // Show loading overlay
            // Show processing message on table card (green background)
            this.showTableCardProcessing(tableId, 'Hesap alınıyor...', 'pay');
            
            // Close modals immediately
            const receiptModal = document.getElementById('receipt-modal');
            if (receiptModal) receiptModal.classList.remove('active');
            this.closeTableModal();

            // Optimistic UI: mark table as closed immediately with all data cleared
            this.setTableCardState(tableId, {
                isActive: false,
                type: table.type,
                openTime: null,
                hourlyRate: table.hourlyRate || 0,
                salesTotal: 0,
                checkTotal: 0
            });
            this.showTableSettlementEffect(tableId, 'Hesap Alındı');

            // Use centralized closure function
            const result = await this._closeTableSafely(tableId, {
                paymentTime: new Date().toISOString(),
                isCredit: false
            });

            if (!result.success) {
                throw new Error(result.error || 'Masa kapatılamadı');
            }

            // CRITICAL: Additional verification after closure
            // Re-read table and force close if it was reopened by realtime updates
            await new Promise(resolve => setTimeout(resolve, 500));
            const postClosureCheck = await this.db.getTable(tableId);
            if (postClosureCheck && (postClosureCheck.isActive || (postClosureCheck.type === 'hourly' && postClosureCheck.openTime))) {
                debugLog(`Post-closure check: Table ${tableId} was reopened, forcing close again`);
                postClosureCheck.isActive = false;
                postClosureCheck.openTime = null;
                postClosureCheck.closeTime = postClosureCheck.closeTime || new Date().toISOString();
                postClosureCheck.salesTotal = 0;
                postClosureCheck.checkTotal = 0;
                if (postClosureCheck.type === 'hourly') {
                    postClosureCheck.hourlyTotal = 0;
                }
                await this.db.updateTable(postClosureCheck);
            }

            // Update UI with final state - ensure table is closed
            const finalTableForUI = await this.db.getTable(tableId);
            if (finalTableForUI) {
                // Force closed state regardless of what DB says
                const closedState = {
                    isActive: false,
                    type: finalTableForUI.type,
                    openTime: null,
                    hourlyRate: finalTableForUI.hourlyRate || 0,
                    salesTotal: 0,
                    checkTotal: 0,
                    hourlyTotal: 0
                };
                this.setTableCardState(tableId, closedState);
                
                // If DB still shows active, force update
                if (finalTableForUI.isActive || (finalTableForUI.type === 'hourly' && finalTableForUI.openTime)) {
                    finalTableForUI.isActive = false;
                    finalTableForUI.openTime = null;
                    finalTableForUI.closeTime = finalTableForUI.closeTime || new Date().toISOString();
                    finalTableForUI.salesTotal = 0;
                    finalTableForUI.checkTotal = 0;
                    if (finalTableForUI.type === 'hourly') {
                        finalTableForUI.hourlyTotal = 0;
                    }
                    await this.db.updateTable(finalTableForUI);
                }
            }

            // Wait for DB operations to complete and realtime updates to propagate
            await new Promise(resolve => setTimeout(resolve, 2000));
            
            // Hide processing overlay
            this.hideTableCardProcessing(tableId);
            
            // Final verification: check table state one more time
            const finalCheck = await this.db.getTable(tableId);
            if (finalCheck && (finalCheck.isActive || (finalCheck.type === 'hourly' && finalCheck.openTime))) {
                console.warn(`Table ${tableId} still shows as active after payment, forcing close`);
                finalCheck.isActive = false;
                finalCheck.openTime = null;
                finalCheck.closeTime = finalCheck.closeTime || new Date().toISOString();
                finalCheck.salesTotal = 0;
                finalCheck.checkTotal = 0;
                if (finalCheck.type === 'hourly') {
                    finalCheck.hourlyTotal = 0;
                }
                await this.db.updateTable(finalCheck);
                this.setTableCardState(tableId, {
                    isActive: false,
                    salesTotal: 0,
                    checkTotal: 0,
                    openTime: null,
                    hourlyTotal: 0
                });
            }
            
            // Background refresh - biraz gecikmeli (DB güncellemesi tamamlansın, kart zaten güncellendi)
            setTimeout(() => {
                const views = ['tables', 'sales'];
                if (this.currentView === 'daily') views.push('daily');
                this.reloadViews(views);
            }, 500);
        } catch (error) {
            console.error('Ödeme işlenirken hata:', error);
            this.hideTableCardProcessing(tableId);
            
            // Rollback: restore original table state
            try {
                const currentTable = await this.db.getTable(tableId);
                if (currentTable) {
                    // Restore original state
                    currentTable.isActive = originalTableState.isActive;
                    currentTable.openTime = originalTableState.openTime;
                    currentTable.salesTotal = originalTableState.salesTotal;
                    currentTable.checkTotal = originalTableState.checkTotal;
                    if (currentTable.type === 'hourly') {
                        currentTable.hourlyTotal = originalTableState.hourlyTotal;
                    }
                    await this.db.updateTable(currentTable);
                    
                    // Update UI to reflect restored state
                    this.setTableCardState(tableId, {
                        isActive: originalTableState.isActive,
                        salesTotal: originalTableState.salesTotal,
                        checkTotal: originalTableState.checkTotal,
                        openTime: originalTableState.openTime,
                        hourlyTotal: originalTableState.hourlyTotal
                    });
                }
            } catch (rollbackError) {
                console.error('Rollback sırasında hata:', rollbackError);
            }
            
            await this.appAlert('Ödeme işlenirken hata oluştu. Lütfen tekrar deneyin.', 'Hata');
            
            // Reload views to ensure consistency
            setTimeout(() => {
                this.reloadViews(['tables', 'sales']);
            }, 100);
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

        if (modal.classList.contains('closing')) modal.classList.remove('closing');
        modal.classList.add('active');
        if (modal.classList.contains('modal-bottom-sheet') && window.innerWidth <= 768) {
            this.runBottomSheetOpen(modal);
        } else {
            requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                    const modalContent = modal.querySelector('.modal-content');
                    if (modalContent) {
                        modalContent.style.transform = 'scale(1)';
                        modalContent.style.opacity = '1';
                    }
                });
            });
        }
    }

    async openCustomerSelectionModalForReceipt() {
        this.closeFormModal('receipt-modal');

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

        if (modal.classList.contains('closing')) modal.classList.remove('closing');
        modal.classList.add('active');
        if (modal.classList.contains('modal-bottom-sheet') && window.innerWidth <= 768) {
            this.runBottomSheetOpen(modal);
        } else {
            requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                    const modalContent = modal.querySelector('.modal-content');
                    if (modalContent) {
                        modalContent.style.transform = 'scale(1)';
                        modalContent.style.opacity = '1';
                    }
                });
            });
        }
    }

    async processCreditTable(selectedCustomerId) {
        if (!this.currentTableId) return;
        this.hapticFeedback('medium');

        const tableId = this.currentTableId;
        const table = await this.db.getTable(tableId);
        if (!table) return;

        // Validate table can be closed
        if (table.type === 'hourly' && (!table.isActive || !table.openTime)) {
            debugLog(`Table ${tableId} is already closed (no open session), skipping`);
            return;
        }
        if (table.type !== 'hourly' && !table.isActive) {
            debugLog(`Table ${tableId} is already closed, skipping`);
            return;
        }

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

        // Calculate final check total BEFORE closing (needed for customer balance)
        const unpaidSales = await this.db.getUnpaidSalesByTable(tableId);
        let finalCheckTotal = 0;
        if (table.type === 'hourly' && table.isActive && table.openTime) {
            const hoursUsed = calculateHoursUsed(table.openTime);
            const hourlyTotal = hoursUsed * table.hourlyRate;
            const salesTotal = unpaidSales.reduce((sum, s) => sum + (Number(s?.saleTotal) || 0), 0);
            finalCheckTotal = hourlyTotal + salesTotal;
        } else {
            finalCheckTotal = unpaidSales.reduce((sum, s) => sum + (Number(s?.saleTotal) || 0), 0);
        }
        
        // Allow credit if there's a check total
        if (finalCheckTotal === 0) {
            await this.appAlert('Bu masa için veresiye yazılacak tutar yok.', 'Uyarı');
            return;
        }

        try {
            // Show loading overlay
            // Show processing message on table card (orange background)
            this.showTableCardProcessing(tableId, 'Veresiye yazılıyor...', 'credit');
            
            // Close modal immediately
            this.closeTableModal();
            
            // Optimistic UI: mark table as closed immediately with all data cleared
            this.setTableCardState(tableId, {
                isActive: false,
                type: table.type,
                openTime: null,
                hourlyRate: table.hourlyRate || 0,
                salesTotal: 0,
                checkTotal: 0
            });
            this.showTableSettlementEffect(tableId, 'Veresiye');

            // Use centralized closure function
            const result = await this._closeTableSafely(tableId, {
                paymentTime: new Date().toISOString(),
                isCredit: true,
                customerId: selectedCustomerId
            });

            if (!result.success) {
                throw new Error(result.error || 'Masa kapatılamadı');
            }

            // Update customer balance (use pre-calculated finalCheckTotal)
            customer.balance = (customer.balance || 0) + finalCheckTotal;
            await this.db.updateCustomer(customer);

            // Update UI with final state - ensure closed state
            const finalState = {
                isActive: false,
                type: result.table?.type || table.type,
                openTime: null,
                hourlyRate: result.table?.hourlyRate || table.hourlyRate || 0,
                salesTotal: 0,
                checkTotal: 0,
                hourlyTotal: 0
            };
            this.setTableCardState(tableId, finalState);

            // Wait for DB operations to complete
            await new Promise(resolve => setTimeout(resolve, 1500));
            
            // Hide processing overlay
            this.hideTableCardProcessing(tableId);
            
            // Final verification: ensure table state is correct
            const finalCheck = await this.db.getTable(tableId);
            if (finalCheck && (finalCheck.isActive || (finalCheck.type === 'hourly' && finalCheck.openTime))) {
                finalCheck.isActive = false;
                finalCheck.openTime = null;
                finalCheck.closeTime = finalCheck.closeTime || new Date().toISOString();
                finalCheck.salesTotal = 0;
                finalCheck.checkTotal = 0;
                if (finalCheck.type === 'hourly') {
                    finalCheck.hourlyTotal = 0;
                }
                await this.db.updateTable(finalCheck);
                this.setTableCardState(tableId, finalState);
            }
            
            // Background refresh - biraz gecikmeli (DB güncellemesi tamamlansın, kart zaten güncellendi)
            setTimeout(() => {
                const views = ['tables', 'customers', 'sales'];
                if (this.currentView === 'daily') views.push('daily');
                this.reloadViews(views);
            }, 500);
        } catch (error) {
            console.error('Veresiye yazılırken hata:', error);
            this.hideTableCardProcessing(tableId);
            await this.appAlert('Veresiye yazılırken hata oluştu. Lütfen tekrar deneyin.', 'Hata');
        }
    }

    // Expenses Management
    // ---------- Giderler ----------
    async loadExpenses() {
        const expenses = await this.db.getAllExpenses();
        const container = document.getElementById('expenses-container');
        
        if (!container) {
            console.error('Expenses container not found');
            return;
        }
        
        // Debug: Log all expenses to see what we're getting
        debugLog('All expenses from DB:', expenses);
        
        // Filter out any invalid expenses (missing required fields)
        // Also handle backward compatibility with different field names
        const validExpenses = expenses.filter(expense => {
            // Check if expense has required fields (try multiple field name variations)
            const hasId = expense.id != null;
            const hasDescription = (expense.description || expense.desc || '').trim() !== '';
            const hasAmount = (expense.amount != null && !isNaN(expense.amount)) || expense.amount === 0;
            const hasDate = expense.expenseDate || expense.expense_date || expense.date;
            
            if (!hasId) {
                debugWarn('Expense missing ID:', expense);
                return false;
            }
            if (!hasDescription) {
                debugWarn('Expense missing description:', expense);
                return false;
            }
            if (!hasAmount && expense.amount !== 0) {
                debugWarn('Expense missing or invalid amount:', expense);
                return false;
            }
            if (!hasDate) {
                debugWarn('Expense missing date:', expense);
                return false;
            }
            return true;
        });
        
        debugLog('Valid expenses after filtering:', validExpenses);
        
        // Sort by date (newest first)
        validExpenses.sort((a, b) => {
            const dateA = new Date(a.expenseDate || a.date || 0);
            const dateB = new Date(b.expenseDate || b.date || 0);
            return dateB - dateA;
        });
        
        if (validExpenses.length === 0) {
            container.innerHTML = this.createAddExpenseCard();
            const addCard = document.getElementById('add-expense-card');
            if (addCard) addCard.onclick = () => this.openExpenseFormModal();
            return;
        }
        
        container.innerHTML = this.createAddExpenseCard() + validExpenses.map(expense => this.createExpenseCard(expense)).join('');
        
        const addCard = document.getElementById('add-expense-card');
        if (addCard) addCard.onclick = () => this.openExpenseFormModal();
        
        // Use event delegation for edit/delete buttons (rebind each time to get fresh expenses array)
        container.removeEventListener('click', this._expensesClickHandler);
        this._expensesClickHandler = (e) => {
            const target = e.target.closest('[id^="edit-expense-"], [id^="delete-expense-"]');
            if (!target) return;
            
            const extractId = (prefix) => {
                if (!target.id.startsWith(prefix)) return null;
                const idPart = target.id.slice(prefix.length);
                return idPart || null;
            };
            
            const editPrefix = 'edit-expense-';
            const deletePrefix = 'delete-expense-';
            
            if (target.id.startsWith(editPrefix)) {
                const id = extractId(editPrefix);
                if (!id) return;
                // Get fresh expenses list
                this.db.getAllExpenses().then(allExpenses => {
                    const expense = allExpenses.find(e => String(e.id) === String(id));
                    if (expense) {
                        this.openExpenseFormModal(expense);
                    }
                }).catch(err => console.error('Error loading expense:', err));
            } else if (target.id.startsWith(deletePrefix)) {
                const id = extractId(deletePrefix);
                if (!id) return;
                this.deleteExpense(id);
            }
        };
        container.addEventListener('click', this._expensesClickHandler);
    }

    createExpenseCard(expense) {
        const categoryIcons = {
            elektrik: '⚡',
            toptanci: '🍺',
            bilardo: '🎱',
            playstation: '🎮',
            tamir: '🔧',
            eleman: '👤',
            kira: '🏠',
            su: '💧',
            internet: '🌐',
            diger: '📋'
        };
        
        const categoryLabels = {
            elektrik: 'Elektrik',
            toptanci: 'Toptancı',
            bilardo: 'Bilardo Giderleri',
            playstation: 'PlayStation Giderleri',
            tamir: 'Tamir Tadilat',
            eleman: 'Eleman Parası',
            kira: 'Kira',
            su: 'Su',
            internet: 'İnternet',
            diger: 'Diğer'
        };
        
        const icon = categoryIcons[expense.category] || '📋';
        const label = categoryLabels[expense.category] || expense.category || 'Diğer';
        // Try multiple date field names for backward compatibility
        const date = expense.expenseDate || expense.expense_date || expense.date || new Date().toISOString().split('T')[0];
        const formattedDate = this.formatDateOnly(date);
        
        // Ensure we have valid data
        const expenseId = expense.id;
        const expenseDescription = expense.description || expense.desc || 'Gider';
        const expenseAmount = expense.amount || 0;
        
        if (!expenseId) {
            debugWarn('Expense missing ID:', expense);
            return '';
        }
        
        return `
            <div class="expense-card">
                <div class="expense-icon">${icon}</div>
                <div class="expense-content">
                    <h3>${expenseDescription}</h3>
                    <div class="expense-details">
                        <span class="expense-category">${label}</span>
                        <span class="expense-date">${formattedDate}</span>
                    </div>
                </div>
                <div class="expense-amount">${Math.round(expenseAmount)} ₺</div>
                <div class="expense-actions">
                    <button class="btn btn-icon" id="edit-expense-${expenseId}" title="Düzenle">✎</button>
                    <button class="btn btn-icon btn-danger" id="delete-expense-${expenseId}" title="Sil">×</button>
                </div>
            </div>
        `;
    }

    createAddExpenseCard() {
        return `
            <div class="expense-card add-card" id="add-expense-card" title="Gider Ekle">
                <div class="expense-icon add-card-icon">＋</div>
                <div class="expense-content">
                    <h3>Gider Ekle</h3>
                    <div class="expense-details">
                        <span class="expense-category add-card-sub">Yeni gider kaydı</span>
                    </div>
                </div>
            </div>
        `;
    }

    openExpenseFormModal(expense = null) {
        const modal = document.getElementById('expense-form-modal');
        const title = document.getElementById('expense-form-modal-title');
        const form = document.getElementById('expense-form');
        
        if (!modal || !title || !form) return;
        
        if (expense) {
            title.textContent = 'Gideri Düzenle';
            document.getElementById('expense-id').value = expense.id;
            document.getElementById('expense-description').value = expense.description || '';
            document.getElementById('expense-amount').value = expense.amount || 0;
            document.getElementById('expense-category').value = expense.category || '';
            document.getElementById('expense-date').value = expense.expenseDate || expense.date || new Date().toISOString().split('T')[0];
        } else {
            title.textContent = 'Gider Ekle';
            form.reset();
            document.getElementById('expense-id').value = '';
            document.getElementById('expense-date').value = new Date().toISOString().split('T')[0];
        }
        
        // iOS-like opening animation
        if (modal.classList.contains('closing')) {
            modal.classList.remove('closing');
        }
        modal.classList.add('active');
        if (modal.classList.contains('modal-bottom-sheet') && window.innerWidth <= 768) {
            this.runBottomSheetOpen(modal);
        } else {
            requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                    const modalContent = modal.querySelector('.modal-content');
                    if (modalContent) {
                        modalContent.style.transform = 'scale(1)';
                        modalContent.style.opacity = '1';
                    }
                });
            });
        }
    }

    async saveExpense() {
        const id = document.getElementById('expense-id').value;
        const description = document.getElementById('expense-description').value.trim();
        const amount = parseFloat(document.getElementById('expense-amount').value) || 0;
        const category = document.getElementById('expense-category').value;
        const expenseDate = document.getElementById('expense-date').value;
        
        if (!description || !category || amount <= 0) {
            await this.appAlert('Lütfen tüm alanları doldurun ve tutar 0\'dan büyük olsun.', 'Uyarı');
            return;
        }
        
        const expenseData = {
            description,
            amount,
            category,
            expenseDate: expenseDate || new Date().toISOString().split('T')[0]
        };
        
        try {
            if (id) {
                expenseData.id = parseInt(id);
                await this.db.updateExpense(expenseData);
            } else {
                await this.db.addExpense(expenseData);
            }
            
            this.closeFormModal('expense-form-modal');
            await this.loadExpenses();
            if (this.currentView === 'daily') {
                await this.loadDailyDashboard();
            }
        } catch (error) {
            console.error('Gider kaydedilirken hata:', error);
            await this.appAlert('Gider kaydedilirken hata oluştu. Lütfen tekrar deneyin.', 'Hata');
        }
    }

    async deleteExpense(id) {
        if (!(await this.appConfirm('Bu gideri silmek istediğinize emin misiniz?', { title: 'Silme Onayı', confirmText: 'Sil', cancelText: 'İptal', confirmVariant: 'danger' }))) return;
        
        try {
            // Ensure id is a number
            const expenseId = typeof id === 'string' ? parseInt(id, 10) : id;
            if (isNaN(expenseId)) {
                await this.appAlert('Geçersiz gider ID\'si.', 'Hata');
                return;
            }
            
            await this.db.deleteExpense(expenseId);
            await this.loadExpenses();
            if (this.currentView === 'daily') {
                await this.loadDailyDashboard();
            }
        } catch (error) {
            console.error('Gider silinirken hata:', error);
            await this.appAlert('Gider silinirken hata oluştu. Lütfen tekrar deneyin.', 'Hata');
        }
    }

    formatDateOnly(dateString) {
        if (!dateString) return '';
        const date = new Date(dateString);
        if (Number.isNaN(date.getTime())) return dateString;
        const day = String(date.getDate()).padStart(2, '0');
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const year = date.getFullYear();
        return `${day}.${month}.${year}`;
    }

    // Products Management with Lazy Loading
    // ---------- Ürünler (liste & form) ----------
    async loadProducts(reset = false) {
        const container = document.getElementById('products-container');
        
        if (!container) {
            console.error('Products container not found');
            return;
        }

        // Reset pagination if needed
        if (reset) {
            this._productsCurrentPage = 0;
            this._productsAllLoaded = false;
            container.innerHTML = '';
            if (this._productsObserver) {
                this._productsObserver.disconnect();
                this._productsObserver = null;
            }
        }

        // Get all products: önce kategoriye göre (alkollü, meşrubat, yiyecek), sonra alfabetik; böylece sıra hep aynı kalır
        if (!this._allProducts || reset) {
            const raw = await this.db.getAllProducts();
            this._allProducts = this.sortProductsByCategoryThenName(raw);
        }

        const products = this._allProducts;
        
        if (products.length === 0) {
            container.innerHTML = this.createAddProductCard();
            const addCard = document.getElementById('add-product-card');
            if (addCard) addCard.onclick = () => this.openProductFormModal();
            return;
        }

        // Calculate pagination
        const startIndex = this._productsCurrentPage * this._productsPageSize;
        const endIndex = Math.min(startIndex + this._productsPageSize, products.length);
        const productsToShow = products.slice(startIndex, endIndex);
        const hasMore = endIndex < products.length;

        // Render products for current page
        const productsHTML = productsToShow.map(product => this.createProductCard(product)).join('');
        container.insertAdjacentHTML('beforeend', productsHTML);

        // Add "Add Product" card only on first page
        if (this._productsCurrentPage === 0) {
            container.insertAdjacentHTML('beforeend', this.createAddProductCard());
        const addCard = document.getElementById('add-product-card');
        if (addCard) addCard.onclick = () => this.openProductFormModal();
        }
        
        // Setup event delegation (only once)
        if (!this._productsDelegationBound) {
            this._productsDelegationBound = true;
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

        // Update pagination state
        this._productsCurrentPage++;
        this._productsAllLoaded = !hasMore;

        // Setup infinite scroll observer if there's more to load
        if (hasMore && !this._productsObserver) {
            this.setupProductsInfiniteScroll();
        } else if (this._productsAllLoaded && this._productsObserver) {
            this._productsObserver.disconnect();
            this._productsObserver = null;
        }
    }

    setupProductsInfiniteScroll() {
        const container = document.getElementById('products-container');
        if (!container) return;

        // Create sentinel element for intersection observer
        let sentinel = container.querySelector('.products-load-more-sentinel');
        if (!sentinel) {
            sentinel = document.createElement('div');
            sentinel.className = 'products-load-more-sentinel';
            sentinel.style.height = '20px';
            sentinel.style.width = '100%';
            container.appendChild(sentinel);
        }

        // Setup Intersection Observer
        this._productsObserver = new IntersectionObserver((entries) => {
            entries.forEach(entry => {
                if (entry.isIntersecting && !this._productsAllLoaded) {
                    this.loadProducts(false); // Load next page
                }
            });
        }, {
            root: null,
            rootMargin: '100px', // Start loading 100px before reaching the sentinel
            threshold: 0.1
        });

        this._productsObserver.observe(sentinel);
    }

    createAddProductCard() {
        return `
            <div class="product-card add-card" id="add-product-card" title="Ürün Ekle">
                <div class="product-card-icon add-card-icon">＋</div>
                <div class="product-card-content">
                    <h3>Ürün Ekle</h3>
                    <div class="product-card-details">
                        <span class="add-card-sub">Yeni ürün</span>
                    </div>
                </div>
            </div>
        `;
    }

    createProductCard(product) {
        const iconHtml = this.renderProductIcon?.(product.icon) || (product.icon || '📦');
        const tracksStock = this.tracksStock(product);
        const stockText = !tracksStock ? '∞' : (product.stock === 0 ? 'Stok Yok' : `${product.stock}`);
        const stockClass = !tracksStock ? 'stock-high' : (product.stock === 0 ? 'stock-out' : (product.stock < 10 ? 'stock-low' : 'stock-high'));

        return `
            <div class="product-card" data-product-id="${product.id}">
                <div class="product-card-icon">${iconHtml}</div>
                <div class="product-card-name">${product.name}</div>
                <div class="product-card-price-stock">
                    <span class="product-card-price">${Math.round(product.price)} ₺</span>
                    <span class="product-card-stock ${stockClass}">Stok: ${stockText}</span>
                </div>
                <div class="product-actions">
                    ${this.isAdmin() ? `
                    <button class="btn btn-primary btn-icon" id="edit-product-${product.id}" title="Düzenle">✎</button>
                    <button class="btn btn-danger btn-icon" id="delete-product-${product.id}" title="Sil">×</button>
                    ` : ''}
                </div>
            </div>
        `;
    }

    async openProductFormModal(product = null) {
        // Only admin can add/edit products
        if (!this.isAdmin()) {
            this.appAlert('Ürün ekleme/düzenleme yetkiniz yok. Lütfen yönetici ile iletişime geçin.', 'Yetki Yok');
            return;
        }
        const modal = document.getElementById('product-modal');
        const title = document.getElementById('product-modal-title');
        const form = document.getElementById('product-form');
        const iconSelect = document.getElementById('product-icon');
        const categorySelect = document.getElementById('product-category');
        
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
            if (product.id != null) {
                try {
                    const fresh = await this.db.getProduct(product.id);
                    if (fresh) product = fresh;
                } catch (_) {}
            }
            title.textContent = 'Ürünü Düzenle';
            const productId = product.id;
            document.getElementById('product-id').value = productId;
            document.getElementById('product-name').value = product.name;
            const priceVal = product.price;
            document.getElementById('product-price').value = priceVal != null && priceVal !== '' ? Number(priceVal) : '';
            document.getElementById('product-arrival-price').value = product.arrivalPrice ?? 0;
            if (iconSelect) iconSelect.value = product.icon || '📦';
            if (categorySelect) categorySelect.value = this.getProductCategoryKey(product);
            
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
            if (iconSelect) iconSelect.value = 'cay';
            if (categorySelect) categorySelect.value = 'soft';
            const trackStockCheckboxElement = document.getElementById('product-track-stock');
            if (trackStockCheckboxElement) trackStockCheckboxElement.checked = true;
            const stockInputGroup = stockLabel.querySelector('.stock-input-group');
            if (stockInputGroup) stockInputGroup.style.display = 'flex';
            stockInput.required = true;
        }
        
        // iOS-like opening animation
        if (modal.classList.contains('closing')) {
            modal.classList.remove('closing');
        }
        modal.classList.add('active');
        if (modal.classList.contains('modal-bottom-sheet') && window.innerWidth <= 768) {
            this.runBottomSheetOpen(modal);
        } else {
            requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                    const modalContent = modal.querySelector('.modal-content');
                    if (modalContent) {
                        modalContent.style.transform = 'scale(1)';
                        modalContent.style.opacity = '1';
                    }
                });
            });
        }
    }

    async saveProduct() {
        const id = document.getElementById('product-id').value;
        const name = document.getElementById('product-name').value;
        const priceRaw = document.getElementById('product-price').value;
        const price = Number(priceRaw);
        const arrivalPrice = parseFloat(document.getElementById('product-arrival-price').value) || 0;
        const icon = (document.getElementById('product-icon')?.value || '📦');
        const category = (document.getElementById('product-category')?.value || 'soft');
        const trackStock = document.getElementById('product-track-stock').checked;
        const stock = trackStock ? parseInt(document.getElementById('product-stock').value, 10) : null;

        if (Number.isNaN(price) || price < 0) {
            await this.appAlert('Lütfen geçerli bir fiyat girin.', 'Uyarı');
            return;
        }

        const productData = {
            name,
            price: price,
            arrivalPrice: Number.isNaN(arrivalPrice) ? 0 : arrivalPrice,
            icon,
            category,
            stock: trackStock && stock != null && !Number.isNaN(stock) ? stock : null,
            trackStock
        };

        try {
            if (id) {
                productData.id = id;
                await this.db.updateProduct(productData);
            } else {
                await this.db.addProduct(productData);
            }
            this.closeFormModal('product-modal');
            this._allProducts = null;
            await this.loadProducts(true);
        } catch (error) {
            console.error('Ürün kaydedilirken hata:', error);
            await this.appAlert('Ürün kaydedilirken hata oluştu. Lütfen tekrar deneyin.', 'Hata');
        }
    }

    async deleteProduct(id) {
        // Only admin can delete products
        if (!this.isAdmin()) {
            this.appAlert('Ürün silme yetkiniz yok. Lütfen yönetici ile iletişime geçin.', 'Yetki Yok');
            return;
        }
        if (!(await this.appConfirm('Bu ürünü silmek istediğinize emin misiniz?', { title: 'Ürün Sil', confirmText: 'Sil', cancelText: 'Vazgeç', confirmVariant: 'danger' }))) return;

        try {
            await this.db.deleteProduct(id);
            await this.loadProducts(true); // Reset pagination
        } catch (error) {
            console.error('Ürün silinirken hata:', error);
            await this.appAlert('Ürün silinirken hata oluştu. Lütfen tekrar deneyin.', 'Hata');
        }
    }

    // Customers Management
    // ---------- Müşteriler ----------
    async loadCustomers(reset = true) {
        try {
            const container = document.getElementById('customers-container');
            
            if (!container) {
                console.error('Customers container not found');
                return;
            }

            // Reset pagination if needed
            if (reset) {
                this._customersCurrentPage = 0;
                this._customersAllData = null;
                container.innerHTML = '';
                if (this._customersObserver) {
                    this._customersObserver.disconnect();
                    this._customersObserver = null;
                }
            }

            // Get all customers
            if (!this._customersAllData || reset) {
                const customers = await this.db.getAllCustomers();
                // Sort customers by balance (debt) in descending order - highest debt first
                this._customersAllData = customers.sort((a, b) => {
                    const balanceA = a.balance || 0;
                    const balanceB = b.balance || 0;
                    return balanceB - balanceA; // Descending order
                });
            }

            const customers = this._customersAllData;
            
            if (customers.length === 0) {
                container.innerHTML = this.createAddCustomerCard();
                const addCard = document.getElementById('add-customer-card');
                if (addCard) addCard.onclick = () => this.openCustomerFormModal();
                return;
            }

            // Calculate pagination
            const startIndex = this._customersCurrentPage * this._customersPageSize;
            const endIndex = Math.min(startIndex + this._customersPageSize, customers.length);
            const customersToShow = customers.slice(startIndex, endIndex);
            const hasMore = endIndex < customers.length;

            // Render customers for current page (async - need to get payment dates)
            const customersHTMLPromises = customersToShow.map(async customer => await this.createCustomerCard(customer));
            const customersHTML = (await Promise.all(customersHTMLPromises)).join('');
            container.insertAdjacentHTML('beforeend', customersHTML);

            // Add "Add Customer" card only on first page
            if (this._customersCurrentPage === 0) {
                container.insertAdjacentHTML('beforeend', this.createAddCustomerCard());
            const addCard = document.getElementById('add-customer-card');
            if (addCard) addCard.onclick = () => this.openCustomerFormModal();
            }
            
            // Add event listeners - card click opens detail modal
            customersToShow.forEach(customer => {
                const card = document.getElementById(`customer-${customer.id}`);
                if (card) {
                    card.addEventListener('click', () => {
                        this.openCustomerDetailModal(customer);
                    });
                }
            });

            // Update pagination state
            this._customersCurrentPage++;
            const allLoaded = !hasMore;

            // Setup infinite scroll observer if there's more to load
            if (hasMore && !this._customersObserver) {
                this.setupCustomersInfiniteScroll();
            } else if (allLoaded && this._customersObserver) {
                this._customersObserver.disconnect();
                this._customersObserver = null;
            }
        } catch (error) {
            console.error('Error loading customers:', error);
            const container = document.getElementById('customers-container');
            if (container) {
                container.innerHTML = '<div class="empty-state"><h3>Müşteriler yüklenirken hata oluştu</h3><p>Lütfen sayfayı yenileyin</p></div>';
            }
        }
    }

    setupCustomersInfiniteScroll() {
        const container = document.getElementById('customers-container');
        if (!container) return;

        // Create sentinel element
        let sentinel = container.querySelector('.customers-load-more-sentinel');
        if (!sentinel) {
            sentinel = document.createElement('div');
            sentinel.className = 'customers-load-more-sentinel';
            sentinel.style.height = '20px';
            sentinel.style.width = '100%';
            container.appendChild(sentinel);
        }

        // Setup Intersection Observer
        this._customersObserver = new IntersectionObserver((entries) => {
            entries.forEach(entry => {
                if (entry.isIntersecting && this._customersAllData && 
                    this._customersCurrentPage * this._customersPageSize < this._customersAllData.length) {
                    this.loadCustomers(false); // Load next page
                }
            });
        }, {
            root: null,
            rootMargin: '200px',
            threshold: 0.1
        });

        this._customersObserver.observe(sentinel);
    }

    createAddCustomerCard() {
        return `
            <div class="customer-card add-card" id="add-customer-card" title="Müşteri Ekle">
                <div class="customer-card-content">
                    <h3>Müşteri Ekle</h3>
                    <div class="customer-card-balance add-card-sub">Yeni müşteri</div>
                </div>
            </div>
        `;
    }

    async createCustomerCard(customer) {
        const balance = customer.balance || 0;
        const balanceText = balance > 0 ? `${Math.round(balance)} ₺` : '0 ₺';

        return `
            <div class="customer-card" id="customer-${customer.id}" data-customer-id="${customer.id}">
                <div class="customer-card-content">
                    <h3>${customer.name}</h3>
                    <div class="customer-card-balance">
                        ${balanceText}
                    </div>
                </div>
            </div>
        `;
    }

    openCustomerCreditAddModal(customer) {
        const modal = document.getElementById('customer-credit-add-modal');
        const idEl = document.getElementById('credit-add-customer-id');
        const nameEl = document.getElementById('credit-add-customer-name');
        const balEl = document.getElementById('credit-add-customer-balance');
        const amountEl = document.getElementById('credit-add-amount');
        if (!modal || !idEl || !nameEl || !balEl || !amountEl) return;

        idEl.value = customer.id;
        nameEl.textContent = customer.name;
        balEl.textContent = `${Math.round(customer.balance || 0)} ₺`;
        amountEl.value = '';

        if (modal.classList.contains('closing')) modal.classList.remove('closing');
        modal.classList.add('active');
        if (modal.classList.contains('modal-bottom-sheet') && window.innerWidth <= 768) {
            this.runBottomSheetOpen(modal);
        } else {
            requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                    const modalContent = modal.querySelector('.modal-content');
                    if (modalContent) {
                        modalContent.style.transform = 'scale(1)';
                        modalContent.style.opacity = '1';
                    }
                });
            });
        }
    }

    updateCustomerCardBalance(customerId, newBalance) {
        const card = document.getElementById(`customer-${customerId}`);
        if (!card) return;
        const balEl = card.querySelector('.customer-card-balance');
        if (!balEl) return;
        const balance = newBalance || 0;
        balEl.textContent = `${Math.round(balance)} ₺`;
        balEl.classList.toggle('balance-negative', balance > 0);
        balEl.classList.toggle('balance-positive', !(balance > 0));
    }

    async processCustomerCreditAdd() {
        const modal = document.getElementById('customer-credit-add-modal');
        const idEl = document.getElementById('credit-add-customer-id');
        const amountEl = document.getElementById('credit-add-amount');
        if (!modal || !idEl || !amountEl) return;

        const customerId = idEl.value;
        const amount = parseFloat(amountEl.value || '0') || 0;
        if (!customerId || amount <= 0) {
            await this.appAlert('Geçerli bir tutar girin.', 'Uyarı');
            return;
        }

        try {
            const customer = await this.db.getCustomer(customerId);
            if (!customer) {
                await this.appAlert('Müşteri bulunamadı.', 'Hata');
                return;
            }

            // Optimistic UI: update balance immediately
            const newBalance = (customer.balance || 0) + amount;
            this.updateCustomerCardBalance(customerId, newBalance);

            this.closeFormModal('customer-credit-add-modal');

            // Persist: update customer balance + record as credit sale so reports reflect it
            customer.balance = newBalance;
            await this.db.updateCustomer(customer);

            const nowIso = new Date().toISOString();
            await this.db.addSale({
                tableId: null,
                customerId,
                items: [],
                sellDateTime: nowIso,
                saleTotal: amount,
                isPaid: true,
                isCredit: true,
                paymentTime: nowIso
            });

            // Refresh customer detail modal if open for this customer (update balance and pay button only)
            const customerDetailModal = document.getElementById('customer-detail-modal');
            if (customerDetailModal && customerDetailModal.classList.contains('active') && this._customerDetailCustomer && String(this._customerDetailCustomer.id) === String(customerId)) {
                this._customerDetailCustomer.balance = newBalance;
                const balanceEl = document.getElementById('customer-detail-balance');
                if (balanceEl) balanceEl.textContent = `${Math.round(newBalance)} ₺`;
                const payBtn = document.getElementById('customer-detail-pay-btn');
                if (payBtn) {
                    payBtn.style.display = newBalance > 0 ? 'inline-flex' : 'none';
                    if (newBalance > 0) {
                        payBtn.onclick = () => {
                            this.closeFormModal('customer-detail-modal');
                            this.openCustomerPaymentModal(this._customerDetailCustomer);
                        };
                    }
                }
            }

            // Background refresh (keep UI consistent across views)
            setTimeout(() => {
                const views = ['customers', 'sales'];
                if (this.currentView === 'daily') views.push('daily');
                this.reloadViews(views);
            }, 0);
        } catch (error) {
            console.error('Veresiye eklenirken hata:', error, error?.message, error?.details, error?.hint, error?.code);
            await this.appAlert('Veresiye eklenirken hata oluştu.', 'Hata');
            // Fallback refresh
            setTimeout(() => this.loadCustomers(), 0);
        }
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
        
        if (modal.classList.contains('closing')) modal.classList.remove('closing');
        modal.classList.add('active');
        if (modal.classList.contains('modal-bottom-sheet') && window.innerWidth <= 768) {
            this.runBottomSheetOpen(modal);
        } else {
            requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                    const modalContent = modal.querySelector('.modal-content');
                    if (modalContent) {
                        modalContent.style.transform = 'scale(1)';
                        modalContent.style.opacity = '1';
                    }
                });
            });
        }
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
            
            this.closeFormModal('customer-modal');
            await this.loadCustomers(true); // Reset pagination
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
            await this.loadCustomers(true); // Reset pagination
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
        // Use whole ₺ amounts to avoid floating point leftovers in UI/validation
        const roundedBalance = Math.round(customer.balance || 0);
        customerBalance.textContent = `${roundedBalance} ₺`;
        customerIdInput.value = customer.id;
        paymentAmount.value = '';
        paymentAmount.max = roundedBalance;
        paymentAmount.min = 1;
        paymentAmount.step = '1';
        
        if (modal.classList.contains('closing')) modal.classList.remove('closing');
        modal.classList.add('active');
        if (modal.classList.contains('modal-bottom-sheet') && window.innerWidth <= 768) {
            this.runBottomSheetOpen(modal);
        } else {
            requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                    const modalContent = modal.querySelector('.modal-content');
                    if (modalContent) {
                        modalContent.style.transform = 'scale(1)';
                        modalContent.style.opacity = '1';
                    }
                });
            });
        }
    }

    async processCustomerPayment() {
        const customerId = document.getElementById('payment-customer-id').value;
        const rawPayment = parseFloat(document.getElementById('payment-amount').value);
        const paymentAmount = Math.round(rawPayment);

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

            const currentBalance = Math.round(customer.balance || 0);
            if (paymentAmount > currentBalance) {
                await this.appAlert(`Ödeme miktarı veresiye bakiyesinden fazla olamaz. Bakiye: ${Math.round(currentBalance)} ₺`, 'Uyarı');
                return;
            }

            // Update customer balance
            customer.balance = Math.max(0, currentBalance - paymentAmount);
            await this.db.updateCustomer(customer);

            // If balance becomes zero, delete all credit sales for this customer
            if (customer.balance === 0) {
                const customerSales = await this.db.getSalesByCustomer(customerId);
                for (const sale of customerSales) {
                    // Only delete credit sales (isCredit = true)
                    if (sale.isCredit) {
                        await this.db.deleteSale(sale.id);
                    }
                }
            }

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
            
            this.closeFormModal('customer-payment-modal');
            
            // Reload customer detail modal if it's open
            const customerDetailModal = document.getElementById('customer-detail-modal');
            if (customerDetailModal && customerDetailModal.classList.contains('active')) {
                const updatedCustomer = await this.db.getCustomer(customerId);
                if (updatedCustomer) {
                    await this.openCustomerDetailModal(updatedCustomer);
                }
            }
            
            await this.loadCustomers(true); // Reset pagination
            
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

            const fullBalance = Math.round(customer.balance || 0);
            if (fullBalance <= 0) {
                await this.appAlert('Veresiye bakiyesi yok', 'Uyarı');
                return;
            }

            // Set payment amount to full balance (rounded)
            document.getElementById('payment-amount').value = String(fullBalance);
            
            // Process payment
            await this.processCustomerPayment();
        } catch (error) {
            console.error('Tamamını ödeme işlenirken hata:', error);
            await this.appAlert('Tamamını ödeme işlenirken hata oluştu. Lütfen tekrar deneyin.', 'Hata');
        }
    }

    async openCustomerDetailModal(customer) {
        const modal = document.getElementById('customer-detail-modal');
        const title = document.getElementById('customer-detail-title');
        const nameEl = document.getElementById('customer-detail-name');
        const balanceEl = document.getElementById('customer-detail-balance');
        const hoursEl = document.getElementById('customer-detail-hours');
        const receiptsEl = document.getElementById('customer-detail-receipts');
        const contentEl = document.getElementById('customer-detail-content');
        
        if (!modal || !title || !nameEl || !balanceEl || !hoursEl || !receiptsEl || !contentEl) return;
        
        this._customerDetailCustomer = customer;
        
        // Set customer info
        title.textContent = `${customer.name} - Detay`;
        nameEl.textContent = customer.name;
        const balance = customer.balance || 0;
        balanceEl.textContent = `${Math.round(balance)} ₺`;
        
        // Get customer sales
        const sales = await this.db.getSalesByCustomer(customer.id);
        
        // Get all tables to check hourly sessions
        const allTables = await this.db.getAllTables();
        
        let totalHours = 0;
        
        // Also check hourly sessions from tables (table closures with customerId)
        allTables.forEach(table => {
            if (table.hourlySessions && Array.isArray(table.hourlySessions)) {
                table.hourlySessions.forEach(session => {
                    if (session.customerId && String(session.customerId) === String(customer.id)) {
                        const hours = typeof session.hoursUsed === 'number' ? session.hoursUsed : parseFloat(session.hoursUsed) || 0;
                        totalHours += hours;
                    }
                });
            }
        });
        
        hoursEl.textContent = `${Math.round(totalHours * 10) / 10} saat`;
        receiptsEl.textContent = `${sales.length} adet`;
        
        // Group sales by date
        const salesByDate = new Map();
        sales.forEach(sale => {
            const saleDate = new Date(sale.sellDateTime || sale.paymentTime || sale.createdAt);
            const dateKey = saleDate.toLocaleDateString('tr-TR', { year: 'numeric', month: '2-digit', day: '2-digit' });
            if (!salesByDate.has(dateKey)) {
                salesByDate.set(dateKey, []);
            }
            salesByDate.get(dateKey).push(sale);
        });
        
        // Sort dates descending
        const sortedDates = Array.from(salesByDate.keys()).sort((a, b) => {
            const dateA = new Date(a.split('.').reverse().join('-'));
            const dateB = new Date(b.split('.').reverse().join('-'));
            return dateB - dateA;
        });
        
        // Build content HTML
        let contentHTML = '';
        
        
        // Add sales by date - Group sales from same table closure into single receipt
        // Filter out dates that have no valid sales (only credit sales, no items, no hourly)
        const validDates = [];
        sortedDates.forEach(dateKey => {
            const dateSales = salesByDate.get(dateKey);
            // Check if there are any valid sales (with items or tableId)
            const hasValidSales = dateSales.some(sale => {
                const hasItems = sale.items && sale.items.length > 0;
                const hasTableId = sale.tableId;
                return hasItems || hasTableId;
            });
            if (hasValidSales) {
                validDates.push(dateKey);
            }
        });
        
        if (validDates.length > 0) {
            contentHTML += '<div><h3 style="margin-bottom: 10px; color: var(--primary-color);">Adisyonlar</h3>';
            validDates.forEach(dateKey => {
                const dateSales = salesByDate.get(dateKey);
                contentHTML += `<div style="margin-bottom: 20px;"><h4 style="margin-bottom: 10px; color: var(--secondary-color);">${dateKey}</h4>`;
                
                // Group sales by tableId and paymentTime (same table closure = same receipt)
                // Sales with same tableId and paymentTime within 2 minutes are from same closure
                const salesByClosure = new Map();
                dateSales.forEach(sale => {
                    const salePaymentTime = sale.paymentTime ? new Date(sale.paymentTime).getTime() : (sale.sellDateTime ? new Date(sale.sellDateTime).getTime() : 0);
                    const tableId = sale.tableId || 'no-table';
                    // Create a key: tableId + rounded paymentTime (to nearest 2 minutes for better grouping)
                    const closureKey = `${tableId}-${Math.floor(salePaymentTime / 120000)}`;
                    
                    if (!salesByClosure.has(closureKey)) {
                        salesByClosure.set(closureKey, []);
                    }
                    salesByClosure.get(closureKey).push(sale);
                });
                
                // Process each closure group as a single receipt (like receipt modal)
                Array.from(salesByClosure.entries()).sort((a, b) => {
                    // Sort by first sale's time
                    const timeA = a[1][0].paymentTime || a[1][0].sellDateTime || a[1][0].createdAt;
                    const timeB = b[1][0].paymentTime || b[1][0].sellDateTime || b[1][0].createdAt;
                    return new Date(timeB) - new Date(timeA);
                }).forEach(([closureKey, closureSales]) => {
                    // Filter out sales with no items and no hourly total (empty sales)
                    const validSales = closureSales.filter(sale => {
                        const hasItems = sale.items && sale.items.length > 0;
                        const hasTableId = sale.tableId;
                        return hasItems || hasTableId;
                    });
                    
                    // Skip if no valid sales in this closure
                    if (validSales.length === 0) {
                        return;
                    }
                    
                    // Get the first valid sale for time and table info
                    const firstSale = validSales[0];
                    const saleDate = new Date(firstSale.sellDateTime || firstSale.paymentTime || firstSale.createdAt);
                    const timeStr = saleDate.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
                    
                    // Find table name from first sale
                    let tableName = firstSale.tableName || null;
                    const tableId = firstSale.tableId;
                    if (tableId && !tableName) {
                        const table = allTables.find(t => String(t.id) === String(tableId));
                        if (table) tableName = table.name;
                    }
                    
                    // Calculate hourly total from table's hourlySessions if any sale has tableId
                    let hourlyTotal = 0;
                    let hourlySessionsInfo = [];
                    if (tableId) {
                        const table = allTables.find(t => String(t.id) === String(tableId));
                        if (table && table.hourlySessions && Array.isArray(table.hourlySessions)) {
                            // Find sessions that match this closure (by paymentTime or closeTime)
                            const closurePaymentTime = firstSale.paymentTime ? new Date(firstSale.paymentTime).toISOString() : null;
                            table.hourlySessions.forEach(session => {
                                if (session.customerId && String(session.customerId) === String(customer.id)) {
                                    const sessionCloseTime = session.closeTime ? new Date(session.closeTime).toISOString() : null;
                                    if (closurePaymentTime && sessionCloseTime) {
                                        // Check if times are close (within 1 minute)
                                        const timeDiff = Math.abs(new Date(closurePaymentTime) - new Date(sessionCloseTime));
                                        if (timeDiff < 60000) { // 1 minute
                                            const hours = typeof session.hoursUsed === 'number' ? session.hoursUsed : parseFloat(session.hoursUsed) || 0;
                                            const rate = session.hourlyRate || table.hourlyRate || 0;
                                            hourlyTotal += hours * rate;
                                            hourlySessionsInfo.push({ hours, rate, tableName: table.name });
                                        }
                                    } else if (!closurePaymentTime && sessionCloseTime) {
                                        // If sale has no paymentTime, try to match by sellDateTime
                                        const closureSellTime = firstSale.sellDateTime ? new Date(firstSale.sellDateTime).toISOString() : null;
                                        if (closureSellTime) {
                                            const timeDiff = Math.abs(new Date(closureSellTime) - new Date(sessionCloseTime));
                                            if (timeDiff < 60000) { // 1 minute
                                                const hours = typeof session.hoursUsed === 'number' ? session.hoursUsed : parseFloat(session.hoursUsed) || 0;
                                                const rate = session.hourlyRate || table.hourlyRate || 0;
                                                hourlyTotal += hours * rate;
                                                hourlySessionsInfo.push({ hours, rate, tableName: table.name });
                                            }
                                        }
                                    }
                                }
                            });
                        }
                    }
                    
                    // Group products by name from ALL valid sales in this closure (like receipt modal)
                    const productGroups = {};
                    validSales.forEach(sale => {
                        if (sale.items && sale.items.length > 0) {
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
                        }
                    });
                    
                    // Calculate product total
                    const productTotal = Object.values(productGroups).reduce((sum, group) => sum + group.total, 0);
                    const finalTotal = hourlyTotal + productTotal;
                    
                    // Skip if no products and no hourly total (empty receipt)
                    if (Object.keys(productGroups).length === 0 && hourlyTotal === 0) {
                        return;
                    }
                    
                    const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
                    const receiptBg = isDark ? 'var(--dark-surface)' : 'white';
                    const receiptBorder = isDark ? 'var(--dark-border)' : '#e0e0e0';
                    const receiptText = isDark ? 'var(--dark-text-primary)' : 'inherit';
                    const receiptTextSecondary = isDark ? 'var(--dark-text-secondary)' : '#7f8c8d';
                    
                    // Build receipt card for this sale (exactly like receipt modal)
                    contentHTML += `
                        <div class="customer-receipt-item" style="padding: 15px; margin-bottom: 20px; background: ${receiptBg}; border-radius: 10px; box-shadow: 0 2px 6px rgba(0,0,0,0.08); border: 1px solid ${receiptBorder}; color: ${receiptText};">
                            <div class="receipt-section" style="margin-bottom: 15px;">
                                <div style="margin-bottom: 10px; font-weight: bold; font-size: 1.1rem; color: ${receiptText};">${timeStr}${tableName ? ` - ${tableName}` : ''}</div>
                            </div>
                    `;
                    
                    // Build receipt HTML using receipt-section and receipt-item classes (exactly like receipt modal)
                    let receiptContentHTML = '';
                    
                    // Hourly section (if exists) - shown first
                    if (hourlyTotal > 0) {
                        const totalHours = hourlySessionsInfo.reduce((sum, s) => sum + s.hours, 0);
                        receiptContentHTML += `<div class="receipt-section">`;
                        receiptContentHTML += `<div class="receipt-section-title">OYUN</div>`;
                        receiptContentHTML += `<div class="receipt-item">`;
                        receiptContentHTML += `<div class="receipt-item-name">Süre: ${formatHoursToReadable(totalHours)}</div>`;
                        receiptContentHTML += `<div class="receipt-item-price">${Math.round(hourlyTotal)} ₺</div>`;
                        receiptContentHTML += `</div>`;
                        receiptContentHTML += `</div>`;
                    }
                    
                    // Products section
                    if (Object.keys(productGroups).length > 0) {
                        receiptContentHTML += `<div class="receipt-section">`;
                        receiptContentHTML += `<div class="receipt-section-title">ÜRÜNLER</div>`;
                        Object.values(productGroups).forEach(group => {
                            receiptContentHTML += `<div class="receipt-item">`;
                            receiptContentHTML += `<div class="receipt-item-name">${group.name} x${group.amount}</div>`;
                            receiptContentHTML += `<div class="receipt-item-price">${Math.round(group.total)} ₺</div>`;
                            receiptContentHTML += `</div>`;
                        });
                        receiptContentHTML += `</div>`;
                    }
                    
                    // Add receipt content to main content
                    if (receiptContentHTML) {
                        contentHTML += receiptContentHTML;
                    }
                    
                    // Total section (like receipt modal)
                    if (hourlyTotal > 0 || Object.keys(productGroups).length > 0) {
                        contentHTML += `<div class="receipt-total">`;
                        if (hourlyTotal > 0 && Object.keys(productGroups).length > 0) {
                            contentHTML += `<div class="receipt-total-row">`;
                            contentHTML += `<span>Oyun Toplam:</span>`;
                            contentHTML += `<span>${Math.round(hourlyTotal)} ₺</span>`;
                            contentHTML += `</div>`;
                            contentHTML += `<div class="receipt-total-row">`;
                            contentHTML += `<span>Ürün Toplam:</span>`;
                            contentHTML += `<span>${Math.round(productTotal)} ₺</span>`;
                            contentHTML += `</div>`;
                        }
                        contentHTML += `<div class="receipt-total-row final">`;
                        contentHTML += `<span>GENEL TOPLAM:</span>`;
                        contentHTML += `<span>${Math.round(finalTotal)} ₺</span>`;
                        contentHTML += `</div>`;
                        contentHTML += `</div>`;
                    }
                    
                    contentHTML += '</div>';
                });
                
                contentHTML += '</div>';
            });
            contentHTML += '</div>';
        } else {
            contentHTML += '<div style="text-align: center; padding: 20px; color: #7f8c8d;">Henüz adisyon yok</div>';
        }
        
        contentEl.innerHTML = contentHTML;
        
        // Setup action buttons
        const payBtn = document.getElementById('customer-detail-pay-btn');
        const addBalanceBtn = document.getElementById('customer-detail-add-balance-btn');
        const editBtn = document.getElementById('customer-detail-edit-btn');
        const deleteBtn = document.getElementById('customer-detail-delete-btn');
        const closeBtn = modal.querySelector('.close');
        
        if (addBalanceBtn) {
            addBalanceBtn.onclick = () => {
                if (this._customerDetailCustomer) this.openCustomerCreditAddModal(this._customerDetailCustomer);
            };
        }
        
        // Show/hide pay button based on balance
        if (payBtn) {
            if (balance > 0) {
                payBtn.style.display = 'inline-flex';
                payBtn.onclick = () => {
                    modal.classList.remove('active');
                    this.openCustomerPaymentModal(customer);
                };
            } else {
                payBtn.style.display = 'none';
            }
        }
        
        if (editBtn) {
            editBtn.onclick = () => {
                modal.classList.remove('active');
                this.openCustomerFormModal(customer);
            };
        }
        
        if (deleteBtn) {
            deleteBtn.onclick = async () => {
                const confirmed = await this.appConfirm('Bu müşteriyi silmek istediğinizden emin misiniz?', { title: 'Müşteri Sil', confirmText: 'Sil', cancelText: 'İptal', confirmVariant: 'danger' });
                if (confirmed) {
                    modal.classList.remove('active');
                    await this.deleteCustomer(customer.id);
                }
            };
        }
        
        if (closeBtn) {
            closeBtn.onclick = () => this.closeFormModal('customer-detail-modal');
        }
        
        if (modal.classList.contains('closing')) modal.classList.remove('closing');
        modal.classList.add('active');
        if (modal.classList.contains('modal-bottom-sheet') && window.innerWidth <= 768) {
            this.runBottomSheetOpen(modal);
        } else {
            requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                    const modalContent = modal.querySelector('.modal-content');
                    if (modalContent) {
                        modalContent.style.transform = 'scale(1)';
                        modalContent.style.opacity = '1';
                    }
                });
            });
        }
    }

    // Sales History
    // ---------- Satış geçmişi ----------
    async loadSales() {
        const tables = await this.db.getAllTables();
        const sales = await this.db.getAllSales();
        
        // Update table filter
        const tableFilter = document.getElementById('sales-table-filter');
        tableFilter.innerHTML = '<option value="">Tüm Masalar</option>' +
            tables.map(t => `<option value="${t.id}">${t.name}</option>`).join('');

        await this.filterSales();
    }

    async filterSales(reset = true) {
        const tableFilter = document.getElementById('sales-table-filter').value || null;
        const statusFilter = document.getElementById('sales-status-filter').value;
        
        // Reset pagination if needed
        if (reset) {
            this._salesCurrentPage = 0;
            this._salesAllData = null;
            const container = document.getElementById('sales-container');
            if (container) container.innerHTML = '';
            if (this._salesObserver) {
                this._salesObserver.disconnect();
                this._salesObserver = null;
            }
        }

        // Get all sales and filter
        if (!this._salesAllData || reset) {
            let allSales = await this.db.getAllSales();
        
        // Filter by table
        if (tableFilter) {
                allSales = allSales.filter(s => String(s.tableId) === String(tableFilter));
        }
        
        // Filter by status
        if (statusFilter === 'paid') {
                allSales = allSales.filter(s => s.isPaid);
        } else if (statusFilter === 'unpaid') {
                allSales = allSales.filter(s => !s.isPaid);
        }
        
        // Sort by date (newest first)
            allSales.sort((a, b) => new Date(b.sellDateTime) - new Date(a.sellDateTime));
            this._salesAllData = allSales;
        }
        
        const sales = this._salesAllData;
        const container = document.getElementById('sales-container');
        
        if (sales.length === 0) {
            container.innerHTML = '<div class="empty-state"><h3>Satış bulunamadı</h3></div>';
            return;
        }

        // Get table names for display
        const tables = await this.db.getAllTables();
        const tableMap = {};
        tables.forEach(t => tableMap[t.id] = t.name);

        // Calculate pagination
        const startIndex = this._salesCurrentPage * this._salesPageSize;
        const endIndex = Math.min(startIndex + this._salesPageSize, sales.length);
        const salesToShow = sales.slice(startIndex, endIndex);
        const hasMore = endIndex < sales.length;

        // Render sales for current page
        const salesHTML = await Promise.all(salesToShow.map(async (sale) => {
            const tableName = sale.tableId ? (tableMap[sale.tableId] || 'Bilinmeyen Masa') : null;
            return await this.createSaleCard(sale, tableName);
        })).then(cards => cards.join(''));

        container.insertAdjacentHTML('beforeend', salesHTML);

        // Update pagination state
        this._salesCurrentPage++;
        const allLoaded = !hasMore;

        // Setup infinite scroll observer if there's more to load
        if (hasMore && !this._salesObserver) {
            this.setupSalesInfiniteScroll();
        } else if (allLoaded && this._salesObserver) {
            this._salesObserver.disconnect();
            this._salesObserver = null;
        }
    }

    setupSalesInfiniteScroll() {
        const container = document.getElementById('sales-container');
        if (!container) return;

        // Create sentinel element
        let sentinel = container.querySelector('.sales-load-more-sentinel');
        if (!sentinel) {
            sentinel = document.createElement('div');
            sentinel.className = 'sales-load-more-sentinel';
            sentinel.style.height = '20px';
            sentinel.style.width = '100%';
            container.appendChild(sentinel);
        }

        // Setup Intersection Observer
        this._salesObserver = new IntersectionObserver((entries) => {
            entries.forEach(entry => {
                if (entry.isIntersecting && this._salesAllData && 
                    this._salesCurrentPage * this._salesPageSize < this._salesAllData.length) {
                    this.filterSales(false); // Load next page
                }
            });
        }, {
            root: null,
            rootMargin: '200px',
            threshold: 0.1
        });

        this._salesObserver.observe(sentinel);
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
        
        // Get user info for display
        let userInfo = '';
        if (sale.createdBy || sale.userId) {
            const userName = sale.createdByName || sale.userName || (sale.createdBy || sale.userId);
            const roleDisplay = sale.createdByRole || 'Kullanıcı';
            userInfo = `<span style="color: #7f8c8d; font-size: 0.85rem;">${roleDisplay}: ${userName}</span>`;
        }

        return `
            <div class="sale-card">
                <div class="sale-card-icon">💰</div>
                <div class="sale-card-content">
                <div class="sale-header">
                        <h3>${tableName || 'Ödeme'}</h3>
                        <div class="sale-header-meta">
                            <span>${formatDateTimeWithoutSeconds(sale.sellDateTime)}</span>
                            ${customerInfo ? `<span style="color: #3498db;">${customerInfo}</span>` : ''}
                            ${userInfo}
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
            const todayStart = this.getTodayStartTime();
            
            // Format dates as YYYY-MM-DD for input type="date"
            const formatDateForInput = (date) => {
                const year = date.getFullYear();
                const month = String(date.getMonth() + 1).padStart(2, '0');
                const day = String(date.getDate()).padStart(2, '0');
                return `${year}-${month}-${day}`;
            };
            
            startDateInput.value = formatDateForInput(todayStart);
            // For "business day" reporting, a single selected day means 08:00 -> next day 08:00
            // so "Today" should be the same date on both inputs.
            endDateInput.value = formatDateForInput(todayStart);
        }
    }

    getReportDateRange() {
        const startDateInput = document.getElementById('report-start-date');
        const endDateInput = document.getElementById('report-end-date');
        
        if (startDateInput && endDateInput && startDateInput.value && endDateInput.value) {
            // Business day range: Start 08:00, End next day 07:59:59.999 (inclusive)
            const startDate = new Date(startDateInput.value + 'T08:00:00');
            const endDate = new Date(endDateInput.value + 'T08:00:00');
            endDate.setDate(endDate.getDate() + 1);
            endDate.setMilliseconds(endDate.getMilliseconds() - 1);
            
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
        
        const todayEnd = new Date(todayStart);
        todayEnd.setDate(todayEnd.getDate() + 1);
        todayEnd.setMilliseconds(todayEnd.getMilliseconds() - 1);
        const effectiveEnd = todayEnd > now ? now : todayEnd;

        return startDate.getTime() === todayStart.getTime() && endDate.getTime() === effectiveEnd.getTime();
    }

    // ---------- Günlük rapor ----------
    async loadDailyDashboard() {
        const { startDate, endDate } = this.getReportDateRange();

        const parseDateSafe = (v) => {
            if (!v) return null;
            const d = new Date(v);
            return Number.isNaN(d.getTime()) ? null : d;
        };

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
                // Skip cancelled sessions - they should not count as income
                if (session.isCancelled) continue;
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

        const hourlyTablesToday = [
            ...Array.from(hourlyAggByTableId.values())
        ];

        // Calculate product sales statistics and profit
        let totalProductIncome = 0;
        let totalProductCost = 0;
        let totalProductsSold = 0;
        let totalCreditGiven = 0; // Total amount given as credit today
        let totalCreditReceived = 0; // Total amount received from customers paying their credit debt
        const productCounts = {};

        periodPaidSales.forEach(sale => {
            // Check if this is a customer payment (credit received)
            // Customer payments have: customerId, tableId === null, isCredit === false, items empty or no items
            const isCustomerPayment = sale.customerId && 
                                     (sale.tableId === null || sale.tableId === undefined) && 
                                     !sale.isCredit && 
                                     (!sale.items || sale.items.length === 0);
            
            if (isCustomerPayment) {
                // This is a customer paying their credit debt
                totalCreditReceived += sale.saleTotal;
            } else {
                // Only count non-credit sales in income (credit sales are not actual income yet)
                if (!sale.isCredit) {
                    totalProductIncome += sale.saleTotal;
                }
                
                // Count credit sales separately
                if (sale.isCredit) {
                    totalCreditGiven += sale.saleTotal;
                }
            }
            
            // Only process items if they exist and it's not a customer payment
            if (sale.items && Array.isArray(sale.items) && sale.items.length > 0) {
                sale.items.forEach(item => {
                    // Skip cancelled items
                    if (item.isCancelled) return;
                    
                    totalProductsSold += item.amount || 0;
                    // Calculate product cost (arrival price * amount) - only for non-credit sales
                    if (!sale.isCredit) {
                        const itemCost = (item.arrivalPrice || 0) * (item.amount || 0);
                        totalProductCost += itemCost;
                    }
                    if (item.name) {
                        if (!productCounts[item.name]) {
                            productCounts[item.name] = 0;
                        }
                        productCounts[item.name] += (item.amount || 0);
                    }
                });
            }
        });

        // Calculate total credit balance (all customers)
        const allCustomers = await this.db.getAllCustomers();
        const totalCreditBalance = allCustomers.reduce((sum, customer) => sum + (customer.balance || 0), 0);

        // Calculate expenses in date range (must be calculated before profit calculations)
        const allExpenses = await this.db.getAllExpenses();
        const periodExpenses = allExpenses.filter(expense => {
            const expenseDate = expense.expenseDate || expense.date;
            if (!expenseDate) return false;
            // Parse expense date and set to start of day for comparison
            const expenseDateObj = new Date(expenseDate);
            expenseDateObj.setHours(0, 0, 0, 0);
            
            // Compare dates (not times) - expense should be included if its date falls within the range
            const startDateOnly = new Date(startDate);
            startDateOnly.setHours(0, 0, 0, 0);
            const endDateOnly = new Date(endDate);
            endDateOnly.setHours(23, 59, 59, 999);
            
            return expenseDateObj >= startDateOnly && expenseDateObj <= endDateOnly;
        });
        const totalExpenses = periodExpenses.reduce((sum, expense) => sum + (expense.amount || 0), 0);

        // Calculate profits (professional accounting)
        const productProfit = totalProductIncome - totalProductCost; // Gross profit from products
        const gameProfit = totalHourlyIncome; // 100% profit from game hours (no cost)
        const grossProfit = productProfit + gameProfit; // Total gross profit (before expenses)
        
        // Total revenue includes product income, hourly income, and credit received (cash inflow)
        const totalRevenue = totalProductIncome + totalHourlyIncome + totalCreditReceived;
        
        // Net profit = Gross profit - Expenses
        const netProfit = grossProfit - totalExpenses;
        
        // Profit margin percentage
        const profitMargin = totalRevenue > 0 ? ((netProfit / totalRevenue) * 100) : 0;
        
        // Net credit (given - received in period)
        const netCredit = totalCreditGiven - totalCreditReceived;
        
        const transactionsCount = periodPaidSales.filter(sale => {
            // Don't count customer payments as transactions (they're credit settlements)
            const isCustomerPayment = sale.customerId && 
                                     (sale.tableId === null || sale.tableId === undefined) && 
                                     !sale.isCredit && 
                                     (!sale.items || sale.items.length === 0);
            return !isCustomerPayment;
        }).length;

        // Calculate monthly income and expenses (for current month)
        const now = new Date();
        const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
        const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);
        
        const monthlySales = allSales.filter(sale => {
            if (!sale.isPaid || sale.isCancelled) return false;
            const paymentDate = sale.paymentTime ? new Date(sale.paymentTime) : new Date(sale.sellDateTime);
            return paymentDate >= monthStart && paymentDate <= monthEnd;
        });
        
        const monthlyIncome = monthlySales
            .filter(sale => !sale.isCredit)
            .reduce((sum, sale) => sum + (sale.saleTotal || 0), 0);
        
        // Add monthly hourly income
        const monthlyHourlyIncome = allTables
            .filter(table => table.type === 'hourly')
            .reduce((sum, table) => {
                const sessions = Array.isArray(table.hourlySessions) ? table.hourlySessions : [];
                return sum + sessions
                    .filter(s => {
                        if (!s.closeTime) return false;
                        const closeDate = new Date(s.closeTime);
                        return closeDate >= monthStart && closeDate <= monthEnd;
                    })
                    .reduce((sSum, s) => sSum + (s.hourlyTotal || 0), 0);
            }, 0);
        
        const totalMonthlyIncome = monthlyIncome + monthlyHourlyIncome;
        
        const monthlyExpenses = allExpenses.filter(expense => {
            const expenseDate = expense.expenseDate || expense.date;
            if (!expenseDate) return false;
            // Parse expense date and set to start of day for comparison
            const expenseDateObj = new Date(expenseDate);
            expenseDateObj.setHours(0, 0, 0, 0);
            
            // Compare dates (not times)
            const monthStartOnly = new Date(monthStart);
            monthStartOnly.setHours(0, 0, 0, 0);
            const monthEndOnly = new Date(monthEnd);
            monthEndOnly.setHours(23, 59, 59, 999);
            
            return expenseDateObj >= monthStartOnly && expenseDateObj <= monthEndOnly;
        }).reduce((sum, expense) => sum + (expense.amount || 0), 0);

        // Update Financial Summary Section
        const totalRevenueEl = document.getElementById('total-revenue');
        if (totalRevenueEl) {
            totalRevenueEl.textContent = `${Math.round(totalRevenue)} ₺`;
        }
        const productIncomeEl = document.getElementById('product-income');
        if (productIncomeEl) {
            productIncomeEl.textContent = `${Math.round(totalProductIncome)} ₺`;
        }
        const hourlyIncomeEl = document.getElementById('hourly-income');
        if (hourlyIncomeEl) {
            hourlyIncomeEl.textContent = `${Math.round(totalHourlyIncome)} ₺`;
        }
        const creditReceivedDisplayEl = document.getElementById('credit-received-display');
        if (creditReceivedDisplayEl) {
            creditReceivedDisplayEl.textContent = `${Math.round(totalCreditReceived)} ₺`;
        }
        const creditReceivedTodayEl = document.getElementById('credit-received-today');
        if (creditReceivedTodayEl) {
            creditReceivedTodayEl.textContent = `${Math.round(totalCreditReceived)} ₺`;
        }

        // Update Cost & Profit Section
        const productCostEl = document.getElementById('product-cost');
        if (productCostEl) {
            productCostEl.textContent = `${Math.round(totalProductCost)} ₺`;
        }
        const totalExpensesEl = document.getElementById('total-expenses');
        if (totalExpensesEl) {
            totalExpensesEl.textContent = `${Math.round(totalExpenses)} ₺`;
        }
        const grossProfitEl = document.getElementById('gross-profit');
        if (grossProfitEl) {
            grossProfitEl.textContent = `${Math.round(grossProfit)} ₺`;
        }
        const netProfitEl = document.getElementById('net-profit');
        if (netProfitEl) {
            netProfitEl.textContent = `${Math.round(netProfit)} ₺`;
            const netProfitCard = netProfitEl.closest('.stat-card');
            if (netProfitCard) {
                netProfitCard.style.background = netProfit >= 0 ? '#d4edda' : '#f8d7da';
                netProfitCard.style.borderColor = netProfit >= 0 ? '#28a745' : '#dc3545';
            }
        }
        const profitMarginEl = document.getElementById('profit-margin');
        if (profitMarginEl) {
            profitMarginEl.textContent = `${profitMargin.toFixed(1)}%`;
            const profitMarginCard = profitMarginEl.closest('.stat-card');
            if (profitMarginCard) {
                profitMarginCard.style.background = profitMargin >= 20 ? '#d4edda' : profitMargin >= 10 ? '#fff3cd' : '#f8d7da';
                profitMarginCard.style.borderColor = profitMargin >= 20 ? '#28a745' : profitMargin >= 10 ? '#ffc107' : '#dc3545';
            }
        }

        // Update Credit Management Section
        const creditGivenEl = document.getElementById('credit-given-today');
        if (creditGivenEl) {
            creditGivenEl.textContent = `${Math.round(totalCreditGiven)} ₺`;
        }
        const netCreditEl = document.getElementById('net-credit');
        if (netCreditEl) {
            netCreditEl.textContent = `${Math.round(netCredit)} ₺`;
            const netCreditCard = netCreditEl.closest('.stat-card');
            if (netCreditCard) {
                netCreditCard.style.background = netCredit <= 0 ? '#d4edda' : '#fff3cd';
                netCreditCard.style.borderColor = netCredit <= 0 ? '#28a745' : '#ffc107';
            }
        }
        const creditBalanceEl = document.getElementById('total-credit-balance');
        if (creditBalanceEl) {
            creditBalanceEl.textContent = `${Math.round(totalCreditBalance)} ₺`;
        }

        // Update Operational Metrics Section
        const productsSoldEl = document.getElementById('products-sold');
        if (productsSoldEl) {
            productsSoldEl.textContent = totalProductsSold;
        }
        const tableHoursEl = document.getElementById('table-hours');
        if (tableHoursEl) {
            tableHoursEl.textContent = formatHoursToReadable(totalTableHours);
        }
        const transactionsCountEl = document.getElementById('transactions-count');
        if (transactionsCountEl) {
            transactionsCountEl.textContent = transactionsCount;
        }
        // Monthly income/expenses removed

        // Debug: Log calculated values
        console.log('Report Calculations:', {
            totalRevenue,
            totalProductIncome,
            totalHourlyIncome,
            totalCreditReceived,
            totalProductCost,
            totalExpenses,
            grossProfit,
            netProfit,
            profitMargin,
            totalCreditGiven,
            netCredit,
            totalCreditBalance,
            totalProductsSold,
            transactionsCount
        });

        // Update charts
        this.updateIncomeChart(totalProductIncome, totalHourlyIncome);
        this.updateProductsChart(productCounts);

        // Update table usage list
        this.updateTableUsageList(hourlyTablesToday);
    }


    // Chart functions removed - keeping only basic reporting

    // ---------- Tema & footer ----------
    initDarkMode() {
        // Check if user has manually set a preference
        const manualPreference = localStorage.getItem('darkMode');
        
        let isDark = false;
        
        if (manualPreference !== null) {
            // User has manually set a preference, use it
            isDark = manualPreference === 'true';
        } else {
            // No manual preference, check system preference
            if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
                isDark = true;
        }
        }
        
        if (isDark) {
            document.documentElement.setAttribute('data-theme', 'dark');
        } else {
            document.documentElement.removeAttribute('data-theme');
        }
        this.updateDarkModeIcon();
        this.updateThemeColor();
        
        // Listen for system theme changes (only if no manual preference)
        if (window.matchMedia && manualPreference === null) {
            window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
                if (localStorage.getItem('darkMode') === null) {
                    // Only auto-update if user hasn't manually set a preference
                    if (e.matches) {
                        document.documentElement.setAttribute('data-theme', 'dark');
                    } else {
                        document.documentElement.removeAttribute('data-theme');
                    }
                    this.updateDarkModeIcon();
                    this.updateThemeColor();
            }
        });
    }
    }

    toggleDarkMode() {
        const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
        if (isDark) {
            document.documentElement.removeAttribute('data-theme');
            localStorage.setItem('darkMode', 'false');
        } else {
            document.documentElement.setAttribute('data-theme', 'dark');
            localStorage.setItem('darkMode', 'true');
        }
        this.updateDarkModeIcon();
        this.updateThemeColor();
        }

    updateThemeColor() {
        const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
        const lightColor = '#ecf0f1';
        const darkColor = '#0E0E0E';
        const themeColor = isDark ? darkColor : lightColor;
        
        // Update all theme-color meta tags
        const metaTags = document.querySelectorAll('meta[name="theme-color"]');
        metaTags.forEach(tag => {
            tag.setAttribute('content', themeColor);
        });
        
        // Update manifest theme_color (requires manifest update, but we can update meta tags)
        // Note: manifest.json is static, but meta tags work for PWA status bar
    }

    updateDarkModeIcon() {
        const icon = document.querySelector('.dark-mode-icon');
        if (!icon) return;
        const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
        icon.textContent = isDark ? '☀️' : '🌙';
    }

    updateIncomeChart(productIncome, hourlyIncome) {
        const canvas = document.getElementById('income-chart');
        if (!canvas) return;

        // Destroy existing chart if it exists
        if (this.incomeChart) {
            this.incomeChart.destroy();
        }

        const ctx = canvas.getContext('2d');
        this.incomeChart = new Chart(ctx, {
            type: 'doughnut',
            data: {
                labels: ['Ürün Geliri', 'Oyun Geliri'],
                datasets: [{
                    data: [productIncome, hourlyIncome],
                    backgroundColor: [
                        'rgba(52, 152, 219, 0.8)',
                        'rgba(46, 204, 113, 0.8)'
                    ],
                    borderColor: [
                        'rgba(52, 152, 219, 1)',
                        'rgba(46, 204, 113, 1)'
                    ],
                    borderWidth: 2
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: true,
                plugins: {
                    legend: {
                        position: 'bottom',
                        labels: {
                            padding: 15,
                            font: {
                                size: 12
                            }
                        }
                    },
                    tooltip: {
                        callbacks: {
                            label: function(context) {
                                const label = context.label || '';
                                const value = context.parsed || 0;
                                const total = context.dataset.data.reduce((a, b) => a + b, 0);
                                const percentage = total > 0 ? ((value / total) * 100).toFixed(1) : 0;
                                return `${label}: ${Math.round(value)} ₺ (${percentage}%)`;
                            }
                        }
                    }
                }
            }
        });
    }

    updateProductsChart(productCounts) {
        const canvas = document.getElementById('products-chart');
        if (!canvas) return;

        const chartCard = canvas.closest('.chart-card');
        if (!chartCard) return;

        // Destroy existing chart if it exists
        if (this.productsChart) {
            this.productsChart.destroy();
            this.productsChart = null;
        }

        // Remove any existing empty state message
        const existingMessage = chartCard.querySelector('.chart-empty-message');
        if (existingMessage) {
            existingMessage.remove();
        }

        // Show canvas
        canvas.style.display = 'block';

        // Sort products by count and get top 10
        const sortedProducts = Object.entries(productCounts)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 10);

        if (sortedProducts.length === 0) {
            // Hide canvas and show message
            canvas.style.display = 'none';
            const emptyMessage = document.createElement('p');
            emptyMessage.className = 'chart-empty-message';
            emptyMessage.style.cssText = 'text-align: center; color: #7f8c8d; padding: 20px; margin: 0;';
            emptyMessage.textContent = 'Seçilen dönemde satılan ürün yok';
            chartCard.appendChild(emptyMessage);
            return;
        }

        const ctx = canvas.getContext('2d');
        this.productsChart = new Chart(ctx, {
            type: 'bar',
            data: {
                labels: sortedProducts.map(p => p[0]),
                datasets: [{
                    label: 'Satılan Miktar',
                    data: sortedProducts.map(p => p[1]),
                    backgroundColor: 'rgba(52, 152, 219, 0.8)',
                    borderColor: 'rgba(52, 152, 219, 1)',
                    borderWidth: 1
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: true,
                indexAxis: 'y',
                plugins: {
                    legend: {
                        display: false
                    },
                    tooltip: {
                        callbacks: {
                            label: function(context) {
                                return `Satılan: ${context.parsed.x} adet`;
                            }
                        }
                    }
                },
                scales: {
                    x: {
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
                    <span>${formatHoursToReadable(table.hours)} ${table.isActive ? '(Aktif)' : ''}</span>
                </div>
                <div class="usage-income">${Math.round(table.income)} ₺</div>
            </div>
        `).join('');
    }

    updateFooter() {
        // Footer removed
    }

    startFooterUpdates() {
        // Footer removed
    }

    async handlePageVisible() {
        // Page is now visible - refresh all data
        try {
            // Reload current view
            if (this.currentView === 'tables') {
                await this.loadTables();
                this.startTableCardPriceUpdates();
            } else if (this.currentView === 'products') {
                await this.loadProducts(true); // Reset pagination
            } else if (this.currentView === 'sales') {
                await this.loadSales();
            } else if (this.currentView === 'customers') {
                await this.loadCustomers(true); // Reset pagination
            } else if (this.currentView === 'daily') {
                await this.loadDailyDashboard();
            }
            
            // If table modal is open, refresh it
            const tableModal = document.getElementById('table-modal');
            if (tableModal && tableModal.classList.contains('active') && this.currentTableId) {
                await this.openTableModal(this.currentTableId);
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

// Modülleri sınıfa ekle (diyaloglar)
Object.assign(MekanApp.prototype, dialogsModule);

// Register Service Worker for PWA (only on HTTP/HTTPS, not file://)
// Service Worker is optional - app works without it
if ('serviceWorker' in navigator && (location.protocol === 'http:' || location.protocol === 'https:')) {
    window.addEventListener('load', () => {
        // Try to register service worker, but don't fail if it doesn't work
        navigator.serviceWorker.register('service-worker.js', { scope: '/' })
            .then((registration) => {
                console.log('ServiceWorker registered successfully');
            })
            .catch((error) => {
                // Silently ignore - app works without service worker
                console.log('ServiceWorker not available (app will work normally)');
            });
    });
}

// Initialize dark mode early (before app loads) for auth screen
function initDarkModeEarly() {
    // Check if user has manually set a preference
    const manualPreference = localStorage.getItem('darkMode');
    
    let isDark = false;
    
    if (manualPreference !== null) {
        // User has manually set a preference, use it
        isDark = manualPreference === 'true';
    } else {
        // No manual preference, check system preference
        if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
            isDark = true;
        }
    }
    
    if (isDark) {
        document.documentElement.setAttribute('data-theme', 'dark');
    } else {
        document.documentElement.removeAttribute('data-theme');
    }
    
    // Update theme-color meta tags early
    const lightColor = '#ecf0f1';
    const darkColor = '#0E0E0E';
    const themeColor = isDark ? darkColor : lightColor;
    const metaTags = document.querySelectorAll('meta[name="theme-color"]');
    metaTags.forEach(tag => {
        tag.setAttribute('content', themeColor);
    });
}

// Initialize dark mode immediately (before DOMContentLoaded)
initDarkModeEarly();

// Bootstrap Supabase + Auth + App
document.addEventListener('DOMContentLoaded', async () => {
    try {
    // Create global supabase client (frontend-safe: anon key only)
        if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
            throw new Error('Supabase configuration missing. Please check env.js');
        }
    window.supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

    // Require login before app boot (RLS will enforce anyway, but this improves UX)
        // Add timeout to prevent infinite waiting
        try {
            await Promise.race([
                ensureSignedIn(window.supabase),
                new Promise((_, reject) => 
                    setTimeout(() => reject(new Error('Giriş işlemi zaman aşımına uğradı. Lütfen internet bağlantınızı kontrol edin.')), 30000)
                )
            ]);
        } catch (authError) {
            console.error('Auth error:', authError);
            // If auth fails, show error but don't prevent app from initializing
            // User can retry login
            const errorMsg = document.createElement('div');
            errorMsg.style.cssText = 'position: fixed; top: 20px; left: 50%; transform: translateX(-50%); background: #e74c3c; color: white; padding: 15px 20px; border-radius: 8px; z-index: 10000; text-align: center; max-width: 90%; box-shadow: 0 4px 6px rgba(0,0,0,0.1);';
            errorMsg.innerHTML = `
                <p style="margin: 0 0 10px 0;">${authError.message || 'Giriş hatası'}</p>
                <button onclick="location.reload()" style="background: white; color: #e74c3c; border: none; padding: 8px 16px; border-radius: 4px; cursor: pointer; font-weight: bold;">
                    Yeniden Dene
                </button>
            `;
            document.body.appendChild(errorMsg);
            // Don't proceed if auth fails - app needs authenticated user
            return;
        }

        // Initialize app with error handling
    window.app = new MekanApp();
    } catch (error) {
        console.error('Uygulama başlatılırken kritik hata:', error);
        // Show user-friendly error message
        const errorMsg = document.createElement('div');
        errorMsg.style.cssText = 'position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); background: #e74c3c; color: white; padding: 20px; border-radius: 8px; z-index: 10000; text-align: center; max-width: 90%;';
        errorMsg.innerHTML = `
            <h2 style="margin: 0 0 10px 0;">Uygulama Başlatılamadı</h2>
            <p style="margin: 0 0 15px 0;">${error.message || 'Bilinmeyen bir hata oluştu'}</p>
            <button onclick="location.reload()" style="background: white; color: #e74c3c; border: none; padding: 10px 20px; border-radius: 4px; cursor: pointer; font-weight: bold;">
                Sayfayı Yenile
            </button>
        `;
        document.body.appendChild(errorMsg);
    }
});
