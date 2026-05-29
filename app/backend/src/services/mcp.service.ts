import type { Prisma } from '@prsi/shared/db';
import { withUser } from '../lib/prisma-rls.js';
import { encrypt, decrypt } from '../lib/encryption.js';

function toJson(v: unknown): Prisma.InputJsonValue {
  return v as unknown as Prisma.InputJsonValue;
}

export type MCPStatus = 'active' | 'inactive' | 'error';

export interface MCPRecord {
  id: string;
  userId: string;
  sourceName: string;
  serverUrl: string;
  tokenEncrypted: '***encrypted***';
  status: MCPStatus;
  lastVerifiedAt: Date | null;
  availableTools: unknown[];
  createdAt: Date;
}

export interface CreateMCPInput {
  sourceName: string;
  serverUrl: string;
  token: string;
}
export interface UpdateMCPInput {
  sourceName?: string;
  serverUrl?: string;
  token?: string;
}

function mask(row: { tokenEncrypted: string; [k: string]: unknown }): MCPRecord {
  return { ...(row as unknown as MCPRecord), tokenEncrypted: '***encrypted***' };
}

export async function listMCPConnections(userId: string): Promise<MCPRecord[]> {
  return withUser(userId, async (tx) => {
    const rows = await tx.mCPConnection.findMany({ orderBy: { createdAt: 'asc' } });
    return rows.map(mask);
  });
}

export async function createMCPConnection(
  userId: string, input: CreateMCPInput,
): Promise<MCPRecord> {
  return withUser(userId, async (tx) => {
    const row = await tx.mCPConnection.create({
      data: {
        userId,
        sourceName: input.sourceName,
        serverUrl: input.serverUrl,
        tokenEncrypted: encrypt(input.token),
      },
    });
    return mask(row);
  });
}

export async function updateMCPConnection(
  userId: string, id: string, input: UpdateMCPInput,
): Promise<MCPRecord> {
  return withUser(userId, async (tx) => {
    const owned = await tx.mCPConnection.findFirst({ where: { id } });
    if (!owned) throw new Error('MCP connection not found');
    const data: Prisma.MCPConnectionUpdateInput = {};
    if (input.sourceName !== undefined) data.sourceName = input.sourceName;
    if (input.serverUrl !== undefined) data.serverUrl = input.serverUrl;
    if (input.token !== undefined) data.tokenEncrypted = encrypt(input.token);
    const updated = await tx.mCPConnection.update({ where: { id }, data });
    return mask(updated);
  });
}

export async function deleteMCPConnection(userId: string, id: string): Promise<void> {
  await withUser(userId, async (tx) => {
    const owned = await tx.mCPConnection.findFirst({ where: { id } });
    if (!owned) throw new Error('MCP connection not found');
    await tx.mCPConnection.delete({ where: { id } });
  });
}

export interface VerifyResult {
  status: MCPStatus;
  latencyMs: number;
  httpStatus?: number;
  message: string;
  availableTools: unknown[];
}

export async function verifyMCPConnection(
  userId: string, id: string,
): Promise<VerifyResult> {
  const row = await withUser(userId, async (tx) =>
    tx.mCPConnection.findFirst({ where: { id } }),
  );
  if (!row) throw new Error('MCP connection not found');

  let token: string;
  try { token = decrypt(row.tokenEncrypted); }
  catch { return { status: 'error', latencyMs: 0, message: 'stored token could not be decrypted', availableTools: [] }; }

  const start = Date.now();
  let status: MCPStatus = 'error';
  let httpStatus: number | undefined;
  let availableTools: unknown[] = [];
  let message = 'connection failed';

  try {
    const res = await fetch(row.serverUrl, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5000),
    });
    httpStatus = res.status;
    if (res.ok) {
      status = 'active';
      message = 'connected';
      const ct = res.headers.get('content-type') ?? '';
      if (ct.includes('application/json')) {
        try {
          const body = (await res.json()) as { tools?: unknown[] };
          if (Array.isArray(body.tools)) availableTools = body.tools;
        } catch { /* tolerate non-json on a 200 */ }
      }
    } else {
      status = 'error';
      message = `verify returned status ${res.status}`;
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[mcp] verify failed', { id, errMessage: (err as Error).message });
    status = 'error';
    message = 'connection failed';
  }
  const latencyMs = Date.now() - start;

  await withUser(userId, async (tx) => {
    await tx.mCPConnection.update({
      where: { id },
      data: {
        status,
        availableTools: toJson(availableTools),
        lastVerifiedAt: new Date(),
      },
    });
  });

  return { status, latencyMs, httpStatus, message, availableTools };
}
