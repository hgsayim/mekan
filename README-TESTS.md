# 🧪 Test Documentation

## Test Setup

This project uses:
- **Vitest** for unit tests
- **Playwright** for E2E tests

## Installation

```bash
npm install
```

## Running Tests

### Unit Tests
```bash
# Run all unit tests
npm test

# Run with UI
npm run test:ui

# Run with coverage
npm run test:coverage
```

### E2E Tests
```bash
# Run all E2E tests
npm run test:e2e

# Run with UI
npm run test:e2e:ui
```

### All Tests
```bash
npm run test:all
```

## Test Structure

```
test/
  ├── setup.js              # Test setup and mocks
  └── utils.test.js         # Unit tests for utility functions

e2e/
  └── table-operations.spec.js  # E2E tests for table operations
```

## Writing Tests

### Unit Tests
Unit tests are located in `test/` directory. Each test file should:
- Import necessary functions/classes
- Use `describe` and `it` blocks
- Use `expect` for assertions

Example:
```javascript
import { describe, it, expect } from 'vitest';
import { formatDateTimeWithoutSeconds } from '../src/utils/formatters.js';

describe('formatDateTimeWithoutSeconds', () => {
  it('should format date correctly', () => {
    const date = new Date('2024-01-15T14:30:00');
    const formatted = formatDateTimeWithoutSeconds(date.toISOString());
    expect(formatted).toBe('15.01.2024 14:30');
  });
});
```

### E2E Tests
E2E tests are located in `e2e/` directory. They use Playwright to test:
- User interactions
- Navigation
- Modal operations
- Form submissions

Example:
```javascript
import { test, expect } from '@playwright/test';

test('should open table modal', async ({ page }) => {
  await page.goto('/');
  const tableCard = page.locator('.table-card').first();
  await tableCard.click();
  await expect(page.locator('#table-modal.active')).toBeVisible();
});
```

## Coverage Goals

- **Unit Tests**: > 80% coverage
- **E2E Tests**: All critical user flows

## Continuous Integration

Tests run automatically on:
- Pull requests
- Commits to main branch

## Performance Testing

Performance tests are included in E2E suite:
- Page load times
- Interaction responsiveness
- Memory usage
