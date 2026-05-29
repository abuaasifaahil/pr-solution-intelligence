import { prisma } from '@prsi/shared/db';
import type { Prisma } from '@prsi/shared/db';
import { withUser } from '../lib/prisma-rls.js';
import { AgentRegistry } from '../agents/agent-registry.js';
import { publishChatEvent } from '../lib/event-bus.js';
import type { ChatContext, Chip, ConversationState } from '../agents/orchestrator-state.js';
import type { OrchestratorAgent } from '../agents/orchestrator.agent.js';

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

export interface StartStreamingResult {
  userMessage: MessageRecord;
  assistantMessageId: string;
  chips: Chip[];
  /** Resolves when the background streaming task completes. Tests await this;
   *  production callers ignore it (fire-and-forget). */
  streamingDone: Promise<void>;
}

/**
 * M4 streaming-aware variant of `appendUserMessage`:
 *   1. Persist user message
 *   2. Insert empty placeholder assistant row
 *   3. Compute chips synchronously from the state machine (cheap, no LLM)
 *   4. Return { userMessage, assistantMessageId, chips } immediately
 *   5. Kick off background task: publish typing:start → run orchestrator
 *      streaming (which publishes chunks + typing:stop) → update assistant
 *      row with final content → publish message:new with the persisted record
 *
 * The background task is awaitable via `streamingDone` for tests, but routes
 * MUST NOT await it — that would defeat the streaming UX.
 */
export async function startStreamingReply(
  userId: string,
  chatId: string,
  content: string,
  choice?: string,
): Promise<StartStreamingResult> {
  // Synchronous step: persist user + placeholder + compute chips.
  const sync = await withUser(userId, async (tx) => {
    const chat = (await tx.chat.findFirst({ where: { id: chatId } })) as ChatRecord | null;
    if (!chat) throw new Error('Chat not found');

    const userMessage = (await tx.message.create({
      data: {
        chatId,
        role: 'user',
        content,
        metadata: choice ? toJson({ choice }) : toJson({}),
      },
    })) as MessageRecord;

    // Empty placeholder assistant message — frontend renders an empty bubble
    // keyed by this id and appends chunks into it.
    const placeholder = (await tx.message.create({
      data: {
        chatId,
        role: 'assistant',
        content: '',
        metadata: toJson({}),
      },
    })) as MessageRecord;

    // Compute chips synchronously by running the state-machine `advance()`
    // without an LLM call. We re-import here to avoid a top-level cycle.
    const { advance } = await import('../agents/orchestrator-state.js');
    const advanceInput = choice ? { choice } : { freeText: content };
    const currentState = (chat.context.state ?? 'welcome') as ConversationState;
    const r = advance(currentState, advanceInput, chat.agentType);

    return {
      userMessage,
      assistantMessageId: placeholder.id,
      chips: r.chips,
      chatAgentType: chat.agentType,
      chatContext: chat.context,
      currentState,
    };
  });

  // Background streaming task — fire and forget from the route's POV.
  const streamingDone = (async () => {
    try {
      await publishChatEvent(chatId, 'typing:start', {
        assistantMessageId: sync.assistantMessageId,
      });

      const orchestrator = AgentRegistry.getByType(sync.chatAgentType) as
        | OrchestratorAgent
        | null;
      if (!orchestrator) {
        throw new Error(`No orchestrator for ${sync.chatAgentType}`);
      }

      const result = await orchestrator.executeStreaming({
        userId,
        chatId,
        assistantMessageId: sync.assistantMessageId,
        message: content,
        metadata: {
          currentState: sync.currentState,
          currentContext: sync.chatContext,
          choice,
        },
      });

      // Persist final content + chips into the placeholder + bump chat context.
      await withUser(userId, async (tx) => {
        await tx.message.update({
          where: { id: sync.assistantMessageId },
          data: {
            content: result.replyText,
            metadata: toJson({ chips: result.chips }),
          },
        });
        const newContext = { ...sync.chatContext, ...result.contextPatch };
        await tx.chat.update({
          where: { id: chatId },
          data: { context: toJson(newContext) },
        });
      });

      // Tell connected WS clients the final persisted assistant message.
      await publishChatEvent(chatId, 'message:new', {
        message: {
          id: sync.assistantMessageId,
          chatId,
          role: 'assistant',
          content: result.replyText,
          metadata: { chips: result.chips },
        },
      });
    } catch (err) {
      // The orchestrator already publishes `error` on failure. Just log here.
      // eslint-disable-next-line no-console
      console.error('[chat.service] streaming task failed', { chatId, err });
    }
  })();

  return {
    userMessage: sync.userMessage,
    assistantMessageId: sync.assistantMessageId,
    chips: sync.chips,
    streamingDone,
  };
}
