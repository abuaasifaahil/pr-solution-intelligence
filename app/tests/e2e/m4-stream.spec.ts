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

test.describe('M4: WebSocket streaming', () => {
  test('assistant reply streams progressively (chunks visible)', async ({ page }) => {
    await login(page);
    await page.getByRole('heading', { name: /PR Impact Agent/i }).click();
    await expect(page).toHaveURL(/\/chat\/[0-9a-f-]+/);

    // Click the welcome chip — kicks off the first streamed reply.
    await page.getByRole('button', { name: /Analyze brand sentiment/i }).click();

    // Wait for the empty placeholder assistant bubble to appear with at least one char.
    const lastAssistantBubble = page
      .locator('[data-role="assistant"]')
      .last();
    await expect(lastAssistantBubble).toBeVisible({ timeout: 5000 });

    // Capture intermediate length, then final length — assert intermediate is shorter.
    // Poll quickly to grab a mid-stream snapshot.
    let intermediate = '';
    for (let i = 0; i < 50; i++) {
      const t = (await lastAssistantBubble.textContent()) ?? '';
      if (t.length > 5) { intermediate = t; break; }
      await page.waitForTimeout(40);
    }
    expect(intermediate.length).toBeGreaterThan(0);

    // Wait for the stream to settle (chips appear when typing:stop fires).
    await expect(page.getByRole('button', { name: /Weekly/i })).toBeVisible({ timeout: 30_000 });

    const final = (await lastAssistantBubble.textContent()) ?? '';
    expect(final.length).toBeGreaterThan(intermediate.length);
    expect(final).not.toBe(intermediate);
  });

  test('full flow still reaches "ready" state with streaming', async ({ page }) => {
    await login(page);
    await page.getByRole('heading', { name: /PR Impact Agent/i }).click();
    await expect(page).toHaveURL(/\/chat\/[0-9a-f-]+/);

    await page.getByRole('button', { name: /Analyze brand sentiment/i }).click();
    await expect(page.getByRole('button', { name: /Weekly/i })).toBeVisible({ timeout: 30_000 });
    await page.getByRole('button', { name: /Weekly/i }).click();
    await expect(page.getByRole('button', { name: /^Enrichment$/i })).toBeVisible({ timeout: 30_000 });
    await page.getByRole('button', { name: /^Enrichment$/i }).click();
    // awaiting_brand: free-text → use chat input.
    await expect(page.getByPlaceholder(/Type a message/i)).toBeEnabled({ timeout: 30_000 });
    await page.getByPlaceholder(/Type a message/i).fill('FreshSip');
    await page.getByRole('button', { name: /Send/i }).click();
    await expect(page.getByRole('button', { name: /Top 5/i })).toBeVisible({ timeout: 30_000 });
    await page.getByRole('button', { name: /Top 5/i }).click();
    await expect(page.getByRole('button', { name: /Intention-based/i })).toBeVisible({ timeout: 30_000 });
    await page.getByRole('button', { name: /Intention-based/i }).click();

    // Final reply mentions Phase 2.
    await expect(page.getByText(/Phase 2/i)).toBeVisible({ timeout: 30_000 });
  });
});
