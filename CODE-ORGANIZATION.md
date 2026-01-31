# 📁 Code Organization Guide

## Project Structure

```
MekanApp/
├── src/                    # Source code (modular)
│   ├── utils/              # Utility functions
│   │   ├── formatters.js   # Date/time/currency formatting
│   │   ├── calculators.js  # Calculation functions
│   │   ├── performance.js  # Debounce, throttle
│   │   ├── performance-monitor.js  # Performance monitoring
│   │   └── lazy-loader.js   # Lazy loading utilities
│   ├── services/           # Business logic services
│   │   ├── TableService.js # Table operations
│   │   ├── ProductService.js # Product operations (future)
│   │   └── SaleService.js  # Sale operations (future)
│   └── components/         # UI components (future)
│       ├── TableCard.js    # Table card component
│       └── ProductCard.js  # Product card component
├── test/                   # Unit tests
│   ├── setup.js
│   └── utils.test.js
├── e2e/                    # E2E tests
│   └── table-operations.spec.js
├── app.js                  # Main application (legacy - to be refactored)
├── hybrid-db.js           # Database layer
├── supabase-db.js         # Supabase adapter
└── index.html             # Main HTML
```

## Architecture Principles

### 1. Separation of Concerns
- **Utils**: Pure functions, no side effects
- **Services**: Business logic, data operations
- **Components**: UI rendering, user interactions
- **Main App**: Orchestration, event handling

### 2. Service Layer Pattern
Services encapsulate business logic:
```javascript
// TableService.js
export class TableService {
    async updateTableTotals(table, unpaidSales) {
        // Business logic here
    }
}
```

### 3. Utility Functions
Pure, testable functions:
```javascript
// utils/formatters.js
export function formatDateTimeWithoutSeconds(dateString) {
    // Pure function, no side effects
}
```

### 4. Lazy Loading
Load code on demand:
```javascript
// utils/lazy-loader.js
const loadTableModal = lazyLoad(() => import('./components/TableModal.js'));
```

## Migration Strategy

### Phase 1: Extract Utilities ✅
- [x] Extract formatters to `src/utils/formatters.js`
- [x] Extract calculators to `src/utils/calculators.js`
- [x] Extract performance utils to `src/utils/performance.js`

### Phase 2: Create Services ✅
- [x] Create `TableService` for table operations
- [ ] Create `ProductService` for product operations
- [ ] Create `SaleService` for sale operations

### Phase 3: Component Extraction (Future)
- [ ] Extract table card to component
- [ ] Extract product card to component
- [ ] Extract modals to components

### Phase 4: Main App Refactoring (Future)
- [ ] Break down `app.js` into smaller modules
- [ ] Use services instead of direct DB calls
- [ ] Implement proper dependency injection

## Best Practices

### 1. Import Organization
```javascript
// External dependencies
import { createClient } from '@supabase/supabase-js';

// Internal utilities
import { formatDateTime } from './utils/formatters.js';
import { debounce } from './utils/performance.js';

// Services
import { TableService } from './services/TableService.js';
```

### 2. Function Naming
- **Utils**: `formatX`, `calculateX`, `parseX`
- **Services**: `getX`, `createX`, `updateX`, `deleteX`
- **Components**: `renderX`, `handleX`, `setupX`

### 3. Error Handling
```javascript
// Services should handle errors
async updateTableTotals(table, unpaidSales) {
    try {
        // Business logic
    } catch (error) {
        console.error('Error updating table totals:', error);
        throw error; // Re-throw for caller to handle
    }
}
```

### 4. Testing
- Utils: Unit tests (100% coverage goal)
- Services: Unit tests with mocks
- Components: Integration tests
- Main App: E2E tests

## Performance Considerations

### Code Splitting
- Lazy load heavy components
- Split routes if using routing
- Dynamic imports for optional features

### Caching
- Cache utility function results
- Cache service responses
- Use memoization for expensive calculations

### Bundle Size
- Tree-shake unused code
- Use ES modules
- Minimize dependencies

## Future Improvements

1. **TypeScript Migration**: Add type safety
2. **State Management**: Consider Redux/Zustand for complex state
3. **Routing**: Add client-side routing if needed
4. **Build System**: Optimize with Vite/Rollup
5. **Component Library**: Build reusable component library
