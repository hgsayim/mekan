/**
 * Utility functions for formatting dates, times, and currency
 */

/**
 * Format date and time without seconds
 * @param {string} dateString - ISO date string
 * @returns {string} Formatted date string (DD.MM.YYYY HH:mm)
 */
export function formatDateTimeWithoutSeconds(dateString) {
    if (!dateString) return '';
    const date = new Date(dateString);
    if (isNaN(date.getTime())) return '';
    
    const day = String(date.getDate()).padStart(2, '0');
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const year = date.getFullYear();
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    return `${day}.${month}.${year} ${hours}:${minutes}`;
}

/**
 * Format time only (HH:mm)
 * @param {string} dateString - ISO date string
 * @returns {string} Formatted time string (HH:mm)
 */
export function formatTimeOnly(dateString) {
    if (!dateString) return '';
    const date = new Date(dateString);
    if (isNaN(date.getTime())) return '';
    
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    return `${hours}:${minutes}`;
}

/**
 * Format hours to readable string
 * @param {number} hours - Hours as decimal
 * @returns {string} Formatted string (e.g., "2 saat 30 dk")
 */
export function formatHoursToReadable(hours) {
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

/**
 * Format currency (Turkish Lira)
 * @param {number} amount - Amount to format
 * @returns {string} Formatted currency string (e.g., "100 ₺")
 */
export function formatCurrency(amount) {
    if (amount == null || isNaN(amount)) return '0 ₺';
    return `${Math.round(amount)} ₺`;
}
