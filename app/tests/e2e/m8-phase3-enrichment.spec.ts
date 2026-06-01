/**
 * M8.10 — Phase 3 happy-path Playwright e2e.
 *
 * Walks the entire Alice journey from CSV upload through the ChipUp
 * artifact, including the Phase 3 enrichment surface that lands after
 * Phase 2 finishes:
 *
 *   1. Login as Alice
 *   2. Click PR Impact agent → new chat
 *   3. Upload a small CSV via the FileDropZone hidden <input>
 *   4. Walk the chip flow (enrichment → brand → competitors → intention)
 *   5. BooleanQueryPreview → Confirm & Process
 *   6. Wait for AgentActionPanel (M7.9) summary
 *   7. Wait for EnrichmentProgressCard (M8.8) to appear
 *   8. Wait for ChipUpArtifact to be visible (fires after json-ready)
 *   9. Click chip → expanded view
 *  10. Click "JSON Code" tab → JsonCodeView appears
 *  11. Click ⤢ fullscreen → modal opens
 *  12. Press Esc → modal closes (returns to expanded view)
 *  13. Click × in expanded → collapsed
 *  14. Assert chip persists in chat history
 *
 * Skips when the backend smoke check fails — same pattern as m7-phase2.
 * Heavy: requires real LLM calls (Azure OpenAI key + budget). Spec author
 * runs against live prod after merge; NOT in local CI default.
 *
 * @file tests/e2e/m8-phase3-enrichment.spec.ts
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
  const tmp = path.join(os.tmpdir(), `prsi-m8-10-${Date.now()}.csv`);
  const rows = [
    'title,content,source,published_date,url',
    'AMX Series B,Round of $50M for AI growth,TechCrunch,2025-03-10,https://www.techcrunch.com/a',
    'Hiring spree,200 new engineering roles announced,Reuters,2025-03-12,https://reuters.com/b',
    'New product line,AMX unveils PR intelligence product,Bloomberg,2025-03-15,https://bloomberg.com/c',
  ];
  fs.writeFileSync(tmp, rows.join('\n'), 'utf8');
  return tmp;
}

test.describe('M8.10 — Phase 3 enrichment pipeline', () => {
  test('Alice: upload → flow → enrich → ChipUp artifact collapsed/expanded/fullscreen', async ({
    page,
  }) => {
    test.skip(
      !backendOk,
      'backend smoke failed — start API + DB + Redis to run this',
    );

    // 1. Login as Alice.
    await login(page);

    // 2. Open a PR Impact chat.
    await page.getByRole('heading', { name: /PR Impact Agent/i }).click();
    await expect(page).toHaveURL(/\/chat\/[0-9a-f-]+/);

    // 3. Upload a CSV.
    const csv = tempCsvPath();
    const hiddenInput = page.locator('input[type="file"]');
    await expect(hiddenInput).toBeAttached({ timeout: 15_000 });
    await hiddenInput.setInputFiles(csv);

    // UploadProgressCard appears, flips to ready.
    const progressCard = page.locator('[data-status]').first();
    await expect(progressCard).toBeVisible({ timeout: 15_000 });
    await expect(progressCard).toHaveAttribute('data-status', 'ready', {
      timeout: 20_000,
    });

    // 4. Walk the chip flow.
    //    a) collect_enrichment — Standard.
    await page
      .getByRole('button', { name: /^Standard$/i })
      .click({ timeout: 15_000 });

    //    b) collect_brand — fill + Continue.
    const brandInput = page.getByLabel(/Brand name$/i);
    await expect(brandInput).toBeVisible({ timeout: 15_000 });
    await brandInput.fill('AMX');
    await page.getByRole('button', { name: /Continue/i }).click();

    //    c) collect_competitors — Top 3 (fallback to Custom on suggest fail).
    await expect(page.getByRole('tab', { name: /Top 3/i })).toBeVisible({
      timeout: 15_000,
    });
    await page.getByRole('tab', { name: /Top 3/i }).click();
    const anyPill = page.locator('span', { hasText: /^[A-Z]/ }).first();
    try {
      await expect(anyPill).toBeVisible({ timeout: 8_000 });
    } catch {
      await page.getByRole('tab', { name: /Custom/i }).click();
      await page.getByLabel(/Add competitor/i).fill('Reuters');
      await page.getByRole('button', { name: /^Add$/i }).click();
    }
    await page.getByRole('button', { name: /Continue/i }).click();

    //    d) collect_intention — Intention-based.
    await page
      .getByRole('button', { name: /Intention-based/i })
      .click({ timeout: 15_000 });

    // 5. BooleanQueryPreview → Confirm & Process.
    const queryBlock = page.getByTestId('boolean-query-pre');
    await expect(queryBlock).toBeVisible({ timeout: 15_000 });
    await page.getByRole('button', { name: /Confirm & Process/i }).click();

    // 6. ProcessingSteps card → all 7 steps flip to done (M7.7 pipeline).
    const stepsCard = page.getByTestId('processing-steps');
    await expect(stepsCard).toBeVisible({ timeout: 15_000 });
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

    // 7. AgentActionPanel completion summary visible.
    const summary = page.getByTestId('completion-summary');
    await expect(summary).toBeVisible({ timeout: 15_000 });

    // 8. EnrichmentProgressCard (M8.8) appears once `enrichment:start` lands.
    const enrichCard = page.getByTestId('enrichment-progress-card');
    await expect(enrichCard).toBeVisible({ timeout: 30_000 });

    // 9. Wait for the ChipUp artifact to appear. The frontend listens for
    //    `enrichment:json-ready` to mount it; that fires after the worker
    //    finishes the last batch + GET /enrich/json computes the JSON.
    const chip = page.getByTestId('chip-up-artifact');
    await expect(chip).toBeVisible({ timeout: 60_000 });

    // 10. Click chip → expanded view.
    await chip.click();
    const expanded = page.getByTestId('chip-up-expanded');
    await expect(expanded).toBeVisible({ timeout: 15_000 });

    // 11. Click "JSON Code" tab → JsonCodeView.
    await expanded.getByRole('tab', { name: /JSON Code/i }).click();
    await expect(page.getByTestId('json-code-view')).toBeVisible({
      timeout: 5_000,
    });

    // 12. Click ⤢ fullscreen → modal opens.
    await page.getByTestId('chip-up-fullscreen-btn').click();
    const modal = page.getByTestId('chip-up-fullscreen');
    await expect(modal).toBeVisible({ timeout: 5_000 });

    // 13. Press Esc → modal closes (returns to expanded view).
    await page.keyboard.press('Escape');
    await expect(modal).toBeHidden({ timeout: 5_000 });
    await expect(page.getByTestId('chip-up-expanded')).toBeVisible();

    // 14. Click × in expanded → back to collapsed.
    await page.getByTestId('chip-up-collapse-btn').click();
    await expect(page.getByTestId('chip-up-expanded')).toBeHidden();
    // Chip persists in chat history.
    await expect(page.getByTestId('chip-up-artifact')).toBeVisible();
  });
});
