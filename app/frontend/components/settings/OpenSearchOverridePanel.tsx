'use client';
import { useEffect, useState } from 'react';
import {
  getOpenSearchOverride,
  saveOpenSearchOverride,
  deleteOpenSearchOverride,
  type DataSource,
  type OpenSearchIndexType,
} from '../../lib/settings';
import {
  probeOpenSearchConnection,
  type OpenSearchProbeResult,
} from '../../lib/opensearch-probe';
import { OpenSearchStatusBadge } from './OpenSearchStatusBadge';

/**
 * M9.9 (Phase 3.5) — OpenSearch override surface inside the Data Sources
 * tab.
 *
 * Behavior (ADR-0001 config-resolver chain):
 *  - On mount, GET the user's data-sources rows; show "Using your
 *    override" when a `custom` row with `config.kind='opensearch'` exists,
 *    else "Using organization OpenSearch" (org env config presumed —
 *    M9.9 doesn't probe the org config separately).
 *  - "Configure my own" reveals the form: URL / username / password /
 *    index name / index type (daywise | monthwise | single).
 *  - "Test connection" hits POST /api/v1/opensearch/probe with the form
 *    values. Result chip surfaces latency + cluster status.
 *  - "Save" calls `saveOpenSearchOverride()` which PATCHes the existing
 *    row OR POSTs a new one. The backend encrypts the password via the
 *    existing M5 AES-256-GCM path; the resolver picks the row up on the
 *    next chat read.
 *  - "Use org default" deletes the override row.
 *
 * @file components/settings/OpenSearchOverridePanel.tsx
 */
export function OpenSearchOverridePanel(): JSX.Element {
  const [override, setOverride] = useState<DataSource | null>(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);

  const [url, setUrl] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [indexName, setIndexName] = useState('amx-data*');
  const [indexType, setIndexType] = useState<OpenSearchIndexType>('daywise');

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<OpenSearchProbeResult | null>(null);

  useEffect(() => {
    void getOpenSearchOverride()
      .then((row) => {
        setOverride(row);
        if (row) {
          setUrl(row.endpointUrl ?? '');
          const cfg = row.config as {
            username?: string;
            indexName?: string;
            indexType?: OpenSearchIndexType;
          };
          setUsername(cfg.username ?? '');
          setIndexName(cfg.indexName ?? 'amx-data*');
          setIndexType(cfg.indexType ?? 'daywise');
        }
      })
      .catch(() => setOverride(null))
      .finally(() => setLoading(false));
  }, []);

  async function reload(): Promise<void> {
    const row = await getOpenSearchOverride();
    setOverride(row);
  }

  async function onTest(): Promise<void> {
    setError(null);
    setTestResult(null);
    if (!url.trim() || !username.trim() || !password.trim()) {
      setError('URL, username, and password are required to test.');
      return;
    }
    setBusy(true);
    try {
      const r = await probeOpenSearchConnection({
        url: url.trim(),
        username: username.trim(),
        password,
        indexName: indexName.trim() || undefined,
      });
      setTestResult(r);
      if (!r.ok && r.error) setError(r.error);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function onSave(): Promise<void> {
    setError(null);
    if (!url.trim() || !username.trim() || !password.trim()) {
      setError('URL, username, and password are required to save.');
      return;
    }
    setBusy(true);
    try {
      await saveOpenSearchOverride({
        url: url.trim(),
        username: username.trim(),
        password,
        indexName: indexName.trim() || undefined,
        indexType,
      });
      await reload();
      setEditing(false);
      setPassword('');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function onClear(): Promise<void> {
    if (
      !confirm(
        'Remove your OpenSearch override and fall back to the organization endpoint?',
      )
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await deleteOpenSearchOverride();
      await reload();
      setEditing(false);
      setPassword('');
      setTestResult(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const status = override ? 'override' : 'org-default';
  const detail = override
    ? `${(override.config as { username?: string }).username ?? '?'} @ ${
        override.endpointUrl ?? '?'
      }`
    : 'admin-uat (platform env config)';

  return (
    <section
      data-testid="opensearch-override-panel"
      className="border border-border-default rounded-lg p-4 bg-white mb-6"
    >
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <div className="text-sm font-bold mb-1">OpenSearch</div>
          {loading ? (
            <div className="text-xs text-text-tertiary">Loading…</div>
          ) : (
            <OpenSearchStatusBadge status={status} detail={detail} />
          )}
        </div>
        <div className="flex gap-2">
          {!editing && !loading && (
            <button
              type="button"
              onClick={() => setEditing(true)}
              className="px-3 py-1.5 border border-border-default rounded text-sm font-medium
                         hover:bg-surface-hover"
            >
              {override ? 'Edit override' : 'Configure my own'}
            </button>
          )}
          {override && !editing && (
            <button
              type="button"
              onClick={onClear}
              disabled={busy}
              className="px-3 py-1.5 text-status-error-text rounded text-sm
                         hover:bg-status-error-bg disabled:opacity-50"
            >
              Use org default
            </button>
          )}
        </div>
      </div>

      {editing && (
        <div className="mt-4 grid gap-2.5">
          <label className="block text-xs font-semibold text-text-secondary">
            URL
            <input
              className="mt-1 w-full px-2.5 py-1.5 border border-border-default rounded text-sm font-mono"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://search-amx-opensearch-uat.es.eu-west-1.aws.com"
              data-testid="os-url-input"
            />
          </label>
          <label className="block text-xs font-semibold text-text-secondary">
            Username
            <input
              className="mt-1 w-full px-2.5 py-1.5 border border-border-default rounded text-sm font-mono"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              data-testid="os-username-input"
            />
          </label>
          <label className="block text-xs font-semibold text-text-secondary">
            Password
            <input
              type="password"
              className="mt-1 w-full px-2.5 py-1.5 border border-border-default rounded text-sm font-mono"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={override ? '••••••• (leave blank to keep)' : ''}
              data-testid="os-password-input"
            />
          </label>
          <label className="block text-xs font-semibold text-text-secondary">
            Index name
            <input
              className="mt-1 w-full px-2.5 py-1.5 border border-border-default rounded text-sm font-mono"
              value={indexName}
              onChange={(e) => setIndexName(e.target.value)}
              data-testid="os-index-name-input"
            />
          </label>
          <div>
            <span className="block text-xs font-semibold text-text-secondary mb-1">
              Index type
            </span>
            <div className="flex gap-3 text-xs">
              {(['daywise', 'monthwise', 'single'] as OpenSearchIndexType[]).map(
                (t) => (
                  <label key={t} className="inline-flex items-center gap-1.5">
                    <input
                      type="radio"
                      name="os-index-type"
                      value={t}
                      checked={indexType === t}
                      onChange={() => setIndexType(t)}
                      data-testid={`os-index-type-${t}`}
                    />
                    {t}
                  </label>
                ),
              )}
            </div>
          </div>

          <div className="flex gap-2 mt-1">
            <button
              type="button"
              onClick={onTest}
              disabled={busy}
              className="px-3 py-1.5 border border-border-default rounded text-sm font-medium
                         hover:bg-surface-hover disabled:opacity-50"
              data-testid="os-test-button"
            >
              Test connection
            </button>
            <button
              type="button"
              onClick={onSave}
              disabled={busy}
              className="px-3 py-1.5 bg-win-blue-500 text-white text-sm font-semibold rounded
                         hover:bg-win-blue-600 disabled:opacity-50"
              data-testid="os-save-button"
            >
              Save
            </button>
            <button
              type="button"
              onClick={() => {
                setEditing(false);
                setError(null);
                setTestResult(null);
              }}
              disabled={busy}
              className="ml-auto px-3 py-1.5 text-sm rounded hover:bg-surface-hover disabled:opacity-50"
            >
              Cancel
            </button>
          </div>

          {testResult && (
            <div
              data-testid="os-test-result"
              className={`mt-1 text-xs ${
                testResult.ok
                  ? 'text-status-success-text'
                  : 'text-status-error-text'
              }`}
            >
              {testResult.ok ? (
                <>
                  Connected ({testResult.latencyMs} ms, status:{' '}
                  {testResult.clusterStatus ?? '?'}, cluster:{' '}
                  {testResult.clusterName ?? '?'},{' '}
                  {testResult.numberOfNodes ?? '?'} node
                  {testResult.numberOfNodes === 1 ? '' : 's'})
                </>
              ) : (
                <>Failed: {testResult.error ?? 'Connection failed'}</>
              )}
            </div>
          )}
          {error && !testResult && (
            <div className="text-xs text-status-error-text">{error}</div>
          )}
        </div>
      )}
    </section>
  );
}
