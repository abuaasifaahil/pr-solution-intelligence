import Fastify, { type FastifyInstance, type preHandlerAsyncHookHandler } from 'fastify';
import cors from '@fastify/cors';
import { healthzRoute } from './routes/healthz.js';
import { authRoutes } from './routes/auth.routes.js';
import { agentRoutes } from './routes/agent.routes.js';
import { chatRoutes } from './routes/chat.routes.js';
import { authMiddleware } from './middleware/auth.middleware.js';
import { OrchestratorAgent } from './agents/orchestrator.agent.js';
import { AgentRegistry } from './agents/agent-registry.js';
import { prisma } from '@prsi/shared/db';

declare module 'fastify' {
  interface FastifyInstance {
    auth: preHandlerAsyncHookHandler;
  }
}

function corsOriginConfig(): true | string[] {
  const raw = process.env.CORS_ALLOWED_ORIGIN ?? '*';
  if (raw === '*') return true;
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

async function bootstrapAgents(): Promise<void> {
  if (AgentRegistry.listAll().length > 0) return;
  const agents = await prisma.agent.findMany({ where: { isActive: true } });
  for (const a of agents) {
    AgentRegistry.register(new OrchestratorAgent(a.id, a.name, a.type));
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

  await app.register(cors, { origin: corsOriginConfig(), credentials: true });
  app.decorate('auth', authMiddleware);
  await bootstrapAgents();
  await app.register(healthzRoute);
  await app.register(authRoutes);
  await app.register(agentRoutes);
  await app.register(chatRoutes);

  return app;
}
