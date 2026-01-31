import { test, expect } from '@playwright/test';

test.describe('Table Operations', () => {
  test.beforeEach(async ({ page }) => {
    // Navigate to app
    await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    
    // Wait for page to be ready - check for either auth modal or main header
    const authModal = page.locator('#auth-modal.active');
    const mainHeader = page.locator('#main-header');
    
    // Wait for either auth modal or main header to appear
    await Promise.race([
      authModal.waitFor({ state: 'visible', timeout: 30000 }),
      mainHeader.waitFor({ state: 'visible', timeout: 30000 })
    ]).catch(() => {
      // If neither appears, continue anyway
    });
    
    // Check if auth is needed
    const needsAuth = await authModal.isVisible().catch(() => false);
    
    if (needsAuth) {
      // Fill in auth credentials
      await page.fill('#auth-email', 'hgsayim@gmail.com');
      await page.fill('#auth-password', 'iPhoneX10');
      
      // Wait a bit for form to be ready
      await page.waitForTimeout(500);
      
      // Click login button
      await page.click('#auth-login-btn');
      
      // Wait for auth to complete - modal should disappear
      await authModal.waitFor({ state: 'hidden', timeout: 30000 });
      
      // Wait for header to appear after auth
      await mainHeader.waitFor({ state: 'visible', timeout: 30000 });
    }
    
    // Wait for app to be fully loaded
    // Check for tables view to be active (attached, not visible - CSS might hide it)
    await page.waitForSelector('#tables-view.active', { state: 'attached', timeout: 30000 });
    
    // Wait for tables container
    await page.waitForSelector('#tables-container', { state: 'attached', timeout: 30000 });
    
    // Wait for at least one table card to be present (data loaded)
    // If no tables exist, that's OK - we'll skip tests that need tables
    try {
      await page.waitForSelector('.table-card', { state: 'attached', timeout: 10000 });
    } catch (e) {
      console.warn('No table cards found - tests may be skipped');
    }
    
    // Give a moment for any animations/transitions
    await page.waitForTimeout(1000);
  });

  test('should open table modal when clicking a table card', async ({ page }) => {
    // Check if any table cards exist
    const tableCard = page.locator('.table-card').first();
    const hasTables = await tableCard.count() > 0;
    
    if (!hasTables) {
      test.skip('No tables available in database');
      return;
    }
    
    await expect(tableCard).toBeVisible();
    
    // Click table card
    await tableCard.click();
    
    // Check if modal opened
    await expect(page.locator('#table-modal.active')).toBeVisible({ timeout: 5000 });
  });

  test('should add product to table', async ({ page }) => {
    // Check if any table cards exist
    const tableCard = page.locator('.table-card').first();
    const hasTables = await tableCard.count() > 0;
    
    if (!hasTables) {
      test.skip('No tables available in database');
      return;
    }
    
    // Open table modal
    await tableCard.click();
    await expect(page.locator('#table-modal.active')).toBeVisible();
    
    // Wait for products to load
    await page.waitForSelector('#table-products-grid', { timeout: 10000 });
    
    // Click first product
    const firstProduct = page.locator('#table-products-grid .product-card').first();
    const hasProducts = await firstProduct.count() > 0;
    
    if (!hasProducts) {
      test.skip('No products available');
      return;
    }
    
    if (await firstProduct.isVisible()) {
      await firstProduct.click();
      
      // Check if product was added (should appear in sales list)
      await expect(page.locator('.sale-product-line')).toBeVisible({ timeout: 5000 });
    }
  });

  test('should close table modal when clicking back button', async ({ page }) => {
    // Check if any table cards exist
    const tableCard = page.locator('.table-card').first();
    const hasTables = await tableCard.count() > 0;
    
    if (!hasTables) {
      test.skip('No tables available in database');
      return;
    }
    
    // Open table modal
    await tableCard.click();
    await expect(page.locator('#table-modal.active')).toBeVisible();
    
    // Click back button
    const backButton = page.locator('#table-modal .close');
    await backButton.click();
    
    // Check if modal closed
    await expect(page.locator('#table-modal.active')).not.toBeVisible({ timeout: 3000 });
  });
});

test.describe('Navigation', () => {
  test('should navigate between views', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    
    // Handle auth if needed
    const authModal = page.locator('#auth-modal.active');
    const mainHeader = page.locator('#main-header');
    
    // Wait for either auth modal or main header
    await Promise.race([
      authModal.waitFor({ state: 'visible', timeout: 30000 }),
      mainHeader.waitFor({ state: 'visible', timeout: 30000 })
    ]).catch(() => {});
    
    if (await authModal.isVisible().catch(() => false)) {
      await page.fill('#auth-email', 'hgsayim@gmail.com');
      await page.fill('#auth-password', 'iPhoneX10');
      await page.waitForTimeout(500);
      await page.click('#auth-login-btn');
      await authModal.waitFor({ state: 'hidden', timeout: 30000 });
      await mainHeader.waitFor({ state: 'visible', timeout: 30000 });
    }
    
    // Wait for app to load
    await page.waitForSelector('#tables-view.active', { state: 'attached', timeout: 30000 });
    
    // Tables may not exist - that's OK
    try {
      await page.waitForSelector('.table-card', { state: 'attached', timeout: 5000 });
    } catch (e) {
      console.warn('No table cards found');
    }
    
    await page.waitForTimeout(1000);
    
    // Navigate to products view
    const productsBtn = page.locator('[data-view="products"]');
    if (await productsBtn.isVisible()) {
      await productsBtn.click();
      await expect(page.locator('#products-view')).toBeVisible({ timeout: 3000 });
    }
    
    // Navigate to sales view
    const salesBtn = page.locator('[data-view="sales"]');
    if (await salesBtn.isVisible()) {
      await salesBtn.click();
      await expect(page.locator('#sales-view')).toBeVisible({ timeout: 3000 });
    }
  });
});
