# Phase 3 — Enrichment Engine

**Source:** `Phase 3/Phase3_Technical_Specification.docx` (digested 2026-05-30)
**Status:** Spec digested · milestone plan pending user approval
**Builds on:** [phase1.md](phase1.md) + [phase2.md](phase2.md)

> Read this file before any Phase 3 work. Phase 3 contracts become immutable once shipped — Phase 4 dashboards consume them directly.

## Scope — what Phase 3 ships

Per-article AI enrichment across **6 dimensions** (Sentiment, Themes, Emotion, Entities, Signals, Reach) plus optional **SimilarWeb-driven reach** lookup. Triggered automatically when Phase 2's DataExtractAgent emits `ENRICHMENT_READY`. Streams progress, then renders a Chip-Up artifact card in the chat with collapsed → expanded → full-screen JSON views.

| Area | Deliverable |
|---|---|
| `EnrichmentAgent` | BaseAgent subclass; batches articles, calls LLM, validates, upserts |
| `SimilarWebAgent` | Parallel agent for domain reach; cache-with-TTL (7 days, global) |
| `LLMGateway` | Multi-model abstraction (Claude / GPT / Ollama / Perplexity) — defaults to existing Azure OpenAI GPT-4.1; user overrides via M5 llm_configs |
| `EnrichBatchWorker` | BullMQ inline worker — concurrency 3, max 2 retries per batch |
| 4 new DB tables | `enrichments` (1:1 article), `enrichment_jobs`, `enrichment_batches`, `reach_cache` (global) |
| 9 new REST endpoints | All under `/api/v1/`, auth-guarded |
| 9 new WS events | `enrichment:start`, `:batch-start`, `:batch-complete`, `:batch-error`, `:progress`, `:reach-start`, `:reach-complete`, `:complete`, `:json-ready` |
| 8 new frontend components | EnrichmentProgressCard, BatchGrid, ReachAgentCard, ChipUpArtifact (collapsed/expanded/fullscreen), ArticleEnrichmentCard, JsonCodeView |
| Dashboard-ready JSON | Aggregated artifact emitted on completion — Phase 4 reads this |

## What Phase 3 does NOT do

- **No dashboards** — Phase 4
- **No learning / memory** — Phase 5
- **No new agents beyond Enrichment + SimilarWeb** — Phase 5 adds Analysis/QA/Learning
- **No admin UI / dark mode** — Phase 6

## Phase 1 + 2 contracts to preserve

| Contract | How Phase 3 uses it |
|---|---|
| `BaseAgent` abstract class | `EnrichmentAgent` + `SimilarWebAgent` subclass it |
| `AgentRegistry` singleton | Both new agents register at boot (singleton pattern from M7.7) |
| Redis pub/sub bus | DataExtract → Enrichment handoff via `agent:enrichment:incoming`; SimilarWeb → Enrichment via `agent:enrichment:reach` |
| BullMQ inline worker | `enrich-batch` processor added to existing PROCESSORS map in server.ts |
| `withUser(userId, fn)` RLS | Every new DB call wraps — enrichment tables RLS-scoped per user |
| Auth middleware | All 9 new endpoints behind `preHandler: app.auth` |
| Existing per-chat WS channel | All 9 new events ride this — no new channel |
| `lib/encryption.ts` (AES-256-GCM) | SimilarWeb API key (from M5 `data_sources`) decrypted at fetch time |
| `lib/storage.ts` (S3-compatible) | Optional artifact storage (current Phase 3 stores inline JSONB — see open items) |
| `AgentActionPanel` (M7.9 generic) | Reused for enrichment progress visualization |
| `articles` + `chat_params` + `boolean_queries` tables | Read-only inputs |

## New tech-stack additions

| Tech | Purpose | ADR? |
|---|---|---|
| `tiktoken` | Token counting for batch sizing (Azure OpenAI is GPT-based) | Light dep, no ADR |
| `@anthropic-ai/tokenizer` | Token counting when user opts for Claude | Conditional; light dep |

No SimilarWeb SDK — direct `fetch` is fine.

## Database — 4 new tables (additive)

**Total after Phase 3: 18 tables** (10 P1 + 4 P2 + 4 P3).

### `enrichments` (1:1 with articles)

```
id, articleId UNIQUE FK, chatId FK, userId FK (RLS), batchId FK NULLABLE,
sentiment JSONB { label, confidence, reason },
themes JSONB [{ level, name, confidence, reason }],
emotion JSONB { label, intensity },
entities JSONB [{ type, name, mentions }],
signals JSONB [{ type, description, reason }],
reach JSONB NULLABLE { domain, monthly_visitors, score },
social_engagement JSONB NULLABLE,
model_used VARCHAR(100), tokens_input INT, tokens_output INT, processing_ms INT,
is_valid BOOLEAN DEFAULT true, created_at TIMESTAMPTZ
```

Indexes: `UNIQUE(article_id)`, `idx_chat`, `idx_user`, **GIN** on sentiment / themes / entities / signals (heavy Phase 4 query target).
RLS: `user_id = current_setting('app.user_id')::uuid`.

### `enrichment_jobs`
Status: `queued | processing | completed | failed | partial`. Fields: total_articles, processed_count, batch_count, batches_completed, model_used, enrichment_type (`standard | reach`), total_tokens_input, total_tokens_output, started_at, completed_at, error_log JSONB, **dashboard_json JSONB** (aggregated artifact, see open items).

### `enrichment_batches`
Status: `pending | processing | completed | failed | retrying`. Fields: job_id FK, batch_number, article_ids UUID[], estimated_tokens, actual_tokens_in/out, retry_count, processing_ms, error TEXT.

### `reach_cache` (GLOBAL — NOT RLS-scoped)
Shared domain→reach cache. UNIQUE(domain), monthly_visitors BIGINT, global_rank, category, score INT (0–100), raw_response JSONB, fetched_at, ttl_hours DEFAULT 168 (7 days), is_valid.

**Critical: this is the ONLY Phase 3 table that's global.** A reach lookup for `reuters.com` is the same regardless of who asks — privacy-acceptable since domain metrics are public data. Document the divergence prominently.

## API — 9 new endpoints (`/api/v1/`)

**Total after Phase 3: 42** (22 P1 + 11 P2 + 9 P3). All auth-guarded.

| Method | Path | Purpose |
|---|---|---|
| POST | `/chats/:id/enrich` | Start enrichment job; returns `{ jobId, batchCount }` |
| GET | `/chats/:id/enrich/status` | Job status + progress + batch detail |
| GET | `/chats/:id/enrich/result` | Paginated enriched articles |
| GET | `/chats/:id/enrich/json` | Full dashboard-ready JSON (Phase 4 input) |
| GET | `/chats/:id/enrich/summary` | Aggregated stats (sentiment dist, top themes, entities, signals) |
| GET | `/enrichments/:articleId` | Single article enrichment detail |
| POST | `/chats/:id/reach/fetch` | Trigger SimilarWebAgent for this chat's domains |
| GET | `/reach/cache/:domain` | Cached reach for a specific domain |
| POST | `/chats/:id/enrich/retry` | Retry failed batches |

## WebSocket — 9 new events on existing channel

| Event | Payload |
|---|---|
| `enrichment:start` | `{ jobId, totalArticles, batchCount, model }` |
| `enrichment:batch-start` | `{ jobId, batchNumber, articleCount, estimatedTokens }` |
| `enrichment:batch-complete` | `{ jobId, batchNumber, processedCount, tokensUsed, duration }` |
| `enrichment:batch-error` | `{ jobId, batchNumber, error, retrying }` |
| `enrichment:progress` | `{ jobId, processed, total, percent, tokensTotal, elapsed }` |
| `enrichment:reach-start` | `{ domains, chatId }` |
| `enrichment:reach-complete` | `{ resolved, total, coverage, duration }` |
| `enrichment:complete` | `{ jobId, totalArticles, totalTokens, duration, dimensions }` |
| `enrichment:json-ready` | `{ chatId, artifactId, articleCount }` |

## EnrichmentAgent lifecycle

| Method | Implementation |
|---|---|
| `perceive` | Subscribes to `agent:enrichment:incoming`. Loads articles via `withUser`. Loads user `llm_configs` (M5) → falls back to Azure OpenAI GPT-4.1. |
| `reason` | Per model `max_input_tokens`, computes batch size to fit avg article token count (target ≤80% of max). Returns `{batchSize, totalBatches, estimatedTokens}`. **Rejects if `estimatedTokens > MAX_TOKENS_PER_JOB`.** |
| `plan` | Inserts `enrichment_job` + N `enrichment_batches`. Enqueues N `enrich-batch` BullMQ jobs (concurrency 3). |
| `act` | Per batch worker: build prompt → LLMGateway.complete → validateJSON (Zod) → upsert enrichments → emit `batch-complete`. On failure: increment retry_count, max 2 retries, then mark `failed`. |
| `reflect` | Verify `enrichments.count === articles.count`; if `failed_batches > 0` mark job `partial`; emit `enrichment:complete`. |
| `learn` | No-op (Phase 5). |

## SimilarWebAgent lifecycle (parallel)

Activated when `enrichment_type = reach`.

1. `SELECT DISTINCT publisher_domain FROM articles WHERE chat_id = ?`
2. For each domain: check `reach_cache` — valid if `fetched_at > NOW() - ttl_hours hours`. Cache hit → use cached.
3. Uncached: batch SimilarWeb API calls (50 domains/call).
4. Persist results to `reach_cache` (upsert).
5. Emit `enrichment:reach-complete` with coverage stats.
6. EnrichmentAgent merges `reach_cache` rows into `enrichments.reach` JSONB by `publisher_domain`.

**Coverage target:** 95%+ resolved. Below logs warning; doesn't fail the job.

## LLMGateway

Unified interface across providers. Methods:

| Method | Description |
|---|---|
| `getModel(userId)` | User's default from `llm_configs` (M5); falls back to Azure OpenAI GPT-4.1 |
| `countTokens(text, model)` | tiktoken for OpenAI/Azure; `@anthropic-ai/tokenizer` for Claude |
| `createBatches(articles, maxTokens)` | Greedy bin-packing — each batch ≤ `maxTokens × 0.8` |
| `complete(messages, model, config)` | Single call; auto-retries on transient errors (rate limits, 5xx) with exponential backoff |
| `validateJSON(response, schema)` | Strips markdown fencing, parses JSON, validates against Zod schema |

Phase 5 AnalysisAgent will reuse this gateway directly.

## Frontend — 8 new components

| Component | Purpose |
|---|---|
| `EnrichmentProgressCard` | Wraps M7.9 `AgentActionPanel`; passes per-batch + per-dimension step data |
| `BatchGrid` | Grid view of batches with status + tokens + duration |
| `ReachAgentCard` | Mid-process card showing domain coverage stats |
| `ChipUpArtifact` | Collapsible chip in chat history |
| `ChipUpExpanded` | Inline expansion with tab bar (Preview / JSON Code) |
| `ArticleEnrichmentCard` | Per-article preview: title, source, sentiment pill, themes, entities, signals, reach, AI reason |
| `JsonCodeView` | Syntax-highlighted JSON (reuse M7.9 BooleanQueryPreview's tokenizer pattern) |
| `ChipUpFullscreen` | Modal overlay with download / share / email actions |

## Contracts exposed to Phase 4+

Immutable once Phase 3 ships:
- `EnrichmentAgent` + `SimilarWebAgent` (registered, emit `enrichment:json-ready`)
- `enrichments` table (Phase 4 dashboards read directly)
- `enrichment_jobs` table (Phase 5 Learning Agent observes patterns)
- `reach_cache` table (cross-user shared)
- `LLMGateway` service (Phase 5 AnalysisAgent reuses)
- 9 REST endpoints + 9 WS events
- Enriched JSON schema (Phase 4 Design Agent maps to charts)
- Shared TS types: `Enrichment`, `EnrichmentJob`, `EnrichmentBatch`, `ReachCache`

## Performance / cost targets

| Metric | Target |
|---|---|
| Avg article tokens | ~800 |
| Avg batch size | 200–250 articles |
| Total tokens for 2,847-article reference | ~220K |
| Cost per chat (Azure GPT-4.1) | **~$0.50** at 200K input + 20K output |
| Concurrency | 3 parallel batches |
| Reach cache hit rate (steady state) | 80%+ |
| SimilarWeb domain coverage | 95%+ |
| End-to-end enrichment time | <30s for 2,847 articles |

## Open items — resolve before milestone start

| Item | Resolution |
|---|---|
| **LLM default model** | Azure OpenAI GPT-4.1 (already configured). Claude is `llm_configs` config flip, not a code change. |
| **SimilarWeb API key location** | Per-user via M5 `data_sources` (sourceType=`custom`). Falls back to env if no per-user config. |
| **Cost budget per chat** | `MAX_TOKENS_PER_JOB=300_000` env var. Job rejected with friendly error if estimate exceeds. |
| **Reach cache RLS exemption** | Global (no RLS) — domain-level public data. Documented divergence. |
| **Dashboard JSON artifact storage** | Inline in `enrichment_jobs.dashboard_json` JSONB column. Simple; no extra S3 storage. |
| **Failed-row policy** | Retry whole batch (2 retries max) → mark `failed` → continue other batches → job ends `partial`. |
| **Concurrency on Render free** | Start with 3; configurable via `ENRICHMENT_CONCURRENCY` env. |

## Gotchas / non-obvious

- **EnrichmentAgent must subscribe to `agent:enrichment:incoming`**. DataExtractAgent's M7.7 handoff currently has no subscriber. Phase 3 turns this on.
- **Token counting per model.** GPT-4.1 = tiktoken `cl100k_base`. Claude = `@anthropic-ai/tokenizer`. Mixing → wrong batch fit.
- **Article content length is unbounded.** Cap per article at 4K tokens — truncate middle if needed.
- **JSON validation is brittle.** LLMs occasionally emit markdown fence / prose. validateJSON must aggressively clean: strip ` ```json ... ``` `, retry once on still-malformed.
- **`reach_cache` is global** — documented divergence from per-user RLS pattern.
- **`enrichments.is_valid`** matters — Phase 4 dashboards filter `is_valid = true`.
- **`enrichment_type = standard`** skips SimilarWeb entirely — important free-tier path; no SimilarWeb API key needed.
- **Frontend ChipUp pattern is NEW.** Distinct from `ChatActionPrompt` (M5) and `AgentActionPanel` (M7.9). Three sister components.
- **`articleIds[]` array column.** Postgres native; index with `idx_batches_job`. No join table at this scale.

## Proposed milestones (M8.1 → M8.10)

| # | Title | Demo |
|---|---|---|
| **M8.1** | DB foundation — 4 tables, RLS (3 of 4 user-scoped; reach_cache global), GIN indexes, shared types, `dashboard_json` JSONB column | `prisma migrate deploy` clean; RLS isolation test green; types compile |
| **M8.2** | LLMGateway — multi-model abstraction (Azure GPT-4.1 + skeleton for Claude/Ollama/Perplexity); tiktoken; batch sizing; retry/fallback | Token count accurate; createBatches packs greedily; complete() handles 5xx retry |
| **M8.3** | Enrichment prompt + Zod schemas — system prompt, few-shot examples, Zod schemas for all 6 dimensions, validateJSON cleaner | Unit test: malformed LLM response → cleanup → valid; schema rejects junk |
| **M8.4** | EnrichmentAgent (perceive/reason/plan/act/reflect) + subscribes to `agent:enrichment:incoming` | Fake ENRICHMENT_READY → agent loads articles → creates job + batches → idle |
| **M8.5** | EnrichBatchWorker (BullMQ) — registers `enrich-batch`; concurrency 3; per-batch upserts; emits 5 enrichment WS events | E2E: enqueue batch → worker picks up → calls LLMGateway (mocked) → upserts → emits events |
| **M8.6** | SimilarWebAgent + reach_cache — TTL check; batched fetch (50/call); merge into enrichments | Queue 234 domains → 180 cache misses → fetch → cache populated; rerun = 100% cache hit |
| **M8.7** | REST endpoints (9 routes) + remaining WS events (`enrichment:json-ready`, `reach-*`) + dashboard JSON aggregation | curl POST /enrich → status polls → /enrich/json returns full structure |
| **M8.8** | Frontend EnrichmentProgressCard (extends M7.9 AgentActionPanel) + BatchGrid + ReachAgentCard | Browser: Phase 2 → enrichment auto-starts → batches stream → green completion summary |
| **M8.9** | Frontend ChipUp artifact — collapsed/expanded/fullscreen with tab bar (Preview / JSON Code), download / share / email | Click chip → expand inline → switch tabs → fullscreen → close back |
| **M8.10** | Tests + Playwright e2e + docs (Phase 3 SHIPPED) + budget guardrails + CLAUDE.md update | Full backend suite green; Playwright e2e walks full Phase 2 → 3 flow; `MAX_TOKENS_PER_JOB` enforced |

Estimate: ~3-4 working days subagent-driven.

## Shipped milestones

(M8.1 — TBD)
