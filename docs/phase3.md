# Phase 3 — Enrichment Engine (STUB)

**Source:** `Phase 3/Phase3_Technical_Specification.docx` (not yet digested)
**Status:** Not started · spec digest pending
**Builds on:** `phase2.md`

## One-line scope

Runs the Enrichment Agent (Claude `claude-sonnet-4`) over Phase 2's parsed articles to tag sentiment, themes, emotion, entities, signals, and reach.

## Plugs into

- `BaseAgent` → `EnrichmentAgent` + `SimilarWebAgent`
- Articles table from Phase 2
- LLM SDK (`@anthropic-ai/sdk`) with token-aware batching
- WebSocket: new `enrichment:progress` event added per spec §8 contract
- Output: dashboard-ready JSON per BRD §12 schema (sentiment, themes, emotion, entities, reach, signals)

## Action when this phase begins

Digest spec into this file. Define enrichment JSON schema, batch-sizing logic, Similar Web parallel agent contract, and any new tables (`enrichments`, `entities`, etc.).
