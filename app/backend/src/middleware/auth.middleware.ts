import type { FastifyRequest, FastifyReply, preHandlerAsyncHookHandler } from 'fastify';
import { verifyAccess, type AccessPayload } from '../lib/jwt.js';

export const authMiddleware: preHandlerAsyncHookHandler = async (
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<void> => {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    reply.code(401).send({ success: false, error: 'Missing Authorization header' });
    return;
  }
  const token = header.slice('Bearer '.length).trim();
  try {
    const payload: AccessPayload = verifyAccess(token);
    req.user = payload;
  } catch {
    reply.code(401).send({ success: false, error: 'Invalid or expired token' });
  }
};
