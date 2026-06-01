/**
 * M9.10 — M9.5.5 reach-probe e2e (deliberately stubbed).
 *
 * The reach-probe flow (chat ready → SearchAgent fetches → reach
 * coverage < 0.8 → `reach:absent` WS event → user picks "Add SimilarWeb"
 * → enrichment runs) is hard to make deterministic without seeded
 * OpenSearch fixtures + injectable adapter mocks. Both arrive with
 * M9.11's `SourceOrchestrator` / `chat_data_sources` table.
 *
 * Coverage today:
 *   - 14 backend unit tests for `enterReachProbe` + `resolveReachProbe`
 *     (see `app/backend/test/services/reach-probe.service.test.ts`)
 *   - Frontend `ReachAgentCard.test.tsx` covers the chip surface
 *
 * This e2e is intentionally `test.skip()` to keep the contract visible
 * (a placeholder grep target) without leaving a flaky test in CI. When
 * M9.11 lands, promote to a real run by mocking the OpenSearch
 * response via Playwright's `route()` interception so coverage is
 * always below the 0.8 threshold and the probe fires deterministically.
 *
 * @file tests/e2e/m9-phase3.5-reach-probe.spec.ts
 */
import { test } from '@playwright/test';

test.describe('M9.10 — M9.5.5 reach-probe flow', () => {
  test('reach-absent probe surfaces the SimilarWeb chip (stubbed)', () => {
    test.skip(
      true,
      'M9.5.5 is covered by 14 backend unit tests in ' +
        'app/backend/test/services/reach-probe.service.test.ts plus the ' +
        'ReachAgentCard frontend unit test. The full e2e needs M9.11 ' +
        'fixture injection (SourceOrchestrator + chat_data_sources) so ' +
        "we can deterministically drop OpenSearch's reach coverage below " +
        '0.8 without mutating prod data.',
    );
  });
});
