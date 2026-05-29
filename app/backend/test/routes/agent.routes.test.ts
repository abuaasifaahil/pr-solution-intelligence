import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

vi.mock('@prsi/shared/db', () => ({
  prisma: {
    $queryRaw: vi.fn().mockResolvedValue([{ '?column?': 1 }]),
    $disconnect: vi.fn(),
    agent: {
      findMany: vi.fn().mockResolvedValue([
        { id: 'a1', type: 'pr_impact', name: 'PR Impact Agent', description: 'd', capabilities: [], icon: 'i', color: '#0078D4', isDefault: true, isActive: true },
      ]),
      findUnique: vi.fn().mockResolvedValue({
        id: 'a1', type: 'pr_impact', name: 'PR Impact Agent', description: 'd', capabilities: [], icon: 'i', color: '#0078D4', isDefault: true, isActive: true,
      }),
    },
  },
}));
vi.mock('../../src/lib/redis.js', () => ({
  getRedis: () => ({ ping: vi.fn().mockResolvedValue('PONG') }),
  closeRedis: vi.fn(),
}));

const { buildServer } = await import('../../src/server.js');
const { signAccess } = await import('../../src/lib/jwt.js');

const token = signAccess({
  userId: '00000000-0000-0000-0000-000000000001',
  email: 'kb@test.local',
  role: 'analyst',
  sessionId: 's',
});

describe('GET /api/v1/agents', () => {
  let app: FastifyInstance;
  beforeAll(async () => { app = await buildServer(); await app.ready(); });
  afterAll(async () => { await app.close(); });

  it('requires auth', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/agents' });
    expect(res.statusCode).toBe(401);
  });

  it('returns list of active default agents', async () => {
    const res = await app.inject({
      method: 'GET', url: '/api/v1/agents',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(Array.isArray(body.data.agents)).toBe(true);
    expect(body.data.agents[0].type).toBe('pr_impact');
  });

  it('GET /agents/:id returns one agent', async () => {
    const res = await app.inject({
      method: 'GET', url: '/api/v1/agents/a1',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.agent.type).toBe('pr_impact');
  });
});
