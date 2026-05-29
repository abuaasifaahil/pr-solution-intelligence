'use client';
import { useEffect, useState } from 'react';
import { getModelConfig, saveModelConfig, type LLMProvider } from '../../lib/settings';

const PROVIDERS: Array<{ id: LLMProvider; label: string; description: string; models: string[] }> = [
  { id: 'claude',     label: 'Claude',     description: 'Anthropic',  models: ['claude-3-5-sonnet-20241022', 'claude-3-5-haiku-20241022', 'claude-3-opus-20240229'] },
  { id: 'gpt',        label: 'GPT',        description: 'OpenAI',     models: ['gpt-4.1', 'gpt-4o', 'gpt-4o-mini', 'gpt-3.5-turbo'] },
  { id: 'ollama',     label: 'Ollama',     description: 'Local',      models: ['llama3.1:70b', 'llama3.1:8b', 'mistral:7b'] },
  { id: 'perplexity', label: 'Perplexity', description: 'Sonar',      models: ['llama-3.1-sonar-large-128k-online', 'llama-3.1-sonar-small-128k-online'] },
];

export function ModelTab() {
  const [provider, setProvider] = useState<LLMProvider>('gpt');
  const [modelName, setModelName] = useState<string>(PROVIDERS[1]!.models[0]!);
  const [apiKey, setApiKey] = useState('');
  const [hasExistingKey, setHasExistingKey] = useState(false);
  const [maxTokens, setMaxTokens] = useState(4096);
  const [temperature, setTemperature] = useState(0.3);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [savedMsg, setSavedMsg] = useState<string | null>(null);

  useEffect(() => {
    getModelConfig()
      .then((c) => {
        if (c) {
          setProvider(c.provider);
          setModelName(c.modelName);
          setMaxTokens(c.maxTokens);
          setTemperature(c.temperature);
          setHasExistingKey(c.apiKeyEncrypted === '***encrypted***');
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  function selectProvider(p: LLMProvider) {
    setProvider(p);
    setModelName(PROVIDERS.find((x) => x.id === p)!.models[0]!);
  }

  async function save() {
    setBusy(true); setSavedMsg(null);
    try {
      const input: Parameters<typeof saveModelConfig>[0] = {
        provider, modelName, maxTokens, temperature,
      };
      if (apiKey) input.apiKey = apiKey;
      await saveModelConfig(input);
      setApiKey('');
      setHasExistingKey(true);
      setSavedMsg('Saved.');
    } catch (err) {
      setSavedMsg(`Error: ${(err as Error).message}`);
    } finally { setBusy(false); }
  }

  if (loading) return <div className="p-6 text-sm text-text-tertiary">Loading…</div>;

  const currentModels = PROVIDERS.find((p) => p.id === provider)!.models;

  return (
    <div className="p-6 max-w-5xl">
      <h1 className="text-xl font-bold mb-1">Model</h1>
      <p className="text-sm text-text-secondary mb-5">
        Select the default LLM provider and configure its API access.
      </p>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
        {PROVIDERS.map((p) => {
          const selected = p.id === provider;
          return (
            <button
              key={p.id}
              onClick={() => selectProvider(p.id)}
              className={`text-left border rounded-lg p-4 transition
                ${selected ? 'border-win-blue-500 bg-win-blue-50' : 'border-border-default bg-white hover:border-win-blue-300'}`}
            >
              <div className="text-sm font-bold">{p.label}</div>
              <div className="text-xs text-text-tertiary">{p.description}</div>
            </button>
          );
        })}
      </div>

      <div className="border border-border-default rounded-lg p-5 bg-white max-w-2xl">
        <label className="block text-xs font-semibold text-text-secondary mb-1">Model version</label>
        <select value={modelName} onChange={(e) => setModelName(e.target.value)}
          className="w-full mb-4 px-2.5 py-1.5 border border-border-default rounded text-sm">
          {currentModels.map((m) => <option key={m} value={m}>{m}</option>)}
        </select>

        <label className="block text-xs font-semibold text-text-secondary mb-1">
          API Key {hasExistingKey && <span className="text-text-tertiary font-normal">(saved — leave blank to keep)</span>}
        </label>
        <input type="password"
          className="w-full mb-4 px-2.5 py-1.5 border border-border-default rounded text-sm font-mono"
          value={apiKey} onChange={(e) => setApiKey(e.target.value)}
          placeholder={hasExistingKey ? '•••••••••••' : 'sk-…'} />

        <label className="block text-xs font-semibold text-text-secondary mb-1">Max tokens</label>
        <input type="number" min={1} max={200000} step={1}
          className="w-full mb-4 px-2.5 py-1.5 border border-border-default rounded text-sm"
          value={maxTokens} onChange={(e) => setMaxTokens(Number(e.target.value))} />

        <label className="block text-xs font-semibold text-text-secondary mb-1">
          Temperature <span className="text-text-tertiary font-normal">— {temperature.toFixed(2)}</span>
        </label>
        <input type="range" min={0} max={2} step={0.05}
          className="w-full mb-4"
          value={temperature} onChange={(e) => setTemperature(Number(e.target.value))} />

        <div className="flex items-center gap-3">
          <button onClick={save} disabled={busy}
            className="px-4 py-1.5 bg-win-blue-500 text-white text-sm font-semibold rounded-md
                       hover:bg-win-blue-600 disabled:opacity-50">Save</button>
          {savedMsg && <span className="text-xs text-text-secondary">{savedMsg}</span>}
        </div>
      </div>
    </div>
  );
}
