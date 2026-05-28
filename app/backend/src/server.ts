import Fastify, { type FastifyInstance, type preHandlerAsyncHookHandler } from 'fastify';
import cors from '@fastify/cors';
import { healthzRoute } from './routes/healthz.js';
import { authRoutes } from './routes/auth.routes.js';
import { authMiddleware } from './middleware/auth.middleware.js';

declare module 'fastify' {
  interface FastifyInstance {
    auth: preHandlerAsyncHookHandler;
  }
}

export async function buildServer(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
      transport:
        process.env.NODE_ENV === 'development'
          ? { target: 'pino-pretty', options: { colorize: true } }
          : undefined,
    },
  });

  await app.register(cors, { origin: true, credentials: true });
  app.decorate('auth', authMiddleware);
  await app.register(healthzRoute);
  await app.register(authRoutes);

  return app;
}
