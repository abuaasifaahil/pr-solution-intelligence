import { test, expect } from '@playwright/test';

const FE_URL = process.env.FE_URL ?? 'http://localhost:3000';
const A_EMAIL = 'user-a@test.local';
const A_PASSWORD = 'Password123!';

async function login(page: import('@playwright/test').Page): Promise<void> {
  await page.goto(`${FE_URL}/login`);
  await page.getByLabel('Email').fill(A_EMAIL);
  await page.getByLabel('Password').fill(A_PASSWORD);
  await page.getByRole('button', { name: /Sign In/i }).click();
  await expect(page).toHaveURL(FE_URL + '/');
}

test.describe('M3: chat flow', () => {
  test('home shows 5 agent cards after login', async ({ page }) => {
    await login(page);
    await expect(page.getByRole('heading', { name: /PR Impact Agent/i })).toBeVisible();
    await expect(page.getByRole('heading', { name: /Media Monitoring Agent/i })).toBeVisible();
    await expect(page.getByRole('heading', { name: /Media Measurement Agent/i })).toBeVisible();
    await expect(page.getByRole('heading', { name: /Reputation Index Agent/i })).toBeVisible();
    await expect(page.getByRole('heading', { name: /Crisis Management Agent/i })).toBeVisible();
  });

  test('clicking PR Impact Agent creates a chat and lands on /chat/:id', async ({ page }) => {
    await login(page);
    await page.getByRole('heading', { name: /PR Impact Agent/i }).click();
    await expect(page).toHaveURL(/\/chat\/[0-9a-f-]+/);
    // Welcome message + first chips visible
    await expect(page.getByText(/PR Impact|brand/i).first()).toBeVisible({ timeout: 30_000 });
  });

  test('full 6-step flow reaches "ready" state', async ({ page }) => {
    await login(page);
    await page.getByRole('heading', { name: /PR Impact Agent/i }).click();
    await expect(page).toHaveURL(/\/chat\/[0-9a-f-]+/);

    // welcome → click a welcome chip
    await page.getByRole('button', { name: /Analyze brand sentiment/i }).click();
    // awaiting_date → Weekly
    await page.getByRole('button', { name: /Weekly/i }).click();
    // awaiting_enrichment → Enrichment
    await page.getByRole('button', { name: /^Enrichment$/i }).click();
    // awaiting_brand → type brand
    await page.getByPlaceholder(/Type a message/i).fill('FreshSip');
    await page.getByRole('button', { name: /Send/i }).click();
    // awaiting_competitors → Top 5
    await page.getByRole('button', { name: /Top 5/i }).click();
    // awaiting_intention → Intention-based
    await page.getByRole('button', { name: /Intention-based/i }).click();

    // Should see a "Phase 2" line in the final reply
    await expect(page.getByText(/Phase 2/i)).toBeVisible({ timeout: 30_000 });
  });

  test('recent chats appear in the sidebar', async ({ page }) => {
    await login(page);
    await page.getByRole('heading', { name: /PR Impact Agent/i }).click();
    await page.goto(`${FE_URL}/`);
    // Sidebar should now list at least one chat
    await expect(page.getByRole('link', { name: /PR Impact Agent/i }).first()).toBeVisible();
  });
});
