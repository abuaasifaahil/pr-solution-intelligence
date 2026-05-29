import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { WebSocket } from 'ws';
import { verifyAccess } from '../lib/jwt.js';
import { withUser } from '../lib/prisma-rls.js';
import { subscribeChatEvents, type ChatEvent } from '../lib/event-bus.js';

/**
 * WebSocket route for real-time chat events.
 *
 * Uses @fastify/websocket v10 (Fastify-4-compatible). The v10 handler signature
 * is `(socket: WebSocket, req: FastifyRequest)` — the first arg is the raw
 * ws.WebSocket instance (NOT a connection wrapper; that was a pre-v10 API).
 *
 * Auth strategy: JWT lives in `?token=` query param because browsers cannot set
 * custom headers on `new WebSocket()`. JWT is 15-min TTL; tokens are redacted
 * from route-level logs via req.log.child().
 *
 * Pre-upgrade rejection: @fastify/websocket v10 routes the HTTP Upgrade request
 * through Fastify's normal routing stack, so a `preHandler` hook can reply with
 * HTTP 401 / 404 *before* the WS handshake, causing the ws client to emit
 * `unexpected-response` with the correct status code.
 */
export async function wsRoutes(app: FastifyInstance): Promise<void> {
  /**
   * preHandler: validate JWT + chat ownership and reject with HTTP 401/404
   * before the WebSocket handshake if auth fails. This runs for every request
   * to this route — both upgrade (WS) and plain HTTP GET alike.
   */
  async function wsPreHandler(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { chatId } = req.params as { chatId: string };
    const token = (req.query as { token?: string }).token;

    if (!token) {
      req.log.warn({ chatId }, 'ws connection without token');
      reply.code(401).send({ error: 'Missing token' });
      return;
    }

    let userId: string;
    try {
      const payload = verifyAccess(token);
      userId = payload.userId;
    } catch {
      req.log.warn({ chatId }, 'ws invalid token');
      reply.code(401).send({ error: 'Invalid token' });
      return;
    }

    // Ownership check via RLS — null for non-owned/missing chats.
    const chat = await withUser(userId, (tx) =>
      tx.chat.findFirst({ where: { id: chatId } }),
    );
    if (!chat) {
      req.log.warn({ userId, chatId }, 'ws chat not owned or missing');
      reply.code(404).send({ error: 'Chat not found' });
      return;
    }

    // Stash userId on the request so the WS handler can read it without re-verifying.
    (req as FastifyRequest & { wsUserId?: string }).wsUserId = userId;
  }

  app.get(
    '/ws/chat/:chatId',
    { websocket: true, preHandler: wsPreHandler },
    async (socket: WebSocket, req: FastifyRequest) => {
      const { chatId } = req.params as { chatId: string };
      const userId = (req as FastifyRequest & { wsUserId?: string }).wsUserId ?? 'unknown';

      const log = req.log.child({ chatId, userId, route: 'ws/chat' });
      log.info('ws connection opened');

      // Subscribe to Redis pub/sub and forward each event as NDJSON.
      const unsubscribe = await subscribeChatEvents(chatId, (evt: ChatEvent) => {
        if (socket.readyState === socket.OPEN) {
          socket.send(JSON.stringify(evt) + '\n');
        }
      });

      socket.on('close', async () => {
        log.info('ws connection closed');
        await unsubscribe();
      });

      socket.on('error', (err: Error) => {
        log.warn({ err }, 'ws socket error');
      });
    },
  );
}
