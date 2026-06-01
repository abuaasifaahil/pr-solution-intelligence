/**
 * M9.10 — Phase 3.5 Playwright e2e pattern-matrix.
 *
 * Validates the 8 chat-entry patterns from ADR-0003 Decision 1. The
 * adapter registry only ships CSV + OpenSearch in Phase 3.5; the
 * remaining `crawler` adapter is deferred to M9.11+, so the patterns
 * that reference it (1, 4, 7) are asserted via the "Coming soon" UI
 * surface rather than an end-to-end run.
 *
 * Patterns covered (per ADR-0003 §Decision 1):
 *   0 — default agent, empty prompt
 *   2 — skill + (CSV placeholder) + prompt
 *   3 — prompt + no skill (probe surfaces)
 *   5 — prompt only (general)
 *   6 — agent + prompt (classifier)
 *   1/4/7 — surfaced as "Coming soon" (no e2e execution)
 *
 * Plus two ADR-0003 UX commitments:
 *   - "Recently used" chip row renders first-party defaults
 *   - "Show all agents" toggle reveals legacy AgentCard grid
 *
 * Smoke-checks the backend up front; whole suite skips when API is
 * unreachable — same pattern as m7-phase2-pipeline + m8-phase3.
 *
 * @file tests/e2e/m9-phase3.5-chat-entry-patterns.spec.ts
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

test.describe('M9.10 — ADR-0003 chat-entry patterns', () => {
  test.beforeEach(async ({ page }) => {
    test.skip(!backendOk, 'backend smoke failed — start API + DB + Redis to run');
    await login(page);
  });

  test('Pattern 0: default agent, empty prompt — chat creation form is reachable', async ({
    page,
  }) => {
    // The chat-creation form is the primary entry surface.
    await expect(page.getByTestId('chat-creation-form')).toBeVisible();
    // The default agent dropdown is populated and not disabled (no skill pinned).
    const agentSelect = page.getByTestId('agent-select');
    await expect(agentSelect).toBeVisible();
    await expect(agentSelect).toBeEnabled();
    // Start chat with no prompt + default agent.
    await page.getByTestId('start-chat-btn').click();
    await expect(page).toHaveURL(/\/chat\/[0-9a-f-]+/, { timeout: 15_000 });
  });

  test('Pattern 2: skill + prompt — skill drives flow, agent picker disabled', async ({
    page,
  }) => {
    await page.getByLabel('Describe what you want to know').fill(
      'Analyze FreshSip from April',
    );

    // Open the skill popover and pick the first available row.
    await page.getByTestId('attach-skill-btn').click();
    const popover = page.getByTestId('attach-skill-popover');
    await expect(popover).toBeVisible();
    // The seed inserts first-party skills (e.g. pr-impact); fall back to
    // whatever row renders first if the seed naming changes.
    const firstSkill = popover.locator('[data-testid^="skill-pick-"]').first();
    await expect(firstSkill).toBeVisible({ timeout: 5_000 });
    await firstSkill.click();

    // Agent selector must be disabled (Pattern 1/2 — skill drives flow).
    await expect(page.getByTestId('agent-select')).toBeDisabled();
    // Attached-chips row shows the pinned skill.
    await expect(page.getByTestId('attached-chips-row')).toBeVisible();

    // CSV upload option is exposed in the source popover.
    await page.getByTestId('attach-source-btn').click();
    await expect(page.getByTestId('source-pick-csv')).toBeVisible();
  });

  test('Pattern 3: prompt + no skill — ProbingResultCard surfaces', async ({
    page,
  }) => {
    test.slow(); // IntentExtractor LLM call can take 1.5-17s.
    await page.getByLabel('Describe what you want to know').fill(
      'Analyze FreshSip on Twitter last week',
    );
    await page.getByTestId('start-chat-btn').click();
    await expect(page).toHaveURL(/\/chat\/[0-9a-f-]+/);

    // Wait for IntentExtractor to fire and the ProbingResultCard to mount.
    // Card host is rendered eagerly; the card itself appears once the
    // probe payload arrives. Use a generous timeout to absorb LLM latency.
    const card = page.getByTestId('probing-result-card');
    await expect(card).toBeVisible({ timeout: 60_000 });
  });

  test('Pattern 5: prompt only — chat opens and welcomes the user', async ({
    page,
  }) => {
    await page.getByLabel('Describe what you want to know').fill(
      'tell me about PR strategies',
    );
    await page.getByTestId('start-chat-btn').click();
    await expect(page).toHaveURL(/\/chat\/[0-9a-f-]+/);
    // The chat thread renders (catch-all pattern — minimum assertion).
    await expect(page.getByPlaceholder(/Type a message/i)).toBeVisible({
      timeout: 15_000,
    });
  });

  test('Pattern 6: agent attached + prompt — chat opens with selected agent', async ({
    page,
  }) => {
    // Pick a specific (non-default) agent via the dropdown. Media
    // Monitoring is one of the five seeded first-party agents and is
    // distinct from the default pr_impact pick.
    const select = page.getByTestId('agent-select');
    await select.selectOption({ label: 'Media Monitoring Agent' });
    await page.getByLabel('Describe what you want to know').fill(
      'Watch FreshSip mentions',
    );
    await page.getByTestId('start-chat-btn').click();
    await expect(page).toHaveURL(/\/chat\/[0-9a-f-]+/, { timeout: 15_000 });
    // Either an immediate welcome OR a ProbingResultCard arrives — both
    // satisfy "agent classifies on entry"; minimum assertion is the
    // input remains usable.
    await expect(page.getByPlaceholder(/Type a message/i)).toBeVisible({
      timeout: 15_000,
    });
  });

  test('Patterns 1, 4, 7: crawl source is surfaced as "Coming soon"', async ({
    page,
  }) => {
    await page.getByTestId('attach-source-btn').click();
    const disabledRow = page.getByTestId('source-pick-crawler-disabled');
    await expect(disabledRow).toBeVisible();
    await expect(disabledRow).toHaveAttribute('aria-disabled', 'true');
    await expect(disabledRow).toContainText(/Coming soon/i);
  });

  test('Recently used chips render seeded first-party agents', async ({
    page,
  }) => {
    await expect(page.getByTestId('recently-used-chips')).toBeVisible({
      timeout: 15_000,
    });
    // The seed inserts five first-party agents (pr_impact + four others).
    // pr_impact is the canonical Pattern 0 default and must be present.
    await expect(page.getByTestId('recently-used-pr_impact')).toBeVisible();
    // At least one additional chip must render (proves "Recently used"
    // is more than just the default agent).
    const allChips = page
      .getByTestId('recently-used-chips')
      .locator('button');
    await expect(allChips.nth(1)).toBeVisible();
  });

  test('Show all agents toggle reveals the legacy AgentCard grid', async ({
    page,
  }) => {
    const toggle = page.getByTestId('show-all-agents-toggle');
    await expect(toggle).toBeVisible();
    await toggle.click();
    // After toggle, the AgentCard grid renders with the seeded agents.
    await expect(
      page.getByRole('heading', { name: /PR Impact Agent/i }),
    ).toBeVisible({ timeout: 5_000 });
  });
});
