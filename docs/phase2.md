# Phase 2 — Data Pipeline

**Source:** `Phase 2/Phase2_Technical_Specification.docx` (digested 2026-05-30)
**Status:** Spec digested · milestone plan pending user approval
**Builds on:** [phase1.md](phase1.md)

> Read this file before any Phase 2 work. Read [tech-stack.md](tech-stack.md) for cross-phase tech choices. Phase 2 contracts become immutable once shipped — Phase 3+ depends on them.

## Scope — what Phase 2 ships

Complete data ingestion layer. **File-upload-driven; live API crawls against configured connectors are deferred** ("Phase 2+ extension" per spec §6.2).

| Area | Deliverable |
|---|---|
| File upload | Drag-and-drop CSV/JSON, ≤50 MB, streaming to S3-compatible storage |
| Schema detection | Auto-detect columns, date range, normalize to `articles` schema |
| Conversational flow | 9-state machine extending Phase 1's orchestrator; skips collected params |
| Boolean query engine | Pure-string generation from brand + competitors + dates + intention |
| Data Extract Agent | `BaseAgent` subclass with 7-step processing visualization |
| Background processing | BullMQ-backed async parsing (no blocked API responses) |
| 4 new DB tables | `uploads`, `articles`, `chat_params`, `boolean_queries` |
| 11 new REST endpoints | All under `/api/v1/`, auth-guarded |
| 6 new WS events | `upload:*`, `flow:state-change`, `processing:*` |
| 12 new frontend components | File drop zone, query preview, processing card, etc. |

## What Phase 2 does NOT do

- **No live API extraction** from Meltwater/Opoint/Webz/Twitter — spec defers this. Connectors stored in `data_sources` (M5) are inert in Phase 2.
- No sentiment / theme / emotion enrichment (→ Phase 3)
- No dashboards (→ Phase 4)
- No learning / memory (→ Phase 5)
- No multi-agent routing (→ Phase 6)

## Phase 1 contracts Phase 2 must preserve

Per Phase 1 spec §8, these are immutable — Phase 2 is additive only:

| Phase 1 Contract | How Phase 2 uses it |
|---|---|
| `BaseAgent` abstract class | `DataExtractAgent` subclasses it (`perceive → reason → plan → act → reflect → learn`) |
| `AgentRegistry` singleton | `DataExtractAgent` registers at boot |
| Redis pub/sub bus | Orchestrator → DataExtract handoff via `agent:data_extract:incoming` |
| `withUser(userId, fn)` RLS wrapper | Every DB call against new tables wraps in this |
| Auth middleware (`preHandler: app.auth`) | All 11 new endpoints |
| Existing per-chat WS channel | All 6 new events ride this — no new channel |
| `lib/encryption.ts` (AES-256-GCM) | Decrypts data-source keys (when API crawls land post-Phase-2) |
| Existing `data_sources`, `mcp_connections`, `llm_configs` tables | Read-only in Phase 2 |
| Existing `chats`, `messages` tables | No schema changes; `chat_params` is a sibling, not a replacement |

## New tech-stack additions (ADRs required)

Per the freeze rule in `tech-stack.md`:

| Tech | Purpose | Why now | Risk |
|---|---|---|---|
| **BullMQ** | Async job queue (parse-upload worker) | Spec §5.1; uploads ≤50 MB / 50K rows can't block REST | New worker process; reuses existing ioredis |
| **S3-compatible storage** | File persistence | Can't store 50 MB files in Postgres or memory | Provider decision: Cloudflare R2 vs AWS S3 vs Render disk |
| **PapaParse 5.x** | CSV streaming parser | ArticleNormalizer needs row iteration without loading full file | Light dep, no ADR |
| **MinIO (dev only)** | Local S3-compatible storage | Mirror prod S3 without AWS creds in dev | Adds one container to docker-compose |

**Decisions needed before M7.2:** S3 provider for production. Default if no decision: Cloudflare R2 (no egress fees, 10 GB free).

## Database — 4 new tables (additive, no Phase 1 changes)

**Total after Phase 2: 14 tables** (10 from Phase 1 + 4 new).

### `uploads`
| Field | Type | Notes |
|---|---|---|
| `id` | UUID PK | |
| `user_id` | UUID FK → users | RLS scope |
| `chat_id` | UUID FK → chats | |
| `filename`, `mime_type`, `file_path`, `size_bytes` | — | S3 path in `file_path` |
| `row_count`, `column_count` | INTEGER | Set after parsing |
| `schema_detected` | JSONB | `[{name, type, sample}]` |
| `date_column`, `date_range_start`, `date_range_end` | — | Auto-detected at parse time |
| `status` | ENUM(`uploading`, `parsing`, `ready`, `error`) | Lifecycle |
| `error_message`, `parsed_at`, `created_at` | — | |

Indexes: `(user_id, chat_id)`, `(status)`, `(created_at)`. RLS: own rows only.

### `articles`
| Field | Type | Notes |
|---|---|---|
| `id` | UUID PK | |
| `upload_id` | UUID FK → uploads (NULLABLE) | NULL when from API crawl (Phase 2+) |
| `chat_id`, `user_id` | UUID FK | `user_id` denormalized for RLS perf |
| `title`, `content`, `description`, `source`, `author`, `url` | — | Normalized fields |
| `published_date` | DATE | |
| `publisher_domain` | VARCHAR(255) | Extracted from URL for Phase 3 reach lookup |
| `language` | VARCHAR(10) | Default `'en'` |
| `raw_data` | JSONB | Original CSV row / JSON for reference |

Indexes: `(chat_id)`, `(user_id)`, `(upload_id)`, `(published_date)`, `(publisher_domain)`, GIN on `raw_data`. RLS via `user_id`. Bulk insert via `prisma.article.createMany({skipDuplicates: true})`.

### `chat_params`
1:1 with `chats` — one parameter set per chat. Tracks the flow:
| Field | Type | Notes |
|---|---|---|
| `id`, `chat_id` (UNIQUE), `user_id` | UUID | |
| `flow_state` | ENUM (9 states — see "Conversational flow" below) | |
| `date_range_type`, `date_start`, `date_end` | — | Source: chip pick OR auto-detected |
| `enrichment_type` | ENUM(`standard`, `reach`) | |
| `reach_threshold` | INTEGER | When `enrichment_type = 'reach'` |
| `brand` | VARCHAR(255) | |
| `competitors` | JSONB | Array of brand names |
| `competitor_set` | ENUM(`top5`, `top3`, `top2`, `custom`) | |
| `intention` | ENUM(`intention_based`, `comment_based`) | |
| `has_upload`, `upload_id` | — | Whether a file backs this chat |
| `collected_at`, `created_at`, `updated_at` | — | |

### `boolean_queries`
| Field | Type | Notes |
|---|---|---|
| `id`, `chat_id`, `chat_params_id` | UUID | |
| `query_text` | TEXT | Full Boolean query string |
| `query_structured` | JSONB | `{brand, competitors[], fields[], dateRange, language}` |
| `version` | INTEGER | Incremented on edit |
| `is_confirmed`, `confirmed_at`, `created_at` | — | |

## API — 11 new endpoints (all `/api/v1/`)

**Total after Phase 2: 33** (22 from Phase 1 + 11). All auth-guarded.

| Method | Path | Purpose |
|---|---|---|
| POST | `/uploads` | multipart/form-data `{file, chatId}` → stream to S3 → queue parse job |
| GET | `/uploads/:id` | Status + schema + dateRange + rowCount |
| GET | `/uploads/:id/preview?limit=10` | First N parsed rows |
| DELETE | `/uploads/:id` | Hard delete + S3 cleanup |
| GET | `/chats/:id/params` | Current params + flowState |
| PATCH | `/chats/:id/params` | Partial update; advances flow state |
| POST | `/chats/:id/params/brand-suggest` | LLM-driven competitor suggestion |
| POST | `/chats/:id/query/generate` | Auto-generate from params |
| PATCH | `/chats/:id/query` | User manual edit; bumps `version` |
| POST | `/chats/:id/query/confirm` | Trigger DataExtractAgent |
| GET | `/chats/:id/processing` | Status + step list + progress |

## WebSocket — 6 new events on existing channel

| Event | Direction | Payload |
|---|---|---|
| `upload:progress` | server→client | `{uploadId, percent, phase}` |
| `upload:parsed` | server→client | `{uploadId, rowCount, columns, dateRange, schema}` |
| `upload:error` | server→client | `{uploadId, error}` |
| `flow:state-change` | server→client | `{chatId, fromState, toState, nextPrompt}` |
| `processing:step` | server→client | `{chatId, stepName, status, duration}` |
| `processing:complete` | server→client | `{chatId, totalArticles, domains, totalTime}` |

## Conversational flow engine — 9 states

Extends Phase 1's `OrchestratorAgent` state machine. The 6 Phase 1 states map to the first 6; Phase 2 adds 3 terminal states.

| Phase 2 state | Phase 1 equivalent | Enters when | Skip if |
|---|---|---|---|
| `INIT` | `welcome` | First message | — |
| `COLLECT_DATES` | `awaiting_date` | No date range, no upload | File with auto-detected dates |
| `COLLECT_ENRICHMENT` | `awaiting_enrichment` | Dates known | Never |
| `COLLECT_BRAND` | `awaiting_brand` | Enrichment selected | Brand in INIT prompt |
| `COLLECT_COMPETITORS` | `awaiting_competitors` | Brand confirmed | Competitors in prompt |
| `COLLECT_INTENTION` | `awaiting_intention` | Competitors selected | Intention in prompt |
| `GENERATE_QUERY` | — | All params collected | Never |
| `PROCESSING` | — | Query confirmed | — |
| `COMPLETE` | (extends `ready`) | All steps done | — |

State transitions are pure functions (no LLM); `BooleanQueryEngine.generate()` is pure string construction. Only `brand-suggest` uses the LLM.

## DataExtractAgent lifecycle

| Lifecycle method | Implementation |
|---|---|
| `perceive` | Identify upload notification vs query confirmation |
| `reason` | Strategy: `csv_upload` vs `api_crawl` (Phase 2 = csv_upload only) |
| `plan` | Ordered step list: validate → parse → dates → domains → normalize → insert → handoff |
| `act` | Execute each step; emit `processing:step` via Redis bus → WS; retry on failure |
| `reflect` | Validate: all articles inserted, domain extraction rate >90% |
| `learn` | No-op (Phase 5) |

**7 processing steps shown to user** with typical durations: validate (0.2-0.5s) · parse (0.5-2s) · dates (0.1-0.3s) · domains (0.3-1s) · normalize (0.5-1.5s) · DB insert (1-3s) · handoff (0.1-0.3s). ~6.5s total for the spec's 2,847-article reference dataset.

## Frontend — 12 new components

| Component | Purpose |
|---|---|
| `FileDropZone` | Drag-drop area; type/size validation; drag-over highlight |
| `UploadProgressCard` | Progress bar → metadata grid on complete |
| `DataPreviewTable` | First N rows; scroll + sticky header |
| `OptionChips` | ✓ Already covered by `ChatActionPrompt` (M5/PR#15-16) — reuse |
| `CustomDatePicker` | from/to date inputs + Apply |
| `BrandInput` | Text + auto-suggestion dropdown |
| `CompetitorTags` | Pill tags with remove × |
| `ReachThresholdInput` | Number input ("monthly visitors") |
| `BooleanQueryPreview` | Syntax-highlighted code block + Edit/Copy/Confirm |
| `ProcessingSteps` | Animated step list (spinner / check / circle) |
| `CompletionSummary` | Collapsible green stats card |
| `FlowDotIndicator` | Top progress dots (done/active/pending) |

## Contracts Phase 2 exposes to Phase 3+

Immutable once Phase 2 ships:
- `DataExtractAgent` (registered, emits `ENRICHMENT_READY` event)
- `articles` table (normalized schema for enrichment input)
- `chat_params` table (Phase 3 reads `enrichment_type`, `reach_threshold`)
- `boolean_queries` table (re-executable post-Phase-2)
- `uploads` table (Phase 3 references for batch context)
- `ConversationalFlowEngine` service (reusable for any agent needing param collection)
- `BooleanQueryEngine` service (reusable across agents)
- 11 REST endpoints + 6 WS events
- Shared TS types: `Upload`, `Article`, `ChatParams`, `BooleanQuery`, `FlowState`

## Performance targets (validated at phase end)

| Tier | Metric | Target |
|---|---|---|
| Upload | File ≤50 MB | streaming, no memory spike |
| Upload | Parse latency | <5 s for 5K rows; <15 s for 50K rows |
| DB | Bulk insert | 500 rows/batch; <3 s for 5K articles |
| DB | `articles` lookup by `chat_id` | <5 ms |
| Flow engine | State transition | <2 ms per `getNextState()` |
| Boolean query | Generation | <10 ms |
| WS | Event delivery | <20 ms worker→client |
| Memory | Worker peak (50K articles) | <256 MB |
| Error | Job retry | 3 retries, exponential backoff, dead-letter on 4th |

## Open items — resolutions

All items resolved during Phase 2. Snapshot of actual decisions:

| Item | Resolution |
|---|---|
| **S3 provider (prod)** | DEFERRED — `STORAGE_MODE=inmemory` in the current Render free tier (bytes-discarded baseline). AWS S3 migration runbook in [storage-migration.md](storage-migration.md); flip env vars on Render, zero code change. |
| **MinIO in docker-compose** | DONE — `app/infra/docker-compose.yml` provides `minio` + `minio-init` services for local-dev parity. |
| **BullMQ vs simpler queue** | DONE — BullMQ inline worker (same Node process as Fastify; no separate Render dyno). |
| **brand-suggest implementation** | DONE — LLM call via existing `chatComplete`. |
| **Phase 2 includes API crawls?** | CONFIRMED CSV-only per spec. Live API crawls deferred to Phase 2.5 or Phase 3. |

## Gotchas / non-obvious

- **`chats.context` is shared with Phase 1's orchestrator.** Phase 2's `chat_params` adds a sibling table — flow state goes in `chat_params.flow_state`, NOT in `chats.context`. Avoid double-bookkeeping.
- **`upload:parsed` arrives async.** Frontend must not assume the upload card transitions to "ready" synchronously; the WS event drives the UI.
- **CSV column variations** (`headline` vs `title`, `body` vs `content`) need configurable mapping in `ArticleNormalizer`. Hard-coded is brittle — start with a config object, defer learning-based normalization to Phase 5.
- **`publisher_domain` extraction** uses `new URL(url).hostname` per spec. Doesn't strip `www.`. Decide whether to canonicalize for reach-lookup matching.
- **The orchestrator's existing state machine** lives in [orchestrator-state.ts](app/backend/src/agents/orchestrator-state.ts). Phase 2's flow engine should *extend* (add `GENERATE_QUERY`, `PROCESSING`, `COMPLETE`), NOT replace — preserve the M3-M5 chip-state shapes.
- **`articles.user_id` is denormalized** (already reachable via `chat → user`). The spec calls this out for RLS performance — keeps the `user_id` filter on the same row, no join needed.
- **`brand-suggest` is an LLM call.** Budget: ~$0.0001/call with `chatComplete`. Cache by brand name with short TTL.
- **Spec's reference dataset is "2,847 parsed articles" with 234 domains.** Use as a benchmark in performance tests.

## Milestone plan

See proposed milestones in chat thread → pending approval → will land at `docs/plans/phase2-milestones.md`.

## Shipped milestones (M7.1 → M7.10)

| # | sha | Title |
|---|---|---|
| M7.1 | 5e23065 | DB foundation (4 tables + RLS + types) |
| M7.2 | 5898d40 | Storage abstraction + BullMQ inline worker |
| M7.3 | a21cccc | Upload REST endpoints |
| M7.4 | a2de98a | ParseUploadWorker + ArticleNormalizer |
| M7.5 | bf5aabd | ConversationalFlowEngine + chat_params |
| M7.6 | 5467c17 | BooleanQueryEngine |
| M7.7 | 8a0614c | DataExtractAgent + 7-step processing pipeline |
| M7.8 | dab7966 | Frontend upload UX (drop zone + progress + preview) |
| M7.9 | df9b25e | Frontend flow + AgentActionPanel (generic) + processing card |
| M7.10 | (this) | Tests + e2e + docs |

**Phase 2 deliverables vs spec:** 4 new tables · 11 new REST endpoints · 6 new WS events · 12 new frontend components · 2 agents (Orchestrator + DataExtractAgent) · ~250 backend tests + ~50 frontend tests + 1 Playwright e2e.
