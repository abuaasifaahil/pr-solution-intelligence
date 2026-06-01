# Phase 5 — Intelligence Layer (STUB)

**Source:** `Phase 5/Phase5_Technical_Specification.docx` (not yet digested)
**Status:** Not started · spec digest pending
**Builds on:** `phase4.md`
**Architecture decisions:** [ADR-0003](adr/0003-chat-entry-composition.md) (memory inputs for skill/agent ranking)

## One-line scope

Analysis · QA · Learning · Memory. `AnalysisAgent`, `QAAgent`, `LearningAgent` generate insights and store patterns. Introduces vector store (`pgvector`) for semantic/episodic memory.

## Plugs into

- `BaseAgent` → multiple new agents
- Enrichment data from Phase 3
- Dashboard data from Phase 4
- `BaseAgent.learn()` no-op from Phase 1 — implemented here
- New tables for memory layers (working, short-term, long-term, episodic, semantic, procedural per BRD §6.4)
- **`agent_skill_experience` table** (schema locked in [ADR-0003 Decision 5](adr/0003-chat-entry-composition.md)) populates here; the ranker that reads it lives here too
- **Composer ranking algorithm** (the function that orders chip candidates in chat-entry patterns 3 + 4) is a Phase 5 deliverable. Phase 3.5 stubs first-party-first ordering until this lands

## Ranking algorithm contract (locked by ADR-0003)

Inputs (priority order):
1. Sequence proximity (cosine similarity on intent embeddings) — Phase 5 introduces embeddings
2. Per-user experience (success/abandoned/redirected outcomes)
3. Per-user explicit pins (Phase 5/6 settings)
4. Workspace-level success rate
5. First-party defaults (fallback)

Definition of outcomes:
- `success` — user accepted output (reached dashboard / saved chat / shared)
- `abandoned` — chat closed without enrichment finishing
- `redirected` — user picked different agent mid-chat (strong negative signal)

## Action when this phase begins

Digest spec. Decide vector store (`pgvector` on existing Postgres vs Pinecone/Weaviate). Define memory schema. Define insight-generation contracts. **Implement the agent/skill ranker per ADR-0003 Decision 5.**
