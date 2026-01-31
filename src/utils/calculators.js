/**
 * Utility functions for calculations
 */

/**
 * Calculate hours used from open time to now
 * @param {string} openTime - ISO date string
 * @returns {number} Hours as decimal
 */
export function calculateHoursUsed(openTime) {
    if (!openTime) return 0;
    const now = new Date();
    const opened = new Date(openTime);
    if (isNaN(opened.getTime())) return 0;
    
    const diffMs = now - opened;
    if (diffMs < 0) return 0; // Future date
    
    return diffMs / (1000 * 60 * 60); // Convert to hours
}

/**
 * Calculate hours between two dates
 * @param {string} startTime - ISO date string
 * @param {string} endTime - ISO date string
 * @returns {number} Hours as decimal
 */
export function calculateHoursBetween(startTime, endTime) {
    if (!startTime || !endTime) return 0;
    const start = new Date(startTime);
    const end = new Date(endTime);
    
    if (isNaN(start.getTime()) || isNaN(end.getTime())) return 0;
    
    const diffMs = end - start;
    if (diffMs < 0) return 0;
    
    return diffMs / (1000 * 60 * 60); // Convert to hours
}

/**
 * Calculate hourly total for a table
 * @param {Object} table - Table object with openTime and hourlyRate
 * @returns {number} Hourly total
 */
export function calculateHourlyTotal(table) {
    if (!table || !table.openTime || !table.hourlyRate) return 0;
    const hoursUsed = calculateHoursUsed(table.openTime);
    return hoursUsed * table.hourlyRate;
}

/**
 * Calculate check total for a table
 * @param {Object} table - Table object
 * @returns {number} Check total (hourly + sales)
 */
export function calculateCheckTotal(table) {
    if (!table) return 0;
    const hourlyTotal = calculateHourlyTotal(table);
    return hourlyTotal + (table.salesTotal || 0);
}
