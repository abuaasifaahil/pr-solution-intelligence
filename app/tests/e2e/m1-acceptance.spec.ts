import { test, expect, request } from '@playwright/test';

const API_URL = process.env.API_URL ?? 'http://localhost:3001';
const FE_URL = process.env.FE_URL ?? 'http://localhost:3000';

test('M1: backend /healthz reports ok with db + redis', async () => {
  const ctx = await request.newContext();
  const res = await ctx.get(`${API_URL}/healthz`);
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body).toEqual({ ok: true, service: 'api', db: 'ok', redis: 'ok' });
});

test('M1: frontend /api/healthz reports ok', async () => {
  const ctx = await request.newContext();
  const res = await ctx.get(`${FE_URL}/api/healthz`);
  expect(res.status()).toBe(200);
  expect(await res.json()).toEqual({ ok: true, service: 'frontend' });
});

// Note: the M1 "home page renders placeholder" test was removed at M2.12.
// M2.11 added the AuthGate, so the home page now requires authentication and
// shows the user greeting instead of the M1 placeholder. M2's
// m2-auth.spec.ts → "unauthenticated visit to / redirects to /login" covers
// the equivalent frontend-reachability assertion.

test('M1: database has agents seeded (proxied via healthz.db = ok)', async () => {
  // M1 does not implement /api/v1/agents (that's an M3 deliverable).
  // We assert healthz says db=ok, which means migrations + seed ran.
  // Direct row-count verification is via psql in the M1 Definition of Done.
  const ctx = await request.newContext();
  const res = await ctx.get(`${API_URL}/healthz`);
  const body = await res.json();
  expect(body.db).toBe('ok');
});
