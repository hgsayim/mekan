/**
 * Performance monitoring utilities
 */

class PerformanceMonitor {
    constructor() {
        this.metrics = {
            pageLoad: null,
            interactions: [],
            apiCalls: [],
            errors: []
        };
        this.init();
    }

    init() {
        // Monitor page load
        if (typeof window !== 'undefined' && window.performance) {
            window.addEventListener('load', () => {
                const perfData = window.performance.timing;
                this.metrics.pageLoad = {
                    domContentLoaded: perfData.domContentLoadedEventEnd - perfData.navigationStart,
                    loadComplete: perfData.loadEventEnd - perfData.navigationStart,
                    timestamp: Date.now()
                };
                this.logMetric('pageLoad', this.metrics.pageLoad);
            });
        }

        // Monitor long tasks
        if ('PerformanceObserver' in window) {
            try {
                const observer = new PerformanceObserver((list) => {
                    for (const entry of list.getEntries()) {
                        if (entry.duration > 50) { // Tasks longer than 50ms
                            this.metrics.interactions.push({
                                type: 'long-task',
                                duration: entry.duration,
                                timestamp: Date.now()
                            });
                        }
                    }
                });
                observer.observe({ entryTypes: ['longtask'] });
            } catch (e) {
                // Long task observer not supported
            }
        }
    }

    /**
     * Measure function execution time
     * @param {string} name - Function name
     * @param {Function} fn - Function to measure
     * @returns {Promise} Function result
     */
    async measure(name, fn) {
        const start = performance.now();
        try {
            const result = await fn();
            const duration = performance.now() - start;
            this.metrics.interactions.push({
                name,
                duration,
                timestamp: Date.now(),
                success: true
            });
            return result;
        } catch (error) {
            const duration = performance.now() - start;
            this.metrics.interactions.push({
                name,
                duration,
                timestamp: Date.now(),
                success: false,
                error: error.message
            });
            throw error;
        }
    }

    /**
     * Log API call performance
     * @param {string} endpoint - API endpoint
     * @param {number} duration - Duration in ms
     * @param {boolean} success - Whether call succeeded
     */
    logApiCall(endpoint, duration, success = true) {
        this.metrics.apiCalls.push({
            endpoint,
            duration,
            success,
            timestamp: Date.now()
        });
    }

    /**
     * Log error
     * @param {Error} error - Error object
     * @param {Object} context - Additional context
     */
    logError(error, context = {}) {
        this.metrics.errors.push({
            message: error.message,
            stack: error.stack,
            context,
            timestamp: Date.now()
        });
    }

    /**
     * Log metric
     * @param {string} type - Metric type
     * @param {Object} data - Metric data
     */
    logMetric(type, data) {
        if (process.env.NODE_ENV === 'development') {
            console.log(`[Performance] ${type}:`, data);
        }
    }

    /**
     * Get performance report
     * @returns {Object} Performance metrics
     */
    getReport() {
        return {
            ...this.metrics,
            summary: {
                avgInteractionTime: this.getAverageInteractionTime(),
                slowApiCalls: this.getSlowApiCalls(),
                errorCount: this.metrics.errors.length
            }
        };
    }

    /**
     * Get average interaction time
     * @returns {number} Average time in ms
     */
    getAverageInteractionTime() {
        if (this.metrics.interactions.length === 0) return 0;
        const total = this.metrics.interactions.reduce((sum, i) => sum + i.duration, 0);
        return total / this.metrics.interactions.length;
    }

    /**
     * Get slow API calls (> 1 second)
     * @returns {Array} Slow API calls
     */
    getSlowApiCalls() {
        return this.metrics.apiCalls.filter(call => call.duration > 1000);
    }

    /**
     * Clear metrics
     */
    clear() {
        this.metrics = {
            pageLoad: null,
            interactions: [],
            apiCalls: [],
            errors: []
        };
    }
}

// Export singleton instance
export const performanceMonitor = new PerformanceMonitor();
