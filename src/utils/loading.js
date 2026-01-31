/**
 * Loading States Utility
 * Provides loading indicators, skeleton loaders, and button states
 */

/**
 * Show loading state on a button
 * @param {HTMLElement} button - Button element
 * @param {string} loadingText - Text to show while loading
 */
export function setButtonLoading(button, loadingText = 'Yükleniyor...') {
    if (!button) return;
    
    button.dataset.loading = 'true';
    button.disabled = true;
    
    const originalText = button.textContent;
    button.dataset.originalText = originalText;
    
    button.innerHTML = `
        <span class="button-spinner"></span>
        <span class="button-loading-text">${loadingText}</span>
    `;
}

/**
 * Remove loading state from button
 * @param {HTMLElement} button - Button element
 */
export function removeButtonLoading(button) {
    if (!button) return;
    
    button.dataset.loading = 'false';
    button.disabled = false;
    
    const originalText = button.dataset.originalText || button.textContent;
    button.textContent = originalText;
    button.removeAttribute('data-original-text');
}

/**
 * Create skeleton loader element
 * @param {string} className - Additional CSS class
 * @returns {HTMLElement} Skeleton element
 */
export function createSkeleton(className = '') {
    const skeleton = document.createElement('div');
    skeleton.className = `skeleton ${className}`;
    return skeleton;
}

/**
 * Show skeleton loaders in a container
 * @param {HTMLElement} container - Container element
 * @param {number} count - Number of skeletons to show
 * @param {string} skeletonClass - CSS class for skeleton
 */
export function showSkeletons(container, count = 3, skeletonClass = '') {
    if (!container) return;
    
    container.classList.add('loading');
    container.innerHTML = '';
    
    for (let i = 0; i < count; i++) {
        const skeleton = createSkeleton(skeletonClass);
        container.appendChild(skeleton);
    }
}

/**
 * Hide skeleton loaders
 * @param {HTMLElement} container - Container element
 */
export function hideSkeletons(container) {
    if (!container) return;
    container.classList.remove('loading');
}

/**
 * Show loading overlay (full screen)
 * @param {string} message - Loading message
 */
export function showLoadingOverlay(message = 'Yükleniyor...') {
    let overlay = document.getElementById('loading-overlay');
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'loading-overlay';
        overlay.className = 'loading-overlay';
        overlay.innerHTML = `
            <div class="loading-content">
                <div class="loading-spinner"></div>
                <div class="loading-message">${message}</div>
            </div>
        `;
        document.body.appendChild(overlay);
    }
    
    const messageEl = overlay.querySelector('.loading-message');
    if (messageEl) {
        messageEl.textContent = message;
    }
    
    overlay.style.display = 'flex';
}

/**
 * Hide loading overlay
 */
export function hideLoadingOverlay() {
    const overlay = document.getElementById('loading-overlay');
    if (overlay) {
        overlay.style.display = 'none';
    }
}
