# Phase 3.5 — Autonomous Intent Extraction + OpenSearch Data Source

**Source:** No .docx — this phase closes two gaps the user identified between Phase 3 and Phase 4.
**Status:** **SHIPPED 2026-06-01** — M9.1 → M9.10 all landed.
**Builds on:** [phase1.md](phase1.md) + [phase2.md](phase2.md) + [phase3.md](phase3.md)
**Architecture decisions:** [ADR-0001 data-source adapters](adr/0001-data-source-adapter.md) · [ADR-0002 skill composition](adr/0002-skill-composition.md) · [ADR-0003 chat-entry composition](adr/0003-chat-entry-composition.md)

> **2026-06-01 architecture pivot:** User raised multi-source + skill-composition concerns mid-phase. Two ADRs (0001, 0002) lock the design vector. M9.6 is re-scoped to introduce the `DataSourceAdapter` interface; **M9.11 (new)** ships `chat_data_sources` table + `SourceOrchestrator`. Phase 5.5 is renamed and expanded (see ADR-0002). Phase 7 (new) handles MCP integration. None of this changes M9.1-M9.5 already shipped.

> Phase 3.5 is the autonomy increment. Without it, the platform is a "guided wizard" (the chat orchestrator probes the user for every parameter, regardless of context, and the only data source is CSV upload). After Phase 3.5: the orchestrator extracts as much as it can from the user's first prompt, asks only for what's missing, and pulls real articles from OpenSearch via the boolean query.

## Scope — what Phase 3.5 ships

| Area | Deliverable |
|---|---|
| **LLM intent extraction** | Orchestrator's first message processed by an LLM-driven `IntentExtractor` that returns `{brand?, dateStart?, dateEnd?, competitors?, intention?, enrichmentType?}`. Pre-fills `chat_params`; flow engine skips states for fields already filled. |
| **OpenSearchClient** | Direct `@opensearch-project/opensearch` client. Builds DSL query from `boolean_queries.queryStructured`. Streams paginated hits into `articles` table (same schema, `upload_id=NULL`). |
| **DataExtractAgent dual-path** | Extends M7.7's 7-step pipeline to choose between `csv_upload` (existing) and `opensearch` (new) based on whether `chat_params.uploadId` is set. |
| **Per-user OpenSearch override** | M5 `data_sources` row (sourceType=`custom`, displayName contains 'OpenSearch') overrides platform env vars when present. AES-256-GCM-encrypted credentials, mirroring M5 pattern. |
| **Reasoning chat preface** | Before the flow engine drives forward, system replies with a 1-line acknowledgement of what was extracted ("Got it — analyzing FreshSip from April 1 to May 1, intention-based. What enrichment level?"). Avoids the jarring "we just deleted half your question" feel. |
| **Tests + e2e** | Backend integration tests for extraction + OpenSearch fetch; Playwright e2e for the "single-message → autonomous run" path. |

## What Phase 3.5 does NOT do

- **No new dashboards** (Phase 4)
- **No learning / memory** (Phase 5)
- **No multi-agent routing** (Phase 6)
- **CSV upload stays working** (additive — Phase 2's capability preserved)
- **No semantic re-ranking** of OpenSearch results (Phase 4 territory if needed)

## Phase 1 + 2 + 3 contracts to preserve

| Contract | How Phase 3.5 uses it |
|---|---|
| `OrchestratorAgent` state machine | Same 9 states; intent extraction populates `chat_params` BEFORE the state machine evaluates — flow-engine skip logic already handles pre-filled fields |
| `DataExtractAgent` 7-step pipeline | Extended to switch strategy on `uploadId` presence; same WS event taxonomy |
| `articles` table schema | Same shape; `upload_id` NULL when source is OpenSearch |
| Phase 3 `agent:enrichment:incoming` bus | Triggered identically on DataExtract handoff — Phase 3.5 doesn't touch this |
| `lib/encryption.ts` | Encrypts per-user OpenSearch credentials when stored via M5 |
| `BooleanQueryEngine` (M7.6) | Output structured form is consumed directly by OpenSearch DSL builder |
| All Phase 1-3 endpoints + WS events | Immutable — Phase 3.5 is additive |

## New tech-stack additions

| Tech | Purpose | ADR? |
|---|---|---|
| `@opensearch-project/opensearch` | Official OpenSearch JS client. Auth via basic/AWS sigv4/token. | Light dep, no ADR |

## OpenSearch env vars (already set in Render per user)

Verify the existing Render env vars match these names. If different, M9.1 adjusts to match:

```
OPENSEARCH_HOST=                  # e.g. https://search-cluster.us-east-1.es.amazonaws.com
OPENSEARCH_INDEX_PATTERN=         # e.g. articles-* OR media_articles_*
OPENSEARCH_USERNAME=              # basic auth user (optional if using API key)
OPENSEARCH_PASSWORD=              # encrypted at Render (not exposed in code)
OPENSEARCH_API_KEY=               # alternative to user/password (optional)
OPENSEARCH_TIMEOUT_MS=30000       # request timeout
OPENSEARCH_PAGE_SIZE=500          # hits per page
OPENSEARCH_MAX_PAGES=20           # cap to bound cost; 500 × 20 = 10K articles max per chat
```

Per-user override pattern (M5 `data_sources`): user adds a row with `sourceType='custom'`, `displayName` containing 'OpenSearch', and `endpointUrl` set. Their API key is encrypted via `lib/encryption.ts`. When the DataExtractAgent runs, `getOpenSearchConfig(userId)` checks for that override first, falls back to env.

## Database — NO new tables

Phase 3.5 is purely additive on existing tables:
- `articles` (Phase 2): `upload_id=NULL` rows when sourced from OpenSearch
- `chat_params` (Phase 2): `dataSource` ENUM added (`'csv_upload' | 'opensearch'`) — defaults `'csv_upload'` for back-compat. Migration is a single ALTER COLUMN.

## API — 2 new endpoints

**Total after Phase 3.5: 44** (42 P1-3 + 2 P3.5).

| Method | Path | Purpose |
|---|---|---|
| POST | `/chats/:id/messages/extract-intent` | Manual re-trigger: LLM-extract from a given message string + update `chat_params` |
| POST | `/chats/:id/opensearch/probe` | Test the user's OpenSearch config (cluster reachable, index pattern resolves, sample query works) — returns `{ok, latencyMs, sampleCount, error?}` |

The actual OpenSearch FETCH runs inside `DataExtractAgent` (no new endpoint — same trigger as today: query confirm → process).

## WebSocket — 2 new events

| Event | Payload |
|---|---|
| `intent:extracted` | `{chatId, extracted: {brand?, dateStart?, dateEnd?, competitors?, intention?, enrichmentType?}, prefillCount}` |
| `opensearch:page` | `{chatId, jobId, page, totalPages, hitsThisPage, hitsSoFar}` — fires per OpenSearch page during DataExtract |

## IntentExtractor design

```
LLM call: chat completion with structured JSON output mode.

System prompt:
  "Extract PR analysis parameters from the user's message. Return STRICT JSON
   matching the schema. Only include fields the user explicitly mentioned —
   do not invent values. Use ISO dates (YYYY-MM-DD). The competitors array
   should contain ONLY brand names the user named (do not auto-suggest)."

Schema (Zod):
  {
    brand?: string,
    dateStart?: string (ISO),
    dateEnd?: string (ISO),
    competitors?: string[],
    intention?: 'intention_based' | 'comment_based',
    enrichmentType?: 'standard' | 'reach',
    confidence: number  // 0.0–1.0 — how sure the extractor is about its parse
  }

User: "<the actual user message>"

Cost: ~$0.0005 per chat (one extract per chat opening). Acceptable.
```

After the LLM returns, the extractor:
1. Validates against Zod (drop any hallucinated fields)
2. UPDATEs `chat_params` with the extracted fields
3. Emits `intent:extracted` WS event with the extracted shape + `prefillCount` (how many fields got filled)
4. Returns to the orchestrator, which re-evaluates `flow-engine.getNextFlowState(updatedParams)` — already skips filled fields

The chat orchestrator's reply is generated AFTER extraction:
- If `prefillCount > 0`: "Got it — analyzing {brand} from {dateStart} to {dateEnd}, {intention}. What enrichment level?" (only asks about missing fields)
- If `prefillCount === 0`: existing welcome message

## OpenSearch query builder

```ts
function buildOpenSearchQuery(structured: BooleanQueryStructured): OpenSearchDSL {
  // structured = { brand, brandFields, competitors, competitorFields, dateRange, language }
  return {
    query: {
      bool: {
        must: [
          // Brand must appear in any of title/content/description/summary
          {
            multi_match: {
              query: structured.brand,
              fields: ['title^3', 'content', 'description', 'summary'],
              operator: 'and',
            },
          },
        ],
        should: structured.competitors.map((c) => ({
          multi_match: { query: c, fields: ['content', 'description', 'summary'] },
        })),
        filter: [
          ...(structured.dateRange ? [{
            range: {
              published_date: {
                gte: structured.dateRange.start,
                lte: structured.dateRange.end,
                format: 'yyyy-MM-dd',
              },
            },
          }] : []),
          { term: { language: structured.language } },
        ],
      },
    },
    sort: [{ published_date: 'desc' }],
    size: env.OPENSEARCH_PAGE_SIZE,
  };
}
```

**Field selection** matches what user wrote: title, content, description, summary. Date format follows OpenSearch's `yyyy-MM-dd`. Boost on title (^3) so brand-in-headline ranks higher.

## DataExtractAgent dual-path

Phase 2's M7.7 agent had a 7-step pipeline (validate → parse → dates → domains → normalize → insert → handoff). Phase 3.5 adds a parallel path for the OpenSearch source:

| Step | CSV (existing) | OpenSearch (NEW) |
|---|---|---|
| 1. Validate | Schema OK? | Cluster reachable? Index pattern resolves? |
| 2. Parse | PapaParse rows | Query DSL built; first page fetched |
| 3. Dates | Detect from columns | Filter pushed to OpenSearch — verify min/max in returned hits |
| 4. Domains | URL → hostname extract | publisher_domain field in hits (or URL parse if absent) |
| 5. Normalize | Column-name aliasing | Field-name aliasing (configurable map: OpenSearch field → Article schema) |
| 6. Insert | Bulk createMany | Stream paginated bulk inserts |
| 7. Handoff | Publish ENRICHMENT_READY | Same |

The agent picks the strategy in `reason()`:
- `chat_params.uploadId` set → `csv_upload` strategy
- `chat_params.dataSource === 'opensearch'` → `opensearch` strategy (default when no upload AND `OPENSEARCH_HOST` env set)
- Neither → fail with friendly "configure data source" error

The 7-step UI visualization stays identical — same `processing:step` event taxonomy; step names slightly differ per strategy.

## Frontend changes

| Component | Change |
|---|---|
| `BrandInput`, `CustomDatePicker`, etc. | No change — flow engine skip logic already handles pre-filled fields |
| `ChatActionPrompt` welcome state | Replaced by an "intent confirmation" message that lists what was extracted ("FreshSip · April 1–May 1 · intention-based · 2 competitors") and a chip to confirm OR edit |
| `MessageThread` | Renders a small `IntentExtractedCard` immediately after the user's first message, showing the extracted fields. Editable inline (revert → manual flow). |
| Settings → Data Sources (M5) | Filter to show `OpenSearch` as a recognized type when displayName matches. Add a "Test connection" button that calls `POST /chats/:id/opensearch/probe` (or a generic `/data-sources/:id/probe`). |
| `EnrichmentProgressCard` from M8.8 | Reused identically — the agent transition from extract → process is invisible to this card |

## Performance / cost targets

| Metric | Target |
|---|---|
| Intent extraction LLM call | <1s, ~$0.0005 |
| OpenSearch first page latency | <500ms (vs cluster region) |
| OpenSearch full fetch (10K articles, 20 pages × 500) | <30s |
| `articles` bulk insert | 500 rows/batch, same as Phase 2 |
| End-to-end "single message → enrichment ready" | <60s for 2,000-article chat |

## Open items — resolve before milestone start

| Item | Default if no decision |
|---|---|
| OpenSearch auth method | Basic auth (user/password) for M9.1. AWS sigv4 + token auth deferred to M9.x if needed. |
| Field name mapping | Hardcode the default map (`title`, `body`/`content`, `description`, `summary`, `published_date`, `language`, `url`, `source`) in `lib/opensearch-mapping.ts`. User can override via env or M5 row. |
| OpenSearch `max_pages` ceiling | 20 (= 10K articles) for free-tier Render. Bumpable via env. |
| Per-user OpenSearch override | Phase 3.5 supports it; default platform-wide env config for free-tier baseline. |
| What if user's prompt is just "hi"? | `confidence < 0.3` → no extraction; orchestrator falls back to existing welcome chip flow. |
| Intent extraction security | LLM input is user-provided text — no injection risk to backend (no eval). LLM output is JSON-validated. Standard. |

## Gotchas / non-obvious

- **Intent extraction runs ONCE per chat**, on the first user message. Subsequent messages just advance the flow normally. Don't run extraction on every message.
- **The user can override extracted fields** — the IntentExtractedCard is editable. If they change "FreshSip" to "Coca-Cola", the flow engine re-evaluates from the new state.
- **OpenSearch results may have varied field shapes** — some clusters use `body`, some `content`, some `text`. The mapping layer must handle this gracefully; unknown fields go into `raw_data` JSONB.
- **Date format in OpenSearch is per-index**. The query builder assumes `yyyy-MM-dd` per spec — if the user's cluster uses unix timestamps, the mapping layer normalizes.
- **Pagination uses `search_after`**, NOT `from + size` (which has a 10K hard limit). Required for >10K result sets.
- **CSV upload path stays working**. If user wants to upload, the chat_params.uploadId path takes over; the `dataSource` field flips to `'csv_upload'`.
- **The `confidence` field from the LLM** is advisory. Below 0.3, we don't trust the extraction — fall back to manual flow. Tunable via env.
- **Cost reminder**: intent extraction = 1 LLM call per chat. At scale this is negligible vs enrichment which is N batches × LLM. Just don't loop extraction.

## Proposed milestones (M9.1 → M9.10)

| # | Title | Demo |
|---|---|---|
| **M9.1** | OpenSearch env + lib/opensearch-client.ts + DSL query builder | `prsi-opensearch-probe` script returns hits from a known query |
| **M9.2** | `chat_params.dataSource` ENUM migration + lib/opensearch-mapping.ts (field alias map) | Migration applies; unit tests for builder + mapper |
| **M9.3** | IntentExtractor (LLM + Zod schema) + `intent:extracted` WS event | Unit test: "Analyze FreshSip from Apr 1 to May 1" → `{brand:'FreshSip', dateStart:'2026-04-01', dateEnd:'2026-05-01', confidence:0.95}` |
| **M9.4** | Wire IntentExtractor into chat opening — first message triggers extract, populates chat_params, emits event | Integration: post first message → chat_params row updated → flow advances past skipped states |
| **M9.5** | DataExtractAgent dual-path: strategy=opensearch branch with paginated fetch + bulk insert + `opensearch:page` events | E2E: confirmed query → 3 OpenSearch pages → 1500 articles in DB |
| **M9.6** | Per-user OpenSearch override via M5 data_sources + AES-256-GCM-encrypted credentials | Integration: user POSTs data_sources row → agent uses it instead of env |
| **M9.7** | New REST endpoints: `/messages/extract-intent`, `/opensearch/probe` | curl probe returns ok + latency |
| **M9.8** | Frontend IntentExtractedCard (editable summary above the first AI bubble) | Browser: user types one-liner → card appears with extracted fields |
| **M9.9** | Frontend OpenSearch settings UX (M5 tab gains "Test connection" + "OpenSearch" sourceType detection) | Settings: add OpenSearch row → click test → green badge |
| **M9.10** | Tests + Playwright e2e + docs (Phase 3.5 SHIPPED) + CLAUDE.md status | Full one-message-to-enrichment-ready autonomous flow proven |

Estimate: **~2-3 working days** subagent-driven.

## Done when

A test analyst (Alice) opens a new PR Impact chat and types:

> "Analyze FreshSip brand coverage from April 1 to May 1 with intention-based, compare against PepsiCo and Coca-Cola"

→ within ~1s, sees the IntentExtractedCard:

```
✓ Got: brand=FreshSip · dates=2026-04-01 → 2026-05-01 · intention=intention-based · competitors=PepsiCo, Coca-Cola
  → Need: enrichment_type
```

→ picks "Enrichment" chip → boolean query auto-generated → confirms → DataExtractAgent fetches 1,847 articles from OpenSearch live → Phase 3 EnrichmentAgent auto-runs → ChipUp artifact appears with full enriched dataset.

No upload step. No re-prompts for already-given info. Fully autonomous.

## Final stats (SHIPPED 2026-06-01)

| Surface | Before Phase 3.5 | After Phase 3.5 |
|---|---|---|
| REST endpoints | 42 | 52 (+10) |
| DB tables | 18 | 21 (+3: `search_history`, `composable_skills`, `user_agents`) |
| WS events | 21 | 27 (+6: `search:start`/`progress`/`fetched`/`error`/`complete`, `reach:absent`/`resolved`, `intent:extracting`/`extracted`) |
| Agents | 4 | 5 (+SearchAgent) |
| Test files (backend) | 60 | 91 (+31) |
| Tests (backend) | 565 | 832 (+267) |
| Tests (frontend) | 121 | 169 (+48) |
| Cross-phase ADRs | 0 | 3 (data-source adapter, skill composition, chat-entry composition) |

Live URLs unchanged from Phase 3: https://pr-solutions.vercel.app + https://prsi-api.onrender.com.

Open follow-ups deliberately deferred:

- **M9.11** (`chat_data_sources` table + `SourceOrchestrator`) — multi-source per chat
- **M9.5.5 reach-probe full e2e** — needs M9.11 fixture injection
- **crawler / RSS / S3 / Slack / MCP adapters** — surface ready (Coming soon)
- **Skill manifest editor + composer runtime** — Phase 5.5
