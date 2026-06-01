/**
 * M9.10 — Phase 3.5 settings e2e.
 *
 * Validates the M9.9 surfaces added to Settings:
 *  1. "My Agents & Skills" tab — create + delete a `user_agent`
 *  2. "My Agents & Skills" tab — create a `composable_skill`, verifying
 *     the modal's JSON-validation guard rejects malformed manifests
 *  3. "Data Sources" tab — the OpenSearchOverridePanel shows the
 *     org-default badge when no override exists, and reveals the form
 *     when the user clicks "Configure my own"
 *
 * Smoke-checks the backend up front; whole suite skips when API is
 * unreachable — matches M5/M7/M8 e2e convention.
 *
 * @file tests/e2e/m9-phase3.5-settings.spec.ts
 */
import { test, expect, request } from '@playwright/test';

const API_URL = process.env.API_URL ?? 'http://localhost:3001';
const FE_URL = process.env.FE_URL ?? 'http://localhost:3000';
const A_EMAIL = 'user-a@test.local';
const A_PASSWORD = 'Password123!';

let backendOk = false;
test.beforeAll(async () => {
  try {
    const ctx = await request.newContext();
    const res = await ctx.get(`${API_URL}/healthz`, { timeout: 3000 });
    if (res.status() === 200) {
      const body = await res.json();
      backendOk = body.ok === true && body.db === 'ok' && body.redis === 'ok';
    }
  } catch {
    backendOk = false;
  }
});

async function login(page: import('@playwright/test').Page): Promise<void> {
  await page.goto(`${FE_URL}/login`);
  await page.getByLabel('Email').fill(A_EMAIL);
  await page.getByLabel('Password').fill(A_PASSWORD);
  await page.getByRole('button', { name: /Sign In/i }).click();
  await expect(page).toHaveURL(FE_URL + '/');
}

test.describe('M9.10 — Phase 3.5 Settings surfaces', () => {
  test.beforeEach(async ({ page }) => {
    test.skip(!backendOk, 'backend smoke failed — start API + DB + Redis to run');
    await login(page);
  });

  test('My Agents & Skills: create + delete a user_agent', async ({ page }) => {
    await page.goto(`${FE_URL}/settings/my-agents-skills`);
    await expect(
      page.getByRole('heading', { name: /My Agents & Skills/i }),
    ).toBeVisible();

    // Open the new-agent modal.
    await page.getByTestId('new-user-agent-button').click();
    await expect(page.getByTestId('new-user-agent-modal')).toBeVisible();

    // Fill the form. Use a unique name so a stale row from a previous
    // run doesn't false-positive the visibility assertion.
    const uniqueName = `E2E Agent ${Date.now()}`;
    await page.getByTestId('ua-name-input').fill(uniqueName);
    await page.getByTestId('ua-base-pr_impact').check();
    await page
      .getByTestId('ua-description-input')
      .fill('Created by m9.10 e2e — safe to delete');

    // Auto-accept the browser confirm dialog when delete fires later.
    page.on('dialog', (d) => d.accept());

    await page.getByTestId('ua-submit').click();
    // Modal closes; row appears in the list.
    await expect(page.getByTestId('new-user-agent-modal')).toBeHidden({
      timeout: 5_000,
    });
    const row = page.locator('div').filter({ hasText: uniqueName }).first();
    await expect(row).toBeVisible({ timeout: 5_000 });

    // Locate the delete button for the row we just created.
    const deleteButton = page.getByRole('button', {
      name: new RegExp(`Delete ${uniqueName}$`, 'i'),
    });
    await expect(deleteButton).toBeVisible();
    await deleteButton.click();

    // The row should disappear once the DELETE settles.
    await expect(
      page.locator('div').filter({ hasText: uniqueName }).first(),
    ).toBeHidden({ timeout: 5_000 });
  });

  test('My Agents & Skills: create user_private skill with JSON-validation guard', async ({
    page,
  }) => {
    await page.goto(`${FE_URL}/settings/my-agents-skills`);
    await page.getByTestId('new-composable-skill-button').click();
    await expect(page.getByTestId('new-composable-skill-modal')).toBeVisible();

    const uniqueName = `e2e_skill_${Date.now()}`;
    await page.getByTestId('cs-name-input').fill(uniqueName);
    await page.getByTestId('cs-kind-select').selectOption('analysis_skill');
    await page
      .getByTestId('cs-description-input')
      .fill('Created by m9.10 e2e');

    // First submit a malformed manifest — must trigger an inline error
    // and keep the modal open.
    await page.getByTestId('cs-manifest-input').fill('not json');
    await page.getByTestId('cs-submit').click();
    await expect(page.getByRole('alert')).toContainText(
      /not valid JSON|JSON/i,
      { timeout: 5_000 },
    );
    await expect(page.getByTestId('new-composable-skill-modal')).toBeVisible();

    // Replace with valid JSON object → submit succeeds.
    await page
      .getByTestId('cs-manifest-input')
      .fill('{"description": "created by e2e"}');
    await page.getByTestId('cs-submit').click();

    // Modal closes; the new skill row appears.
    await expect(page.getByTestId('new-composable-skill-modal')).toBeHidden({
      timeout: 5_000,
    });
    await expect(page.locator(`text=${uniqueName}`).first()).toBeVisible({
      timeout: 5_000,
    });
  });

  test('Data Sources: OpenSearch override panel shows org-default + reveals form', async ({
    page,
  }) => {
    await page.goto(`${FE_URL}/settings/data-sources`);

    // The panel surfaces a status badge — for Alice (no override seeded)
    // the badge reads "Using organization OpenSearch".
    const panel = page.getByTestId('opensearch-override-panel');
    await expect(panel).toBeVisible({ timeout: 5_000 });

    const orgBadge = page.getByTestId('opensearch-status-org-default');
    const overrideBadge = page.getByTestId('opensearch-status-override');

    // One of the two badges must appear; org-default is the default
    // when no row is seeded for user-a. Don't fail if a previous test
    // left an override — assert that *some* badge surfaced.
    const badgeAppeared = await Promise.race([
      orgBadge.waitFor({ state: 'visible', timeout: 5_000 }).then(() => 'org'),
      overrideBadge
        .waitFor({ state: 'visible', timeout: 5_000 })
        .then(() => 'override'),
    ]).catch(() => null);
    expect(badgeAppeared).not.toBeNull();

    // "Configure my own" / "Edit override" toggles the form open with
    // the URL + username + password + index inputs.
    const configureBtn = page.getByRole('button', {
      name: /Configure my own|Edit override/i,
    });
    await expect(configureBtn).toBeVisible();
    await configureBtn.click();
    await expect(page.getByTestId('os-url-input')).toBeVisible();
    await expect(page.getByTestId('os-username-input')).toBeVisible();
    await expect(page.getByTestId('os-password-input')).toBeVisible();
    await expect(page.getByTestId('os-test-button')).toBeVisible();
    await expect(page.getByTestId('os-save-button')).toBeVisible();
  });
});
