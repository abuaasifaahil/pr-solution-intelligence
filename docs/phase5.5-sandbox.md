# Phase 5.5 — Dynamic Tool Sandbox (DEFERRED)

**Source:** TBD (no .docx; born of mid-Phase-2 discussion)
**Status:** Not started · scheduled after Phase 5
**Builds on:** Phase 2's `AgentActionPanel` generic component; Phase 5 Learning Agent

## One-line scope

Let an agent generate a tool at runtime, execute it in a sandboxed environment, stream step-by-step progress to the chat, and collapse to the result. Same UX pattern as Phase 2's DataExtractAgent processing panel — just driven by a dynamically-generated step list.

## Implementation decision

**Use Azure OpenAI Assistants API + Code Interpreter** rather than building a custom sandbox runtime.

Rationale:
- We already use Azure OpenAI GPT-4.1 for the orchestrator (Phase 1).
- Azure Assistants provides a hosted Python sandbox with filesystem, package install, file I/O — same security and scaling problems already solved by Microsoft.
- Building our own sandbox (`isolated-vm`, subprocess + ulimits, or full container-based) is significant engineering investment for capability that's not differentiating.
- Vendor-aligned with existing infrastructure (no new auth, no new billing).

Alternatives considered + rejected:
- **Anthropic Analysis Tool** (Claude API): would require migrating LLM provider Azure → Anthropic. Tracked as a future decision but not Phase 5.5.
- **Anthropic Computer Use**: overkill (full Linux desktop) for "run a code snippet". Different use case.
- **E2B / Modal / Replit Agent**: third-party hosted, adds vendor and cost, no benefit over Azure-native.
- **Custom isolated-vm runtime**: significant security + scaling investment not justified.

## Plugs into

- Phase 2 `AgentActionPanel` (generic, already built) → renders the step list + result
- Phase 5 Learning Agent → observes tool-execution outcomes to bias future tool choices
- Azure OpenAI Assistants API (new dep to wrap)

## Milestone outline (when this phase begins)

~4 milestones (down from original "build custom sandbox" 8 milestones, thanks to using hosted execution):

| # | Title |
|---|---|
| M9.1 | Wrap Azure OpenAI Assistants API in `lib/assistants.ts` — create thread, post message, poll for tool-result, capture stdout/stderr |
| M9.2 | Tool generation prompt + execution lifecycle (create thread → run → poll → cancel-on-timeout) |
| M9.3 | `agent_tools` + `tool_executions` audit tables; RLS-scoped; AES-encrypted persisted outputs if sensitive |
| M9.4 | Wire the tool agent into the existing `AgentActionPanel` UI; demo: LLM generates "parse PDF" tool → runs → result inline |

## Action when this phase begins

1. Verify Azure OpenAI Assistants is enabled on the existing `amx-gpt-india` resource (different SKU than chat completions).
2. Cost projection: Assistants API is ~30% pricier than chat completions per token; estimate impact on monthly Azure bill.
3. Design the prompt that asks the LLM to decide "I need a tool that does X" vs "I can answer directly with chat completion".
4. Define the audit trail UI: which past tool executions are visible per user, how long they're retained.
