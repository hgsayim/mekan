import { describe, it, expect, vi, beforeEach } from 'vitest';
import { debounce, throttle } from '../src/utils/performance.js';
import { formatDateTimeWithoutSeconds, formatTimeOnly, formatHoursToReadable } from '../src/utils/formatters.js';
import { calculateHoursUsed, calculateHoursBetween } from '../src/utils/calculators.js';

describe('Performance Utilities', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  describe('debounce', () => {
    it('should delay function execution', () => {
      const mockFn = vi.fn();
      const debounced = debounce(mockFn, 100);

      debounced();
      expect(mockFn).not.toHaveBeenCalled();

      vi.advanceTimersByTime(50);
      debounced();
      expect(mockFn).not.toHaveBeenCalled();

      vi.advanceTimersByTime(100);
      expect(mockFn).toHaveBeenCalledTimes(1);
    });

    it('should cancel previous calls', () => {
      const mockFn = vi.fn();
      const debounced = debounce(mockFn, 100);

      debounced();
      debounced();
      debounced();

      vi.advanceTimersByTime(100);
      expect(mockFn).toHaveBeenCalledTimes(1);
    });
  });

  describe('throttle', () => {
    it('should limit function execution rate', () => {
      const mockFn = vi.fn();
      const throttled = throttle(mockFn, 100);

      throttled();
      expect(mockFn).toHaveBeenCalledTimes(1);

      throttled();
      throttled();
      vi.advanceTimersByTime(50);
      expect(mockFn).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(50);
      throttled();
      expect(mockFn).toHaveBeenCalledTimes(2);
    });
  });
});

describe('Formatter Utilities', () => {
  describe('formatDateTimeWithoutSeconds', () => {
    it('should format date correctly', () => {
      const date = new Date('2024-01-15T14:30:00');
      const formatted = formatDateTimeWithoutSeconds(date.toISOString());
      // Timezone may vary, so check format structure
      expect(formatted).toMatch(/\d{2}\.\d{2}\.\d{4} \d{2}:\d{2}/);
    });

    it('should pad single digit values', () => {
      const date = new Date('2024-01-05T09:05:00');
      const formatted = formatDateTimeWithoutSeconds(date.toISOString());
      expect(formatted).toMatch(/\d{2}\.\d{2}\.\d{4} \d{2}:\d{2}/);
    });

    it('should handle null/undefined', () => {
      expect(formatDateTimeWithoutSeconds(null)).toBe('');
      expect(formatDateTimeWithoutSeconds(undefined)).toBe('');
    });
  });

  describe('formatTimeOnly', () => {
    it('should format time correctly', () => {
      const date = new Date('2024-01-15T14:30:00');
      const formatted = formatTimeOnly(date.toISOString());
      expect(formatted).toMatch(/\d{2}:\d{2}/);
    });

    it('should pad single digit hours and minutes', () => {
      const date = new Date('2024-01-15T09:05:00');
      const formatted = formatTimeOnly(date.toISOString());
      expect(formatted).toMatch(/\d{2}:\d{2}/);
    });
  });

  describe('formatHoursToReadable', () => {
    it('should format minutes correctly', () => {
      expect(formatHoursToReadable(0.5)).toBe('30 dk');
      expect(formatHoursToReadable(0.25)).toBe('15 dk');
    });

    it('should format hours correctly', () => {
      expect(formatHoursToReadable(2)).toBe('2 saat');
      expect(formatHoursToReadable(1)).toBe('1 saat');
    });

    it('should format hours and minutes correctly', () => {
      expect(formatHoursToReadable(1.5)).toBe('1 saat 30 dk');
      expect(formatHoursToReadable(2.25)).toBe('2 saat 15 dk');
    });

    it('should handle zero', () => {
      expect(formatHoursToReadable(0)).toBe('0 dk');
      expect(formatHoursToReadable(null)).toBe('0 dk');
    });
  });
});

describe('Calculator Utilities', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  describe('calculateHoursUsed', () => {
    it('should calculate hours correctly', () => {
      const now = new Date('2024-01-15T15:00:00');
      vi.setSystemTime(now);
      const oneHourAgo = new Date('2024-01-15T14:00:00');
      const hours = calculateHoursUsed(oneHourAgo.toISOString());
      expect(hours).toBeCloseTo(1, 1);
    });

    it('should handle minutes correctly', () => {
      const now = new Date('2024-01-15T14:30:00');
      vi.setSystemTime(now);
      const thirtyMinutesAgo = new Date('2024-01-15T14:00:00');
      const hours = calculateHoursUsed(thirtyMinutesAgo.toISOString());
      expect(hours).toBeCloseTo(0.5, 1);
    });

    it('should return 0 for invalid dates', () => {
      expect(calculateHoursUsed(null)).toBe(0);
      expect(calculateHoursUsed(undefined)).toBe(0);
    });
  });

  describe('calculateHoursBetween', () => {
    it('should calculate hours between two dates', () => {
      const start = new Date('2024-01-15T10:00:00');
      const end = new Date('2024-01-15T12:00:00');
      const hours = calculateHoursBetween(start.toISOString(), end.toISOString());
      expect(hours).toBe(2);
    });

    it('should handle 30 minutes correctly', () => {
      const start = new Date('2024-01-15T10:00:00');
      const end = new Date('2024-01-15T10:30:00');
      const hours = calculateHoursBetween(start.toISOString(), end.toISOString());
      expect(hours).toBeCloseTo(0.5, 1);
    });

    it('should return 0 for invalid dates', () => {
      expect(calculateHoursBetween(null, null)).toBe(0);
      expect(calculateHoursBetween(undefined, undefined)).toBe(0);
    });
  });
});
