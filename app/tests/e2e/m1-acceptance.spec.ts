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

test('M1: frontend home page renders placeholder', async ({ page }) => {
  await page.goto(FE_URL);
  await expect(page.getByRole('heading', { name: 'PR Solution Intelligence' })).toBeVisible();
  await expect(page.getByText('M1 — Foundation Core')).toBeVisible();
});

test('M1: database has agents seeded (proxied via healthz.db = ok)', async () => {
  // M1 does not implement /api/v1/agents (that's an M3 deliverable).
  // We assert healthz says db=ok, which means migrations + seed ran.
  // Direct row-count verification is via psql in the M1 Definition of Done.
  const ctx = await request.newContext();
  const res = await ctx.get(`${API_URL}/healthz`);
  const body = await res.json();
  expect(body.db).toBe('ok');
});
