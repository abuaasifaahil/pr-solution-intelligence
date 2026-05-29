import type { Prisma } from '@prsi/shared/db';
import { withUser } from '../lib/prisma-rls.js';
import { encrypt } from '../lib/encryption.js';

export type LLMProvider = 'claude' | 'gpt' | 'ollama' | 'perplexity';

export interface ModelConfigRecord {
  id: string;
  userId: string;
  provider: LLMProvider;
  modelName: string;
  apiKeyEncrypted: '***encrypted***' | null;
  maxTokens: number;
  temperature: number;
  isDefault: boolean;
  createdAt: Date;
}

export interface UpsertModelConfigInput {
  provider: LLMProvider;
  modelName: string;
  apiKey?: string;       // optional on update (keep existing)
  maxTokens: number;
  temperature: number;
}

function mask(row: {
  apiKeyEncrypted: string | null; temperature: unknown; [k: string]: unknown;
}): ModelConfigRecord {
  return {
    ...(row as unknown as ModelConfigRecord),
    apiKeyEncrypted: row.apiKeyEncrypted ? '***encrypted***' : null,
    temperature: typeof row.temperature === 'object' && row.temperature !== null && 'toNumber' in row.temperature
      ? (row.temperature as { toNumber: () => number }).toNumber()
      : Number(row.temperature),
  };
}

export async function getDefaultModelConfig(userId: string): Promise<ModelConfigRecord | null> {
  return withUser(userId, async (tx) => {
    const row = await tx.lLMConfig.findFirst({ where: { isDefault: true } });
    return row ? mask(row) : null;
  });
}

export async function upsertDefaultModelConfig(
  userId: string, input: UpsertModelConfigInput,
): Promise<ModelConfigRecord> {
  if (input.temperature < 0 || input.temperature > 2) {
    throw new Error('temperature must be between 0 and 2');
  }
  if (input.maxTokens < 1 || input.maxTokens > 200000) {
    throw new Error('maxTokens must be between 1 and 200000');
  }
  return withUser(userId, async (tx) => {
    const existing = await tx.lLMConfig.findFirst({ where: { isDefault: true } });
    // Clear is_default on this user's other rows first.
    await tx.lLMConfig.updateMany({
      where: { isDefault: true },
      data: { isDefault: false },
    });
    if (existing) {
      const data: Prisma.LLMConfigUpdateInput = {
        provider: input.provider,
        modelName: input.modelName,
        maxTokens: input.maxTokens,
        temperature: input.temperature as unknown as Prisma.Decimal,
        isDefault: true,
      };
      if (input.apiKey !== undefined) data.apiKeyEncrypted = encrypt(input.apiKey);
      const updated = await tx.lLMConfig.update({ where: { id: existing.id }, data });
      return mask(updated);
    }
    const created = await tx.lLMConfig.create({
      data: {
        userId,
        provider: input.provider,
        modelName: input.modelName,
        apiKeyEncrypted: input.apiKey ? encrypt(input.apiKey) : null,
        maxTokens: input.maxTokens,
        temperature: input.temperature as unknown as Prisma.Decimal,
        isDefault: true,
      },
    });
    return mask(created);
  });
}
