import 'dotenv/config';
import { z } from 'zod';

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3001),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  JWT_PRIVATE_KEY: z.string().min(100).transform((s) => s.replace(/\\n/g, '\n')),
  JWT_PUBLIC_KEY: z.string().min(100).transform((s) => s.replace(/\\n/g, '\n')),
  JWT_ACCESS_TTL: z.coerce.number().int().positive().default(900),
  JWT_REFRESH_TTL: z.coerce.number().int().positive().default(604800),
  CORS_ALLOWED_ORIGIN: z.string().default('*'),
  // Azure OpenAI (M3). Required for OrchestratorAgent.
  AZURE_OPENAI_ENDPOINT: z.string().url(),
  AZURE_OPENAI_API_KEY: z.string().min(20),
  AZURE_OPENAI_API_VERSION: z.string().default('2025-03-01-preview'),
  AZURE_OPENAI_DEPLOYMENT: z.string().default('gpt-4.1'),
  // M5 — AES-256-GCM key for encrypting data-source/MCP/model secrets.
  // 32 bytes = 64 hex characters. Generate with: openssl rand -hex 32
  ENCRYPTION_KEY: z.string().regex(/^[0-9a-f]{64}$/i, 'ENCRYPTION_KEY must be 64 hex chars (32 bytes)'),

  // Phase 2 — Storage abstraction. `inmemory` for the free-tier prod baseline
  // (no persistence; stream-parse + discard). `s3` for local MinIO and the
  // eventual AWS S3 migration — only env vars change between those two.
  STORAGE_MODE: z.enum(['inmemory', 's3']).default('inmemory'),
  STORAGE_ENDPOINT: z.string().optional(), // 'http://localhost:9000' for MinIO; omit for AWS S3
  STORAGE_REGION: z.string().default('us-east-1'),
  STORAGE_BUCKET: z.string().default('prsi-uploads'),
  STORAGE_ACCESS_KEY: z.string().optional(), // MinIO root user / AWS access key
  STORAGE_SECRET_KEY: z.string().optional(), // MinIO root password / AWS secret
  STORAGE_FORCE_PATH_STYLE: z.coerce.boolean().default(true), // required for MinIO; false for AWS S3

  // Phase 2 — Queue (BullMQ). Reuses existing REDIS_URL; no new connection string.
  QUEUE_CONCURRENCY: z.coerce.number().int().positive().default(2),
  QUEUE_JOB_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),

  // Phase 3.5 — OpenSearch (autonomous article fetching).
  //
  // All five connection vars are `.optional()` so the backend boots cleanly
  // when OpenSearch isn't configured — Phase 1/2/3 paths don't need it.
  // The DataExtractAgent (M9.5) checks `hasOpenSearchConfig()` and falls
  // back to CSV upload when missing.
  OPENSEARCH_URL: z.string().url().optional(),
  OPENSEARCH_USERNAME: z.string().optional(),
  OPENSEARCH_PASSWORD: z.string().optional(),
  OPENSEARCH_INDEX_NAME: z.string().default('amx-data*'),
  OPENSEARCH_INDEX_TYPE: z.enum(['daywise', 'monthwise', 'single']).default('daywise'),
  // Tuning knobs — sensible defaults so devs don't need to set them locally.
  OPENSEARCH_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  OPENSEARCH_PAGE_SIZE: z.coerce.number().int().positive().default(500),
  OPENSEARCH_MAX_PAGES: z.coerce.number().int().positive().default(20),
  OPENSEARCH_CONCURRENCY: z.coerce.number().int().positive().default(3),
  OPENSEARCH_PATTERN_OF_INDEX: z.string().default('YYYY-MM-DD'),
  OPENSEARCH_FIELDS_FOR_QUERY: z.string().default('title,content,description,summary'),
});

export type Env = z.infer<typeof EnvSchema>;

let cached: Env | undefined;

export function loadEnv(): Env {
  if (cached) return cached;
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    console.error('Invalid environment:', parsed.error.flatten().fieldErrors);
    process.exit(1);
  }
  cached = parsed.data;
  return cached;
}

/**
 * True when OpenSearch is configured well enough to fetch articles
 * (URL + basic-auth credentials present). Used by DataExtractAgent's
 * opensearch path (M9.5) and the `/opensearch/probe` endpoint (M9.7).
 */
export function hasOpenSearchConfig(env: Env = loadEnv()): boolean {
  return !!(env.OPENSEARCH_URL && env.OPENSEARCH_USERNAME && env.OPENSEARCH_PASSWORD);
}
