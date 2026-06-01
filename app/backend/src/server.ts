import Fastify, { type FastifyInstance, type preHandlerAsyncHookHandler } from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import type { Processor } from 'bullmq';
import { healthzRoute } from './routes/healthz.js';
import { authRoutes } from './routes/auth.routes.js';
import { agentRoutes } from './routes/agent.routes.js';
import { chatRoutes } from './routes/chat.routes.js';
import { dataSourceRoutes } from './routes/data-source.routes.js';
import { mcpRoutes } from './routes/mcp.routes.js';
import { modelConfigRoutes } from './routes/model-config.routes.js';
import { skillRoutes } from './routes/skill.routes.js';
import { wsRoutes } from './routes/ws.routes.js';
import { authMiddleware } from './middleware/auth.middleware.js';
import { OrchestratorAgent } from './agents/orchestrator.agent.js';
import { AgentRegistry } from './agents/agent-registry.js';
import { startInlineWorker } from './lib/queue.js';
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
  await app.register(websocket, {
    options: { maxPayload: 1024 * 1024 /* 1MB */ },
  });
  app.decorate('auth', authMiddleware);
  await bootstrapAgents();
  await app.register(healthzRoute);
  await app.register(authRoutes);
  await app.register(agentRoutes);
  await app.register(chatRoutes);
  await app.register(dataSourceRoutes);
  await app.register(mcpRoutes);
  await app.register(modelConfigRoutes);
  await app.register(skillRoutes);
  await app.register(wsRoutes);

  // Boot the BullMQ inline worker. Phase 2 jobs register their processors
  // via the PROCESSORS map below; today there are none registered (M7.4 will
  // add the first one — `parse-upload`). We still start the worker so the
  // queue infrastructure is live and ready to accept future processors.
  // Skipped under NODE_ENV=test so unit tests don't open Redis connections
  // they don't need; queue tests open their own connections explicitly.
  if (process.env.NODE_ENV !== 'test') {
    const PROCESSORS: Record<string, Processor> = {
      // M7.4 will add: 'parse-upload': parseUploadProcessor
    };
    startInlineWorker(async (job, token) => {
      const processor = PROCESSORS[job.name];
      if (!processor) {
        app.log.warn({ name: job.name }, 'no processor registered for job');
        return;
      }
      return processor(job, token);
    });
  }

  return app;
}
