import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  createChat, listChats, getChat, deleteChat,
} from '../services/chat.service.js';

const CreateChatBody = z.object({
  agentType: z.string().min(1).max(50),
  title: z.string().max(255).optional(),
});

export async function chatRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/v1/chats', { preHandler: app.auth }, async (req, reply) => {
    const parsed = CreateChatBody.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { success: false, error: 'Invalid body', meta: parsed.error.flatten() };
    }
    try {
      const result = await createChat(req.user!.userId, parsed.data.agentType);
      return { success: true, data: result };
    } catch (err) {
      reply.code(400);
      return { success: false, error: (err as Error).message };
    }
  });

  app.get('/api/v1/chats', { preHandler: app.auth }, async (req) => {
    const chats = await listChats(req.user!.userId);
    return { success: true, data: { chats } };
  });

  app.get('/api/v1/chats/:id', { preHandler: app.auth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const chat = await getChat(req.user!.userId, id);
    if (!chat) {
      reply.code(404);
      return { success: false, error: 'Chat not found' };
    }
    return { success: true, data: { chat } };
  });

  app.delete('/api/v1/chats/:id', { preHandler: app.auth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      await deleteChat(req.user!.userId, id);
      return { success: true, data: { message: 'Deleted' } };
    } catch (err) {
      reply.code(404);
      return { success: false, error: (err as Error).message };
    }
  });
}
