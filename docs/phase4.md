# Phase 4 — Dashboard Factory (STUB)

**Source:** `Phase 4/Phase4_Technical_Specification.docx` (not yet digested)
**Status:** Not started · spec digest pending
**Builds on:** `phase3.md`

## One-line scope

`DesignAgent` turns enriched JSON into a responsive HTML/JSX PR Impact Dashboard with KPI cards, charts, tabs, and artifact preview (chip-up pattern like Claude artifacts).

## Plugs into

- `BaseAgent` → `DesignAgent`
- Enrichment JSON from Phase 3
- Windows 11 theme tokens from Phase 1
- New routes for dashboard artifacts (download, share, email)
- Email provider integration (SES/Resend/Postmark — decided at this phase)

## Action when this phase begins

Digest spec. Decide chart library (Recharts vs Chart.js per BRD §13). Define dashboard storage (HTML blob? JSON + render at view time?). Decide email provider.
