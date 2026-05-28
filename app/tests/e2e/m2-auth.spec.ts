import { test, expect } from '@playwright/test';

const FE_URL = process.env.FE_URL ?? 'http://localhost:3000';
const A_EMAIL = 'user-a@test.local';
const A_PASSWORD = 'Password123!';

test.describe('M2: auth flow', () => {
  test('unauthenticated visit to / redirects to /login', async ({ page }) => {
    await page.goto(FE_URL);
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByText('PR Solution Intelligence', { exact: true })).toBeVisible();
  });

  test('valid credentials log in and redirect to home', async ({ page }) => {
    await page.goto(`${FE_URL}/login`);
    await page.getByLabel('Email').fill(A_EMAIL);
    await page.getByLabel('Password').fill(A_PASSWORD);
    await page.getByRole('button', { name: /Sign In/i }).click();
    await expect(page).toHaveURL(FE_URL + '/');
    // Greeting includes the seeded display name
    await expect(page.getByText(/Alice/i)).toBeVisible();
  });

  test('invalid credentials show error message', async ({ page }) => {
    await page.goto(`${FE_URL}/login`);
    await page.getByLabel('Email').fill(A_EMAIL);
    await page.getByLabel('Password').fill('WRONG');
    await page.getByRole('button', { name: /Sign In/i }).click();
    await expect(page.getByRole('alert').filter({ hasText: /Invalid email or password/i })).toBeVisible();
  });

  test('sign out clears session and redirects', async ({ page }) => {
    await page.goto(`${FE_URL}/login`);
    await page.getByLabel('Email').fill(A_EMAIL);
    await page.getByLabel('Password').fill(A_PASSWORD);
    await page.getByRole('button', { name: /Sign In/i }).click();
    await expect(page).toHaveURL(FE_URL + '/');
    await page.getByRole('button', { name: /Sign out/i }).click();
    await expect(page).toHaveURL(/\/login$/);
  });
});
