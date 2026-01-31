/**
 * Lazy loading utilities for code splitting
 */

/**
 * Lazy load a module
 * @param {Function} importFn - Dynamic import function
 * @returns {Promise} Module
 */
export function lazyLoad(importFn) {
    let module = null;
    let loading = false;
    let promise = null;

    return async () => {
        if (module) return module;
        if (loading) return promise;
        
        loading = true;
        promise = importFn().then(m => {
            module = m;
            loading = false;
            return m;
        });
        
        return promise;
    };
}

/**
 * Preload a module
 * @param {Function} importFn - Dynamic import function
 */
export function preload(importFn) {
    importFn().catch(() => {
        // Silently fail preload
    });
}

/**
 * Load module with retry
 * @param {Function} importFn - Dynamic import function
 * @param {number} retries - Number of retries
 * @returns {Promise} Module
 */
export async function loadWithRetry(importFn, retries = 3) {
    for (let i = 0; i < retries; i++) {
        try {
            return await importFn();
        } catch (error) {
            if (i === retries - 1) throw error;
            await new Promise(resolve => setTimeout(resolve, 1000 * (i + 1)));
        }
    }
}

/**
 * Intersection Observer for lazy loading elements
 */
export class LazyLoader {
    constructor(options = {}) {
        this.options = {
            root: null,
            rootMargin: '50px',
            threshold: 0.01,
            ...options
        };
        this.observer = null;
        this.elements = new Map();
    }

    /**
     * Initialize observer
     */
    init() {
        if (typeof IntersectionObserver === 'undefined') {
            console.warn('IntersectionObserver not supported');
            return;
        }

        this.observer = new IntersectionObserver((entries) => {
            entries.forEach(entry => {
                if (entry.isIntersecting) {
                    const element = entry.target;
                    const loader = this.elements.get(element);
                    if (loader) {
                        loader();
                        this.observer.unobserve(element);
                        this.elements.delete(element);
                    }
                }
            });
        }, this.options);
    }

    /**
     * Observe element for lazy loading
     * @param {HTMLElement} element - Element to observe
     * @param {Function} loader - Loader function
     */
    observe(element, loader) {
        if (!this.observer) this.init();
        if (!this.observer) {
            // Fallback: load immediately
            loader();
            return;
        }

        this.elements.set(element, loader);
        this.observer.observe(element);
    }

    /**
     * Stop observing element
     * @param {HTMLElement} element - Element to stop observing
     */
    unobserve(element) {
        if (this.observer) {
            this.observer.unobserve(element);
            this.elements.delete(element);
        }
    }

    /**
     * Disconnect observer
     */
    disconnect() {
        if (this.observer) {
            this.observer.disconnect();
            this.elements.clear();
        }
    }
}
