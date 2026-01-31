/**
 * Table Service - Business logic for table operations
 */

import { calculateHoursUsed, calculateHoursBetween } from '../utils/calculators.js';

export class TableService {
    constructor(db) {
        this.db = db;
    }

    /**
     * Get table with computed totals
     * @param {string} tableId - Table ID
     * @returns {Object} Table with computed totals
     */
    async getTableWithTotals(tableId) {
        const table = await this.db.getTable(tableId);
        if (!table) return null;
        
        const unpaidSales = await this.db.getUnpaidSalesByTable(tableId);
        return await this.updateTableTotals(table, unpaidSales);
    }

    /**
     * Calculate table totals from unpaid sales
     * @param {Object} table - Table object
     * @param {Array} unpaidSales - Array of unpaid sales
     * @returns {Object} Updated table with totals
     */
    async updateTableTotals(table, unpaidSales) {
        if (!table) return null;
        
        const salesTotal = (unpaidSales || []).reduce(
            (sum, s) => sum + (Number(s?.saleTotal) || 0),
            0
        );
        
        table.salesTotal = salesTotal;
        
        // Calculate hourly total for hourly tables
        if (table.type === 'hourly' && table.isActive && table.openTime && !table.closeTime) {
            const hoursUsed = calculateHoursUsed(table.openTime);
            table.hourlyTotal = hoursUsed * (table.hourlyRate || 0);
            table.checkTotal = table.hourlyTotal + salesTotal;
        } else {
            table.hourlyTotal = table.hourlyTotal || 0;
            table.checkTotal = salesTotal;
        }
        
        return table;
    }

    /**
     * Calculate hourly total for a table
     * @param {Object} table - Table object
     * @returns {number} Hourly total
     */
    calculateHourlyTotal(table) {
        if (!table || !table.openTime || !table.hourlyRate) return 0;
        if (table.closeTime) return table.hourlyTotal || 0; // Use stored value if closed
        
        const hoursUsed = calculateHoursUsed(table.openTime);
        return hoursUsed * table.hourlyRate;
    }

    /**
     * Calculate check total (hourly + sales)
     * @param {Object} table - Table object
     * @returns {number} Check total
     */
    calculateCheckTotal(table) {
        if (!table) return 0;
        const hourlyTotal = this.calculateHourlyTotal(table);
        return hourlyTotal + (table.salesTotal || 0);
    }

    /**
     * Check if table should be auto-closed
     * @param {Object} table - Table object
     * @param {Array} unpaidSales - Array of unpaid sales
     * @returns {boolean} True if table should be closed
     */
    shouldAutoClose(table, unpaidSales) {
        if (!table) return false;
        
        // Hourly tables should not auto-close
        if (table.type === 'hourly') return false;
        
        // Instant tables should not auto-close
        if (table.type === 'instant') return false;
        
        // Close if no unpaid sales and totals are 0
        return unpaidSales.length === 0 && 
               table.checkTotal === 0 && 
               table.salesTotal === 0;
    }

    /**
     * Sync table status with unpaid sales
     * @param {Object} table - Table object
     * @returns {Object} Updated table
     */
    async syncTableStatus(table) {
        if (!table) return null;
        
        const unpaidSales = await this.db.getUnpaidSalesByTable(table.id);
        const updatedTable = await this.updateTableTotals(table, unpaidSales);
        
        // Update isActive status for regular tables
        if (table.type !== 'hourly' && table.type !== 'instant') {
            updatedTable.isActive = unpaidSales.length > 0 || updatedTable.checkTotal > 0;
        }
        
        return updatedTable;
    }
}
