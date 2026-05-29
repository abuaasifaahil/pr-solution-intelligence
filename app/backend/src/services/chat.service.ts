import { prisma } from '@prsi/shared/db';
import type { Prisma } from '@prsi/shared/db';
import { withUser } from '../lib/prisma-rls.js';
import { AgentRegistry } from '../agents/agent-registry.js';
import type { ChatContext, Chip, ConversationState } from '../agents/orchestrator-state.js';

/** Cast a plain object to Prisma's opaque InputJsonValue type. */
function toJson(v: unknown): Prisma.InputJsonValue {
  return v as unknown as Prisma.InputJsonValue;
}

export interface ChatRecord {
  id: string;
  userId: string;
  agentType: string;
  title: string | null;
  status: 'active' | 'completed' | 'archived';
  context: ChatContext;
  createdAt: Date;
  updatedAt: Date;
}

export interface MessageRecord {
  id: string;
  chatId: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  metadata: { chips?: Chip[]; choice?: string };
  createdAt: Date;
}

export interface CreateChatResult {
  chat: ChatRecord;
  welcomeMessage: MessageRecord;
}

export async function createChat(userId: string, agentType: string): Promise<CreateChatResult> {
  // Validate agent exists.
  const agentRow = await prisma.agent.findUnique({ where: { type: agentType } });
  if (!agentRow) throw new Error(`Unknown agent type: ${agentType}`);

  return withUser(userId, async (tx) => {
    const chat = await tx.chat.create({
      data: {
        userId,
        agentType,
        title: agentRow.name,
        status: 'active',
        context: {},
      },
    });

    const orchestrator = AgentRegistry.getByType(agentType);
    if (!orchestrator) throw new Error(`No orchestrator registered for ${agentType}`);

    const result = await orchestrator.execute<{ replyText: string; chips: Chip[]; contextPatch: Partial<ChatContext> }>({
      userId,
      chatId: chat.id,
      message: '', // empty triggers welcome path
      metadata: { currentState: 'welcome', currentContext: {} },
    });

    const welcomeMessage = await tx.message.create({
      data: {
        chatId: chat.id,
        role: 'assistant',
        content: result.replyText,
        metadata: toJson({ chips: result.chips }),
      },
    });

    const newContext = { ...(chat.context as ChatContext), ...result.contextPatch };
    await tx.chat.update({
      where: { id: chat.id },
      data: { context: toJson(newContext) },
    });

    return {
      chat: { ...chat, context: newContext } as ChatRecord,
      welcomeMessage: welcomeMessage as MessageRecord,
    };
  });
}

export async function listChats(userId: string): Promise<ChatRecord[]> {
  return withUser(userId, async (tx) => {
    const chats = await tx.chat.findMany({
      where: { status: { not: 'archived' } },
      orderBy: { updatedAt: 'desc' },
      take: 50,
    });
    return chats as ChatRecord[];
  });
}

export async function getChat(userId: string, chatId: string): Promise<ChatRecord | null> {
  return withUser(userId, async (tx) => {
    const chat = await tx.chat.findFirst({ where: { id: chatId } });
    return (chat as ChatRecord | null) ?? null;
  });
}

export async function deleteChat(userId: string, chatId: string): Promise<void> {
  await withUser(userId, async (tx) => {
    await tx.chat.delete({ where: { id: chatId } });
  });
}

export async function listMessages(userId: string, chatId: string): Promise<MessageRecord[]> {
  return withUser(userId, async (tx) => {
    const owned = await tx.chat.findFirst({ where: { id: chatId } });
    if (!owned) throw new Error('Chat not found');
    const msgs = await tx.message.findMany({
      where: { chatId },
      orderBy: { createdAt: 'asc' },
    });
    return msgs as MessageRecord[];
  });
}

export interface AppendResult {
  userMessage: MessageRecord;
  aiMessage: MessageRecord;
}

export async function appendUserMessage(
  userId: string,
  chatId: string,
  content: string,
  choice?: string,
): Promise<AppendResult> {
  return withUser(userId, async (tx) => {
    const chat = (await tx.chat.findFirst({ where: { id: chatId } })) as ChatRecord | null;
    if (!chat) throw new Error('Chat not found');

    const userMessage = (await tx.message.create({
      data: {
        chatId,
        role: 'user',
        content,
        metadata: choice ? { choice } : {},
      },
    })) as MessageRecord;

    const orchestrator = AgentRegistry.getByType(chat.agentType);
    if (!orchestrator) throw new Error(`No orchestrator for ${chat.agentType}`);

    const currentState = (chat.context.state ?? 'welcome') as ConversationState;
    const result = await orchestrator.execute<{ replyText: string; chips: Chip[]; contextPatch: Partial<ChatContext> }>({
      userId,
      chatId,
      message: content,
      metadata: { currentState, currentContext: chat.context, choice },
    });

    const aiMessage = (await tx.message.create({
      data: {
        chatId,
        role: 'assistant',
        content: result.replyText,
        metadata: toJson({ chips: result.chips }),
      },
    })) as MessageRecord;

    const newContext = { ...chat.context, ...result.contextPatch };
    await tx.chat.update({ where: { id: chatId }, data: { context: toJson(newContext) } });

    return { userMessage, aiMessage };
  });
}
