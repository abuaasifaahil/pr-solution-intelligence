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

test.describe('M5: Settings tabs', () => {
  test('sidebar Settings link opens /settings/data-sources and tab strip navigates all 5', async ({ page }) => {
    await login(page);

    // Click the Settings sidebar entry.
    await page.getByRole('link', { name: /^Settings$/ }).click();
    await expect(page).toHaveURL(/\/settings\/data-sources$/);
    await expect(page.getByRole('heading', { name: /Data Sources/i })).toBeVisible();

    // Navigate via the tab strip.
    for (const [slug, heading] of [
      ['mcp',    'MCP Connections'],
      ['model',  'Model'],
      ['skills', 'Skills'],
      ['agents', 'Agents'],
    ] as const) {
      await page.getByRole('link', { name: new RegExp(`^${slug.replace('-', ' ')}$|^${heading}`, 'i') }).first().click();
      await expect(page).toHaveURL(new RegExp(`/settings/${slug}$`));
      await expect(page.getByRole('heading', { name: new RegExp(heading, 'i') })).toBeVisible();
    }
  });

  test('Data Sources: add a custom row, see it in the list, then delete it', async ({ page }) => {
    await login(page);
    await page.goto(`${FE_URL}/settings/data-sources`);

    await page.getByRole('button', { name: /^\+ Add Source$/ }).click();
    // The modal opens — fill it in for "Custom".
    await page.locator('select').first().selectOption('custom');
    await page.locator('input').nth(0).fill('My Custom Feed');     // displayName
    await page.locator('input[type="password"]').first().fill('sk-test-1234567890abcdef');
    await page.getByRole('button', { name: /^Create$/ }).click();

    // Card should appear with the display name.
    await expect(page.getByText('My Custom Feed')).toBeVisible({ timeout: 5000 });

    // Delete it.
    page.on('dialog', (d) => d.accept());
    await page.getByRole('button', { name: /^Remove$/ }).first().click();
    await expect(page.getByText('My Custom Feed')).not.toBeVisible({ timeout: 5000 });
  });

  test('Model: change provider + save persists across reload', async ({ page }) => {
    await login(page);
    await page.goto(`${FE_URL}/settings/model`);

    // Select Claude tile.
    await page.getByRole('button', { name: /Claude/i }).first().click();
    // Type a fresh API key (so the save succeeds even on first-time setup).
    await page.locator('input[type="password"]').first().fill('sk-ant-test-keyaaaaaaaaaaaaa');
    // Max tokens to 8000.
    await page.locator('input[type="number"]').fill('8000');
    // Temperature slider — fire the change at value 0.7.
    await page.locator('input[type="range"]').fill('0.7');

    await page.getByRole('button', { name: /^Save$/ }).click();
    await expect(page.getByText(/Saved\./i)).toBeVisible({ timeout: 5000 });

    // Reload and confirm the persisted values come back.
    await page.reload();
    await expect(page.locator('input[type="number"]')).toHaveValue('8000');
    await expect(page.locator('input[type="range"]')).toHaveValue('0.7');
  });

  test('Skills: add a custom skill, toggle it off, reload, confirm persisted off', async ({ page }) => {
    await login(page);
    await page.goto(`${FE_URL}/settings/skills`);

    // Seeded defaults render with locked toggles. Add a fresh custom skill.
    const unique = `e2e_skill_${Date.now()}`;
    await page.getByRole('button', { name: /^\+ Add Skill$/ }).click();
    await page.locator('input').nth(0).fill(unique);
    await page.locator('textarea').fill('Created by e2e test');
    await page.getByRole('button', { name: /^Create$/ }).click();

    // Wait for the card to render with isEnabled=true.
    const card = page.locator('div', { hasText: unique }).first();
    await expect(card).toBeVisible({ timeout: 5000 });

    // Toggle it off.
    const toggle = card.getByRole('switch');
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'false');

    // Reload — must still be off.
    await page.reload();
    const reloadedCard = page.locator('div', { hasText: unique }).first();
    await expect(reloadedCard.getByRole('switch')).toHaveAttribute('aria-checked', 'false');
  });
});
