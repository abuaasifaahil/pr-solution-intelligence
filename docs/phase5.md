# Phase 5 — Intelligence Layer (STUB)

**Source:** `Phase 5/Phase5_Technical_Specification.docx` (not yet digested)
**Status:** Not started · spec digest pending
**Builds on:** `phase4.md`

## One-line scope

Analysis · QA · Learning · Memory. `AnalysisAgent`, `QAAgent`, `LearningAgent` generate insights and store patterns. Introduces vector store (`pgvector`) for semantic/episodic memory.

## Plugs into

- `BaseAgent` → multiple new agents
- Enrichment data from Phase 3
- Dashboard data from Phase 4
- `BaseAgent.learn()` no-op from Phase 1 — implemented here
- New tables for memory layers (working, short-term, long-term, episodic, semantic, procedural per BRD §6.4)

## Action when this phase begins

Digest spec. Decide vector store (`pgvector` on existing Postgres vs Pinecone/Weaviate). Define memory schema. Define insight-generation contracts.
