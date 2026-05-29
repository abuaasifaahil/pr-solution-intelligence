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

export async function createChat(agentType: string): Promise<{ chat: ChatDetail; welcomeMessage: ChatMessage }> {
  return apiFetch('/api/v1/chats', {
    method: 'POST',
    body: JSON.stringify({ agentType }),
  });
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

export async function sendMessage(
  chatId: string, content: string, choice?: string,
): Promise<{ userMessage: ChatMessage; aiMessage: ChatMessage }> {
  return apiFetch(`/api/v1/chats/${chatId}/messages`, {
    method: 'POST',
    body: JSON.stringify({ content, choice }),
  });
}
