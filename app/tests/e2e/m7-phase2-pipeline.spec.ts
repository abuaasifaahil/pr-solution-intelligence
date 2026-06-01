/**
 * M7.10 — Phase 2 happy-path Playwright e2e.
 *
 * Walks the entire Phase 2 user journey through the live FE + BE:
 *   1. Login as Alice
 *   2. Click PR Impact agent → new chat
 *   3. Upload a small CSV via the FileDropZone hidden <input>
 *   4. Wait for UploadProgressCard → status='ready'; DataPreviewTable visible
 *   5. Walk the chip flow (enrichment → brand → competitors → intention)
 *   6. BooleanQueryPreview → Confirm & Process
 *   7. ProcessingSteps card → all 7 rows flip to ✓
 *   8. CompletionSummary card visible with article + domain counts
 *
 * Skips when the backend smoke check fails — same pattern as
 * `m4-stream.spec.ts`. Commit-and-run-against-live is the intent; this
 * spec is NOT part of the local CI default.
 *
 * @file tests/e2e/m7-phase2-pipeline.spec.ts
 */
import { test, expect, request } from '@playwright/test';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const API_URL = process.env.API_URL ?? 'http://localhost:3001';
const FE_URL = process.env.FE_URL ?? 'http://localhost:3000';
const A_EMAIL = 'user-a@test.local';
const A_PASSWORD = 'Password123!';

// ── Smoke check the backend; skip the whole suite if it can't be reached.
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

/** Write a small CSV to a temp file and return its absolute path. */
function tempCsvPath(): string {
  const tmp = path.join(os.tmpdir(), `prsi-m7-10-${Date.now()}.csv`);
  const rows = [
    'title,content,source,published_date,url',
    'AMX Series B,Round of $50M,TechCrunch,2025-03-10,https://www.techcrunch.com/a',
    'IPO filed,Filing today,Reuters,2025-03-12,https://reuters.com/b',
    'Hiring spree,200 new roles,WSJ,2025-03-15,https://www.wsj.com/c',
    'Earnings beat,Q1 results,Bloomberg,2025-03-20,https://bloomberg.com/d',
  ];
  fs.writeFileSync(tmp, rows.join('\n'), 'utf8');
  return tmp;
}

test.describe('M7.10 — Phase 2 full pipeline', () => {
  test('Alice: upload → chip flow → query → 7-step processing → completion', async ({ page }) => {
    test.skip(!backendOk, 'backend smoke failed — start API + DB + Redis to run this');

    // 1. Login as Alice.
    await login(page);

    // 2. Open a PR Impact chat.
    await page.getByRole('heading', { name: /PR Impact Agent/i }).click();
    await expect(page).toHaveURL(/\/chat\/[0-9a-f-]+/);

    // 3. Upload a CSV. The FileDropZone renders a hidden <input type="file">
    //    — Playwright's setInputFiles bypasses the drag-drop event and feeds
    //    the same code path the picker dialog would.
    const csv = tempCsvPath();
    const hiddenInput = page.locator('input[type="file"]');
    await expect(hiddenInput).toBeAttached({ timeout: 15_000 });
    await hiddenInput.setInputFiles(csv);

    // 4. UploadProgressCard appears, status flips to 'ready'. The card sets
    //    a data-status attribute reflecting the lifecycle.
    const progressCard = page.locator('[data-status]').first();
    await expect(progressCard).toBeVisible({ timeout: 15_000 });
    // Wait for ready — parse worker should land in <5s for 4 rows.
    await expect(progressCard).toHaveAttribute('data-status', 'ready', {
      timeout: 20_000,
    });

    // 5. Walk the chip flow.
    //    a) collect_enrichment — pick Standard.
    await page.getByRole('button', { name: /^Standard$/i }).click({ timeout: 15_000 });

    //    b) collect_brand — BrandInput shows a text input + Continue button.
    const brandInput = page.getByLabel(/Brand name$/i);
    await expect(brandInput).toBeVisible({ timeout: 15_000 });
    await brandInput.fill('AMX');
    await page.getByRole('button', { name: /Continue/i }).click();

    //    c) collect_competitors — pick Top 3 then Continue.
    //    (Brand-suggest is an LLM call; we click whichever tab the UI lands
    //     on, then submit. If suggestions fail we fall back to Custom.)
    await expect(page.getByRole('tab', { name: /Top 3/i })).toBeVisible({
      timeout: 15_000,
    });
    await page.getByRole('tab', { name: /Top 3/i }).click();
    // Wait for at least one competitor pill OR the loading skeleton to
    // resolve. If nothing arrives in 10s, fall back to Custom + Reuters.
    const anyPill = page.locator('span', { hasText: /^[A-Z]/ }).first();
    try {
      await expect(anyPill).toBeVisible({ timeout: 8_000 });
    } catch {
      await page.getByRole('tab', { name: /Custom/i }).click();
      await page.getByLabel(/Add competitor/i).fill('Reuters');
      await page.getByRole('button', { name: /^Add$/i }).click();
    }
    await page.getByRole('button', { name: /Continue/i }).click();

    //    d) collect_intention — pick Intention-based.
    await page
      .getByRole('button', { name: /Intention-based/i })
      .click({ timeout: 15_000 });

    // 6. BooleanQueryPreview appears → Confirm & Process.
    const queryBlock = page.getByTestId('boolean-query-pre');
    await expect(queryBlock).toBeVisible({ timeout: 15_000 });
    await expect(queryBlock).toContainText('AMX');
    await page.getByRole('button', { name: /Confirm & Process/i }).click();

    // 7. ProcessingSteps card → all 7 steps flip to done.
    const stepsCard = page.getByTestId('processing-steps');
    await expect(stepsCard).toBeVisible({ timeout: 15_000 });
    // The DataExtractAgent emits 7 step rows; we wait for each to flip.
    for (const key of [
      'validate',
      'parse',
      'dates',
      'domains',
      'normalize',
      'insert',
      'handoff',
    ]) {
      await expect(
        page.locator(`[data-step-key="${key}"][data-step-status="done"]`),
      ).toBeVisible({ timeout: 20_000 });
    }

    // 8. CompletionSummary appears with article + domain counts.
    const summary = page.getByTestId('completion-summary');
    await expect(summary).toBeVisible({ timeout: 15_000 });
    await expect(summary).toContainText(/4|articles/i);
  });
});
