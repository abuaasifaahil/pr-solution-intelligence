'use client';
import { useAuthStore } from '../lib/auth-store';
import { greetingFor } from '../lib/greeting';
import { AuthGate } from '../components/auth/AuthGate';
import { apiFetch } from '../lib/api-client';
import { useRouter } from 'next/navigation';

export default function HomePage() {
  return (
    <AuthGate>
      <Home />
    </AuthGate>
  );
}

function Home() {
  const router = useRouter();
  const { user, clear } = useAuthStore();

  async function handleLogout(): Promise<void> {
    try { await apiFetch('/api/v1/auth/session', { method: 'DELETE' }); } catch { /* fall through */ }
    clear();
    router.replace('/login');
  }

  return (
    <main className="min-h-screen p-12 max-w-4xl mx-auto">
      <div className="flex items-start justify-between mb-12">
        <div>
          <h1 className="text-3xl font-bold mb-2 text-text-primary">
            {greetingFor()}, <span className="text-win-blue-500">{user?.displayName ?? 'there'}</span>
          </h1>
          <p className="text-text-secondary">
            M2 — Auth flow online. The full home page with 5 agent cards arrives in M3.
          </p>
        </div>
        <button
          onClick={handleLogout}
          className="px-4 py-2 text-sm font-medium rounded-md border border-border-default
                     hover:bg-surface-hover text-text-primary transition"
        >
          Sign out
        </button>
      </div>

      <div className="card">
        <p className="text-sm text-text-secondary">
          Signed in as <code className="font-mono bg-win-blue-50 px-1.5 py-0.5 rounded-sm">{user?.email}</code>{' '}
          (role: {user?.role}).
        </p>
      </div>
    </main>
  );
}
