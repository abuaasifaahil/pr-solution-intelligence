'use client';
import { useEffect, useState } from 'react';
import {
  listDataSources, createDataSource, updateDataSource,
  deleteDataSource, testDataSource,
  type DataSource, type DataSourceType, type DataSourceTestResult,
} from '../../lib/settings';
import { OpenSearchOverridePanel } from './OpenSearchOverridePanel';

const SOURCE_LABELS: Record<DataSourceType, string> = {
  meltwater: 'Meltwater',
  opoint: 'Opoint',
  webz: 'Webz',
  twitter: 'Twitter',
  infovision: 'Infovision',
  custom: 'Custom',
};

export function DataSourcesTab() {
  const [rows, setRows] = useState<DataSource[]>([]);
  const [loading, setLoading] = useState(true);
  const [addOpen, setAddOpen] = useState(false);

  useEffect(() => {
    listDataSources()
      .then(setRows)
      .catch(() => setRows([]))
      .finally(() => setLoading(false));
  }, []);

  async function reload() { setRows(await listDataSources()); }

  // M9.9: hide the OpenSearch override row from the generic data-source
  // card grid — `OpenSearchOverridePanel` owns its presentation. We
  // identify it the same way the backend resolver does:
  // sourceType==='custom' && config.kind==='opensearch'.
  function isOpenSearchOverride(r: DataSource): boolean {
    return (
      r.sourceType === 'custom' &&
      typeof r.config === 'object' &&
      r.config !== null &&
      (r.config as { kind?: unknown }).kind === 'opensearch'
    );
  }
  const visibleRows = rows.filter((r) => !isOpenSearchOverride(r));

  return (
    <div className="p-6 max-w-5xl">
      <div className="flex items-center justify-between mb-5">
        <div>
          <h1 className="text-xl font-bold">Data Sources</h1>
          <p className="text-sm text-text-secondary">
            Configure API access for the third-party data providers your agents will query.
          </p>
        </div>
        <button
          onClick={() => setAddOpen(true)}
          className="px-3.5 py-2 bg-win-blue-500 text-white text-sm font-semibold rounded-md
                     hover:bg-win-blue-600 transition"
        >
          + Add Source
        </button>
      </div>

      <OpenSearchOverridePanel />

      {loading && <div className="text-sm text-text-tertiary">Loading…</div>}
      {!loading && visibleRows.length === 0 && (
        <div className="text-sm text-text-tertiary border border-dashed border-border-default
                        rounded-md p-6 text-center">
          No third-party data sources configured yet. Click <strong>Add Source</strong> above to begin.
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {visibleRows.map((row) => (
          <DataSourceCard key={row.id} row={row} onChanged={reload} />
        ))}
      </div>

      {addOpen && (
        <AddSourceModal
          existing={visibleRows.map((r) => r.sourceType)}
          onClose={() => setAddOpen(false)}
          onCreated={async () => { setAddOpen(false); await reload(); }}
        />
      )}
    </div>
  );
}

function DataSourceCard({ row, onChanged }: { row: DataSource; onChanged: () => Promise<void> }) {
  const [displayName, setDisplayName] = useState(row.displayName);
  const [endpointUrl, setEndpointUrl] = useState(row.endpointUrl ?? '');
  const [newKey, setNewKey] = useState(''); // empty = leave existing key untouched
  const [busy, setBusy] = useState(false);
  const [testResult, setTestResult] = useState<DataSourceTestResult | null>(null);
  const connected = testResult?.ok ?? false;

  async function save() {
    setBusy(true);
    try {
      const patch: Parameters<typeof updateDataSource>[1] = { displayName, endpointUrl };
      if (newKey) patch.apiKey = newKey;
      await updateDataSource(row.id, patch);
      setNewKey('');
      await onChanged();
    } finally { setBusy(false); }
  }
  async function test() {
    setBusy(true);
    try { setTestResult(await testDataSource(row.id)); }
    finally { setBusy(false); }
  }
  async function remove() {
    if (!confirm(`Remove "${row.displayName}"?`)) return;
    setBusy(true);
    try { await deleteDataSource(row.id); await onChanged(); }
    finally { setBusy(false); }
  }

  return (
    <div className="border border-border-default rounded-lg p-4 bg-white">
      <div className="flex items-center justify-between mb-3">
        <div>
          <div className="text-sm font-bold">{SOURCE_LABELS[row.sourceType]}</div>
          <div className="text-xs text-text-tertiary">{row.sourceType}</div>
        </div>
        <span className={`text-[0.7rem] px-2 py-0.5 rounded-full font-semibold
          ${connected
            ? 'bg-status-success-bg text-status-success-text'
            : 'bg-status-warn-bg text-status-warn-text'}`}>
          {connected ? 'Connected' : 'Not Connected'}
        </span>
      </div>

      <label className="block text-xs font-semibold text-text-secondary mb-1">Display name</label>
      <input
        className="w-full mb-2.5 px-2.5 py-1.5 border border-border-default rounded text-sm"
        value={displayName} onChange={(e) => setDisplayName(e.target.value)}
      />

      <label className="block text-xs font-semibold text-text-secondary mb-1">API Key</label>
      <input
        type="password"
        placeholder="••••••••••• (leave blank to keep)"
        className="w-full mb-2.5 px-2.5 py-1.5 border border-border-default rounded text-sm font-mono"
        value={newKey} onChange={(e) => setNewKey(e.target.value)}
      />

      <label className="block text-xs font-semibold text-text-secondary mb-1">Endpoint URL</label>
      <input
        className="w-full mb-3 px-2.5 py-1.5 border border-border-default rounded text-sm font-mono"
        value={endpointUrl} onChange={(e) => setEndpointUrl(e.target.value)}
      />

      <div className="flex gap-2">
        <button
          onClick={test} disabled={busy}
          className="px-3 py-1.5 border border-border-default rounded text-sm font-medium
                     hover:bg-surface-hover disabled:opacity-50"
        >Test Connection</button>
        <button
          onClick={save} disabled={busy}
          className="px-3 py-1.5 bg-win-blue-500 text-white rounded text-sm font-semibold
                     hover:bg-win-blue-600 disabled:opacity-50"
        >Save</button>
        <button
          onClick={remove} disabled={busy}
          className="ml-auto px-3 py-1.5 text-status-error-text rounded text-sm
                     hover:bg-status-error-bg disabled:opacity-50"
        >Remove</button>
      </div>
      {testResult && (
        <div className={`mt-2 text-xs ${testResult.ok ? 'text-status-success-text' : 'text-status-error-text'}`}>
          {testResult.message} {testResult.latencyMs ? `(${testResult.latencyMs} ms)` : ''}
        </div>
      )}
    </div>
  );
}

function AddSourceModal({
  existing, onClose, onCreated,
}: { existing: DataSourceType[]; onClose: () => void; onCreated: () => Promise<void> }) {
  const remaining: DataSourceType[] =
    (['meltwater', 'opoint', 'webz', 'twitter', 'infovision', 'custom'] as DataSourceType[])
      .filter((t) => t === 'custom' || !existing.includes(t));
  const [sourceType, setSourceType] = useState<DataSourceType>(remaining[0] ?? 'custom');
  const [displayName, setDisplayName] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [endpointUrl, setEndpointUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (!displayName.trim() || !apiKey.trim()) {
      setError('Display name and API key are required.');
      return;
    }
    setBusy(true); setError(null);
    try {
      await createDataSource({ sourceType, displayName, apiKey, endpointUrl: endpointUrl || undefined });
      await onCreated();
    } catch (err) {
      setError((err as Error).message);
    } finally { setBusy(false); }
  }

  return (
    <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg p-5 w-[480px] max-w-[90vw]">
        <h2 className="text-base font-bold mb-3">Add Data Source</h2>
        <label className="block text-xs font-semibold mb-1">Source type</label>
        <select
          value={sourceType} onChange={(e) => setSourceType(e.target.value as DataSourceType)}
          className="w-full mb-2.5 px-2.5 py-1.5 border border-border-default rounded text-sm"
        >
          {remaining.map((t) => (
            <option key={t} value={t}>{SOURCE_LABELS[t]}</option>
          ))}
        </select>
        <label className="block text-xs font-semibold mb-1">Display name</label>
        <input
          className="w-full mb-2.5 px-2.5 py-1.5 border border-border-default rounded text-sm"
          value={displayName} onChange={(e) => setDisplayName(e.target.value)}
        />
        <label className="block text-xs font-semibold mb-1">API Key</label>
        <input
          type="password"
          className="w-full mb-2.5 px-2.5 py-1.5 border border-border-default rounded text-sm font-mono"
          value={apiKey} onChange={(e) => setApiKey(e.target.value)}
        />
        <label className="block text-xs font-semibold mb-1">Endpoint URL (optional)</label>
        <input
          className="w-full mb-3 px-2.5 py-1.5 border border-border-default rounded text-sm font-mono"
          value={endpointUrl} onChange={(e) => setEndpointUrl(e.target.value)}
        />
        {error && <div className="text-xs text-status-error-text mb-2">{error}</div>}
        <div className="flex justify-end gap-2">
          <button onClick={onClose} disabled={busy}
            className="px-3 py-1.5 text-sm rounded hover:bg-surface-hover">Cancel</button>
          <button onClick={submit} disabled={busy}
            className="px-3 py-1.5 bg-win-blue-500 text-white text-sm font-semibold rounded
                       hover:bg-win-blue-600 disabled:opacity-50">Create</button>
        </div>
      </div>
    </div>
  );
}
