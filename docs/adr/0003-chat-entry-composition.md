# ADR-0003: Chat-entry composition — 8 entry patterns, agent-as-prober, single normalization point, per-user authoring

**Status:** Accepted 2026-06-01
**Phases affected:** Phase 3.5 (M9.6, M9.7, M9.8), Phase 4 (dashboards), Phase 5 (memory + experience), Phase 5.5 (skills), Phase 6 (admin), Phase 7 (MCP)
**Supersedes:** none
**Builds on / amends:** [ADR-0001](0001-data-source-adapter.md), [ADR-0002](0002-skill-composition.md)

## Context

ADR-0001 introduced the data-source adapter pattern (multi-source per chat). ADR-0002 introduced skills as the unit of composition (replacing the fixed agent dropdown). Both ADRs were written before the user articulated the **chat-creation experience itself**.

User feedback 2026-06-01 (two follow-up messages):

> "First along with chat window text input, display default agents user wants to go head. Agent + CSV — with prompt / without prompt. Agent + Crawl — with prompt / without prompt. Probe for brand agents — hope agents are able to classify and probe. Make sure all data sources' enrichment data are normalized at one point and processed."

> "New agents and skills can be added user respective user — within his profile."

> *(Earlier in conversation)* "Skill + Crawl + Prompt — no need of agent selection since skill itself builds a dashboard. Skill + CSV + Prompt — same. Prompt + CSV — probe agent to select agent/skill, chip-up display all agents/skills based on prompt sequence and agents' learning memory and experience. Prompt + Crawl — same. General prompting also should work but always see if he wants to create agent-skill based dashboard."

Two architectural absences in ADR-0001 + ADR-0002 surfaced from this:

1. **Chat-creation flow has more than one entry pattern.** ADR-0002 sketched ONE flow ("describe + attach"). Reality: there are at least **8 entry patterns** depending on what the user pre-selects (agent? skill? source? prompt?).
2. **Agents are not just selectable — they're interactive probers.** When a user attaches an agent + CSV with no prompt, the agent should READ the CSV, classify what it sees (brand mentions? competitor mentions? geographic spread?), and probe the user for the missing pieces. This is a different responsibility than "agent runs analysis when invoked."
3. **Ownership is per-user, not just per-workspace.** ADR-0002 had `workspace_id` on skills; this ADR adds `user_id` so individual analysts can author private agents/skills in their profile.
4. **Single normalization point** is an invariant ADR-0001 implies but doesn't explicitly state.

## Decision

### Decision 1 — Eight chat-entry patterns

Chat creation has exactly **eight** entry pattern combinations. Each is identified by the triple `(pre-selected: agent?, skill?, source?) × (prompt? present?)`. The default chat-creation UI MUST support all eight without modal pivots.

| # | Agent | Skill | Source | Prompt | Behavior |
|---|---|---|---|---|---|
| **0** | default | — | — | — | **Always-visible fallback.** Chat opens with a default agent + empty prompt. User can immediately type — bare minimum to start. |
| **1** | — | yes | crawl | yes | Skill drives full flow. Crawler fetches → skill enriches → skill-declared dashboard renders. No agent selection. |
| **2** | — | yes | csv | yes | Same as 1 with CSV ingestion. |
| **3** | — | — | csv | yes | **Probe: pick agent or skill.** Chip list ranked by (intent + memory + per-user experience). After pick, expand recommendations; "Other" reveals full catalog. |
| **4** | — | — | crawl | yes | Same as 3 with crawl input. |
| **5** | — | — | — | yes | General conversation. After 1-2 turns, **always offer** "Want me to build a dashboard from this?" — opens skill-composer in a chip. |
| **6** | yes | — | csv | yes/no | **Agent-as-prober.** Agent reads CSV header + sample rows, classifies fields (brand mentions, competitor mentions, dates, languages), then probes for ONLY the missing pieces. With prompt: extracts what it can; without prompt: probes for everything missing. |
| **7** | yes | — | crawl | yes/no | Same as 6 with crawler. Agent probes for crawl scope (brand, depth, allow-list) using the same classify-then-probe pattern. |

**Pattern 0 is the default and MUST always be reachable** — even after the user has attached sources or picked skills, the "just start chatting" path remains one click away. This protects against "configuration wall" UX failures.

#### Visual model — UI implication (Phase 3.5 M9.8 + Phase 5.5)

```
┌─ New chat ─────────────────────────────────────────────────┐
│  [Default agent: PR Impact ▾]            [+ Skill] [+ Source] │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐   │
│  │ Describe what you want to know...                    │   │
│  └──────────────────────────────────────────────────────┘   │
│                                                              │
│  Recently used:  [PR Impact] [Brand Sentinel] [CSV+pr-impact]│
│                                                              │
│                              [Start chat]                    │
└──────────────────────────────────────────────────────────────┘
```

The default agent selector starts populated (pattern 0). Adding a skill OR source shifts the user into patterns 1-7. The composer picks the right flow based on what's attached.

### Decision 2 — Agent-as-prober contract

Today's agent classes (PR Impact, Brand Sentinel, etc.) are **dispatch targets** — invoked after `chat_params` is fully filled. Patterns 6 + 7 require agents to also be **classifiers and probers**.

New interface (additive — existing agent code paths preserved):

```ts
// app/backend/src/agents/probing-agent.ts (new)
export interface ProbingAgent {
  /**
   * Inspect attached data sources (and any user prompt) to identify
   * which chat_params slots are already determinable, which need
   * probing, and which are inferred with low confidence.
   *
   * Called BEFORE the existing wizard / state machine. Output drives
   * the orchestrator's chip generation.
   *
   * Idempotent — re-running with the same input MUST yield the same
   * probe set (for Phase 5 memory replay).
   */
  classifyAndProbe(input: ProbingInput): Promise<ProbingResult>;
}

export interface ProbingInput {
  userId: string;
  chatId: string;
  prompt: string | null;            // null when "without prompt" (patterns 6/7)
  attachedSources: AttachedSourceSnapshot[];
  // Snapshot, NOT live adapter — we read first-page sample only.
}

export interface AttachedSourceSnapshot {
  sourceId: string;
  kind: DataSourceKind;
  sampleArticles: NormalizedArticle[]; // first ~25 rows from the adapter's fetch
  declaredCapabilities: DeclaredCapabilities;
}

export interface ProbingResult {
  /** What the agent could determine without asking. */
  inferred: Partial<ChatParams>;
  /** Per-inferred-field confidence 0..1 — matches IntentExtractor pattern. */
  confidence: Record<keyof ChatParams, number>;
  /** Ordered list of probes to surface as chip prompts. */
  probes: Probe[];
  /** Free-text rationale shown in the IntentExtractedCard. */
  rationale: string;
}

export interface Probe {
  field: keyof ChatParams;
  question: string;                  // "Which brand should we focus on?"
  chips: ChipOption[];               // candidate values inferred from sample
  allowFreeText: boolean;            // typically true for brand, false for enums
}
```

**Default implementation lives in `lib/sample-classifier.ts`** — Phase 3.5 M9.6 ships a baseline classifier that:
1. Reads up to 25 rows from each attached source
2. Counts entity mentions per row (brand-likes, competitor-likes via NER if the source pre-computed, else regex over title/content)
3. Detects implicit date ranges (min/max `publishedDate` in the sample)
4. Detects implicit languages
5. Produces a sane `ProbingResult` even when no agent override is registered

Agents extend this baseline by overriding `classifyAndProbe()` with domain-specific heuristics. PR Impact can prioritize brand-vs-competitor disambiguation; Brand Sentinel can prioritize sentiment baselines.

### Decision 3 — Single normalization point (invariant)

Every data-source adapter (CSV, OpenSearch, Crawl, RSS, S3, Slack, MCP, …) MUST converge to the **same** `NormalizedArticle` shape before any downstream code sees it. There is exactly ONE place where this normalization happens — inside the adapter itself, via the existing M9.4.5 `lib/field-aliases.ts` + `lib/opensearch-mapping.ts` patterns generalized to all adapters.

```
       ┌─────────────────┐
       │ CSV adapter     │──┐
       └─────────────────┘  │
       ┌─────────────────┐  │
       │ OpenSearch ad.  │──┼──► NormalizedArticle ──► articles table ──► EnrichmentAgent
       └─────────────────┘  │     (one shape, ever)         (one path)         (one prompt)
       ┌─────────────────┐  │
       │ Crawl adapter   │──┘
       └─────────────────┘
              ...
```

**Invariants:**

1. **Adapters produce `NormalizedArticle` directly** — no per-adapter intermediate shape that leaks to callers
2. **`enrichment-payload-builder.ts` (M9.4.5) is the ONLY code that constructs LLM payloads** — no agent or skill bypasses it
3. **The `articles` table is the single sink** — no per-source articles table, no per-adapter cache that the worker reads from
4. **Field-presence detection runs on the merged pool**, not per-adapter, when multiple sources attach (matches ADR-0001's `SourceOrchestrator`)

This is the architectural reason ADR-0001 introduced the adapter interface AND why pre-computed signals like OpenSearch's `articleSentiment` are deliberately NOT forwarded (ADR-0001 deviation; M9.4.5 commit `c436c05`): the LLM tagger sees a canonical payload regardless of source, ensuring downstream consistency.

### Decision 4 — Per-user agent and skill ownership

Amends ADR-0002. Adds `user_id` to the `skills` table and introduces a parallel `user_agents` table.

```sql
-- amends ADR-0002 Part 2
ALTER TABLE skills
  ADD COLUMN user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  ADD COLUMN scope skill_scope NOT NULL DEFAULT 'workspace';

CREATE TYPE skill_scope AS ENUM (
  'first_party',     -- ships with the platform
  'workspace',       -- workspace-shared (admin-curated, ADR-0002)
  'user_private',    -- per-user, only visible in their profile
  'community'        -- future Phase 7 marketplace
);

CREATE TABLE user_agents (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name            text NOT NULL,
  base_agent_kind agent_kind NOT NULL,         -- which builtin agent this extends
  customization   jsonb NOT NULL,              -- prompt overrides, default chat_params, etc.
  scope           agent_scope NOT NULL DEFAULT 'user_private',
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, name)
);

CREATE TYPE agent_scope AS ENUM ('user_private', 'workspace_shared');
-- 'workspace_shared' requires admin promotion per Phase 6.
```

**Profile UX (Phase 5.5 M10.x):**

```
Settings → My Agents & Skills
├── Agents (3)
│   ├── PR Impact (first-party)            [⊘ default]
│   ├── My Brand Sentinel (private)        [✎ edit]  [⤴ share to workspace]
│   └── Pharma Crisis Watch (private)      [✎ edit]  [⤴ share]
├── Skills (5)
│   ├── pr-impact v1.0 (first-party)       [⊘ default]
│   ├── sentiment-tagger v1.0 (first-party)[⊘ default]
│   ├── csv-cleanup v0.3 (private)         [✎ edit]
│   ├── reach-classifier v0.2 (private)    [✎ edit]
│   └── linear-fetch (workspace, ▼Admin)   [—]
└── [+ New agent]   [+ New skill]
```

**Authoring surface:**
- M9.7 (REST) ships `POST /users/:id/agents` + `POST /users/:id/skills`
- M9.9 (Settings) ships the "My Agents & Skills" tab
- M10.x ships the in-browser authoring forms

**Resolution order in `SkillComposer.compose()`:**

```
1. Explicit pin (user attached skill X to this chat)        ← highest priority
2. User-private skills/agents matching the intent
3. Workspace-shared skills/agents matching the intent
4. First-party defaults matching the intent
5. Composer's intent-extractor + base classifier            ← fallback
```

### Decision 5 — Memory-driven ranking inputs

The "ranked chips" in patterns 3 + 4 depend on a ranking algorithm that today doesn't exist. This ADR locks the **inputs** to that algorithm; the algorithm itself is a Phase 5 deliverable.

Inputs to the ranker (in priority order):

1. **Sequence proximity**: how close is the user's prompt to past prompts that ran agent/skill X? (cosine similarity on intent embeddings)
2. **Per-user experience**: success/failure outcomes the user has had with agent/skill X
3. **Per-user explicit preferences**: pinned agents/skills (Phase 5/6 settings)
4. **Workspace-level success rate**: across all users in the workspace
5. **First-party defaults**: when memory has nothing to say (new user, new workspace)

```sql
-- Phase 5 schema (locked here, implemented later)
CREATE TABLE agent_skill_experience (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users(id),
  agent_or_skill  text NOT NULL,             -- 'agent:pr_impact' | 'skill:sentiment-tagger'
  intent_class    text NOT NULL,             -- coarse intent label from IntentExtractor
  outcome         outcome_kind NOT NULL,     -- 'success' | 'abandoned' | 'redirected'
  context_hash    text NOT NULL,             -- hash of (data_source_kinds, prompt_embedding_cluster)
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE TYPE outcome_kind AS ENUM ('success', 'abandoned', 'redirected');

CREATE INDEX ON agent_skill_experience (user_id, intent_class, created_at DESC);
```

**Definition of "success":** user accepted the agent/skill's output → reached the dashboard / saved the chat / shared it. **"Abandoned":** chat closed without enrichment ever finishing. **"Redirected":** user picked a different agent mid-chat (this is gold for the ranker — strong negative signal for the original pick).

Phase 5 implements the ranker. Phase 3.5 stubs it: M9.6+ uses naive first-party-first ordering until Phase 5 lands.

## Consequences

### Positive

- **Chat creation matches user mental model** — 8 patterns cover the realistic entry combinations; no more "where do I even start" UX failure
- **Agents earn their selection** — Patterns 6+7 turn agents from passive dispatch targets into interactive probers. The agent dropdown becomes meaningful (each agent's probing behavior is different) instead of decorative
- **Per-user authoring** — analysts can build private agents/skills without admin gate, fostering experimentation; admins can promote private → workspace later
- **Single normalization point** locks an invariant that prevents Phase 4 dashboards from accidentally becoming source-aware
- **Memory inputs locked now** — Phase 5 can ship the ranker without retrofitting; Phase 3.5 can stub it cleanly

### Negative

- **8 entry patterns is a lot to test** — M9.10 e2e suite needs 8 happy-path tests + edge cases between modes. Mitigated by composing tests from primitives (one "pattern matrix" test runner)
- **Agent-as-prober adds latency on chat creation** — agents must read sample articles before chat is interactive. Mitigated by streaming: probe results arrive incrementally; user can still type while probing finishes
- **`agent_skill_experience` table will grow rapidly** — one row per chat outcome × source kind. Mitigated by partitioning on `created_at` quarterly (Phase 5 task)
- **Two ownership models (workspace + user_private)** complicate the skill resolver — M10.7 needs robust precedence rules + tests

### Neutral / open

- **What's the default agent for Pattern 0?** Probably PR Impact (most generic). User preference saved to profile after first chat.
- **What happens when a user_private agent is pinned but the user moves workspaces?** Open question — punt to Phase 6 admin migration UI.
- **Sharing user_private → workspace requires admin approval.** Defined as flow but not modeled in this ADR. Phase 6 admin work.

## Alternatives considered + rejected

### Alternative A — Single "describe + attach" textarea (ADR-0002 original)

**Rejected.** Doesn't surface the default agent for Pattern 0; doesn't model agent-as-prober; forces every user through one chat-creation paradigm. Real users want both the "express intent and let the system figure out" path AND the "I know which agent I want, just give it my data" path.

### Alternative B — Wizard-only (current Phase 1 dropdown)

**Rejected.** No room for skills, sources, or composition. Locked us into the limitations the user is asking us to escape.

### Alternative C — Agent-as-prober only (no skills)

**Rejected.** Skills enable cross-source composition + user authoring. Removing them re-collides agents and ingestion (which we just spent ADR-0001 separating).

### Alternative D — Skills replace agents entirely (no agent dropdown ever)

**Rejected.** Removes Pattern 0 + breaks backward compat with Phase 1 users. Skills are additive, not replacement.

## Migration plan

| Milestone | Change |
|---|---|
| **M9.6** (re-scoped, current next) | DataSourceAdapter interface (ADR-0001) + baseline `sample-classifier.ts` shipping the `ProbingAgent` interface. **Default `classifyAndProbe()` lives in lib, not agent classes** — agents extend if they want, otherwise inherit. |
| **M9.7** | REST endpoints: `POST /users/:id/agents`, `POST /users/:id/skills`, `GET /chats/:id/probe`, `POST /chats/:id/probe/resolve`. Plus the multi-source endpoints from ADR-0001. |
| **M9.8** | IntentExtractedCard becomes the "ProbingResultCard" — same component, broader content (handles 8 patterns). Includes the chip-rank UI. |
| **M9.9** | "My Agents & Skills" tab in Settings (M5 surface). |
| **M9.10** | E2E pattern-matrix test runner covering all 8 patterns. |
| **M9.11** | `chat_data_sources` (ADR-0001) + `SourceOrchestrator` + `agent_skill_experience` table created (empty — Phase 5 fills). |
| **Phase 4** | Skill-requested dashboard layouts (Patterns 1+2 declare layout in skill manifest). |
| **Phase 5** | Ranker implementation. `agent_skill_experience` fills on every chat completion. Composer reads ranked candidates. |
| **Phase 5.5** | `user_skills` authoring UI + JSONSchema validator + composer in production. |
| **Phase 6** | Admin promotion (user_private → workspace_shared). Workspace policy editor. |
| **Phase 7 (new)** | MCP server skills + community marketplace gate. |

## References

- User chat 2026-06-01 (5 messages threaded through the conversation)
- [ADR-0001](0001-data-source-adapter.md) — adapter interface + multi-source
- [ADR-0002](0002-skill-composition.md) — skill manifest format + composer
- [field-aliases.ts](../../app/backend/src/lib/field-aliases.ts) — the single normalization point's implementation
- [enrichment-payload-builder.ts](../../app/backend/src/lib/enrichment-payload-builder.ts) — the single LLM-payload entry
- [reach-probe.service.ts](../../app/backend/src/services/reach-probe.service.ts) (M9.5.5) — pattern for "probe + chip + resolve" that probing-agent reuses
