'use client';
import { useEffect, useState } from 'react';
import {
  listMCP, createMCP, updateMCP, deleteMCP, verifyMCP,
  type MCPConnection, type MCPVerifyResult,
} from '../../lib/settings';

export function MCPTab() {
  const [rows, setRows] = useState<MCPConnection[]>([]);
  const [loading, setLoading] = useState(true);
  const [addOpen, setAddOpen] = useState(false);

  useEffect(() => {
    listMCP().then(setRows).catch(() => setRows([])).finally(() => setLoading(false));
  }, []);
  async function reload() { setRows(await listMCP()); }

  return (
    <div className="p-6 max-w-5xl">
      <div className="flex items-center justify-between mb-5">
        <div>
          <h1 className="text-xl font-bold">MCP Connections</h1>
          <p className="text-sm text-text-secondary">
            Model Context Protocol servers your agents can call into.
          </p>
        </div>
        <button onClick={() => setAddOpen(true)}
          className="px-3.5 py-2 bg-win-blue-500 text-white text-sm font-semibold rounded-md
                     hover:bg-win-blue-600 transition">
          + Add MCP Server
        </button>
      </div>

      {loading && <div className="text-sm text-text-tertiary">Loading…</div>}
      {!loading && rows.length === 0 && (
        <div className="text-sm text-text-tertiary border border-dashed border-border-default
                        rounded-md p-6 text-center">
          No MCP servers configured yet.
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {rows.map((row) => <MCPCard key={row.id} row={row} onChanged={reload} />)}
      </div>

      {addOpen && <AddMCPModal onClose={() => setAddOpen(false)}
        onCreated={async () => { setAddOpen(false); await reload(); }} />}
    </div>
  );
}

function MCPCard({ row, onChanged }: { row: MCPConnection; onChanged: () => Promise<void> }) {
  const [sourceName, setSourceName] = useState(row.sourceName);
  const [serverUrl, setServerUrl] = useState(row.serverUrl);
  const [newToken, setNewToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [verifyResult, setVerifyResult] = useState<MCPVerifyResult | null>(null);
  const effectiveStatus = verifyResult?.status ?? row.status;

  const badgeCls =
    effectiveStatus === 'active'   ? 'bg-status-success-bg text-status-success-text' :
    effectiveStatus === 'error'    ? 'bg-status-error-bg   text-status-error-text'   :
                                     'bg-status-warn-bg    text-status-warn-text';

  async function save() {
    setBusy(true);
    try {
      const patch: Parameters<typeof updateMCP>[1] = { sourceName, serverUrl };
      if (newToken) patch.token = newToken;
      await updateMCP(row.id, patch);
      setNewToken('');
      await onChanged();
    } finally { setBusy(false); }
  }
  async function verify() {
    setBusy(true);
    try { setVerifyResult(await verifyMCP(row.id)); await onChanged(); }
    finally { setBusy(false); }
  }
  async function remove() {
    if (!confirm(`Remove "${row.sourceName}"?`)) return;
    setBusy(true);
    try { await deleteMCP(row.id); await onChanged(); }
    finally { setBusy(false); }
  }

  return (
    <div className="border border-border-default rounded-lg p-4 bg-white">
      <div className="flex items-center justify-between mb-3">
        <div className="text-sm font-bold">{row.sourceName}</div>
        <span className={`text-[0.7rem] px-2 py-0.5 rounded-full font-semibold ${badgeCls}`}>
          {effectiveStatus}
        </span>
      </div>

      <label className="block text-xs font-semibold text-text-secondary mb-1">Source name</label>
      <input className="w-full mb-2.5 px-2.5 py-1.5 border border-border-default rounded text-sm"
        value={sourceName} onChange={(e) => setSourceName(e.target.value)} />

      <label className="block text-xs font-semibold text-text-secondary mb-1">Server URL</label>
      <input className="w-full mb-2.5 px-2.5 py-1.5 border border-border-default rounded text-sm font-mono"
        value={serverUrl} onChange={(e) => setServerUrl(e.target.value)} />

      <label className="block text-xs font-semibold text-text-secondary mb-1">Auth Token</label>
      <input type="password" placeholder="••••••••••• (leave blank to keep)"
        className="w-full mb-3 px-2.5 py-1.5 border border-border-default rounded text-sm font-mono"
        value={newToken} onChange={(e) => setNewToken(e.target.value)} />

      <div className="flex gap-2">
        <button onClick={verify} disabled={busy}
          className="px-3 py-1.5 border border-border-default rounded text-sm font-medium
                     hover:bg-surface-hover disabled:opacity-50">Verify Connection</button>
        <button onClick={save} disabled={busy}
          className="px-3 py-1.5 bg-win-blue-500 text-white rounded text-sm font-semibold
                     hover:bg-win-blue-600 disabled:opacity-50">Save</button>
        <button onClick={remove} disabled={busy}
          className="ml-auto px-3 py-1.5 text-status-error-text rounded text-sm
                     hover:bg-status-error-bg disabled:opacity-50">Remove</button>
      </div>
      {verifyResult && (
        <div className={`mt-2 text-xs ${verifyResult.status === 'active' ? 'text-status-success-text' : 'text-status-error-text'}`}>
          {verifyResult.message} {verifyResult.latencyMs ? `(${verifyResult.latencyMs} ms)` : ''}
        </div>
      )}
    </div>
  );
}

function AddMCPModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => Promise<void> }) {
  const [sourceName, setSourceName] = useState('');
  const [serverUrl, setServerUrl] = useState('');
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (!sourceName.trim() || !serverUrl.trim() || !token.trim()) {
      setError('All fields are required.'); return;
    }
    setBusy(true); setError(null);
    try { await createMCP({ sourceName, serverUrl, token }); await onCreated(); }
    catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  }

  return (
    <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg p-5 w-[480px] max-w-[90vw]">
        <h2 className="text-base font-bold mb-3">Add MCP Server</h2>
        <label className="block text-xs font-semibold mb-1">Source name</label>
        <input className="w-full mb-2.5 px-2.5 py-1.5 border border-border-default rounded text-sm"
          value={sourceName} onChange={(e) => setSourceName(e.target.value)} />
        <label className="block text-xs font-semibold mb-1">Server URL</label>
        <input className="w-full mb-2.5 px-2.5 py-1.5 border border-border-default rounded text-sm font-mono"
          value={serverUrl} onChange={(e) => setServerUrl(e.target.value)} />
        <label className="block text-xs font-semibold mb-1">Auth Token</label>
        <input type="password"
          className="w-full mb-3 px-2.5 py-1.5 border border-border-default rounded text-sm font-mono"
          value={token} onChange={(e) => setToken(e.target.value)} />
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
