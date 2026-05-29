'use client';
import { useEffect, useState } from 'react';
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

export interface AuthUser {
  id: string;
  email: string;
  displayName: string;
  role: 'admin' | 'analyst' | 'viewer';
}

interface AuthState {
  user: AuthUser | null;
  accessToken: string | null;
  refreshToken: string | null;
  setAuth: (user: AuthUser, accessToken: string, refreshToken: string) => void;
  setTokens: (accessToken: string, refreshToken: string) => void;
  clear: () => void;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      user: null,
      accessToken: null,
      refreshToken: null,
      setAuth: (user, accessToken, refreshToken) =>
        set({ user, accessToken, refreshToken }),
      setTokens: (accessToken, refreshToken) => set({ accessToken, refreshToken }),
      clear: () => set({ user: null, accessToken: null, refreshToken: null }),
    }),
    {
      name: 'prsi-auth',
      storage: createJSONStorage(() => localStorage),
    },
  ),
);

/**
 * Subscribe to zustand-persist hydration. Consumers (AuthGate) read
 * `useAuthStore.persist.hasHydrated()` synchronously for the initial state
 * and use this hook to re-render once hydration finishes. Without this gate,
 * a deep-link to /chat/:id sees the initial null token and bounces to /login.
 */
export function useHasAuthHydrated(): boolean {
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    // Already hydrated on mount? Reflect it immediately.
    if (useAuthStore.persist.hasHydrated()) {
      setHydrated(true);
    }
    const unsub = useAuthStore.persist.onFinishHydration(() => setHydrated(true));
    return unsub;
  }, []);
  return hydrated;
}
