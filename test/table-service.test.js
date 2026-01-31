import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TableService } from '../src/services/TableService.js';

describe('TableService', () => {
    let tableService;
    let mockDb;

    beforeEach(() => {
        // Mock database
        mockDb = {
            getTable: vi.fn(),
            getAllTables: vi.fn(),
            getUnpaidSalesByTable: vi.fn(() => Promise.resolve([])),
            updateTable: vi.fn(),
            addTable: vi.fn(),
            deleteTable: vi.fn(),
        };

        tableService = new TableService(mockDb);
    });

    describe('calculateHourlyTotal', () => {
        it('should calculate hourly total for active hourly table', () => {
            const table = {
                type: 'hourly',
                isActive: true,
                openTime: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(), // 2 hours ago
                hourlyRate: 50,
            };

            const total = tableService.calculateHourlyTotal(table);
            expect(total).toBeCloseTo(100, 1); // 2 hours * 50
        });

        it('should return 0 for non-hourly table', () => {
            const table = {
                type: 'regular',
                isActive: true,
                openTime: new Date().toISOString(),
                hourlyRate: 50,
            };

            const total = tableService.calculateHourlyTotal(table);
            expect(total).toBe(0);
        });

        it('should return stored value for closed table', () => {
            const table = {
                type: 'hourly',
                isActive: false,
                openTime: new Date().toISOString(),
                closeTime: new Date().toISOString(),
                hourlyRate: 50,
                hourlyTotal: 150,
            };

            const total = tableService.calculateHourlyTotal(table);
            expect(total).toBe(150);
        });
    });

    describe('calculateCheckTotal', () => {
        it('should calculate check total (hourly + sales)', () => {
            const table = {
                type: 'hourly',
                isActive: true,
                openTime: new Date(Date.now() - 60 * 60 * 1000).toISOString(), // 1 hour ago
                hourlyRate: 50,
                salesTotal: 100,
            };

            const total = tableService.calculateCheckTotal(table);
            expect(total).toBeCloseTo(150, 1); // 50 (hourly) + 100 (sales)
        });

        it('should return sales total for regular table', () => {
            const table = {
                type: 'regular',
                salesTotal: 200,
            };

            const total = tableService.calculateCheckTotal(table);
            expect(total).toBe(200);
        });
    });

    describe('updateTableTotals', () => {
        it('should update table totals from unpaid sales', async () => {
            const table = {
                id: '1',
                type: 'regular',
                salesTotal: 0,
                checkTotal: 0,
            };

            const unpaidSales = [
                { saleTotal: 50 },
                { saleTotal: 75 },
            ];

            const updated = await tableService.updateTableTotals(table, unpaidSales);
            expect(updated.salesTotal).toBe(125);
            expect(updated.checkTotal).toBe(125);
        });

        it('should calculate hourly total for hourly table', async () => {
            const table = {
                id: '1',
                type: 'hourly',
                isActive: true,
                openTime: new Date(Date.now() - 60 * 60 * 1000).toISOString(), // 1 hour ago
                hourlyRate: 50,
                salesTotal: 0,
                checkTotal: 0,
            };

            const unpaidSales = [
                { saleTotal: 100 },
            ];

            const updated = await tableService.updateTableTotals(table, unpaidSales);
            expect(updated.salesTotal).toBe(100);
            expect(updated.hourlyTotal).toBeCloseTo(50, 1);
            expect(updated.checkTotal).toBeCloseTo(150, 1);
        });
    });

    describe('shouldAutoClose', () => {
        it('should return false for hourly tables', () => {
            const table = { type: 'hourly' };
            const unpaidSales = [];
            expect(tableService.shouldAutoClose(table, unpaidSales)).toBe(false);
        });

        it('should return false for instant tables', () => {
            const table = { type: 'instant' };
            const unpaidSales = [];
            expect(tableService.shouldAutoClose(table, unpaidSales)).toBe(false);
        });

        it('should return true for regular table with no sales and zero totals', () => {
            const table = {
                type: 'regular',
                checkTotal: 0,
                salesTotal: 0,
            };
            const unpaidSales = [];
            expect(tableService.shouldAutoClose(table, unpaidSales)).toBe(true);
        });

        it('should return false if table has unpaid sales', () => {
            const table = {
                type: 'regular',
                checkTotal: 0,
                salesTotal: 0,
            };
            const unpaidSales = [{ saleTotal: 50 }];
            expect(tableService.shouldAutoClose(table, unpaidSales)).toBe(false);
        });
    });

    describe('syncTableStatus', () => {
        it('should sync table status with unpaid sales', async () => {
            const table = {
                id: '1',
                type: 'regular',
                isActive: false,
                salesTotal: 0,
                checkTotal: 0,
            };

            mockDb.getUnpaidSalesByTable.mockResolvedValue([
                { saleTotal: 100 },
            ]);

            const synced = await tableService.syncTableStatus(table);
            expect(synced.isActive).toBe(true);
            expect(synced.salesTotal).toBe(100);
        });
    });
});
