/**
 * Global Error Handler
 * Centralized error handling and user-friendly error messages
 */

import { toast } from './toast.js';

/**
 * User-friendly error messages
 */
const ERROR_MESSAGES = {
    // Network errors
    'NetworkError': 'İnternet bağlantısı yok. Lütfen bağlantınızı kontrol edin.',
    'Failed to fetch': 'Sunucuya bağlanılamıyor. Lütfen tekrar deneyin.',
    'timeout': 'İşlem zaman aşımına uğradı. Lütfen tekrar deneyin.',
    
    // Database errors
    'Database init timeout': 'Veritabanı başlatılamadı. Sayfayı yenileyin.',
    'Load initial data timeout': 'Veriler yüklenemedi. Sayfayı yenileyin.',
    
    // Auth errors
    'Session check timeout': 'Oturum kontrolü zaman aşımına uğradı. Lütfen tekrar giriş yapın.',
    'Giriş işlemi zaman aşımına uğradı': 'Giriş işlemi zaman aşımına uğradı. Lütfen internet bağlantınızı kontrol edin.',
    
    // Generic
    'default': 'Bir hata oluştu. Lütfen tekrar deneyin.',
};

/**
 * Get user-friendly error message
 * @param {Error|string} error - Error object or message
 * @returns {string} User-friendly message
 */
function getUserFriendlyMessage(error) {
    if (!error) return ERROR_MESSAGES.default;
    
    const errorMessage = typeof error === 'string' ? error : error.message || error.toString();
    
    // Check for specific error messages
    for (const [key, message] of Object.entries(ERROR_MESSAGES)) {
        if (errorMessage.includes(key)) {
            return message;
        }
    }
    
    // Return original message if it's user-friendly, otherwise default
    if (errorMessage.length < 100 && !errorMessage.includes('Error:') && !errorMessage.includes('at ')) {
        return errorMessage;
    }
    
    return ERROR_MESSAGES.default;
}

/**
 * Handle error and show toast
 * @param {Error|string} error - Error object or message
 * @param {string} context - Context where error occurred
 * @param {boolean} showToast - Whether to show toast notification
 */
export function handleError(error, context = '', showToast = true) {
    const message = getUserFriendlyMessage(error);
    
    // Log error for debugging
    console.error(`[${context}]`, error);
    
    // Show toast notification
    if (showToast) {
        toast.error(message);
    }
    
    return message;
}

/**
 * Handle API error
 * @param {Error} error - Error object
 * @param {string} operation - Operation name (e.g., 'Ürün ekleme')
 */
export function handleApiError(error, operation = 'İşlem') {
    let message = `${operation} sırasında hata oluştu.`;
    
    if (error.message) {
        if (error.message.includes('NetworkError') || error.message.includes('Failed to fetch')) {
            message = 'İnternet bağlantısı yok. Lütfen bağlantınızı kontrol edin.';
        } else if (error.message.includes('timeout')) {
            message = 'İşlem zaman aşımına uğradı. Lütfen tekrar deneyin.';
        } else {
            message = `${operation} sırasında hata: ${getUserFriendlyMessage(error)}`;
        }
    }
    
    console.error(`[API Error] ${operation}:`, error);
    toast.error(message);
    
    return message;
}

/**
 * Setup global error handlers
 */
export function setupGlobalErrorHandlers() {
    // Global unhandled errors
    window.addEventListener('error', (event) => {
        handleError(event.error || event.message, 'Global Error', true);
    });
    
    // Unhandled promise rejections
    window.addEventListener('unhandledrejection', (event) => {
        handleError(event.reason, 'Unhandled Promise Rejection', true);
        event.preventDefault(); // Prevent default browser behavior
    });
    
    // Network errors
    window.addEventListener('online', () => {
        toast.info('İnternet bağlantısı yeniden kuruldu.');
    });
    
    window.addEventListener('offline', () => {
        toast.warning('İnternet bağlantısı kesildi. Bazı özellikler çalışmayabilir.');
    });
}

/**
 * Wrap async function with error handling
 * @param {Function} fn - Async function to wrap
 * @param {string} context - Context name
 * @param {boolean} showToast - Whether to show toast on error
 */
export function withErrorHandling(fn, context = '', showToast = true) {
    return async (...args) => {
        try {
            return await fn(...args);
        } catch (error) {
            handleError(error, context, showToast);
            throw error; // Re-throw for caller to handle if needed
        }
    };
}
