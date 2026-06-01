'use client';
import { apiFetch } from './api-client';

export interface ChatSummary {
  id: string;
  agentType: string;
  title: string | null;
  status: 'active' | 'completed' | 'archived';
  updatedAt: string;
}

export interface AgentSummary {
  id: string;
  type: string;
  name: string;
  description: string;
  icon: string | null;
  color: string | null;
}

export interface ChipDef { label: string; value: string }

export interface ChatMessage {
  id: string;
  chatId: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  metadata: { chips?: ChipDef[]; choice?: string };
  createdAt: string;
}

export interface ChatDetail extends ChatSummary {
  context: Record<string, unknown>;
}

export async function listAgents(): Promise<AgentSummary[]> {
  return apiFetch<{ agents: AgentSummary[] }>('/api/v1/agents').then((d) => d.agents);
}

export async function listChats(): Promise<ChatSummary[]> {
  return apiFetch<{ chats: ChatSummary[] }>('/api/v1/chats').then((d) => d.chats);
}

/**
 * M9.8 (Phase 3.5) — pending attachment shape carried forward from the
 * home page to the new chat. The backend's `POST /api/v1/chats` does NOT
 * yet accept these (M9.11 will wire `chat_data_sources` + the multi-source
 * adapter); for now they're encoded into the chat URL as query params so
 * the chat page can read them on mount. See ADR-0003 Decision 1 +
 * `app/frontend/components/home/ChatCreationForm.tsx`.
 */
export interface PendingAttachments {
  /** Composable-skill id pinned at chat creation (Patterns 1, 2). */
  skillId?: string;
  /** Source attachment intents (Patterns 1-4, 6, 7). The shape stays
   *  schemaless until M9.11 — the route layer ignores them today. */
  sources?: Array<{
    kind: 'csv_upload' | 'opensearch' | 'crawler';
    /** Per-kind reference. For `csv_upload` this is the (future) upload
     *  id; for `opensearch` it's an optional override id. Optional. */
    ref?: string;
  }>;
  /** First message to send immediately after chat creation (Patterns 1-5). */
  firstMessage?: string;
}

export async function createChat(
  agentType: string,
  /** Optional opaque title — currently only used by the new-chat home form
   *  for pinning a skill name. Backend accepts it (chat.routes.ts
   *  CreateChatBody.title). */
  title?: string,
): Promise<{ chat: ChatDetail; welcomeMessage: ChatMessage }> {
  return apiFetch('/api/v1/chats', {
    method: 'POST',
    body: JSON.stringify(title !== undefined ? { agentType, title } : { agentType }),
  });
}

/**
 * Encode pending attachments + first-message into a chat-page URL. The
 * chat page reads `?...` on mount and applies the pending state.
 *
 * Note: `firstMessage` is intentionally NOT encoded into the URL — it
 * lives in sessionStorage so a refresh doesn't re-send the message. The
 * other attachments ARE in the URL because they're reproducible state
 * (which skill, which source) that benefits from share-link semantics.
 */
export function buildChatUrl(chatId: string, attachments?: PendingAttachments): string {
  const url = `/chat/${chatId}`;
  if (!attachments) return url;
  const params = new URLSearchParams();
  if (attachments.skillId) params.set('skill', attachments.skillId);
  if (attachments.sources && attachments.sources.length > 0) {
    // Stable encoding: comma-separated `kind:ref?` tokens.
    params.set(
      'sources',
      attachments.sources
        .map((s) => (s.ref ? `${s.kind}:${s.ref}` : s.kind))
        .join(','),
    );
  }
  const qs = params.toString();
  return qs ? `${url}?${qs}` : url;
}

export async function getChat(id: string): Promise<ChatDetail> {
  return apiFetch<{ chat: ChatDetail }>(`/api/v1/chats/${id}`).then((d) => d.chat);
}

export async function deleteChat(id: string): Promise<void> {
  await apiFetch(`/api/v1/chats/${id}`, { method: 'DELETE' });
}

export async function listMessages(chatId: string): Promise<ChatMessage[]> {
  return apiFetch<{ messages: ChatMessage[] }>(`/api/v1/chats/${chatId}/messages`).then((d) => d.messages);
}

export interface SendMessageResponse {
  userMessage: ChatMessage;
  assistantMessageId: string;
  chips: ChipDef[];
}

export async function sendMessage(
  chatId: string, content: string, choice?: string,
): Promise<SendMessageResponse> {
  return apiFetch(`/api/v1/chats/${chatId}/messages`, {
    method: 'POST',
    body: JSON.stringify({ content, choice }),
  });
}
