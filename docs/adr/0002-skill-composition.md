# ADR-0002: Skill-first composition (replacing fixed-agent dropdown)

**Status:** Accepted 2026-06-01
**Phases affected:** Phase 5, Phase 5.5 (renamed), Phase 6, Phase 7 (new)
**Supersedes:** Phase 1 fixed-agent dropdown (architecturally, not the Phase 1 ship — agents remain functional through Phase 4)
**Superseded by:** none

## Context

### What we have today (sha `6b66e76`, after M9.5)

The platform ships 4 fixed agent classes per Phase 1 spec:

| Agent | Purpose |
|---|---|
| PR Impact | Sentiment + reach impact of a brand over a date range |
| Brand Sentinel | Continuous monitoring of brand mentions |
| Crisis Watch | Real-time alerting on negative spikes |
| Competitor Tracker | Comparative coverage across brands |

User selects one from a dropdown at chat creation (`chat_params.agent_type` ENUM). The selection determines:
- The orchestrator's system prompt
- Which sub-agents get invoked
- Which dashboard layout renders in Phase 4
- Which alert thresholds trigger

Phase 5.5 was originally scoped as "Dynamic Tool Sandbox" — wrap Azure OpenAI Assistants API so an agent can generate a tool at runtime, sandbox-execute it, and surface the result in chat. See [docs/phase5.5-sandbox.md](../phase5.5-sandbox.md).

### What we don't have

1. **No way for users to compose multiple capabilities.** "Run PR Impact analysis on a Slack archive of my company's #pr-mentions channel" is not expressible — there's no agent that combines those, and the user can't author one.
2. **No third-party extension surface.** AMX's customers may want their own analysts to add bespoke capabilities (e.g. "watch for SEC filing keywords in the corpus"). Today they'd need to fork the repo.
3. **MCP support is unplanned.** Anthropic's [Model Context Protocol](https://modelcontextprotocol.io/) is becoming the standard way to expose tools to LLMs. No phase currently integrates it.
4. **The agent dropdown is the wrong abstraction long-term.** Users don't think "which agent fits my question?" — they think "I want to know X." The agent should be assembled from intent, not picked from a menu.
5. **Phase 5.5 as currently scoped builds a sandbox but no catalog of what can run in it.** Without a skill registry, the sandbox is a one-off code-interpreter call, not a reusable capability surface.

### Why this matters now

User feedback (chat 2026-06-01):

> "Make sure it can handle new data sources, MCP, skills, agents. Hope upcoming phases have plan for Skill + Csv, Skill + Crawl instead of user selects agents options."

The user has explicitly asked for skill-first composition AND for skill+source combination. The current phase plan can't deliver this without a redesign.

We are NOT building skill composition now (Phase 3.5 is a data-source phase). This ADR locks the design vector so Phase 4 and 5 don't make decisions that fight skill composition.

## Decision

### Six-part decision

#### Part 1 — `Skill` is the new unit of composition

A skill is a JSON manifest + optional code + optional prompt + declared inputs/outputs. The manifest looks like:

```json
{
  "name": "pr-impact",
  "version": "1.0.0",
  "kind": "analysis_skill",
  "displayName": "PR Impact Analysis",
  "description": "Sentiment + reach + themes for a brand over a date range",
  "author": "AMX",
  "trust_level": "first_party",

  "requires": {
    "data_sources": {
      "min": 1,
      "max": null,
      "kinds_any_of": null,
      "must_have_capabilities": ["title", "content", "publishedDate"]
    },
    "chat_params": ["brand", "dateRange"],
    "secrets": []
  },

  "produces": {
    "enrichments_per_article": ["sentiment", "themes", "entities"],
    "dashboard_layout": "pr-impact",
    "alert_rules": []
  },

  "executes": {
    "kind": "llm_chain",
    "system_prompt_ref": "./prompts/pr-impact.system.md",
    "tools_required": [],
    "model_family": "gpt-4-tier"
  }
}
```

Six skill `kind`s in scope:

| Kind | Example | Notes |
|---|---|---|
| `analysis_skill` | pr-impact, brand-sentinel | Replaces the legacy agent dropdown |
| `source_skill` | csv-source, opensearch-source, crawler-source | Wraps an adapter from ADR-0001 |
| `enrichment_skill` | sentiment-tagger, entity-extractor | Re-usable LLM enrichment step |
| `tool_skill` | parse-pdf, run-python, web-fetch | Phase 5.5 sandbox-executed |
| `alert_skill` | spike-detector, sentiment-floor | Phase 5.5+ |
| `external_skill` | mcp:<server-id> | Phase 7 — see Part 6 |

#### Part 2 — Skill catalog + registry

```sql
CREATE TABLE skills (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name            text NOT NULL,
  version         text NOT NULL,
  kind            skill_kind NOT NULL,
  manifest        jsonb NOT NULL,
  source_kind     skill_source NOT NULL, -- 'first_party' | 'workspace' | 'mcp' | 'community'
  workspace_id    uuid REFERENCES workspaces(id) ON DELETE CASCADE,
  trust_level     trust_level NOT NULL DEFAULT 'first_party',
  enabled         boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, name, version)
);

CREATE TABLE chat_skills (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_id         uuid NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  skill_id        uuid NOT NULL REFERENCES skills(id),
  resolved_by     skill_resolver NOT NULL, -- 'user_pick' | 'composer' | 'memory_replay' | 'auto'
  bind_config     jsonb,                    -- per-skill runtime bindings (e.g. which data source it consumes)
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (chat_id, skill_id)
);
```

#### Part 3 — `SkillComposer` decides which skills activate per chat

```ts
// app/backend/src/skills/composer.ts (Phase 5.5)
export class SkillComposer {
  async compose(input: ComposerInput): Promise<ComposedPlan> {
    // 1. IntentExtractor output (from M9.3) — what does the user want?
    // 2. ChatParams.data_sources — what's available?
    // 3. User pinned skills — Phase 5/6 setting
    // 4. Memory-learned skill preferences — Phase 5
    // 5. Workspace policy — Phase 6 admin can disable skills
    //
    // Returns: ordered list of skills + bind_config per skill
  }
}

export interface ComposedPlan {
  analysis_skill: Skill;          // exactly 1
  source_skills: Skill[];         // 1..N — from adapters per ADR-0001
  enrichment_skills: Skill[];     // 0..N
  tool_skills: Skill[];           // 0..N — Phase 5.5 sandbox
  alert_skills: Skill[];          // 0..N — Phase 6+
  rationale: ResolveRationale[];  // explainability — why each skill was picked
}
```

The composer is **explainable**. Every skill picked must have a `rationale` row a Phase 8 admin UI can show.

#### Part 4 — User-facing chat creation flow changes (Phase 5.5)

**Before (Phase 1-3.5):**

```
[Pick agent dropdown ▾]  ← PR Impact / Brand Sentinel / Crisis Watch / Competitor Tracker
[Start chat]
```

**After (Phase 5.5 onward, opt-in):**

```
[Describe what you want to know] (textarea)
[+ Attach data source]            ← multi-source per ADR-0001
[+ Pin a skill] (advanced)
[Start chat]
```

On chat creation:
1. IntentExtractor runs (M9.3 — already shipped)
2. SkillComposer runs → produces `ComposedPlan`
3. `chat_skills` rows persisted
4. Orchestrator dispatches each skill in plan order
5. UI shows an "intent extracted + skills composed" inline card (extends the M9.8 `IntentExtractedCard`)

**Backward compat:** the legacy agent dropdown remains available for users who already use it. Phase 6 admin UI controls whether new workspaces default to legacy or skill-composed flow.

#### Part 5 — Phase 5.5 RENAMED: `Skills + Tool Sandbox`

The Phase 5.5 milestone outline in [docs/phase5.5-sandbox.md](../phase5.5-sandbox.md) expands from 4 milestones to ~10:

| # | Original (sandbox-only) | After this ADR |
|---|---|---|
| M10.1 | Wrap Azure Assistants API | (same) |
| M10.2 | Tool generation + execution lifecycle | (same) |
| M10.3 | `agent_tools` + `tool_executions` tables | renamed to `skill_executions` + `tool_executions` |
| M10.4 | Wire tool agent into AgentActionPanel | (same) |
| **M10.5 (new)** | — | Skill manifest schema + JSONSchema validator |
| **M10.6 (new)** | — | `skills` + `chat_skills` tables + first-party skill seeds (legacy agents become `analysis_skill` rows) |
| **M10.7 (new)** | — | `SkillComposer.compose()` — picks skills from intent + sources |
| **M10.8 (new)** | — | Chat creation flow: "describe + attach" textarea + IntentExtractor → composer integration |
| **M10.9 (new)** | — | Workspace-scoped skill upload (admin can add skills via JSON) |
| **M10.10 (new)** | — | Skill execution tracing in chat (which skill, why, what it produced) |

Phase 5.5 grows from "wrap an API" to "wrap an API + introduce a composable skill system." Cost: ~1 extra week.

#### Part 6 — MCP integration as a special skill kind (Phase 7 — new phase)

```json
{
  "name": "mcp:linear-com",
  "kind": "external_skill",
  "executes": {
    "kind": "mcp_server",
    "transport": "https",
    "url": "https://mcp.linear.app",
    "auth_method": "oauth_pkce"
  }
}
```

`McpServerAdapter` from ADR-0001 + this skill kind together let any MCP server become a usable skill in this platform. Phase 7 (new) handles:
- OAuth flow per MCP server
- Tool-call → skill-execution mapping
- Per-workspace allowlists
- Cost tracking (each MCP call may be billable)

### What we are NOT deciding

- **The exact skill manifest schema.** Part 1's example is illustrative. M10.5 finalizes it with a JSONSchema; this ADR fixes only the existence + structure.
- **Whether to ship a community marketplace.** Out of scope for Phase 5.5–7. Future ADR if customer demand surfaces.
- **Whether legacy agent classes are deleted.** They're seeded as `analysis_skill` rows in M10.6; the classes themselves can stay or migrate to skill-executors later.

## Consequences

### Positive

- **User extensibility.** Customers can author skills (JSON + prompt) without forking the repo.
- **Composability.** "Skill + CSV", "Skill + Crawl", "Skill + Slack" — each is a `chat_skills` row binding an `analysis_skill` to a `source_skill`. No new code per combination.
- **MCP is just one kind of skill** — same composer, same execution path.
- **Phase 4 dashboards stay agnostic.** Skills declare which `dashboard_layout` to render; Phase 4 ships layouts that skills request, not agents.
- **Phase 5 memory becomes "which skills did this user pick / accept / reject for similar intents?"** — much richer than "which agent did they pick?"
- **Backward compatible.** Legacy agent dropdown ships through Phase 4 unchanged.

### Negative

- **Phase 5.5 grows in scope (~1 extra week).** Justified by the strategic shift toward extensibility.
- **`SkillComposer` is an LLM-backed reasoning step** — adds latency on chat creation (mitigated by caching the plan per `(intent_hash, source_set_hash)`).
- **JSON skill manifests are easy to mis-author.** Mitigated by JSONSchema validation + a `pnpm skill:validate` CLI.
- **Two-system coexistence** (legacy agents + new skills) until full migration. Worth it for backward compat; Phase 6 admin tool migrates workspaces opt-in.

### Neutral / open

- **Skill versioning + skill upgrades.** Customers may pin to v1.0.0; first-party may ship v1.1.0. Need migration semantics (ADR-0003 likely, when M10.9 surfaces it).
- **Cost attribution across composed skills.** A composed chat invokes multiple skills; billing UI needs per-skill cost breakdown. Track for Phase 6/7.
- **Security model for community skills.** Trust levels + sandbox enforcement may need a separate ADR.

## Alternatives considered + rejected

### Alternative A — keep fixed agent dropdown forever, deepen each agent

**Rejected.** Doesn't address multi-source composition or MCP; doesn't scale beyond AMX-authored agents.

### Alternative B — rebuild as a LangGraph / LangChain orchestrator with their tool model

**Rejected.** Vendor lock-in. We already have a working orchestrator (Phase 1) + LLM gateway (Phase 3) + agent lifecycle (Phase 1 §5.4). LangChain's value-add over our stack is small.

### Alternative C — adopt OpenAI Custom GPTs as the skill format

**Rejected.** Vendor-specific, no open standard, no MCP compatibility.

### Alternative D — Anthropic Skills format from Claude Code

**Considered seriously.** Claude Code's skill model is well-designed and could be adopted directly. Two reasons we don't (yet):
1. Claude Code skills assume `Skill` tool invocation in an interactive CLI; our platform is multi-user web with persistent chats.
2. We need workspace-scoped + trust-level metadata that Claude Code skills don't carry.

**However:** the manifest in Part 1 is intentionally close-shaped to Claude Code skills so a future bridge is small. If Anthropic publishes an open Skill spec, M10.5 should adopt it instead of inventing fully.

### Alternative E — model everything as MCP tools, skip the skill abstraction

**Rejected.** MCP is the right TRANSPORT but not the right composition layer. MCP tools are stateless function calls; our skills declare prompts, model preferences, dashboard layouts, alert rules. MCP serves a narrower slice. ADR-0002 uses MCP UNDER skills, not instead of.

## Migration plan

| Phase / milestone | Change |
|---|---|
| Phase 3.5 (current, through M9.11) | NO skill work. ADR-0002 only locks design vector. |
| Phase 4 (Dashboards) | Layouts are skill-requestable, not agent-bound. (Layout `pr-impact` exists; legacy agent maps to it; skill `pr-impact` requests it.) |
| Phase 5 (Memory) | Memory model adds "skill preference per user × intent class" as a first-class record. |
| **Phase 5.5 (renamed: Skills + Tool Sandbox)** | Full skill system per Part 5. |
| Phase 6 (Admin) | Admin UI manages skill catalog + composer policies + trust levels + workspace overrides. |
| **Phase 7 (NEW: External Skills / MCP)** | OAuth flow + MCP transport + community-skill upload (gated by Phase 6 admin policy). |

### Migration of existing chats

| Existing concept | Migrates to |
|---|---|
| `chat_params.agent_type` ENUM | Stays. New rows additionally get a `chat_skills` row with `resolved_by='legacy_agent'` linking to the seeded `analysis_skill`. |
| 4 hardcoded agent classes | Seeded as 4 first-party `analysis_skill` rows in M10.6. The class bodies move to skill executors gradually. |
| Phase 4 dashboard layouts | Become `produces.dashboard_layout` in skill manifests. |

## References

- User chat 2026-06-01 raising skill composition + MCP need
- ADR-0001 — data-source adapter pattern (skills consume adapters via `source_skill` kind)
- [phase5.5-sandbox.md](../phase5.5-sandbox.md) — current scope (to be rewritten per Part 5)
- [Model Context Protocol](https://modelcontextprotocol.io/) — to integrate via Phase 7
- [Claude Code Skills](https://docs.anthropic.com/en/docs/claude-code/skills) — shape reference for Part 1 manifest
