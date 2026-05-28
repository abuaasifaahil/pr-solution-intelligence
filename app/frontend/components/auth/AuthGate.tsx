'use client';
import { useEffect, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { useAuthStore } from '../../lib/auth-store';
import { apiFetch, ApiError } from '../../lib/api-client';

export function AuthGate({ children }: { children: ReactNode }) {
  const router = useRouter();
  const { user, accessToken, setAuth, clear } = useAuthStore();
  const [ready, setReady] = useState(false);

  useEffect(() => {
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
  }, [accessToken, router, setAuth, clear]);

  if (!user || !ready) {
    return <div className="min-h-screen flex items-center justify-center text-text-secondary">Loading…</div>;
  }
  return <>{children}</>;
}
