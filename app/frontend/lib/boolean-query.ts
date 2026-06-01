'use client';
import { apiFetch } from './api-client';

/**
 * Phase 2 — Frontend typed client for Boolean query endpoints (M7.6).
 *
 *   POST  /api/v1/chats/:id/query/generate  — engine-driven from chat_params
 *   PATCH /api/v1/chats/:id/query           — user manual edit (version bump)
 *   POST  /api/v1/chats/:id/query/confirm   — flip is_confirmed + enqueue
 *                                             data-extract + advance flow
 *   GET   /api/v1/chats/:id/query           — fetch latest (helper for FE)
 *
 * @file lib/boolean-query.ts
 */

export interface BooleanQuery {
  id: string;
  /** Pretty-printed Boolean expression — the canonical visible string. */
  text: string;
  /** AST-ish representation. Opaque to the FE; passed along for round-trips. */
  structured: unknown;
  version: number;
  isConfirmed: boolean;
}

export async function generateQuery(chatId: string): Promise<BooleanQuery> {
  return apiFetch<{ query: BooleanQuery }>(
    `/api/v1/chats/${encodeURIComponent(chatId)}/query/generate`,
    { method: 'POST' },
  ).then((d) => d.query);
}

/** Save a user-edited query text. Always creates a new draft row (version
 *  bump server-side); previous draft is retained as audit history. */
export async function editQuery(
  chatId: string,
  queryText: string,
): Promise<BooleanQuery> {
  // The server returns the bumped row directly under `data.query`.
  const out = await apiFetch<{ query: unknown }>(
    `/api/v1/chats/${encodeURIComponent(chatId)}/query`,
    {
      method: 'PATCH',
      body: JSON.stringify({ queryText }),
    },
  );
  return normalizeRawRow(out.query);
}

/** Confirm the latest draft. Server flips is_confirmed, enqueues the
 *  data-extract job, and advances the flow state via patchParams. */
export async function confirmQuery(chatId: string): Promise<BooleanQuery> {
  const out = await apiFetch<{ query: unknown; processingJobId: string }>(
    `/api/v1/chats/${encodeURIComponent(chatId)}/query/confirm`,
    { method: 'POST' },
  );
  return normalizeRawRow(out.query);
}

/** Fetch the most-recent query (draft or confirmed). Returns null when the
 *  chat has no query yet. */
export async function getLatestQuery(
  chatId: string,
): Promise<BooleanQuery | null> {
  const out = await apiFetch<{ query: unknown | null }>(
    `/api/v1/chats/${encodeURIComponent(chatId)}/query`,
  );
  if (!out.query) return null;
  return normalizeRawRow(out.query);
}

/**
 * The patch/confirm endpoints return the raw Prisma row whose shape is
 * `{ id, queryText, queryStructured, version, isConfirmed, ... }` — fold
 * that down to the FE-friendly shape (`text`, `structured`) used by
 * generate. Keeps the rest of the FE working against one type.
 */
function normalizeRawRow(raw: unknown): BooleanQuery {
  const r = (raw ?? {}) as Record<string, unknown>;
  return {
    id: String(r.id ?? ''),
    text: typeof r.text === 'string'
      ? r.text
      : typeof r.queryText === 'string' ? r.queryText : '',
    structured: 'structured' in r ? r.structured : r.queryStructured ?? null,
    version: typeof r.version === 'number' ? r.version : 1,
    isConfirmed: Boolean(r.isConfirmed),
  };
}
