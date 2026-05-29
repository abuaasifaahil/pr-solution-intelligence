import type { Prisma } from '@prsi/shared/db';
import { withUser } from '../lib/prisma-rls.js';
import { encrypt, decrypt } from '../lib/encryption.js';

function toJson(v: unknown): Prisma.InputJsonValue {
  return v as unknown as Prisma.InputJsonValue;
}

export type DataSourceType =
  | 'meltwater' | 'opoint' | 'webz' | 'twitter' | 'infovision' | 'custom';

export interface DataSourceRecord {
  id: string;
  userId: string;
  sourceType: DataSourceType;
  displayName: string;
  apiKeyEncrypted: '***encrypted***';
  endpointUrl: string | null;
  config: Record<string, unknown>;
  isActive: boolean;
  lastTestedAt: Date | null;
  createdAt: Date;
}

export interface CreateDataSourceInput {
  sourceType: DataSourceType;
  displayName: string;
  apiKey: string;
  endpointUrl?: string;
  config?: Record<string, unknown>;
}

export interface UpdateDataSourceInput {
  displayName?: string;
  apiKey?: string;
  endpointUrl?: string;
  config?: Record<string, unknown>;
  isActive?: boolean;
}

export interface TestResult {
  ok: boolean;
  latencyMs: number;
  status?: number;
  message: string;
}

const PROBE_BY_TYPE: Record<
  DataSourceType,
  { url: string; header: string; prefix: string } | null
> = {
  meltwater:  { url: 'https://api.meltwater.com/v3/health',  header: 'Authorization', prefix: 'Bearer ' },
  opoint:     { url: 'https://api.opoint.com/v2/health',     header: 'Authorization', prefix: 'Bearer ' },
  webz:       { url: 'https://api.webz.io/health',           header: 'X-API-Key',     prefix: '' },
  twitter:    { url: 'https://api.twitter.com/2/users/me',   header: 'Authorization', prefix: 'Bearer ' },
  infovision: { url: 'https://api.infovision.com/health',    header: 'Authorization', prefix: 'Bearer ' },
  custom:     null,
};

function mask(row: {
  apiKeyEncrypted: string; [k: string]: unknown;
}): DataSourceRecord {
  return { ...(row as unknown as DataSourceRecord), apiKeyEncrypted: '***encrypted***' };
}

export async function listDataSources(userId: string): Promise<DataSourceRecord[]> {
  return withUser(userId, async (tx) => {
    const rows = await tx.dataSource.findMany({
      orderBy: { createdAt: 'asc' },
    });
    return rows.map(mask);
  });
}

export async function createDataSource(
  userId: string,
  input: CreateDataSourceInput,
): Promise<DataSourceRecord> {
  return withUser(userId, async (tx) => {
    const row = await tx.dataSource.create({
      data: {
        userId,
        sourceType: input.sourceType,
        displayName: input.displayName,
        apiKeyEncrypted: encrypt(input.apiKey),
        endpointUrl: input.endpointUrl ?? null,
        config: toJson(input.config ?? {}),
      },
    });
    return mask(row);
  });
}

export async function updateDataSource(
  userId: string,
  id: string,
  input: UpdateDataSourceInput,
): Promise<DataSourceRecord> {
  return withUser(userId, async (tx) => {
    const owned = await tx.dataSource.findFirst({ where: { id } });
    if (!owned) throw new Error('Data source not found');
    const data: Prisma.DataSourceUpdateInput = {};
    if (input.displayName !== undefined) data.displayName = input.displayName;
    if (input.endpointUrl !== undefined) data.endpointUrl = input.endpointUrl;
    if (input.config !== undefined) data.config = toJson(input.config);
    if (input.isActive !== undefined) data.isActive = input.isActive;
    if (input.apiKey !== undefined) data.apiKeyEncrypted = encrypt(input.apiKey);
    const updated = await tx.dataSource.update({ where: { id }, data });
    return mask(updated);
  });
}

export async function deleteDataSource(userId: string, id: string): Promise<void> {
  await withUser(userId, async (tx) => {
    const owned = await tx.dataSource.findFirst({ where: { id } });
    if (!owned) throw new Error('Data source not found');
    await tx.dataSource.delete({ where: { id } });
  });
}

export async function testDataSource(userId: string, id: string): Promise<TestResult> {
  const row = await withUser(userId, async (tx) =>
    tx.dataSource.findFirst({ where: { id } }),
  );
  if (!row) throw new Error('Data source not found');
  const probe = PROBE_BY_TYPE[row.sourceType as DataSourceType];
  if (!probe) {
    return { ok: false, latencyMs: 0, message: 'test not supported for this source type' };
  }

  const start = Date.now();
  let apiKey: string;
  try {
    apiKey = decrypt(row.apiKeyEncrypted);
  } catch {
    return { ok: false, latencyMs: 0, message: 'stored key could not be decrypted' };
  }

  try {
    const res = await fetch(probe.url, {
      method: 'GET',
      headers: { [probe.header]: `${probe.prefix}${apiKey}` },
      // 5s budget — abort if the upstream is slow.
      signal: AbortSignal.timeout(5000),
    });
    const latencyMs = Date.now() - start;
    await withUser(userId, async (tx) => {
      await tx.dataSource.update({
        where: { id },
        data: { lastTestedAt: new Date() },
      });
    });
    return {
      ok: res.ok,
      latencyMs,
      status: res.status,
      message: res.ok ? 'connected' : `probe returned status ${res.status}`,
    };
  } catch (err) {
    const latencyMs = Date.now() - start;
    // eslint-disable-next-line no-console
    console.error('[data-source] probe failed', {
      id, sourceType: row.sourceType, errMessage: (err as Error).message,
    });
    // NEVER include the api key or its substrings in the response message.
    return { ok: false, latencyMs, message: 'connection failed' };
  }
}
