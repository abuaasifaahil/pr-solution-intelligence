/**
 * M9.6a — OpenSearch config-resolver unit tests.
 *
 * Verifies the three-level precedence chain:
 *   chat-attached > user M5 data_sources row > platform env
 * + toRedacted() password masking.
 */
process.env.ENCRYPTION_KEY ??=
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock env so we can flip OPENSEARCH_* per test ──────────────────────
// The encryption module also calls loadEnv() to read ENCRYPTION_KEY, so
// the fixture always carries that key — overriding per-test only shapes
// the OpenSearch fields.
const ENCRYPTION_KEY =
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
let envFixture: Record<string, unknown> = { ENCRYPTION_KEY };
let hasOSConfigFixture = false;
vi.mock('../../../src/env.js', () => ({
  loadEnv: vi.fn(() => envFixture),
  hasOpenSearchConfig: vi.fn(() => hasOSConfigFixture),
}));

// ─── Mock withUser so we can supply (or omit) a `dataSource` model ──────
interface FakeDataSourceRow {
  endpointUrl: string | null;
  apiKeyEncrypted: string;
  config: unknown;
  lastTestedAt: Date | null;
  createdAt: Date;
}
let userRows: FakeDataSourceRow[] = [];
let txHasDataSource = true;
vi.mock('../../../src/lib/prisma-rls.js', () => ({
  withUser: vi.fn(
    async (_uid: string, fn: (tx: unknown) => Promise<unknown>) => {
      const tx = txHasDataSource
        ? { dataSource: { findMany: vi.fn(async () => userRows) } }
        : {};
      return fn(tx);
    },
  ),
  asAdmin: vi.fn(),
}));

vi.mock('@prsi/shared/db', () => ({
  prisma: { $disconnect: vi.fn() },
}));

// Use the real encryption so the decrypt step actually works.
const { encrypt } = await import('../../../src/lib/encryption.js');
const { resolveOpenSearchConfig, toRedacted } = await import(
  '../../../src/data-sources/opensearch/config-resolver.js'
);

const ENV_BASE = {
  OPENSEARCH_URL: 'https://env.example.com',
  OPENSEARCH_USERNAME: 'env_user',
  OPENSEARCH_PASSWORD: 'env_pw',
  OPENSEARCH_INDEX_NAME: 'env-data*',
  OPENSEARCH_INDEX_TYPE: 'daywise' as const,
};

beforeEach(() => {
  envFixture = { ENCRYPTION_KEY };
  hasOSConfigFixture = false;
  userRows = [];
  txHasDataSource = true;
  // Clear process.env so resolver's fallback can't leak from other tests.
  delete process.env.OPENSEARCH_URL;
  delete process.env.OPENSEARCH_USERNAME;
  delete process.env.OPENSEARCH_PASSWORD;
});

describe('resolveOpenSearchConfig — precedence', () => {
  it('chat-attached COMPLETE config → returned as-is', async () => {
    // Env present but should NOT win.
    envFixture = { ENCRYPTION_KEY, ...ENV_BASE };
    hasOSConfigFixture = true;

    const cfg = await resolveOpenSearchConfig('user-1', {
      url: 'https://chat.example.com',
      username: 'chat_user',
      password: 'chat_pw',
      indexName: 'chat-data*',
      indexType: 'monthwise',
    });
    expect(cfg).toEqual({
      url: 'https://chat.example.com',
      username: 'chat_user',
      password: 'chat_pw',
      indexName: 'chat-data*',
      indexType: 'monthwise',
    });
  });

  it('chat-attached PARTIAL + user M5 row → merged (chat overrides user)', async () => {
    userRows = [
      {
        endpointUrl: 'https://user.example.com',
        apiKeyEncrypted: encrypt('user_pw'),
        config: { kind: 'opensearch', username: 'user_u', indexName: 'user-data*' },
        lastTestedAt: new Date(),
        createdAt: new Date(),
      },
    ];

    const cfg = await resolveOpenSearchConfig('user-1', {
      indexName: 'override*', // partial — should layer over the user row
    });
    expect(cfg).toMatchObject({
      url: 'https://user.example.com',
      username: 'user_u',
      password: 'user_pw',
      indexName: 'override*',
      indexType: 'daywise',
    });
  });

  it('no chat-attached, user M5 row exists → user row decrypted + returned', async () => {
    userRows = [
      {
        endpointUrl: 'https://user.example.com',
        apiKeyEncrypted: encrypt('plain-text-pw'),
        config: {
          kind: 'opensearch',
          username: 'user_u',
          indexName: 'user-data*',
          indexType: 'monthwise',
        },
        lastTestedAt: new Date(),
        createdAt: new Date(),
      },
    ];

    const cfg = await resolveOpenSearchConfig('user-1');
    expect(cfg).toEqual({
      url: 'https://user.example.com',
      username: 'user_u',
      password: 'plain-text-pw',
      indexName: 'user-data*',
      indexType: 'monthwise',
    });
  });

  it('user M5 row with malformed config.kind → skipped, falls to env', async () => {
    userRows = [
      {
        endpointUrl: 'https://user.example.com',
        apiKeyEncrypted: encrypt('user_pw'),
        config: { kind: 'NOT_OPENSEARCH' }, // wrong literal → schema fails
        lastTestedAt: new Date(),
        createdAt: new Date(),
      },
    ];
    envFixture = { ENCRYPTION_KEY, ...ENV_BASE };
    hasOSConfigFixture = true;

    const cfg = await resolveOpenSearchConfig('user-1');
    expect(cfg).toMatchObject({ url: 'https://env.example.com' });
  });

  it('no chat-attached, no user row, env set → env returned', async () => {
    envFixture = { ENCRYPTION_KEY, ...ENV_BASE };
    hasOSConfigFixture = true;

    const cfg = await resolveOpenSearchConfig('user-1');
    expect(cfg).toEqual({
      url: 'https://env.example.com',
      username: 'env_user',
      password: 'env_pw',
      indexName: 'env-data*',
      indexType: 'daywise',
    });
  });

  it('user row exists but decryption fails → skipped, falls to env', async () => {
    userRows = [
      {
        endpointUrl: 'https://user.example.com',
        apiKeyEncrypted: 'not-a-valid-ciphertext',
        config: { kind: 'opensearch', username: 'user_u' },
        lastTestedAt: new Date(),
        createdAt: new Date(),
      },
    ];
    envFixture = { ENCRYPTION_KEY, ...ENV_BASE };
    hasOSConfigFixture = true;

    const cfg = await resolveOpenSearchConfig('user-1');
    expect(cfg).toMatchObject({ url: 'https://env.example.com' });
  });

  it('tx without dataSource model (test fixture style) → short-circuits to env', async () => {
    txHasDataSource = false;
    envFixture = { ENCRYPTION_KEY, ...ENV_BASE };
    hasOSConfigFixture = true;

    const cfg = await resolveOpenSearchConfig('user-1');
    expect(cfg).toMatchObject({ url: 'https://env.example.com' });
  });

  it('nothing set anywhere → null', async () => {
    const cfg = await resolveOpenSearchConfig('user-1');
    expect(cfg).toBeNull();
  });

  it('env partial via process.env when loadEnv() mock omits URL fields', async () => {
    // Simulates the search.agent.test fixture pattern: env loader is
    // mocked to return only tuning knobs; process.env still has the
    // connection vars. Resolver should still find a usable config.
    envFixture = { ENCRYPTION_KEY };
    hasOSConfigFixture = false;
    process.env.OPENSEARCH_URL = 'https://proc.example.com';
    process.env.OPENSEARCH_USERNAME = 'proc_u';
    process.env.OPENSEARCH_PASSWORD = 'proc_pw';

    const cfg = await resolveOpenSearchConfig('user-1');
    expect(cfg).toEqual({
      url: 'https://proc.example.com',
      username: 'proc_u',
      password: 'proc_pw',
      indexName: 'amx-data*',
      indexType: 'daywise',
    });
  });
});

describe('toRedacted', () => {
  it('masks password and returns the other fields intact', () => {
    const red = toRedacted({
      url: 'https://x.example.com',
      username: 'u',
      password: 'super-secret',
      indexName: 'idx*',
      indexType: 'monthwise',
    });
    expect(red.password).toBe('***');
    expect(red.url).toBe('https://x.example.com');
    expect(red.username).toBe('u');
    expect(red.indexName).toBe('idx*');
    expect(red.indexType).toBe('monthwise');
    // String search to make double-sure the password literal does not
    // appear ANYWHERE in the serialized output.
    expect(JSON.stringify(red)).not.toContain('super-secret');
  });
});
