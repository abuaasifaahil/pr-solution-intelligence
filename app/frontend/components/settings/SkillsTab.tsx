'use client';
import { useEffect, useState } from 'react';
import { listSkills, createSkill, toggleSkill, type SkillView } from '../../lib/settings';

export function SkillsTab() {
  const [skills, setSkills] = useState<SkillView[]>([]);
  const [loading, setLoading] = useState(true);
  const [addOpen, setAddOpen] = useState(false);

  useEffect(() => {
    listSkills().then(setSkills).catch(() => setSkills([])).finally(() => setLoading(false));
  }, []);
  async function reload() { setSkills(await listSkills()); }

  async function onToggle(s: SkillView, next: boolean) {
    if (s.isDefault) return;
    // Optimistic update.
    setSkills((prev) => prev.map((x) => (x.skillId === s.skillId ? { ...x, isEnabled: next } : x)));
    try { await toggleSkill(s.skillId, next); }
    catch { await reload(); }
  }

  return (
    <div className="p-6 max-w-5xl">
      <div className="flex items-center justify-between mb-5">
        <div>
          <h1 className="text-xl font-bold">Skills</h1>
          <p className="text-sm text-text-secondary">
            Built-in skills are always on. Custom skills you add can be toggled per-user.
          </p>
        </div>
        <button onClick={() => setAddOpen(true)}
          className="px-3.5 py-2 bg-win-blue-500 text-white text-sm font-semibold rounded-md
                     hover:bg-win-blue-600 transition">
          + Add Skill
        </button>
      </div>

      {loading && <div className="text-sm text-text-tertiary">Loading…</div>}

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
        {skills.map((s) => (
          <div key={s.skillId} className="border border-border-default rounded-lg p-4 bg-white">
            <div className="flex items-center gap-3 mb-2">
              <div className="w-8 h-8 rounded-md bg-win-blue-50 text-win-blue-600 font-bold
                              flex items-center justify-center uppercase text-sm">
                {s.name[0]}
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-bold truncate">{s.name}</div>
                <div className="text-[0.7rem] text-text-tertiary">{s.type}</div>
              </div>
              <Toggle
                checked={s.isEnabled}
                disabled={s.isDefault}
                onChange={(next) => onToggle(s, next)}
              />
            </div>
            <p className="text-xs text-text-secondary mb-3 line-clamp-3">{s.description}</p>
            <span className={`text-[0.65rem] px-2 py-0.5 rounded-full font-semibold
              ${s.isDefault
                ? 'bg-surface-tertiary text-text-secondary'
                : 'bg-win-blue-50 text-win-blue-600'}`}>
              {s.isDefault ? 'Default — Locked' : 'User Added'}
            </span>
          </div>
        ))}
      </div>

      {addOpen && (
        <AddSkillModal onClose={() => setAddOpen(false)}
          onCreated={async () => { setAddOpen(false); await reload(); }} />
      )}
    </div>
  );
}

function Toggle({ checked, disabled, onChange }: {
  checked: boolean; disabled?: boolean; onChange: (next: boolean) => void;
}) {
  return (
    <button
      role="switch" aria-checked={checked} disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative w-10 h-5 rounded-full transition
        ${checked ? 'bg-win-blue-500' : 'bg-surface-tertiary'}
        ${disabled ? 'opacity-60 cursor-not-allowed' : 'cursor-pointer'}`}
    >
      <span className={`absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition
        ${checked ? 'left-[22px]' : 'left-0.5'}`} />
    </button>
  );
}

function AddSkillModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => Promise<void> }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [type, setType] = useState('custom');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (!name.trim() || !description.trim()) { setError('Name and description required.'); return; }
    setBusy(true); setError(null);
    try { await createSkill({ name, description, type }); await onCreated(); }
    catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  }

  return (
    <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg p-5 w-[480px] max-w-[90vw]">
        <h2 className="text-base font-bold mb-3">Add Custom Skill</h2>
        <label className="block text-xs font-semibold mb-1">Name (snake_case)</label>
        <input className="w-full mb-2.5 px-2.5 py-1.5 border border-border-default rounded text-sm font-mono"
          value={name} onChange={(e) => setName(e.target.value)} />
        <label className="block text-xs font-semibold mb-1">Description</label>
        <textarea className="w-full mb-2.5 px-2.5 py-1.5 border border-border-default rounded text-sm" rows={3}
          value={description} onChange={(e) => setDescription(e.target.value)} />
        <label className="block text-xs font-semibold mb-1">Type</label>
        <input className="w-full mb-3 px-2.5 py-1.5 border border-border-default rounded text-sm"
          value={type} onChange={(e) => setType(e.target.value)} />
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
