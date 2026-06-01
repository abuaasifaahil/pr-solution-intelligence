import Fastify, { type FastifyInstance, type preHandlerAsyncHookHandler } from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
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
import { uploadRoutes } from './routes/upload.routes.js';
import { chatParamsRoutes } from './routes/chat-params.routes.js';
import { booleanQueryRoutes } from './routes/boolean-query.routes.js';
import { wsRoutes } from './routes/ws.routes.js';
import { authMiddleware } from './middleware/auth.middleware.js';
import { OrchestratorAgent } from './agents/orchestrator.agent.js';
import { DataExtractAgent } from './agents/data-extract.agent.js';
import { EnrichmentAgent } from './agents/enrichment.agent.js';
import { startEnrichmentSubscriber } from './agents/enrichment-subscriber.js';
import { AgentRegistry } from './agents/agent-registry.js';
import { startInlineWorker } from './lib/queue.js';
import { parseUploadProcessor } from './workers/parse-upload.worker.js';
import { dataExtractProcessor } from './workers/data-extract.worker.js';
import { enrichBatchProcessor } from './workers/enrich-batch.worker.js';
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
  // Phase 2 — M7.7: register the singleton DataExtractAgent alongside the
  // per-row Orchestrator agents. One instance serves all chats; per-request
  // state flows through the lifecycle methods (perceive/reason/plan/act).
  //
  // The singleton has no agents-table row. Its `id` is a fixed sentinel UUID
  // so any agent_logs writes by BaseAgent.logAction either succeed (when the
  // sentinel row exists) or fail-soft via the try/catch in logAction. We
  // intentionally do not seed an `agents` row — the singleton is not
  // user-selectable; routing happens via BullMQ job name.
  if (!AgentRegistry.has('data_extract')) {
    AgentRegistry.register(
      new DataExtractAgent(
        '00000000-0000-0000-0000-0000000d4ea7', // sentinel UUID (d4ea7 ~= "data extract")
        'Data Extract Agent',
        'data_extract',
      ),
    );
  }
  // Phase 3 — M8.4: EnrichmentAgent singleton. Same pattern as M7.7's
  // DataExtractAgent — no agents-table row, sentinel UUID, logAction
  // overridden to no-op. The cross-agent bus subscriber (started below
  // after route registration) drives this agent.
  if (!AgentRegistry.has('enrichment')) {
    AgentRegistry.register(
      new EnrichmentAgent(
        '00000000-0000-0000-0000-0000000e87c1', // sentinel UUID (e87c1 ~= "enrich")
        'Enrichment Agent',
        'enrichment',
      ),
    );
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
  // Phase 2 — file uploads (≤50 MB). Used by /api/v1/uploads. The size cap
  // is enforced by @fastify/multipart itself: oversize bodies short-circuit
  // with a 413 before reaching our handler.
  await app.register(multipart, {
    limits: {
      fileSize: 50 * 1024 * 1024, // 50 MB per spec §5.1
      files: 1,
      fields: 5,
    },
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
  await app.register(uploadRoutes);
  await app.register(chatParamsRoutes);
  await app.register(booleanQueryRoutes);
  await app.register(wsRoutes);

  // Boot the BullMQ inline worker. Phase 2 jobs register their processors
  // via the PROCESSORS map below; today there are none registered (M7.4 will
  // add the first one — `parse-upload`). We still start the worker so the
  // queue infrastructure is live and ready to accept future processors.
  // Skipped under NODE_ENV=test so unit tests don't open Redis connections
  // they don't need; queue tests open their own connections explicitly.
  if (process.env.NODE_ENV !== 'test') {
    const PROCESSORS: Record<string, Processor> = {
      'parse-upload': parseUploadProcessor as Processor,
      'data-extract': dataExtractProcessor as Processor,
      'enrich-batch': enrichBatchProcessor as Processor,
    };
    startInlineWorker(async (job, token) => {
      const processor = PROCESSORS[job.name];
      if (!processor) {
        app.log.warn({ name: job.name }, 'no processor registered for job');
        return;
      }
      return processor(job, token);
    });

    // Phase 3 — M8.4: bridge DataExtractAgent's handoff publish to the
    // EnrichmentAgent. Mirrors the queue bootstrap above: NODE_ENV=test
    // skipped so unit tests don't open a Redis subscribe connection.
    startEnrichmentSubscriber();
  }

  return app;
}
