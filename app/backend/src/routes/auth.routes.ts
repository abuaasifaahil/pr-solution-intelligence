import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { login, refresh, logout, getMe } from '../services/auth.service.js';
import type { AccessPayload } from '../lib/jwt.js';

// FastifyInstance.auth is declared in server.ts. Here we only augment
// FastifyRequest with the user payload set by the auth middleware.
declare module 'fastify' {
  interface FastifyRequest {
    user?: AccessPayload;
  }
}

const LoginBody = z.object({
  email: z.string().email().max(255),
  password: z.string().min(1).max(200),
});

const RefreshBody = z.object({
  refreshToken: z.string().length(64),
});

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/v1/auth/login', async (req, reply) => {
    const parsed = LoginBody.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { success: false, error: 'Invalid body', meta: parsed.error.flatten() };
    }
    try {
      const result = await login({
        email: parsed.data.email,
        password: parsed.data.password,
        ip: req.ip ?? null,
        userAgent: req.headers['user-agent'] ?? null,
      });
      return { success: true, data: result };
    } catch (err) {
      reply.code(401);
      return { success: false, error: (err as Error).message };
    }
  });

  app.post('/api/v1/auth/refresh', async (req, reply) => {
    const parsed = RefreshBody.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { success: false, error: 'Invalid body' };
    }
    try {
      const result = await refresh({
        refreshToken: parsed.data.refreshToken,
        ip: req.ip ?? null,
        userAgent: req.headers['user-agent'] ?? null,
      });
      return { success: true, data: result };
    } catch (err) {
      reply.code(401);
      return { success: false, error: (err as Error).message };
    }
  });

  app.delete('/api/v1/auth/session', { preHandler: app.auth }, async (req) => {
    if (req.user?.sessionId) {
      await logout(req.user.sessionId);
    }
    return { success: true, data: { message: 'Logged out' } };
  });

  app.get('/api/v1/auth/me', { preHandler: app.auth }, async (req, reply) => {
    if (!req.user) {
      reply.code(401);
      return { success: false, error: 'Unauthenticated' };
    }
    try {
      const user = await getMe(req.user.userId);
      return { success: true, data: { user } };
    } catch {
      reply.code(404);
      return { success: false, error: 'Not found' };
    }
  });
}
