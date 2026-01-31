// Main Application Logic
// Loaded as a module (see index.html) for Supabase ESM import.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './supabase-config.js';
import { HybridDatabase } from './hybrid-db.js';

// Debug mode: set to false in production
const DEBUG_MODE = false;

// Helper function for debug logging
const debugLog = (...args) => {
    if (DEBUG_MODE) {
        console.log(...args);
    }
};

// Helper function for debug warnings
const debugWarn = (...args) => {
    if (DEBUG_MODE) {
        console.warn(...args);
    }
};

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
    const header = document.getElementById('main-header');
    if (!modal) return;
    // Use flex so modal content is truly centered (block breaks .modal.active layout)
    modal.style.display = show ? 'flex' : 'none';
    if (show) {
        modal.classList.add('active');
        document.body.classList.add('auth-open');
        // Hide header when auth modal is shown
        if (header) header.style.display = 'none';
    } else {
        modal.classList.remove('active');
        document.body.classList.remove('auth-open');
        setAuthError('');
        // Show header when auth modal is closed
        if (header) header.style.display = '';
    }
}

async function ensureSignedIn(supabase) {
    // Add timeout to getSession to prevent hanging
    let session = null;
    try {
        const sessionPromise = supabase.auth.getSession();
        const timeoutPromise = new Promise((_, reject) => 
            setTimeout(() => reject(new Error('Session check timeout')), 10000)
        );
        const { data, error } = await Promise.race([sessionPromise, timeoutPromise]);
    if (error) {
        console.error('Auth session error:', error);
    }
        session = data?.session || null;
    } catch (err) {
        console.error('Error checking session:', err);
        // Continue - will show login modal
        session = null;
    }
    if (session) {
        // Session exists, ensure auth modal is closed and header is shown
        const authModal = document.getElementById('auth-modal');
        if (authModal) {
            authModal.classList.remove('active');
            authModal.style.display = 'none';
        }
        document.body.classList.remove('auth-open');
        const header = document.getElementById('main-header');
        if (header) header.style.display = '';
        return session;
    }

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
        // Hybrid DB: Supabase + IndexedDB cache (instant reads + periodic sync)
        this.db = new HybridDatabase(this.supabase);
        this.currentView = 'tables';
        this.currentTableId = null;
        this.pendingDelayedStartTableId = null;
        this._dialog = null;
        this._dialogResolver = null;
        this._settlingTables = new Map(); // tableId -> expiry timestamp (ms)
        this._openingTables = new Map(); // tableId -> { until: ms, openTime: iso }
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
        this._stockWarningChecked = false; // Track if stock warnings have been checked
        this.init();
    }

    // Haptic feedback helper - provides tactile feedback on mobile devices
    hapticFeedback(type = 'light') {
        if (!navigator.vibrate) return;
        
        const patterns = {
            light: 10,        // Light tap
            medium: 20,        // Medium tap
            heavy: 30,         // Heavy tap
            success: [20, 50, 20],  // Success pattern
            error: [30, 50, 30, 50, 30],  // Error pattern
            warning: [20, 30, 20]  // Warning pattern
        };
        
        const pattern = patterns[type] || patterns.light;
        navigator.vibrate(pattern);
    }

    // Add product to table - no batching, immediate execution
    queueQuickAddToTable(tableId, productId, deltaAmount = 1) {
        if (!tableId || !productId) return;
        const delta = Number(deltaAmount) || 0;
        
        // Handle negative amounts (reduction/cancellation)
        if (delta < 0) {
            // For negative amounts, handle directly
            this.handleProductReduction(tableId, productId, Math.abs(delta));
            return;
        }
        
        // Positive amounts: add immediately, no batching
        this.addProductToTableFromModal(tableId, productId, delta).catch(err => {
            console.error('Error adding product to table:', err);
        });
    }

    async handleProductReduction(tableId, productId, reduceBy) {
        try {
            const unpaidSales = await this.db.getUnpaidSalesByTable(tableId);
            let remaining = reduceBy;
            
            // Sort by date (newest first) to reduce from most recent
            const sortedSales = [...unpaidSales].sort((a, b) => 
                new Date(b.sellDateTime).getTime() - new Date(a.sellDateTime).getTime()
            );
            
            // Find and reduce items, starting from most recent
            for (const sale of sortedSales) {
                if (!sale.items || !Array.isArray(sale.items)) continue;
                // Process items in reverse order (last item first)
                for (let i = sale.items.length - 1; i >= 0; i--) {
                    const item = sale.items[i];
                    if (item.productId == productId && !item.isCancelled && remaining > 0) {
                        const currentAmount = Number(item.amount) || 0;
                        if (currentAmount <= remaining) {
                            // Cancel entire item
                            await this.deleteItemFromSale(sale.id, i, true); // Skip confirm for swipe gesture
                            remaining -= currentAmount;
                        } else {
                            // Reduce item amount
                            item.amount = currentAmount - remaining;
                            
                            // Restore stock
                            const product = await this.db.getProduct(productId);
                            if (product && this.tracksStock(product)) {
                                product.stock += remaining;
                                await this.db.updateProduct(product);
                            }
                            
                            // Recalculate sale total
                            sale.saleTotal = sale.items
                                .filter(item => !item.isCancelled)
                                .reduce((sum, item) => sum + (item.price * item.amount), 0);
                            
                            await this.db.updateSale(sale);
                            remaining = 0;
                        }
                    }
                }
            }
            
            // Refresh table display
            if (this.currentTableId === tableId) {
                await this.loadTableSales(tableId);
                await this.refreshSingleTableCard(tableId);
            }
        } catch (e) {
            console.error('Error reducing product:', e);
        }
    }

    async init() {
        try {
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

        // Run once immediately, then every 3s
        tick();
        this._pollSyncInterval = setInterval(tick, 3000);
    }

    stopPollSync() {
        if (this._pollSyncInterval) {
            clearInterval(this._pollSyncInterval);
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

        // Dark mode toggle
        const darkModeToggle = document.getElementById('dark-mode-toggle');
        if (darkModeToggle) {
            darkModeToggle.addEventListener('click', (e) => {
                e.stopPropagation();
                this.hapticFeedback('medium');
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

        // Instant sale button in header
        const instantSaleBtn = document.getElementById('instant-sale-btn');
        if (instantSaleBtn) {
            instantSaleBtn.addEventListener('click', async () => {
                this.hapticFeedback('light');
                await this.openInstantSaleModal();
            });
        }

        // Table action menu buttons
        const tableActionDeleteBtn = document.getElementById('table-action-delete-btn');
        const tableActionMoveBtn = document.getElementById('table-action-move-btn');
        const tableActionMenuClose = document.getElementById('table-action-menu-close');
        const tableActionMenu = document.getElementById('table-action-menu');
        
        if (tableActionDeleteBtn) {
            tableActionDeleteBtn.addEventListener('click', async () => {
                const tableId = tableActionMenu.dataset.tableId;
                if (tableId) {
                    tableActionMenu.classList.remove('active');
                    await this.deleteTable(tableId);
                }
            });
        }
        
        if (tableActionMoveBtn) {
            tableActionMoveBtn.addEventListener('click', async () => {
                const tableId = tableActionMenu.dataset.tableId;
                if (tableId) {
                    tableActionMenu.classList.remove('active');
                    await this.showTableMoveSelection(tableId);
                }
            });
        }
        
        if (tableActionMenuClose) {
            tableActionMenuClose.addEventListener('click', () => {
                tableActionMenu.classList.remove('active');
            });
        }

        // Table move modal close
        const tableMoveClose = document.getElementById('table-move-close');
        const tableMoveModal = document.getElementById('table-move-modal');
        if (tableMoveClose && tableMoveModal) {
            tableMoveClose.addEventListener('click', () => {
                this.closeTableMoveModal();
            });
            // Close on backdrop click
            tableMoveModal.addEventListener('click', (e) => {
                if (e.target === tableMoveModal) {
                    this.closeTableMoveModal();
                }
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

        // Manual session (report backfill) UI removed

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
                this.hapticFeedback('success');
                this.payTable();
            });
        }

        const creditTableBtn = document.getElementById('credit-table-btn');
        if (creditTableBtn) {
            creditTableBtn.addEventListener('click', () => {
                this.hapticFeedback('success');
                this.creditTable();
            });
        }

        const cancelHourlyBtn = document.getElementById('cancel-hourly-btn');
        if (cancelHourlyBtn) {
            cancelHourlyBtn.addEventListener('click', async (e) => {
                e.preventDefault();
                e.stopPropagation();
                this.hapticFeedback('error');
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

        // Manual credit add (customer)
        const creditAddForm = document.getElementById('customer-credit-add-form');
        if (creditAddForm) {
            creditAddForm.addEventListener('submit', async (e) => {
                e.preventDefault();
                await this.processCustomerCreditAdd();
            });
        }
        const cancelCustomerCreditAddBtn = document.getElementById('cancel-customer-credit-add-btn');
        if (cancelCustomerCreditAddBtn) {
            cancelCustomerCreditAddBtn.addEventListener('click', () => {
                const modal = document.getElementById('customer-credit-add-modal');
                if (modal) modal.classList.remove('active');
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

        // Expense form
        const expenseForm = document.getElementById('expense-form');
        if (expenseForm) {
            expenseForm.addEventListener('submit', (e) => {
                e.preventDefault();
                this.saveExpense();
            });
        }

        // Add expense button - now handled by add-card in loadExpenses()

        // Cancel expense button
        const cancelExpenseBtn = document.getElementById('cancel-expense-btn');
        if (cancelExpenseBtn) {
            cancelExpenseBtn.addEventListener('click', () => {
                const expenseModal = document.getElementById('expense-form-modal');
                if (expenseModal) expenseModal.classList.remove('active');
            });
        }

        // Expense form modal close button
        const expenseModal = document.getElementById('expense-form-modal');
        if (expenseModal) {
            const closeBtn = expenseModal.querySelector('.close');
            if (closeBtn) {
                closeBtn.addEventListener('click', () => {
                    expenseModal.classList.remove('active');
                });
            }
        }

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

    showLoadingOverlay(message = 'İşleniyor...') {
        const overlay = document.getElementById('loading-overlay');
        const messageEl = document.getElementById('loading-message');
        if (overlay) {
            if (messageEl) messageEl.textContent = message;
            overlay.style.display = 'flex';
            // Prevent body scroll
            document.body.style.overflow = 'hidden';
        }
    }

    hideLoadingOverlay() {
        const overlay = document.getElementById('loading-overlay');
        if (overlay) {
            overlay.style.display = 'none';
            // Restore body scroll
            document.body.style.overflow = '';
        }
    }

    async loadInitialData() {
        try {
            // Ensure instant sale table exists (non-blocking)
            this.ensureInstantSaleTable().catch(err => {
                console.error('Error ensuring instant sale table:', err);
                // Non-critical - can be created later
            });
            
            // Load views in parallel with individual error handling
            // This ensures that if one view fails, others can still load
            const viewPromises = [
                this.loadTables().catch(err => {
                    console.error('Error loading tables:', err);
                    return false;
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
            ];
            
            await Promise.allSettled(viewPromises);
            
            // Start auto-update for table cards if we're on the tables view (default view)
            if (this.currentView === 'tables') {
                try {
                this.startTableCardPriceUpdates();
                } catch (err) {
                    console.error('Error starting table card updates:', err);
                    // Non-critical
                }
            }
            
            // Check for low stock warnings (once per session)
            if (!this._stockWarningChecked) {
                this.checkStockWarnings();
                this._stockWarningChecked = true;
            }
        } catch (error) {
            console.error('Error loading initial data:', error, error?.message, error?.details, error?.hint, error?.code);
            // Continue anyway - some data might still load
        }
    }

    async checkStockWarnings() {
        try {
            const products = await this.db.getAllProducts();
            const lowStockProducts = products.filter(p => {
                if (!this.tracksStock(p)) return false;
                return p.stock > 0 && p.stock < 10; // Low stock threshold: less than 10
            });
            
            if (lowStockProducts.length > 0) {
                // Haptic feedback for warning
                this.hapticFeedback('warning');
                
                const productNames = lowStockProducts.map(p => `${p.name} (${p.stock} adet)`).join(', ');
                const message = lowStockProducts.length === 1
                    ? `Düşük stok uyarısı: ${productNames}`
                    : `${lowStockProducts.length} üründe düşük stok var: ${productNames}`;
                
                // Show non-blocking notification (toast-style)
                this.showStockWarning(message, lowStockProducts.length);
            }
        } catch (error) {
            console.error('Stok kontrolü sırasında hata:', error);
        }
    }

    showStockWarning(message, count) {
        // Create toast notification
        const toast = document.createElement('div');
        toast.className = 'stock-warning-toast';
        toast.innerHTML = `
            <div class="stock-warning-content">
                <span class="stock-warning-icon">⚠️</span>
                <span class="stock-warning-text">${message}</span>
            </div>
        `;
        document.body.appendChild(toast);
        
        // Animate in
        setTimeout(() => toast.classList.add('show'), 10);
        
        // Auto-dismiss after 5 seconds
        setTimeout(() => {
            toast.classList.remove('show');
            setTimeout(() => toast.remove(), 300);
        }, 5000);
        
        // Click to dismiss
        toast.addEventListener('click', () => {
            toast.classList.remove('show');
            setTimeout(() => toast.remove(), 300);
        });
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

    async openInstantSaleModal() {
        // Ensure instant sale table exists
        await this.ensureInstantSaleTable();
        
        // Get instant sale table
        const tables = await this.db.getAllTables();
        const instantTable = tables.find(t => t.name === 'ANLIK SATIŞ');
        
        if (!instantTable) {
            await this.appAlert('Anlık satış masası bulunamadı.', 'Hata');
            return;
        }
        
        // Open the table modal
        await this.openTableModal(instantTable.id, { preSync: true });
    }


    async switchView(viewName) {
        // Haptic feedback for view switch
        this.hapticFeedback('light');
        
        this.updateHeaderViewTitle(viewName);

        // Update navigation (compact menu + bottom nav)
        document.querySelectorAll('.nav-btn-compact').forEach(btn => {
            btn.classList.remove('active');
        });
        document
            .querySelectorAll(`.nav-btn-compact[data-view="${viewName}"]`)
            .forEach((btn) => btn.classList.add('active'));

        // Animate view transition
        const currentViewEl = document.querySelector('.view.active');
        const newViewEl = document.getElementById(`${viewName}-view`);
        
        if (currentViewEl && newViewEl && currentViewEl !== newViewEl) {
            // Add fade-out to current view
            currentViewEl.classList.add('view-fade-out');
            await new Promise(resolve => setTimeout(resolve, 150));
            currentViewEl.classList.remove('active', 'view-fade-out');
        } else {
            // No transition needed, just switch
            document.querySelectorAll('.view').forEach(view => {
                view.classList.remove('active');
            });
        }
        
        if (newViewEl) {
            newViewEl.classList.add('view-fade-in', 'active');
            // Remove fade-in class after animation
            setTimeout(() => {
                newViewEl.classList.remove('view-fade-in');
            }, 300);
        }

        this.currentView = viewName;

        // Load data for the view
        if (viewName === 'tables') {
            this.loadTables();
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
            await this.loadProducts();
        } else if (viewName === 'customers') {
            await this.loadCustomers();
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
            sales: 'Satış Geçmişi',
            daily: 'Rapor'
        };
        const label = map[viewName] || 'Masalar';
        el.textContent = `- ${label}`;
    }

    setTablesLoading(isLoading) {
        const container = document.getElementById('tables-container');
        if (!container) return;
        if (isLoading) {
            // Only show the big overlay spinner on cold start / empty state.
            // During small refreshes (e.g. adding a product) we keep the grid interactive and use per-card loading.
            const hasAnyCard = container.querySelector('.table-card');
            if (!hasAnyCard) {
                container.classList.add('is-loading');
                if (container.children.length === 0) {
                    container.innerHTML = this.createTableSkeletonCards(12);
                }
            }
        } else {
            container.classList.remove('is-loading');
        }
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

    // Tables Management
    async loadTables() {
        const container = document.getElementById('tables-container');
        
        if (!container) {
            console.error('Tables container not found');
            return;
        }

        this.setTablesLoading(true);

        let tables = [];
        try {
            tables = await this.db.getAllTables();
            
            if (tables.length === 0) {
                container.innerHTML = this.createAddTableCard();
                const addCard = document.getElementById('add-table-card');
                if (addCard) addCard.onclick = () => this.openTableFormModal();
                return;
            }

        // Filter out instant tables (they won't be shown as cards)
        tables = tables.filter(t => t.type !== 'instant');

        // Sort tables: 1-hourly first, 2-by icon, 3-alphabetically
        tables.sort((a, b) => {
            // 1. Hourly tables first
            if (a.type === 'hourly' && b.type !== 'hourly') return -1;
            if (a.type !== 'hourly' && b.type === 'hourly') return 1;
            
            // 2. Within same type, sort by icon
            const iconA = (a.icon || '').trim();
            const iconB = (b.icon || '').trim();
            if (iconA !== iconB) {
                return iconA.localeCompare(iconB, 'tr', { sensitivity: 'base' });
            }
            
            // 3. Same icon, sort alphabetically by name
            return a.name.localeCompare(b.name, 'tr', { sensitivity: 'base' });
        });

        // Sync each table's status with unpaid sales - but hourly tables must be manually opened
        for (const table of tables) {
            const unpaidSales = await this.db.getUnpaidSalesByTable(table.id);
            // Compute totals from sales to avoid cross-device race conditions on aggregated columns
            const computedSalesTotal = (unpaidSales || []).reduce((sum, s) => sum + (Number(s?.saleTotal) || 0), 0);
            table._computedSalesTotal = computedSalesTotal;

            // Compute check total (hourly tables include time when open)
            // CRITICAL: Don't calculate hourly total if table is closed (has closeTime, no openTime)
            if (table.type === 'hourly' && table.isActive && table.openTime && !table.closeTime) {
                const hoursUsed = this.calculateHoursUsed(table.openTime);
                table._computedHourlyTotal = hoursUsed * (table.hourlyRate || 0);
                table._computedCheckTotal = table._computedHourlyTotal + computedSalesTotal;
            } else {
                table._computedHourlyTotal = 0;
                table._computedCheckTotal = computedSalesTotal;
            }
            let tableUpdated = false;

            // If a table was just settled (paid/credited), avoid "close -> reopen" flicker for a couple seconds
            const isSettling = this._isTableSettling(table.id);
            
            if (unpaidSales.length > 0 && !table.isActive) {
                // Table has products but is not active - activate it only for regular tables
                // Hourly tables must be manually opened via "Open Table" button
                // CRITICAL: Don't activate if table is closed (has closeTime)
                if (!isSettling && table.type !== 'hourly' && !table.closeTime) {
                    table.isActive = true;
                    tableUpdated = true;
                }
            } else if (unpaidSales.length === 0 && table.isActive) {
                // Table has no unpaid sales.
                // CRITICAL: If table is closed (has closeTime), don't keep it active
                // This prevents closed tables from being reopened when loadTables is called
                if (table.type === 'hourly' && table.closeTime && !table.openTime) {
                    // Table was closed - ensure it stays closed
                    table.isActive = false;
                    table.openTime = null;
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
                // For hourly tables: if closed (has closeTime), reset hourlyTotal too (it's stored in hourlySessions)
                if (table.type === 'hourly' && table.closeTime) {
                    // Closed hourly table: reset all totals (history is in hourlySessions)
                    table.salesTotal = 0;
                        table.hourlyTotal = 0;
                    table.checkTotal = 0;
                    table.openTime = null;
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
                // Reload table to get updated data
                const updatedTable = await this.db.getTable(table.id);
                Object.assign(table, updatedTable);
                // Re-attach computed fields after refresh
                table._computedSalesTotal = computedSalesTotal;
                table._computedHourlyTotal = table._computedHourlyTotal || 0;
                table._computedCheckTotal = table._computedCheckTotal || computedSalesTotal;
            }
        }

        // Group tables by category
        const tablesByCategory = {};
        tables.forEach(table => {
            const category = (table.category || '').trim() || 'Kategorisiz';
            if (!tablesByCategory[category]) {
                tablesByCategory[category] = [];
            }
            tablesByCategory[category].push(table);
        });

        // Render tables grouped by category
        let html = '';
        const categories = Object.keys(tablesByCategory).sort((a, b) => {
            if (a === 'Kategorisiz') return 1;
            if (b === 'Kategorisiz') return -1;
            return a.localeCompare(b, 'tr', { sensitivity: 'base' });
        });

        for (const category of categories) {
            if (category !== 'Kategorisiz') {
                html += `<div class="table-category-header"><h3>${category}</h3></div>`;
            }
            const categoryTables = tablesByCategory[category];
            const categoryCards = await Promise.all(categoryTables.map(table => this.createTableCard(table)));
            html += categoryCards.join('');
        }

        html += this.createAddTableCard();
        container.innerHTML = html;

        const addCard = document.getElementById('add-table-card');
        if (addCard) addCard.onclick = () => this.openTableFormModal();
        
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
            
            // Long press (3 seconds) to show action menu (delete/move)
            let pressTimer = null;
            let hasLongPressed = false;
            const longPressDelay = 3000; // 3 seconds
            
            const startLongPress = () => {
                hasLongPressed = false;
                // Don't allow actions on instant sale table
                if (table.type === 'instant') {
                    return;
                }
                pressTimer = setTimeout(async () => {
                    hasLongPressed = true;
                    this.hapticFeedback('medium');
                    await this.showTableActionMenu(table);
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
                    
                    // If table is already open, open modal immediately on single tap (no DB wait)
                    if (table && table.isActive && table.openTime) {
                        clearTimeout(tapTimer);
                        tapCount = 0;
                        this.hapticFeedback('light');
                        this.openTableModal(table.id, { preSync: true });
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
                        // Haptic feedback for table opening
                        this.hapticFeedback('medium');
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
                            
                            // NOW update the card state after message is cleared
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
        }
        } finally {
            this.setTablesLoading(false);
        }
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
        
        // Only update if there are active tables
        const hasActiveTables = tables.some(table => table.isActive);
        if (!hasActiveTables) {
            return;
        }
        
        // Update each table card's price
        for (const table of tables) {
            const card = document.getElementById(`table-${table.id}`);
            if (!card) continue;

            // Calculate current price from unpaid sales (avoid stale aggregated columns when 2 devices add simultaneously)
            // CRITICAL: If table is closed, always show 0 total
            // This ensures cancelled/closed tables show 0 immediately
            const isClosed = table.type === 'hourly' && table.closeTime && !table.openTime;
            const isActive = table.type === 'instant' 
                ? true 
                : (table.type === 'hourly' 
                    ? (table.isActive && table.openTime && !isClosed)
                    : table.isActive);
            
            let displayTotal = 0;
            if (isActive) {
                if (table.type === 'instant') {
                // For instant sale table, show today's paid sales total
                displayTotal = await this.getInstantTableDailyTotal(table.id);
                } else {
                    const unpaid = await this.db.getUnpaidSalesByTable(table.id);
                    const salesTotal = (unpaid || []).reduce((sum, s) => sum + (Number(s?.saleTotal) || 0), 0);
                    if (table.type === 'hourly' && table.isActive && table.openTime) {
                        const hoursUsed = this.calculateHoursUsed(table.openTime);
                        const hourlyTotal = hoursUsed * (table.hourlyRate || 0);
                        displayTotal = hourlyTotal + salesTotal;
                    } else {
                        displayTotal = salesTotal;
                    }
                }
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
        // If user just opened an hourly table, keep it visually open for a couple seconds
        // to avoid "green -> red -> green" flicker while DB/realtime catches up.
        const opening = (table?.type === 'hourly') ? this._getTableOpening(table.id) : null;
        // For hourly tables: if closeTime exists and openTime is null AND table is not active, table is closed
        // BUT: if table is actively opening (isActive: true, openTime exists), ignore closeTime
        // This prevents flicker when table is opened on another device
        const isClosed = table?.type === 'hourly' && table.closeTime && !table.openTime && !table.isActive;
        const effectiveTable = (opening && !isClosed)
            ? { ...table, isActive: true, openTime: opening.openTime || table.openTime }
            : table;

        // Instant sale table is always active
        // For hourly tables: respect closeTime to prevent showing as active when closed
        const isActive = effectiveTable.type === 'instant' 
            ? true 
            : (effectiveTable.type === 'hourly' 
                ? (effectiveTable.isActive && effectiveTable.openTime && !isClosed)
                : effectiveTable.isActive);
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
            const hoursUsed = this.calculateHoursUsed(effectiveTable.openTime);
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

        // Show delayed-start button only when hourly table is CLOSED (not active/open)
        const delayedStartBtn = (effectiveTable.type === 'hourly' && !(effectiveTable.isActive && effectiveTable.openTime))
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

    setTableCardLoading(tableId, message, type = 'info') {
        // type: 'danger' (red), 'success' (green), 'info' (blue)
        const card = this.getTableCardEl(tableId);
        if (!card) return;
        
        // Disable card interactions
        card.style.pointerEvents = 'none';
        card.classList.add('table-card-loading-state');
        card.dataset.loadingType = type;
        card.dataset.loadingMessage = message;
        
        // Create or update loading overlay inside card
        let loadingOverlay = card.querySelector('.table-card-loading-overlay');
        if (!loadingOverlay) {
            loadingOverlay = document.createElement('div');
            loadingOverlay.className = 'table-card-loading-overlay';
            card.appendChild(loadingOverlay);
        }
        
        const messageEl = loadingOverlay.querySelector('.table-card-loading-message');
        if (messageEl) {
            messageEl.textContent = message;
        } else {
            const msg = document.createElement('div');
            msg.className = 'table-card-loading-message';
            msg.textContent = message;
            loadingOverlay.appendChild(msg);
        }
    }

    clearTableCardLoading(tableId) {
        const card = this.getTableCardEl(tableId);
        if (!card) return;
        
        // Re-enable card interactions
        card.style.pointerEvents = '';
        card.classList.remove('table-card-loading-state');
        delete card.dataset.loadingType;
        delete card.dataset.loadingMessage;
        
        // Remove loading overlay
        const loadingOverlay = card.querySelector('.table-card-loading-overlay');
        if (loadingOverlay) {
            loadingOverlay.remove();
        }
    }

    setTableCardState(tableId, { isActive, type = null, openTime = null, hourlyRate = 0, salesTotal = 0, checkTotal = 0 } = {}) {
        const card = this.getTableCardEl(tableId);
        if (!card) return;

        // Classes
        card.classList.toggle('active', Boolean(isActive) || type === 'instant');
        card.classList.toggle('inactive', !Boolean(isActive) && type !== 'instant');

        // Delayed start button: only when hourly table is CLOSED
        const existingDelayBtn = card.querySelector('.table-delay-btn');
        const shouldShowDelay = type === 'hourly' && !(isActive && openTime);
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
            const hoursUsed = this.calculateHoursUsed(openTime);
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
            
            // For hourly tables: closeTime means payment was processed - table MUST be closed
            // For regular tables: closeTime or not active = closed
            const isTableClosed = table.type === 'hourly' 
                ? (table.closeTime || (!table.openTime && !table.isActive))
                : (table.closeTime || !table.isActive);
            
            if (isTableClosed) {
                // Table was cancelled/closed - keep it closed, show 0 total
                // Don't allow realtime updates to reopen it
                // Also ensure DB state matches closed state (defensive programming)
                if (table.isActive || (table.type === 'hourly' && table.openTime && !table.closeTime)) {
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
                }
                
                this.setTableCardState(tableId, {
                    isActive: false,
                    type: table.type,
                    openTime: table.type === 'hourly' ? null : table.openTime,
                    hourlyRate: table.hourlyRate || 0,
                    salesTotal: 0,
                    checkTotal: 0
                });
                return;
            }
            
            const unpaidSales = await this.db.getUnpaidSalesByTable(tableId);
            
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
                    const hoursUsed = this.calculateHoursUsed(table.openTime);
                    const hourlyTotal = hoursUsed * (table.hourlyRate || 0);
                    checkTotal = hourlyTotal + salesTotal;
                }
            } else {
                // CRITICAL: If table is closed (cancelled) and has unpaid sales, clean them up on this device
                // This fixes the issue where cancelled tables still have sales on other devices
                if (unpaidSales.length > 0 && table.closeTime) {
                    // Table was cancelled - clean up unpaid sales on this device
                    debugLog(`Table ${tableId} was cancelled, cleaning up ${unpaidSales.length} unpaid sales on this device`);
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

    _markTableSettling(tableId, ms = 20000) {
        // Increased to 20 seconds to prevent realtime updates from reopening tables
        // during the critical closure period (especially for hourly tables with payment)
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

    async openTableModal(tableId, opts = {}) {
        const { preSync = false } = opts || {};
        // Clear any existing interval
        if (this.hourlyUpdateInterval) {
            clearInterval(this.hourlyUpdateInterval);
            this.hourlyUpdateInterval = null;
        }

        this.currentTableId = tableId;

        // CRITICAL: Clear modal content IMMEDIATELY before opening to prevent old data from showing
        let productsGridEl = document.getElementById('table-products-grid');
        if (productsGridEl) {
            // Clear content and reset attributes (event listeners are on container, not children)
            productsGridEl.innerHTML = '';
            productsGridEl.removeAttribute('data-table-id');
            productsGridEl.removeAttribute('data-events-bound');
        }
        let salesListEl = document.getElementById('table-sales-list');
        if (salesListEl) salesListEl.innerHTML = '';
        let modalTitleEl = document.getElementById('table-modal-title');
        if (modalTitleEl) modalTitleEl.textContent = 'Masa';

        // Open modal shell immediately (avoid perceived lag)
        const tableModalEl = document.getElementById('table-modal');
        if (tableModalEl) tableModalEl.classList.add('active');
        document.body.classList.add('table-modal-open');
        if (modalTitleEl) {
            // Table names are stable; show immediately (avoid "Yükleniyor..." in title)
            const card = this.getTableCardEl?.(tableId);
            const cardName = card?.querySelector?.('h3')?.textContent?.trim?.() || null;
            modalTitleEl.textContent = cardName || modalTitleEl.textContent || 'Masa';
        }

        const modalBodyEl = document.getElementById('table-modal-body');
        // Show loading overlay only if the work is actually slow (avoids spinner flash when using local cache)
        // If products cache exists, don't show loading at all (products are already rendered)
        let loadingTimer = null;
        const hasCachedProducts = this._cachedProducts && this._cachedProducts.length > 0;
        if (modalBodyEl && !hasCachedProducts) {
            loadingTimer = setTimeout(() => {
                modalBodyEl.classList.add('is-loading');
            }, 180);
        }

        // If cache exists, render products immediately (no loading message)
        if (productsGridEl && hasCachedProducts) {
            // Render cached products immediately for instant display
            productsGridEl.dataset.tableId = String(tableId);
            productsGridEl.innerHTML = this._cachedProducts.map(product => this.createTableProductCard(product, tableId)).join('');
            productsGridEl.dataset.tableId = String(tableId);
            // Bind event delegation for cached products (same as fresh products)
            this.setupProductCardEvents(productsGridEl);
        } else if (productsGridEl) {
            productsGridEl.innerHTML = '<div class="empty-state"><p>Ürünler yükleniyor...</p></div>';
        }

        if (salesListEl) salesListEl.innerHTML = '<div class="empty-state"><p>Yükleniyor...</p></div>';

        const footerBtns = [
            document.getElementById('pay-table-btn'),
            document.getElementById('credit-table-btn'),
            document.getElementById('cancel-hourly-btn')
        ].filter(Boolean);
        footerBtns.forEach((b) => { try { b.disabled = true; } catch (e) {} });

        // Track if modal data is fully loaded
        let modalDataReady = false;

        const unlockModal = () => {
            if (loadingTimer) {
                clearTimeout(loadingTimer);
                loadingTimer = null;
            }
            if (modalBodyEl) modalBodyEl.classList.remove('is-loading');
            // Only enable buttons if data is ready AND table is still open
            if (modalDataReady) {
                footerBtns.forEach((b) => { try { b.disabled = false; } catch (e) {} });
            }
        };

        let table = null;
        try {
            // User request: when opening the table detail screen, refresh DB once beforehand.
            // While modal is open we avoid background refreshes.
            if (preSync && typeof this.db?.syncNow === 'function') {
                try {
                    await this.db.syncNow();
                    if (typeof this.db?.syncTablesFull === 'function') {
                        await this.db.syncTablesFull();
                    }
                } catch (_) {}
            }

            table = await this.db.getTable(tableId);
            if (!table) {
                unlockModal();
                await this.appAlert('Masa bulunamadı.', 'Hata');
                this.closeTableModal();
                return;
            }

            // Track current table type for UI behaviors (e.g. instant sale qty)
            this.currentTableType = table.type;

            // Quantity controls removed - using swipe up gesture instead

        // Get all unpaid sales for this table and compute totals from sales (avoid stale table aggregates)
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
            // Regular tables: DO NOT auto-deactivate; empty-but-occupied is a valid state.
            if (table.type === 'hourly' && table.openTime) {
                const hoursUsed = this.calculateHoursUsed(table.openTime);
                table.hourlyTotal = hoursUsed * table.hourlyRate;
                table.checkTotal = table.hourlyTotal + table.salesTotal;
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

        // Total is shown on the green pay button (not in header)
        const payBtnTxt = document.getElementById('pay-table-btn')?.querySelector?.('.btn-txt') || null;
        if (payBtnTxt) payBtnTxt.textContent = `${Math.round(checkTotal || 0)} ₺`;
        
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
            // Use grid so mobile stays single-row (CSS sets the grid template)
            hourlyInfo.style.display = 'grid';
            regularInfo.style.display = 'none';
            
            if (table.isActive && table.openTime) {
                document.getElementById('modal-open-time').textContent = this.formatTimeOnly(table.openTime);
                
                const hoursUsed = this.calculateHoursUsed(table.openTime);
                const hourlyTotal = hoursUsed * table.hourlyRate;
                document.getElementById('modal-hourly-total').textContent = Math.round(hourlyTotal);
                document.getElementById('modal-sales-total').textContent = Math.round(computedSalesTotal);
                
                // Update check total with real-time hourly calculation
                table.checkTotal = hourlyTotal + computedSalesTotal;
                document.getElementById('modal-check-total').textContent = Math.round(table.checkTotal);
                if (payBtnTxt) payBtnTxt.textContent = `${Math.round(table.checkTotal)} ₺`;
                
                // Update hourly total in real-time every minute
                if (this.hourlyUpdateInterval) {
                    clearInterval(this.hourlyUpdateInterval);
                }
                this.hourlyUpdateInterval = setInterval(async () => {
                    const updatedTable = await this.db.getTable(tableId);
                    if (updatedTable && updatedTable.isActive && updatedTable.openTime) {
                        const unpaid = await this.db.getUnpaidSalesByTable(tableId);
                        const salesTotal = (unpaid || []).reduce((sum, s) => sum + (Number(s?.saleTotal) || 0), 0);
                        const hoursUsed = this.calculateHoursUsed(updatedTable.openTime);
                        const hourlyTotal = hoursUsed * updatedTable.hourlyRate;
                        document.getElementById('modal-hourly-total').textContent = Math.round(hourlyTotal);
                        document.getElementById('modal-sales-total').textContent = Math.round(salesTotal);
                        updatedTable.checkTotal = hourlyTotal + salesTotal;
                        document.getElementById('modal-check-total').textContent = Math.round(updatedTable.checkTotal);
                        if (payBtnTxt) payBtnTxt.textContent = `${Math.round(updatedTable.checkTotal)} ₺`;
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
                document.getElementById('modal-sales-total').textContent = Math.round(computedSalesTotal);
                table.checkTotal = computedSalesTotal;
                document.getElementById('modal-check-total').textContent = Math.round(table.checkTotal);
                if (payBtnTxt) payBtnTxt.textContent = `${Math.round(table.checkTotal)} ₺`;
                
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
            // Total moved to header; hide footer info for regular tables to free space.
            regularInfo.style.display = 'none';
            table.checkTotal = computedSalesTotal;
            document.getElementById('modal-check-total-regular').textContent = Math.round(table.checkTotal);
            if (payBtnTxt) payBtnTxt.textContent = `${Math.round(table.checkTotal)} ₺`;
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
        // If cache exists, products are already rendered above, just refresh if needed
        // Otherwise load from cache or DB
        if (!this._cachedProducts || this._cachedProducts.length === 0) {
            await this.loadTableProducts(tableId, { useCache: true });
        } else {
            // Cache exists and products are already rendered, just ensure they're sorted correctly
            // No need to reload - they're already displayed
            debugLog('Products already rendered from cache, skipping reload');
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

        // Check if table is closed (should not show modal for closed tables)
        // For hourly tables: closed if has closeTime, no openTime, and not active
        // For regular/instant tables: NEVER close modal - user can always add products
        // Regular/instant tables don't use closeTime - they're always available for product addition
        const isTableClosed = finalTableCheck.type === 'hourly'
            ? (finalTableCheck.closeTime && !finalTableCheck.openTime && !finalTableCheck.isActive)
            : false; // Regular/instant: never close modal - always allow product addition
        
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
        modalDataReady = true;
        unlockModal();

        // Load sales in the background to keep modal snappy
        Promise.resolve()
            .then(() => this.loadTableSales(tableId))
            .catch((e) => console.error('loadTableSales error:', e));
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
            // Show loading state on table card (not full screen)
            this.setTableCardLoading(tableId, 'İptal ediliyor...', 'danger');
            
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
            this.hideLoadingOverlay();

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
            this.clearTableCardLoading(tableId);
            await this.appAlert('Oyunu iptal ederken hata oluştu. Lütfen tekrar deneyin.', 'Hata');
        }
    }

    // Clean up interval when modal is closed
    closeTableModal() {
        if (this.hourlyUpdateInterval) {
            clearInterval(this.hourlyUpdateInterval);
            this.hourlyUpdateInterval = null;
        }
        
        // Clear modal content immediately to prevent showing old data
        const salesListEl = document.getElementById('table-sales-list');
        if (salesListEl) salesListEl.innerHTML = '';
        
        const productsGridEl = document.getElementById('table-products-grid');
        if (productsGridEl) {
            // Clear content and reset attributes (event listeners are on container, not children)
            productsGridEl.innerHTML = '';
            productsGridEl.removeAttribute('data-table-id');
            productsGridEl.removeAttribute('data-events-bound');
        }
        
        const modalTitleEl = document.getElementById('table-modal-title');
        if (modalTitleEl) modalTitleEl.textContent = 'Masa';
        
        // Quantity controls removed
        
        document.getElementById('table-modal').classList.remove('active');
        document.body.classList.remove('table-modal-open');
        
        // Refresh products cache in background after modal closes
        // This ensures products are up-to-date for the next modal open
        this.refreshProductsCache();
    }

    /**
     * Refresh products cache in the background
     * Called when table modal closes to ensure products are fresh for next open
     */
    async refreshProductsCache() {
        try {
            const products = this.sortProductsByStock(await this.db.getAllProducts());
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
            container.innerHTML = `
                <div class="empty-state">
                    <div class="empty-state-icon">📦</div>
                    <h3>Ürün bulunamadı</h3>
                    <p>Henüz hiç ürün eklenmemiş. Ürün eklemek için ürünler sayfasına gidin.</p>
                </div>
            `;
            return;
        }
            container.dataset.tableId = String(tableId);
        container.innerHTML = products.map(product => this.createTableProductCard(product, tableId)).join('');
            // Bind event delegation with swipe support
            this.setupProductCardEvents(container);
            return; // Early return - no async operation needed
                        } else {
            // Load fresh products from DB
            products = this.sortProductsByStock(await this.db.getAllProducts());
            // Update cache
            this._cachedProducts = products;
            debugLog('Loaded fresh products and updated cache');
        }

        if (products.length === 0) {
            container.innerHTML = `
                <div class="empty-state">
                    <div class="empty-state-icon">📦</div>
                    <h3>Ürün bulunamadı</h3>
                    <p>Henüz hiç ürün eklenmemiş. Ürün eklemek için ürünler sayfasına gidin.</p>
                </div>
            `;
            return;
        }

        // Render square tap-to-add cards (1 item per tap)
        container.dataset.tableId = String(tableId);
        container.innerHTML = products.map(product => this.createTableProductCard(product, tableId)).join('');

        // Bind event delegation with swipe support
        this.setupProductCardEvents(container);
    }

    createTableProductCard(product, tableId) {
        const tracksStock = this.tracksStock(product);
        const isOutOfStock = tracksStock && product.stock === 0;
        const stockText = !tracksStock ? '∞' : (isOutOfStock ? 'Stok Yok' : `${product.stock}`);
        const stockClass = isOutOfStock ? 'stock-out' : (!tracksStock ? 'stock-high' : (product.stock < 10 ? 'stock-low' : 'stock-high'));
        const catClass = this.getProductCategoryClass?.(product) || '';
        const iconHtml = this.renderProductIcon?.(product.icon) || (product.icon || '📦');

        return `
            <div class="product-card-mini ${catClass} ${isOutOfStock ? 'out-of-stock' : ''}" id="table-product-card-${product.id}" data-product-id="${product.id}" title="${product.name}">
                <div class="product-mini-ico-lg" aria-hidden="true">${iconHtml}</div>
                <div class="product-mini-name">${product.name}</div>
                <div class="product-mini-stock ${stockClass}">Stok: ${stockText}</div>
            </div>
        `;
    }

    async loadTableSales(tableId) {
        // Only show unpaid sales (paid sales should not be visible in the table modal)
        const unpaidSales = await this.db.getUnpaidSalesByTable(tableId);
        const container = document.getElementById('table-sales-list');
        
        if (unpaidSales.length === 0) {
            container.innerHTML = `
                <div class="empty-state">
                    <div class="empty-state-icon">🛒</div>
                    <h3>Eklenen ürün yok</h3>
                    <p>Bu masaya henüz ürün eklenmemiş. Üstteki ürünlerden seçerek ekleyebilirsiniz.</p>
                </div>
            `;
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

    setupProductCardEvents(container) {
        // Remove old event listeners if they exist
        // We'll use a data attribute to track if events are bound to this specific container
        if (container.dataset.eventsBound === 'true') {
            // Events already bound to this container, skip
            return;
        }
        container.dataset.eventsBound = 'true';
        
        // Click handler - single tap adds 1 product
        container.addEventListener('click', async (e) => {
            const card = e.target.closest('.product-card-mini');
            if (!card) return;
            if (card.classList.contains('out-of-stock')) return;
            
            const cardId = card.getAttribute('data-product-id');
            const tid = container.getAttribute('data-table-id');
            if (!cardId || !tid) return;
            
            // Single tap = 1 item
            this.queueQuickAddToTable(tid, cardId, 1);
        });
    }

    async getProductQuantityInTable(tableId, productId) {
        try {
            const unpaidSales = await this.db.getUnpaidSalesByTable(tableId);
            let totalQty = 0;
            
            for (const sale of unpaidSales) {
                if (!sale.items || !Array.isArray(sale.items)) continue;
                for (const item of sale.items) {
                    if (item.productId == productId && !item.isCancelled) {
                        totalQty += (Number(item.amount) || 0);
                    }
                }
            }
            
            return totalQty;
        } catch (e) {
            console.error('Error getting product quantity:', e);
            return 0;
        }
    }

    async cancelLastProductFromTable(tableId, productId) {
        try {
            const unpaidSales = await this.db.getUnpaidSalesByTable(tableId);
            
            // Find the most recent sale item with this product
            let targetSale = null;
            let targetItemIndex = -1;
            let latestTs = 0;
            
            for (const sale of unpaidSales) {
                if (!sale.items || !Array.isArray(sale.items)) continue;
                for (let i = 0; i < sale.items.length; i++) {
                    const item = sale.items[i];
                    if (item.productId == productId && !item.isCancelled) {
                        const saleTs = new Date(sale.sellDateTime).getTime();
                        if (saleTs > latestTs) {
                            latestTs = saleTs;
                            targetSale = sale;
                            targetItemIndex = i;
                        }
                    }
                }
            }
            
            if (targetSale && targetItemIndex >= 0) {
                await this.deleteItemFromSale(targetSale.id, targetItemIndex, true); // Skip confirm for swipe gesture
            }
        } catch (e) {
            console.error('Error canceling product:', e);
        }
    }

    async showTableActionMenu(table) {
        const menu = document.getElementById('table-action-menu');
        const title = document.getElementById('table-action-menu-title');
        if (menu && title) {
            title.textContent = `${table.name} - İşlemler`;
            menu.dataset.tableId = table.id;
            menu.classList.add('active');
        }
    }

    async deleteTable(tableId) {
        const table = await this.db.getTable(tableId);
        if (!table) return;
        
        if (await this.appConfirm(`"${table.name}" masasını silmek istediğinize emin misiniz?`, { title: 'Masa Sil', confirmText: 'Sil', cancelText: 'Vazgeç', confirmVariant: 'danger' })) {
            try {
                await this.db.deleteTable(tableId);
                await this.loadTables();
                if (this.currentView === 'daily') {
                    await this.loadDailyDashboard();
                }
            } catch (error) {
                console.error('Masa silinirken hata:', error);
                await this.appAlert('Masa silinirken hata oluştu. Lütfen tekrar deneyin.', 'Hata');
            }
        }
    }

    async createTableCardForMove(table) {
        // Create a simplified table card for move selection
        const icon = table.icon || (table.type === 'hourly' ? '🎱' : '🪑');
        const isActive = table.isActive && (table.type !== 'hourly' || table.openTime);
        const statusClass = isActive ? 'active' : '';
        
        // Calculate display total
        let displayTotal = 0;
        if (isActive) {
            const unpaidSales = await this.db.getUnpaidSalesByTable(table.id);
            const salesTotal = (unpaidSales || []).reduce((sum, s) => sum + (Number(s?.saleTotal) || 0), 0);
            if (table.type === 'hourly' && table.isActive && table.openTime) {
                const hoursUsed = this.calculateHoursUsed(table.openTime);
                const hourlyTotal = hoursUsed * (table.hourlyRate || 0);
                displayTotal = hourlyTotal + salesTotal;
            } else {
                displayTotal = salesTotal;
            }
        }
        
        return `
            <div class="table-card ${statusClass}" id="table-move-target-${table.id}">
                <div class="table-icon">${icon}</div>
                <h3>${table.name}</h3>
                <div class="table-price">${Math.round(displayTotal)} ₺</div>
            </div>
        `;
    }

    async showTableMoveSelection(sourceTableId) {
        const sourceTable = await this.db.getTable(sourceTableId);
        if (!sourceTable) return;

        const modal = document.getElementById('table-move-modal');
        const messageText = document.getElementById('table-move-message-text');
        const grid = document.getElementById('table-move-grid');
        
        if (!modal || !messageText || !grid) return;

        // Blur source table
        const sourceCard = document.getElementById(`table-${sourceTableId}`);
        if (sourceCard) {
            sourceCard.classList.add('table-moving-source');
        }
        
        // Enable move mode
        document.body.classList.add('table-move-mode');
        messageText.textContent = `"${sourceTable.name}" masasını taşımak için hedef masayı seçin:`;
        
        // Load all tables except source and instant
        const allTables = await this.db.getAllTables();
        const availableTables = allTables.filter(t => 
            t.id !== sourceTableId && t.type !== 'instant'
        );
        
        if (availableTables.length === 0) {
            await this.appAlert('Taşınacak başka masa bulunamadı.', 'Uyarı');
            if (sourceCard) sourceCard.classList.remove('table-moving-source');
            document.body.classList.remove('table-move-mode');
            return;
        }
        
        // Render table cards for selection
        const tableCards = await Promise.all(
            availableTables.map(table => this.createTableCardForMove(table))
        );
        grid.innerHTML = tableCards.join('');
        
        // Add click handlers to target tables
        availableTables.forEach(targetTable => {
            const targetCard = document.getElementById(`table-move-target-${targetTable.id}`);
            if (targetCard) {
                targetCard.addEventListener('click', async () => {
                    await this.moveTable(sourceTableId, targetTable.id);
                });
            }
        });
        
        modal.classList.add('active');
    }

    async moveTable(sourceTableId, targetTableId) {
        try {
            const sourceTable = await this.db.getTable(sourceTableId);
            const targetTable = await this.db.getTable(targetTableId);
            
            if (!sourceTable || !targetTable) {
                await this.appAlert('Masa bulunamadı.', 'Hata');
                return;
            }

            // Get unpaid sales from source table
            const sourceUnpaidSales = await this.db.getUnpaidSalesByTable(sourceTableId);
            const targetUnpaidSales = await this.db.getUnpaidSalesByTable(targetTableId);
            
            const sourceHasItems = sourceUnpaidSales.length > 0;
            const targetHasItems = targetUnpaidSales.length > 0;
            const sourceIsHourly = sourceTable.type === 'hourly';
            const targetIsHourly = targetTable.type === 'hourly';
            const sourceIsOpen = sourceIsHourly && sourceTable.isActive && sourceTable.openTime;
            
            // If target has items, show confirmation
            if (targetHasItems) {
                const confirmed = await this.appConfirm(
                    `"${targetTable.name}" masasında zaten ürünler var. Masadaki hesaplar birleşecektir. Onaylıyor musunuz?`,
                    { title: 'Masa Taşıma', confirmText: 'Evet, Taşı', cancelText: 'İptal', confirmVariant: 'primary' }
                );
                if (!confirmed) {
                    this.closeTableMoveModal();
                    return;
                }
            }

            // Handle hourly to regular table move
            if (sourceIsHourly && !targetIsHourly && sourceIsOpen) {
                // Calculate hourly fee and add as product
                const hoursUsed = this.calculateHoursUsed(sourceTable.openTime);
                const hourlyFee = hoursUsed * sourceTable.hourlyRate;
                
                if (hourlyFee > 0) {
                    // Create a sale item for the hourly fee
                    const hourlyFeeSale = {
                        tableId: targetTableId,
                        items: [{
                            productId: null, // Special marker for hourly fee
                            name: 'Oyun Ücreti',
                            icon: '🎱',
                            category: 'game',
                            price: hourlyFee,
                            arrivalPrice: 0,
                            amount: 1,
                            isHourlyFee: true
                        }],
                        sellDateTime: new Date().toISOString(),
                        saleTotal: hourlyFee,
                        isPaid: false,
                        isCredit: false
                    };
                    await this.db.addSale(hourlyFeeSale);
                }
                
                // Stop hourly timer
                sourceTable.isActive = false;
                sourceTable.openTime = null;
                sourceTable.hourlyTotal = 0;
                sourceTable.checkTotal = 0;
            }
            
            // Handle regular to hourly table move
            if (!sourceIsHourly && targetIsHourly && sourceHasItems) {
                // Start hourly timer
                targetTable.isActive = true;
                targetTable.openTime = new Date().toISOString();
            }
            
            // Move all unpaid sales from source to target
            for (const sale of sourceUnpaidSales) {
                sale.tableId = targetTableId;
                await this.db.updateSale(sale);
            }
            
            // Update source table (clear it)
            sourceTable.salesTotal = 0;
            sourceTable.checkTotal = 0;
            sourceTable.isActive = false;
            if (sourceIsHourly) {
                sourceTable.openTime = null;
                sourceTable.hourlyTotal = 0;
            }
            await this.db.updateTable(sourceTable);
            
            // Update target table totals
            const newTargetUnpaidSales = await this.db.getUnpaidSalesByTable(targetTableId);
            const newSalesTotal = newTargetUnpaidSales.reduce((sum, s) => sum + (Number(s?.saleTotal) || 0), 0);
            targetTable.salesTotal = newSalesTotal;
            
            if (targetIsHourly && targetTable.isActive && targetTable.openTime) {
                const hoursUsed = this.calculateHoursUsed(targetTable.openTime);
                targetTable.hourlyTotal = hoursUsed * targetTable.hourlyRate;
                targetTable.checkTotal = targetTable.hourlyTotal + newSalesTotal;
            } else {
                targetTable.checkTotal = newSalesTotal;
            }
            await this.db.updateTable(targetTable);
            
            // Close modal and reload
            this.closeTableMoveModal();
            await this.loadTables();
            
            await this.appAlert(`"${sourceTable.name}" masası "${targetTable.name}" masasına taşındı.`, 'Başarılı');
        } catch (error) {
            console.error('Masa taşınırken hata:', error);
            await this.appAlert('Masa taşınırken hata oluştu. Lütfen tekrar deneyin.', 'Hata');
            this.closeTableMoveModal();
        }
    }

    closeTableMoveModal() {
        const modal = document.getElementById('table-move-modal');
        if (modal) modal.classList.remove('active');
        document.body.classList.remove('table-move-mode');
        
        // Remove blur from all tables
        document.querySelectorAll('.table-moving-source').forEach(card => {
            card.classList.remove('table-moving-source');
        });
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
                const itemTime = it.firstTs ? this.formatTimeOnly(new Date(it.firstTs).toISOString()) : row.timeOnly;
                
                // Hidden action buttons (shown on long press)
                const buttons = `
                    <div class="sale-item-actions" data-sale-id="${saleId}" data-item-index="${idx}">
                        <button class="btn btn-danger btn-icon sale-action-btn" id="delete-sale-item-${saleId}-${idx}" title="İptal">×</button>
                        <button class="btn btn-success btn-icon sale-action-btn" id="pay-sale-item-${saleId}-${idx}" title="Nakit Öde">₺</button>
                        <button class="btn btn-info btn-icon sale-action-btn" id="credit-sale-item-${saleId}-${idx}" title="Veresiye">💳</button>
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

    async deleteItemFromSale(saleId, itemIndex, skipConfirm = false) {
        if (!skipConfirm && !(await this.appConfirm('Bu ürünü iptal etmek istediğinize emin misiniz?', { title: 'İptal Onayı', confirmText: 'İptal Et', cancelText: 'Vazgeç', confirmVariant: 'danger' }))) return;

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
        
        // Step 1: Validate table state and prevent concurrent closures
        if (this._isTableSettling(tableId)) {
            debugLog(`Table ${tableId} is already being settled, skipping`);
            return { success: false, error: 'Table is already being settled' };
        }

        // Step 2: Re-read table from DB to ensure we have the latest state
        let table = await this.db.getTable(tableId);
        if (!table) {
            return { success: false, error: 'Table not found' };
        }

        // Step 3: Validate table can be closed
        if (table.type === 'hourly') {
            if (!table.isActive || !table.openTime) {
                return { success: false, error: 'Hourly table is not open' };
            }
            if (table.closeTime) {
                return { success: false, error: 'Table is already closed' };
            }
        } else {
            if (!table.isActive) {
                return { success: false, error: 'Table is not active' };
            }
        }

        // Step 4: Mark as settling IMMEDIATELY to prevent race conditions
        // Extended duration to prevent realtime updates from interfering during closure
        // For hourly tables, use longer duration to prevent reopening after payment
        const settlingDuration = table.type === 'hourly' ? 25000 : 20000; // 25s for hourly, 20s for others
        this._markTableSettling(tableId, settlingDuration);

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
                    const hoursUsed = this.calculateHoursUsed(table.openTime);
                    finalHourlyTotal = hoursUsed * table.hourlyRate;
                }

                // Persist session to hourlySessions
                updatedTable.hourlySessions = Array.isArray(table.hourlySessions) ? table.hourlySessions : [];
                const sessionHoursUsed = this.calculateHoursBetween(table.openTime, closeTimeISO);
                const sessionHourlyTotal = finalHourlyTotal > 0 ? finalHourlyTotal : (sessionHoursUsed * table.hourlyRate);
                
                const session = {
                    openTime: table.openTime,
                    closeTime: closeTimeISO,
                    hoursUsed: sessionHoursUsed,
                    hourlyTotal: sessionHourlyTotal,
                    paymentTime: closeTimeISO,
                    isCredit
                };
                if (customerId) session.customerId = customerId;
                
                updatedTable.hourlySessions.push(session);

                // Close hourly table
                updatedTable.isActive = false;
                updatedTable.closeTime = closeTimeISO;
                updatedTable.openTime = null;
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

            // Step 8: Wait a moment for DB write to propagate
            await new Promise(resolve => setTimeout(resolve, 100));

            // Step 9: Handle sales based on closure type
            if (isCancel) {
                // Cancel: Delete all unpaid sales and restore stock
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
                    await this.db.updateSale(sale);
                }

                // Note: Customer balance update is handled by the caller (processCreditTable)
                // to ensure accurate calculation before table closure
            }

            // Step 10: Multiple verification passes to ensure table stays closed
            // This prevents race conditions where realtime updates reopen the table
            // Extended verification period to catch delayed realtime updates
            // For hourly tables, use more attempts since payment closure is critical
            const maxAttempts = table.type === 'hourly' ? 8 : 5;
            for (let verifyAttempt = 0; verifyAttempt < maxAttempts; verifyAttempt++) {
                await new Promise(resolve => setTimeout(resolve, 400)); // Wait between attempts (longer for hourly)
                
                const verifyTable = await this.db.getTable(tableId);
                // CRITICAL: For hourly tables, if closeTime exists, table MUST be closed
                const shouldBeClosed = verifyTable && (
                    verifyTable.isActive || 
                    (verifyTable.type === 'hourly' && verifyTable.openTime && !verifyTable.closeTime) ||
                    (verifyTable.type === 'hourly' && verifyTable.closeTime && (verifyTable.openTime || verifyTable.isActive))
                );
                
                if (shouldBeClosed) {
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
                    if (verifyAttempt >= 3) {
                        // After 3 successful checks, we can be more confident
                        break;
                    }
                }
            }

            // Step 11: Final verification - ensure table is closed
            const finalVerifyTable = await this.db.getTable(tableId);
            if (finalVerifyTable && (finalVerifyTable.isActive || (finalVerifyTable.type === 'hourly' && finalVerifyTable.openTime && !finalVerifyTable.closeTime))) {
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
            
            // Step 14: Keep table marked as settling for additional time after closure
            // This prevents realtime updates from interfering immediately after closure
            // The settling period will naturally expire after the extended duration
            // No need to manually clear it - it will expire on its own
            
            return { success: true, table: finalTableState || updatedTable };
        } catch (error) {
            console.error('Error closing table:', error);
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
            const hoursUsed = this.calculateHoursUsed(table.openTime);
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
            amount
        };

        try {
            await this.db.addManualSession(session);
            modal.classList.remove('active');
            await this.loadDailyDashboard();
        } catch (err) {
            console.error('Manuel oyun kaydı eklenirken hata:', err, err?.message, err?.details, err?.hint, err?.code);
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
        // Keep the green pay button label in sync (show amount only)
        const payBtn = document.getElementById('pay-table-btn');
        const payTxt = payBtn?.querySelector?.('.btn-txt') || null;
        if (table.type === 'hourly') {
            const modalSalesTotal = document.getElementById('modal-sales-total');
            const modalCheckTotal = document.getElementById('modal-check-total');
            if (modalSalesTotal) modalSalesTotal.textContent = Math.round(table.salesTotal);
            if (modalCheckTotal) {
                const checkTotal = this.calculateCheckTotal(table);
                modalCheckTotal.textContent = Math.round(checkTotal);
                if (payTxt) payTxt.textContent = `${Math.round(checkTotal)} ₺`;
            }
        } else {
            const modalCheckTotalRegular = document.getElementById('modal-check-total-regular');
            if (modalCheckTotalRegular) modalCheckTotalRegular.textContent = Math.round(table.salesTotal);
            if (payTxt) payTxt.textContent = `${Math.round(table.salesTotal)} ₺`;
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
            .on('postgres_changes', { event: '*', schema: 'public', table: 'manual_sessions' }, (p) => onChange('manual_sessions', p))
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
        } else if (tableName === 'manual_sessions') {
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
                        // CRITICAL: Check if table is currently being settled FIRST
                        // This prevents any updates during closure operations
                        const isSettling = this._isTableSettling(changedTableId);
                        if (isSettling) {
                            debugLog(`Table ${changedTableId} is being settled, skipping realtime update to prevent race condition`);
                            return; // Don't process this realtime update
                        }
                        
                        const updatedTable = this.db.getTable ? await this.db.getTable(changedTableId) : null;
                        
                        // If table was closed, don't refresh
                        // For hourly tables: closeTime means payment was processed - table MUST be closed
                        // For regular tables: closeTime or not active = closed
                        const isTableClosed = updatedTable && (
                            updatedTable.closeTime || 
                            !updatedTable.isActive ||
                            (updatedTable.type === 'hourly' && !updatedTable.openTime && !updatedTable.isActive)
                        );
                        
                        if (isTableClosed) {
                            // Table was cancelled/closed - don't refresh, keep it closed
                            debugLog(`Realtime: Table ${changedTableId} was closed (closeTime: ${updatedTable.closeTime}), skipping card refresh to keep it closed`);
                            // Ensure UI shows closed state
                            this.setTableCardState(changedTableId, {
                                isActive: false,
                                type: updatedTable.type,
                                openTime: null,
                                hourlyRate: updatedTable.hourlyRate || 0,
                                salesTotal: 0,
                                checkTotal: 0
                            });
                            
                            // CRITICAL: If table has closeTime but is still marked as active or has openTime, force close
                            if (updatedTable.closeTime && (updatedTable.isActive || (updatedTable.type === 'hourly' && updatedTable.openTime))) {
                                debugLog(`Realtime: Table ${changedTableId} has closeTime but is still open, forcing close`);
                                const forceClosed = {
                                    ...updatedTable,
                                    isActive: false,
                                    openTime: null,
                                    salesTotal: 0,
                                    checkTotal: 0
                                };
                                if (forceClosed.type === 'hourly') {
                                    forceClosed.hourlyTotal = 0;
                                }
                                await this.db.updateTable(forceClosed);
                            }
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
                // Small delay to ensure IndexedDB transaction is fully committed
                await new Promise(resolve => setTimeout(resolve, 100));
                
                // Additional cleanup for cancelled tables (before scheduling UI refresh)
                if (tableName === 'tables' && changedTableId) {
                    try {
                        const updatedTable = await this.db.getTable(changedTableId);
                        // Check if table is currently being settled (prevent interference during closure)
                        const isSettling = this._isTableSettling(changedTableId);
                        
                        // Only clean up if table is truly closed (not active, no openTime, has closeTime)
                        // Don't clean if table is being opened (isActive: true, openTime exists)
                            // CRITICAL: If table was closed (payment/credit/cancel), ensure it stays closed
                            // and clean up any remaining unpaid sales on this device
                            if (updatedTable && updatedTable.closeTime && !updatedTable.isActive && !updatedTable.openTime) {
                                // Table was closed - if realtime update tries to reopen it, force it closed again
                                // Also check if table is being settled (additional protection)
                                if (isSettling || payload?.new?.isActive || (payload?.new?.openTime && !payload?.new?.closeTime)) {
                                    debugLog(`Realtime: Preventing closed table ${changedTableId} from being reopened (isSettling: ${isSettling})`);
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

    // Helper: Check if product tracks stock
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

    // --- Product icons (built-in) ---
    renderProductIcon(iconValue) {
        const v = (iconValue == null) ? '' : String(iconValue);
        const key = v.startsWith('ico:') ? v.slice(4) : v;
        const supported = new Set(['tuborg', 'carlsberg', 'kasar', 'ayran', 'cola', 'sigara', 'cay', 'nescafe']);
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

        // Toggle a class to allow CSS to optimize header layout for all tables with qty controls
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

        // Optimistic UI: show as opening immediately (avoid perceived lag)
        const optimisticOpenTime = new Date().toISOString();
        this._markTableOpening(targetTableId, optimisticOpenTime);
        // Don't call setTableCardState here - it will interfere with loading state
        // Loading state is already set by the caller, and we'll update after DB write

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
            // Table is already open, just update UI quickly
            this.setTableCardState(table.id, table);
            return;
        }

        // Prevent reopening if table was recently closed (realtime race condition protection)
        // If closeTime exists and openTime is null, table is closed and should not be reopened automatically
        if (table.closeTime && !table.openTime && !table.isActive) {
            // Table is closed - this is expected state after payment/credit
            // CRITICAL: Before reopening, clean up any leftover unpaid sales from cancellation
            // This fixes the issue where cancelled tables still have sales on other devices
            const unpaidSales = await this.db.getUnpaidSalesByTable(targetTableId);
            if (unpaidSales.length > 0) {
                debugLog(`Table ${targetTableId} was closed, cleaning up ${unpaidSales.length} leftover unpaid sales before reopening`);
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
                    if (sale?.id) {
                        await this.db.deleteSale(sale.id);
                    }
                }
            }
            // Only allow manual reopening (user explicitly clicks open)
            // But if we're here, user did click open, so proceed
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

            // Write to DB in foreground, but do NOT block UI with expensive reloads
            await this.db.updateTable(table);
            // DB confirmed; opening flicker guard no longer needed
            this._openingTables.delete(String(table.id));

            // Don't update UI state here if in opening state
            // The opening state will be cleared in the finally block of the caller, and state will be updated there
            // This prevents the table from appearing closed during the loading animation

            // Background refresh (keep other screens eventually consistent)
            setTimeout(() => {
                const views = ['tables'];
                if (this.currentView === 'daily') views.push('daily');
                this.reloadViews(views);
            }, 0);
        } catch (error) {
            console.error('Masayı açarken hata:', error, error?.message, error?.details, error?.hint, error?.code);
            // Revert UI best-effort
            try {
                const fresh = await this.db.getTable(targetTableId);
                if (fresh) this.setTableCardState(fresh.id, fresh);
            } catch (e) {
                // Ignore revert errors
            }
            await this.appAlert('Masayı açarken hata oluştu. Lütfen tekrar deneyin.', 'Hata');
        } finally {
            // Always clear opening state when done
            this.setTableCardOpening(targetTableId, false);
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
                const hoursUsed = this.calculateHoursUsed(table.openTime);
                table.hourlyTotal = hoursUsed * table.hourlyRate;
            }
            table.checkTotal = table.hourlyTotal + table.salesTotal;
            await this.db.updateTable(table);

            // Close modal immediately before reload
            this.closeAddProductModal();

            // Reload modal content in parallel
            // Don't use cache here - we need fresh data after adding a product
            await Promise.all([
                this.loadTableProducts(tableId, { useCache: false }),
                this.loadTableSales(tableId)
            ]);
            
            // Update table totals in modal
            const updatedTable = await this.db.getTable(tableId);
            // Ensure totals are computed from sales (avoid stale aggregated columns)
            try {
                const unpaid = await this.db.getUnpaidSalesByTable(tableId);
                const salesTotal = (unpaid || []).reduce((sum, s) => sum + (Number(s?.saleTotal) || 0), 0);
                updatedTable.salesTotal = salesTotal;
                if (updatedTable.type === 'hourly' && updatedTable.isActive && updatedTable.openTime) {
                    const hoursUsed = this.calculateHoursUsed(updatedTable.openTime);
                    updatedTable.hourlyTotal = hoursUsed * (updatedTable.hourlyRate || 0);
                } else {
                    updatedTable.hourlyTotal = updatedTable.hourlyTotal || 0;
                }
                updatedTable.checkTotal = (updatedTable.hourlyTotal || 0) + salesTotal;
            } catch (_) {
                // ignore
            }
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
        } finally {
            this.clearTableCardLoading(tableId);
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
            // Don't use cache here - we need fresh data after deleting a product
            await this.loadTableProducts(sale.tableId, { useCache: false });
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

        const tableId = this.currentTableId;
        const table = await this.db.getTable(tableId);
        if (!table) return;

        // Validate table can be closed
        if (table.type === 'hourly' && (!table.isActive || !table.openTime || table.closeTime)) {
            debugLog(`Table ${tableId} is already closed, skipping`);
            return;
        }
        if (table.type !== 'hourly' && !table.isActive) {
            debugLog(`Table ${tableId} is already closed, skipping`);
            return;
        }

        try {
            // Show loading state on table card (not full screen)
            this.setTableCardLoading(tableId, 'Hesap alınıyor...', 'success');
            
            // Close modals immediately
            const receiptModal = document.getElementById('receipt-modal');
            if (receiptModal) receiptModal.classList.remove('active');
            this.closeTableModal();

            // Optimistic UI: mark table as closed immediately
            const optimisticClosed = { ...table, isActive: false, salesTotal: 0, checkTotal: 0 };
            if (optimisticClosed.type === 'hourly') {
                optimisticClosed.openTime = null;
            }
            this.setTableCardState(tableId, optimisticClosed);
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
            if (postClosureCheck && (postClosureCheck.isActive || (postClosureCheck.type === 'hourly' && postClosureCheck.openTime && !postClosureCheck.closeTime))) {
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

            // Update UI with final state
            const finalTableForUI = await this.db.getTable(tableId);
            if (finalTableForUI) {
                this.setTableCardState(tableId, {
                    isActive: false,
                    type: finalTableForUI.type,
                    openTime: finalTableForUI.type === 'hourly' ? null : finalTableForUI.openTime,
                    hourlyRate: finalTableForUI.hourlyRate || 0,
                    salesTotal: 0,
                    checkTotal: 0
                });
            }

            // Wait for DB operations to complete and realtime updates to propagate
            await new Promise(resolve => setTimeout(resolve, 2000));
            
            // Clear loading state from table card
            this.clearTableCardLoading(tableId);
            
            // Background refresh
            setTimeout(() => {
                const views = ['tables', 'sales'];
                if (this.currentView === 'daily') views.push('daily');
                this.reloadViews(views);
            }, 100);
        } catch (error) {
            console.error('Ödeme işlenirken hata:', error);
            this.clearTableCardLoading(tableId);
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

        const tableId = this.currentTableId;
        const table = await this.db.getTable(tableId);
        if (!table) return;

        // Validate table can be closed
        if (table.type === 'hourly' && (!table.isActive || !table.openTime || table.closeTime)) {
            debugLog(`Table ${tableId} is already closed, skipping`);
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
            const hoursUsed = this.calculateHoursUsed(table.openTime);
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
            // Show loading state on table card (not full screen)
            this.setTableCardLoading(tableId, 'Veresiye yazılıyor...', 'info');
            
            // Close modal immediately
            this.closeTableModal();
            
            // Optimistic UI: mark table as closed immediately
            const optimisticClosed = { ...table, isActive: false, salesTotal: 0, checkTotal: 0 };
            if (optimisticClosed.type === 'hourly') {
                optimisticClosed.openTime = null;
            }
            this.setTableCardState(tableId, optimisticClosed);
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

            // Update UI with final state
            if (result.table) {
                this.setTableCardState(tableId, {
                    isActive: false,
                    type: result.table.type,
                    openTime: result.table.type === 'hourly' ? null : result.table.openTime,
                    hourlyRate: result.table.hourlyRate || 0,
                    salesTotal: 0,
                    checkTotal: 0
                });
            }

            // Wait for DB operations to complete
            await new Promise(resolve => setTimeout(resolve, 1500));
            
            // Hide loading overlay
            this.hideLoadingOverlay();
            
            // Background refresh (don't block UI)
            setTimeout(() => {
                const views = ['tables', 'customers', 'sales'];
                if (this.currentView === 'daily') views.push('daily');
                this.reloadViews(views);
            }, 100);
        } catch (error) {
            console.error('Veresiye yazılırken hata:', error);
            this.clearTableCardLoading(tableId);
            await this.appAlert('Veresiye yazılırken hata oluştu. Lütfen tekrar deneyin.', 'Hata');
        }
    }

    // Expenses Management
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
            toptanci: 'Toptancı (Bira)',
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
        
        modal.classList.add('active');
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
            
            document.getElementById('expense-form-modal').classList.remove('active');
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

    // Products Management
    async loadProducts() {
        const products = this.sortProductsByStock(await this.db.getAllProducts());
        const container = document.getElementById('products-container');
        
        if (!container) {
            console.error('Products container not found');
            return;
        }
        
        if (products.length === 0) {
            container.innerHTML = this.createAddProductCard();
            const addCard = document.getElementById('add-product-card');
            if (addCard) addCard.onclick = () => this.openProductFormModal();
            return;
        }

        container.innerHTML = products.map(product => this.createProductCard(product)).join('') + this.createAddProductCard();

        const addCard = document.getElementById('add-product-card');
        if (addCard) addCard.onclick = () => this.openProductFormModal();
        
        // Use event delegation for edit/delete buttons (bind once)
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
        const tracksStock = this.tracksStock(product);
        const iconHtml = this.renderProductIcon?.(product.icon) || (product.icon || '📦');
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
                <div class="product-card-icon">${iconHtml}</div>
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
            title.textContent = 'Ürünü Düzenle';
            document.getElementById('product-id').value = product.id;
            document.getElementById('product-name').value = product.name;
            document.getElementById('product-price').value = product.price;
            document.getElementById('product-arrival-price').value = product.arrivalPrice || 0;
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
        
        modal.classList.add('active');
    }

    async saveProduct() {
        const id = document.getElementById('product-id').value;
        const name = document.getElementById('product-name').value;
        const price = parseFloat(document.getElementById('product-price').value);
        const arrivalPrice = parseFloat(document.getElementById('product-arrival-price').value) || 0;
        const icon = (document.getElementById('product-icon')?.value || '📦');
        const category = (document.getElementById('product-category')?.value || 'soft');
        const trackStock = document.getElementById('product-track-stock').checked;
        const stock = trackStock ? parseInt(document.getElementById('product-stock').value) : null;

        const productData = { name, price, arrivalPrice, icon, category, stock, trackStock };

        try {
            if (id) {
                productData.id = id;
                await this.db.updateProduct(productData);
            } else {
                await this.db.addProduct(productData);
            }
            
            // Check for low stock after product update
            if (trackStock && stock !== null && stock < 10) {
                this.showStockWarning(`${name} ürününde düşük stok var (${stock} adet)`, 1);
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
                container.innerHTML = this.createAddCustomerCard();
                const addCard = document.getElementById('add-customer-card');
                if (addCard) addCard.onclick = () => this.openCustomerFormModal();
                return;
            }

            // Sort customers by balance (debt) in descending order - highest debt first
            const sortedCustomers = customers.sort((a, b) => {
                const balanceA = a.balance || 0;
                const balanceB = b.balance || 0;
                return balanceB - balanceA; // Descending order
            });

            container.innerHTML = sortedCustomers.map(customer => this.createCustomerCard(customer)).join('') + this.createAddCustomerCard();

            const addCard = document.getElementById('add-customer-card');
            if (addCard) addCard.onclick = () => this.openCustomerFormModal();
            
            // Add event listeners - card click opens detail modal
            sortedCustomers.forEach(customer => {
                const card = document.getElementById(`customer-${customer.id}`);
                if (card) {
                    card.addEventListener('click', () => {
                        this.openCustomerDetailModal(customer);
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

    createCustomerCard(customer) {
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

        modal.classList.add('active');
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

            modal.classList.remove('active');

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
        // Use whole ₺ amounts to avoid floating point leftovers in UI/validation
        const roundedBalance = Math.round(customer.balance || 0);
        customerBalance.textContent = `${roundedBalance} ₺`;
        customerIdInput.value = customer.id;
        paymentAmount.value = '';
        paymentAmount.max = roundedBalance;
        paymentAmount.min = 1;
        paymentAmount.step = '1';
        
        modal.classList.add('active');
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
            
            document.getElementById('customer-payment-modal').classList.remove('active');
            
            // Reload customer detail modal if it's open
            const customerDetailModal = document.getElementById('customer-detail-modal');
            if (customerDetailModal && customerDetailModal.classList.contains('active')) {
                const updatedCustomer = await this.db.getCustomer(customerId);
                if (updatedCustomer) {
                    await this.openCustomerDetailModal(updatedCustomer);
                }
            }
            
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
        
        // Set customer info
        title.textContent = `${customer.name} - Detay`;
        nameEl.textContent = customer.name;
        const balance = customer.balance || 0;
        balanceEl.textContent = `${Math.round(balance)} ₺`;
        
        // Get customer sales
        const sales = await this.db.getSalesByCustomer(customer.id);
        
        // Get all tables to check hourly sessions
        const allTables = await this.db.getAllTables();
        
        // Get manual sessions for this customer
        const allManualSessions = await this.db.getAllManualSessions();
        const customerSessions = (allManualSessions || []).filter(s => 
            s.customerId && String(s.customerId) === String(customer.id)
        );
        
        // Calculate total hours from manual sessions
        let totalHours = 0;
        customerSessions.forEach(s => {
            const hours = (typeof s.hoursUsed === 'number' ? s.hoursUsed : parseFloat(s.hoursUsed)) || 0;
            totalHours += hours;
        });
        
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
        
        // Add manual sessions section (grouped by date like receipts)
        if (customerSessions.length > 0) {
            const sessionsByDate = new Map();
            customerSessions.forEach(session => {
                const date = session.closeTime ? new Date(session.closeTime) : (session.createdAt ? new Date(session.createdAt) : new Date());
                const dateKey = date.toLocaleDateString('tr-TR', { year: 'numeric', month: '2-digit', day: '2-digit' });
                if (!sessionsByDate.has(dateKey)) {
                    sessionsByDate.set(dateKey, []);
                }
                sessionsByDate.get(dateKey).push(session);
            });
            
            const sortedSessionDates = Array.from(sessionsByDate.keys()).sort((a, b) => {
                const dateA = new Date(a.split('.').reverse().join('-'));
                const dateB = new Date(b.split('.').reverse().join('-'));
                return dateB - dateA;
            });
            
            contentHTML += '<div style="margin-bottom: 20px;"><h3 style="margin-bottom: 10px; color: var(--primary-color);">Oyun Saatleri</h3>';
            sortedSessionDates.forEach(dateKey => {
                const dateSessions = sessionsByDate.get(dateKey);
                contentHTML += `<div style="margin-bottom: 15px;"><h4 style="margin-bottom: 8px; color: var(--secondary-color); font-size: 0.95rem;">${dateKey}</h4>`;
                
                dateSessions.forEach(session => {
                    const hours = (typeof session.hoursUsed === 'number' ? session.hoursUsed : parseFloat(session.hoursUsed)) || 0;
                    const amount = session.hourlyRate ? (hours * session.hourlyRate) : (session.amount || 0);
                    const date = session.closeTime ? new Date(session.closeTime) : (session.createdAt ? new Date(session.createdAt) : new Date());
                    const timeStr = date.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
                    const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
                    const sessionBg = isDark ? 'var(--dark-surface-elevated)' : '#f8f9fa';
                    const sessionText = isDark ? 'var(--dark-text-primary)' : 'inherit';
                    const sessionTextSecondary = isDark ? 'var(--dark-text-secondary)' : '#7f8c8d';
                    
                    contentHTML += `
                        <div style="padding: 10px; margin-bottom: 8px; background: ${sessionBg}; border-radius: 8px; color: ${sessionText};">
                            <div style="display: flex; justify-content: space-between; align-items: center;">
                                <div>
                                    <strong style="color: ${sessionText};">${session.tableName || 'Masa'}</strong>
                                    <div style="font-size: 0.9rem; color: ${sessionTextSecondary};">${timeStr}</div>
                                </div>
                                <div style="text-align: right;">
                                    <div><strong style="color: ${sessionText};">${this.formatHoursToReadable(hours)}</strong></div>
                                    <div style="color: var(--success-color); font-weight: 700;">${Math.round(amount)} ₺</div>
                                </div>
                            </div>
                        </div>
                    `;
                });
                contentHTML += '</div>';
            });
            contentHTML += '</div>';
        }
        
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
                        receiptContentHTML += `<div class="receipt-item-name">Süre: ${this.formatHoursToReadable(totalHours)}</div>`;
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
        const editBtn = document.getElementById('customer-detail-edit-btn');
        const deleteBtn = document.getElementById('customer-detail-delete-btn');
        const closeBtn = modal.querySelector('.close');
        
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
            closeBtn.onclick = () => {
                modal.classList.remove('active');
            };
        }
        
        modal.classList.add('active');
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

        // Manual sessions (report backfill)
        const allManualSessions = await this.db.getAllManualSessions();
        const periodManualSessions = (allManualSessions || []).filter((s) => {
            if (!s || s.type !== 'hourly') return false;
            // Prefer closeTime (actual session end). If it is not parseable (e.g. DB column is TIME),
            // fall back to createdAt/openTime so the record still shows in reports.
            const closeTime = parseDateSafe(s.closeTime) || parseDateSafe(s.createdAt) || parseDateSafe(s.openTime);
            if (!closeTime) return false;
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
            const hours = (typeof s.hoursUsed === 'number' ? s.hoursUsed : parseFloat(s.hoursUsed)) || 0;
            const income = (typeof s.amount === 'number' ? s.amount : parseFloat(s.amount)) || 0;
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

        // Calculate expenses in date range
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

        // Calculate net profit (total profit - expenses)
        const netProfit = totalProfit - totalExpenses;

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

        // Update expense and net profit info
        const totalExpensesEl = document.getElementById('total-expenses');
        if (totalExpensesEl) {
            totalExpensesEl.textContent = `${Math.round(totalExpenses)} ₺`;
        }
        const netProfitEl = document.getElementById('net-profit');
        if (netProfitEl) {
            netProfitEl.textContent = `${Math.round(netProfit)} ₺`;
            netProfitEl.parentElement.parentElement.style.background = netProfit >= 0 ? '#d4edda' : '#f8d7da';
            netProfitEl.parentElement.parentElement.style.borderColor = netProfit >= 0 ? '#28a745' : '#dc3545';
        }
        const monthlyIncomeEl = document.getElementById('monthly-income');
        if (monthlyIncomeEl) {
            monthlyIncomeEl.textContent = `${Math.round(totalMonthlyIncome)} ₺`;
        }
        const monthlyExpensesEl = document.getElementById('monthly-expenses');
        if (monthlyExpensesEl) {
            monthlyExpensesEl.textContent = `${Math.round(monthlyExpenses)} ₺`;
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

        const toSortDate = (s) => {
            const d = new Date(s.closeTime || s.createdAt || s.openTime || 0);
            return Number.isNaN(d.getTime()) ? new Date(0) : d;
        };
        const sorted = [...sessions].sort((a, b) => toSortDate(b) - toSortDate(a));
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
                labels: ['Oyun Geliri', 'Ürün Geliri'],
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
        // Haptic feedback for theme toggle
        this.hapticFeedback('medium');
        
        const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
        
        // Add fade transition
        document.body.classList.add('theme-transitioning');
        
        if (isDark) {
            document.documentElement.removeAttribute('data-theme');
            localStorage.setItem('darkMode', 'false');
        } else {
            document.documentElement.setAttribute('data-theme', 'dark');
            localStorage.setItem('darkMode', 'true');
        }
        
        this.updateDarkModeIcon();
        this.updateThemeColor();
        
        // Remove transition class after animation
        setTimeout(() => {
            document.body.classList.remove('theme-transitioning');
        }, 300);
    }

    updateThemeColor() {
        const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
        
        // For dark mode: use AMOLED black for header, status bar, and navigation bar
        // For light mode: use white
        const lightColor = '#ffffff';
        const darkColor = '#000000'; // AMOLED black for dark mode
        
        const themeColor = isDark ? darkColor : lightColor;
        
        // Update all theme-color meta tags
        // This controls both Chrome status bar (top) and navigation bar (bottom) on Android
        const metaTags = document.querySelectorAll('meta[name="theme-color"]');
        metaTags.forEach(tag => {
            tag.setAttribute('content', themeColor);
        });
    }

    updateDarkModeIcon() {
        const icon = document.querySelector('.dark-mode-icon');
        if (!icon) return;
        const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
        icon.textContent = isDark ? '☀️' : '🌙';
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
    const darkColor = '#1a1a1a';
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
