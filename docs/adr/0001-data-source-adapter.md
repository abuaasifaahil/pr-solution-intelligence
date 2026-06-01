# ADR-0001: Data-source adapter pattern + multi-source per chat

**Status:** Accepted 2026-06-01
**Phases affected:** Phase 3.5 (M9.6, M9.11), Phase 4, Phase 5, Phase 5.5
**Supersedes:** none
**Superseded by:** none

## Context

### What we have today (sha `6b66e76`, after M9.5)

Article-source selection is a single-valued `chat_params.data_source` ENUM column with two possible values: `csv_upload` or `opensearch`. Two agent classes implement the corresponding fetch paths:

| Class | Source | Triggered by |
|---|---|---|
| `DataExtractAgent` | CSV upload | confirmed boolean query + uploaded file |
| `SearchAgent` (M9.5) | OpenSearch | confirmed boolean query + `dataSource='opensearch'` |

A BullMQ worker (`workers/data-extract.worker.ts`) branches on `chat_params.dataSource` and dispatches to one or the other.

Field presence detection ([field-presence-detector.ts](../../app/backend/src/lib/field-presence-detector.ts)) inspects an article batch and reports which signals are populated (reach, country, publisher domain, author, description) so M9.5.5 can probe the user about upgrading to `enrichmentType='reach'` (SimilarWeb fetch) when reach is absent from the raw source.

### What we don't have

1. **No way to attach more than one source to a single chat.** A user who has both a CSV of analyst reports AND wants the AMX OpenSearch cluster pulled CANNOT combine them. They must pick one.
2. **Adding a new source kind (crawler, RSS feed, S3 bucket, Slack archive, IMAP, MCP tool) requires writing a new agent class** that re-implements the fetch loop, the bulk-insert path, the search-history write, the field-presence detection, and the event-bus wiring. ~250 lines of repeated structure per source.
3. **No declared-capability contract.** Today the worker knows OpenSearch carries `reach` because the M9.4.5 author hardcoded it into the payload builder. If a future crawler source ALSO carries reach (e.g. some crawlers populate Alexa rank), nobody else in the system knows that.
4. **No consolidated probe.** If the user attaches CSV + OpenSearch and only the CSV is missing reach, today's M9.5.5 design would emit one `reach:absent` per source, leading to N user prompts.

### Why this matters now

Phase 4 (Dashboards) treats `articles` as a single homogenous table; it does not care which source each row came from. So extending Phase 3.5 to multi-source is **a Phase 3.5 problem only** — Phase 4 inherits the result for free. Delaying multi-source means rewriting the Phase 4 dashboard query layer to be source-aware later, which would be a much larger change.

User feedback (chat 2026-06-01) explicitly raised:
> "user includes more than one data source — agent should be able to handle accordingly — data source request response process — checks enrichment + reach available or not accordingly do it. Make sure it can handle new data sources, MCP, skills, agents."

## Decision

### Three architectural changes

#### Change 1 — Introduce `DataSourceAdapter` interface

```ts
// app/backend/src/data-sources/adapter.ts (new package-style folder)
export interface DataSourceAdapter {
  /** Unique kind identifier. Matches data_source_kind enum value. */
  readonly kind: DataSourceKind;

  /** Static capabilities declared by the adapter. Used to plan the
   *  enrichment pipeline before any fetch happens. */
  declaredCapabilities(): DeclaredCapabilities;

  /** Fetch articles for a confirmed boolean query.
   *  Returns iterator-style for memory efficiency on large fetches. */
  fetch(ctx: FetchContext): AsyncIterable<NormalizedArticleBatch>;

  /** Optional override for the post-fetch presence check. Most adapters
   *  can rely on the default detectFieldPresence; custom overrides exist
   *  when the adapter has a cheaper way to know (e.g. CSV reads the
   *  header row in O(1)). */
  probePresence?(sample: NormalizedArticle[]): FieldPresence;
}

export interface DeclaredCapabilities {
  /** Confidence that EACH article from this source carries this field.
   *  Values: 'always' | 'usually' | 'rarely' | 'never' */
  hasReach: CapabilityConfidence;
  hasArticleSentiment: CapabilityConfidence;
  hasEntities: CapabilityConfidence;
  hasThemes: CapabilityConfidence;
  hasEngagement: CapabilityConfidence;
  hasCountry: CapabilityConfidence;
  hasAuthor: CapabilityConfidence;
}

export type DataSourceKind =
  | 'csv_upload'
  | 'opensearch'
  | 'crawler'          // Phase 3.5 / future M9.x
  | 'rss'              // Phase 3.5 / future M9.x
  | 's3'               // Phase 3.5 / future
  | 'slack_archive'    // Phase 6 / 7
  | 'imap'             // future
  | 'mcp_server'       // Phase 7 (per ADR-0002)
  | 'skill_provided';  // Phase 5.5 (per ADR-0002)
```

CSV and OpenSearch agents become adapters:

| Today | After M9.6 |
|---|---|
| `class DataExtractAgent extends BaseAgent { ... CSV fetch logic ... }` | `class CsvUploadAdapter implements DataSourceAdapter { ... }` + `DataExtractAgent` becomes a thin lifecycle wrapper |
| `class SearchAgent extends BaseAgent { ... OS fetch logic ... }` | `class OpenSearchAdapter implements DataSourceAdapter { ... }` + same |

The agent lifecycle (`perceive/reason/plan/act/reflect/learn`) lives in **one** orchestration class — `SourceOrchestrator` (next change). Adapters are pure fetch + capability declaration.

#### Change 2 — `chat_data_sources` table (1-to-N from `chats`)

```sql
CREATE TABLE chat_data_sources (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_id         uuid NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  source_kind     data_source_kind NOT NULL,  -- ENUM, matches DataSourceKind above
  source_config   jsonb NOT NULL,             -- per-kind: {upload_id} | {query_override} | {crawl_url, depth} | etc.
  priority        smallint NOT NULL DEFAULT 0,-- merge order; lower = earlier
  declared_caps   jsonb,                       -- snapshot of adapter.declaredCapabilities() at attach time
  detected_caps   jsonb,                       -- filled after first fetch by detectFieldPresence
  articles_fetched int NOT NULL DEFAULT 0,
  status          chat_data_source_status NOT NULL DEFAULT 'pending', -- pending | fetching | ready | failed
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (chat_id, source_kind, source_config)  -- prevent dup attaches
);

ALTER TABLE chats ADD COLUMN data_source_count int NOT NULL DEFAULT 0;
-- materialized counter so dashboard queries don't need to JOIN
```

**Migration of existing `chat_params.data_source` ENUM**:
- Keep column for backwards compatibility through Phase 4 (it serves as "primary source kind" for legacy code).
- During Phase 3.5 M9.11, write a one-shot backfill that creates one `chat_data_sources` row per existing chat using `chat_params.data_source` as the kind.
- After Phase 4 ships, deprecate the column. (Adds a follow-up ADR if/when actually removed.)

#### Change 3 — `SourceOrchestrator` (new class, replaces direct dispatch)

```
SourceOrchestrator.fetchAllSources(chatId)
  → loads N rows from chat_data_sources for this chat
  → for each adapter in priority order:
      iterate adapter.fetch() → bulk-insert articles → emit per-source progress
  → dedupe articles across sources by (chatId, normalized_url)
  → detectFieldPresence over the merged pool
  → emit ONE consolidated probe event:
      {
        sourcesAttached: 3,
        sourcesPresence: [
          {kind: 'opensearch', hasReach: true, hasEntities: true},
          {kind: 'csv_upload', hasReach: false, hasEntities: false},
          {kind: 'crawler', hasReach: false, hasEntities: false}
        ],
        unionMissing: ['reach', 'entities'],
        suggestUpgrade: enrichmentType==='standard' && unionMissing.includes('reach')
      }
```

The consolidated probe matches user feedback: *"in case denial then as per the comments found in other please do the same"* — single decision applied uniformly across all attached sources.

### Adapter responsibilities (the interface contract)

| Adapter must | Adapter must NOT |
|---|---|
| Return `NormalizedArticle` batches via async iterable | Touch the `articles` table directly |
| Declare its capabilities statically | Decide enrichment strategy |
| Throw friendly errors (or yield empty + log) on auth/connection failures | Emit `chat_event` directly — SourceOrchestrator does that |
| Support `AbortSignal` for cancellation | Hold open connections after fetch completes |
| Stamp `source_kind` on each `NormalizedArticle` | Modify the schema |

### What lives where

| Concern | Location |
|---|---|
| Adapter interface | `app/backend/src/data-sources/adapter.ts` |
| CsvUploadAdapter | `app/backend/src/data-sources/csv-upload/csv-upload.adapter.ts` |
| OpenSearchAdapter | `app/backend/src/data-sources/opensearch/opensearch.adapter.ts` |
| (future) CrawlerAdapter | `app/backend/src/data-sources/crawler/crawler.adapter.ts` |
| SourceOrchestrator | `app/backend/src/agents/source-orchestrator.agent.ts` |
| Adapter registry | `app/backend/src/data-sources/registry.ts` |
| Capability matrix tests | `app/backend/test/data-sources/declared-capabilities.test.ts` |

## Consequences

### Positive

- **Adding a source kind is a single-file change.** Implement adapter, register in `data-sources/registry.ts`, write tests. ~150 LoC + tests vs. ~500 LoC today.
- **Multi-source chats just work** — `SourceOrchestrator` handles N sources by iteration; merge + dedup is centralized.
- **Phase 4 dashboards stay source-agnostic** — they read `articles` and never branch on source kind. (Dashboards may opt to facet BY source, but they don't have to.)
- **MCP integration becomes a single adapter** — `McpServerAdapter` per ADR-0002 + Phase 7 plans plug into the same interface.
- **Probe consolidation matches user-stated expectation** — one chip dialog per chat, not one per source.

### Negative

- **Refactoring DataExtractAgent and SearchAgent in M9.6** is real engineering work (~1 day) on top of the originally-scoped "per-user OpenSearch override." M9.6 grows from 30 min to ~6 hours.
- **`chat_data_sources` table adds a JOIN to most queries** in the data-extract path. Mitigated by the `chats.data_source_count` counter for cheap "any sources attached?" checks.
- **The `source_config jsonb` is schemaless** — easy to write wrong configs. Mitigated by per-adapter Zod schemas in the registry; the route layer parses the config against the adapter's schema before insert.
- **Capabilities are declared, not verified** until first fetch. Mitigated by `detected_caps` being filled post-fetch; the `declared_caps` is a planning hint, not a contract.

### Neutral / open

- **Cross-source dedup key** = `(chatId, normalized_url)`. URLs from social platforms with trackers (`?utm_source=...`) need a normalizer. Punt to M9.11; for M9.6 we just dedupe within-source.
- **Adapter ordering matters when articles have conflicting metadata.** E.g. OpenSearch and CSV both have the same article with different `reach`. Convention: higher-priority source wins. `priority` defaults to attach order. Document in adapter contract.

## Alternatives considered + rejected

### Alternative A — keep `data_source` as single ENUM; require users to merge sources externally

**Rejected.** Forces every user who wants multi-source into ETL territory. AMX customers explicitly want platform-handled multi-source per the 2026-06-01 chat.

### Alternative B — keep agent classes per source; introduce only `chat_data_sources` table

**Rejected.** Avoids the 1-day refactor but locks in the "one new class per source" pattern. Phase 6/7 ambition for skill-provided and MCP-server sources would multiply the class count to 8-12. Better to pay the refactor cost now.

### Alternative C — use a third-party ingestion framework (Airbyte, Fivetran, Meltano)

**Rejected.** Adds vendor + cost; their connectors are ETL-pipeline-oriented (sync to warehouse), not chat-attached-source-oriented. Different shape than what we need.

### Alternative D — model sources as MCP servers from day one

**Rejected for now.** MCP is the right LONG-term abstraction (per ADR-0002) but the protocol's tool-call model doesn't map cleanly onto streaming article batches today. Phase 7 will introduce `mcp_server` as one DataSourceKind among many, but native adapters are simpler short-term.

## Migration plan

| Milestone | Change |
|---|---|
| **M9.5.5** (next) | NO ADAPTER REFACTOR YET. Just ship the probe orchestration as-designed. Keeps M9.5.5 small. |
| **M9.6** (was: per-user OS override) | **Re-scoped:** introduce `DataSourceAdapter` interface; refactor `SearchAgent` + `DataExtractAgent` into `OpenSearchAdapter` + `CsvUploadAdapter`. Per-user OS override moves into adapter `source_config jsonb`. Original M9.6 work folds in cleanly. |
| **M9.11** (NEW) | `chat_data_sources` table + `SourceOrchestrator` + REST endpoints `POST/DELETE /chats/:id/data-sources`. Multi-source chats become possible. |
| **M9.7** | Adjust scope to expose multi-source endpoints + the probe REST endpoint. |
| Phase 4 | `articles` queries stay source-agnostic. Dashboards can OPTIONALLY facet on `source_kind`. |
| Phase 5 | Memory of "user prefers source X for queries about Y" — recorded against `source_kind`. |
| Phase 5.5 | Skills can declare required-data-source-kinds in manifest; composer rejects ill-fit skills. (See ADR-0002.) |
| Phase 6 | Admin UI lists adapter registry; admins can disable adapters per workspace. |
| Phase 7 (new) | `McpServerAdapter` lets external MCP servers act as data sources. |

## References

- User chat 2026-06-01 raising multi-source + skills concern
- [field-presence-detector.ts](../../app/backend/src/lib/field-presence-detector.ts) (M9.4.5) — survives the refactor as the default `probePresence` implementation
- [enrichment-payload-builder.ts](../../app/backend/src/lib/enrichment-payload-builder.ts) (M9.4.5) — survives the refactor; routes on `detected_caps` instead of single-source heuristics
- ADR-0002 — explains how skills compose adapters
