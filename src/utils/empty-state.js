/**
 * Empty State Utility
 * Shows user-friendly empty states when lists are empty
 */

/**
 * Create empty state element
 * @param {Object} options - Empty state options
 * @param {string} options.icon - Icon/emoji to display
 * @param {string} options.title - Title text
 * @param {string} options.message - Description message
 * @param {string} options.actionText - Action button text (optional)
 * @param {Function} options.onAction - Action button click handler (optional)
 * @returns {HTMLElement} Empty state element
 */
export function createEmptyState({ icon, title, message, actionText, onAction }) {
    const emptyState = document.createElement('div');
    emptyState.className = 'empty-state';
    
    let actionButton = '';
    if (actionText && onAction) {
        actionButton = `
            <button class="btn btn-primary empty-state-action" type="button">
                ${actionText}
            </button>
        `;
    }
    
    emptyState.innerHTML = `
        <div class="empty-state-icon">${icon || '📦'}</div>
        <h3 class="empty-state-title">${title || 'Henüz kayıt yok'}</h3>
        <p class="empty-state-message">${message || 'İlk kaydınızı ekleyerek başlayın'}</p>
        ${actionButton}
    `;
    
    // Add action button click handler
    if (actionText && onAction) {
        const btn = emptyState.querySelector('.empty-state-action');
        if (btn) {
            btn.addEventListener('click', onAction);
        }
    }
    
    return emptyState;
}

/**
 * Show empty state in container
 * @param {HTMLElement} container - Container element
 * @param {Object} options - Empty state options
 */
export function showEmptyState(container, options) {
    if (!container) return;
    
    // Clear container
    container.innerHTML = '';
    
    // Add empty state
    const emptyState = createEmptyState(options);
    container.appendChild(emptyState);
    container.classList.add('has-empty-state');
}

/**
 * Hide empty state from container
 * @param {HTMLElement} container - Container element
 */
export function hideEmptyState(container) {
    if (!container) return;
    
    const emptyState = container.querySelector('.empty-state');
    if (emptyState) {
        emptyState.remove();
    }
    container.classList.remove('has-empty-state');
}

/**
 * Predefined empty states for common use cases
 */
export const emptyStates = {
    tables: {
        icon: '🪑',
        title: 'Henüz masa yok',
        message: 'İlk masanızı ekleyerek başlayın',
        actionText: 'Masa Ekle',
        actionView: 'tables'
    },
    products: {
        icon: '📦',
        title: 'Henüz ürün yok',
        message: 'İlk ürününüzü ekleyerek başlayın',
        actionText: 'Ürün Ekle',
        actionView: 'products'
    },
    sales: {
        icon: '💰',
        title: 'Henüz satış yok',
        message: 'Satışlar burada görünecek',
        actionText: null
    },
    customers: {
        icon: '👥',
        title: 'Henüz müşteri yok',
        message: 'İlk müşterinizi ekleyerek başlayın',
        actionText: 'Müşteri Ekle',
        actionView: 'customers'
    },
    expenses: {
        icon: '💸',
        title: 'Henüz gider yok',
        message: 'Giderlerinizi burada takip edin',
        actionText: 'Gider Ekle',
        actionView: 'expenses'
    }
};
