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
