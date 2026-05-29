'use client';
import { useEffect, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { useAuthStore, useHasAuthHydrated } from '../../lib/auth-store';
import { apiFetch, ApiError } from '../../lib/api-client';

export function AuthGate({ children }: { children: ReactNode }) {
  const router = useRouter();
  const { user, accessToken, setAuth, clear } = useAuthStore();
  const hasHydrated = useHasAuthHydrated();
  const [ready, setReady] = useState(false);

  useEffect(() => {
    // Wait for zustand-persist to load from localStorage. Without this guard
    // a deep-link / hard-reload of /chat/:id sees the initial-state null token
    // and redirects to /login before the persisted session is restored.
    if (!hasHydrated) return;
    if (!accessToken) {
      router.replace('/login');
      return;
    }
    // Validate the access token by calling /me. If 401, the api-client tries
    // refresh once; if that also fails, store is cleared and we redirect.
    (async () => {
      try {
        const result = await apiFetch<{ user: typeof user }>('/api/v1/auth/me');
        if (result?.user) {
          setAuth(result.user, useAuthStore.getState().accessToken!, useAuthStore.getState().refreshToken!);
        }
        setReady(true);
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
          clear();
          router.replace('/login');
        } else {
          setReady(true); // network blip — let the page show; api calls will retry
        }
      }
    })();
  }, [hasHydrated, accessToken, router, setAuth, clear]);

  if (!hasHydrated || !user || !ready) {
    return <div className="min-h-screen flex items-center justify-center text-text-secondary">Loading…</div>;
  }
  return <>{children}</>;
}
