'use client';
import { useAuthStore } from './auth-store';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export async function apiFetch<T = unknown>(
  path: string,
  init: RequestInit = {},
  options: { retryOn401?: boolean } = { retryOn401: true },
): Promise<T> {
  const { accessToken } = useAuthStore.getState();
  const url = path.startsWith('http') ? path : `${API_URL}${path}`;
  const headers = new Headers(init.headers);
  if (!headers.has('content-type') && init.body) {
    headers.set('content-type', 'application/json');
  }
  if (accessToken) headers.set('authorization', `Bearer ${accessToken}`);

  const res = await fetch(url, { ...init, headers });

  if (res.status === 401 && options.retryOn401) {
    const refreshed = await tryRefresh();
    if (refreshed) {
      return apiFetch<T>(path, init, { retryOn401: false });
    }
    useAuthStore.getState().clear();
  }

  const body = res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text();
  if (!res.ok) {
    const message = typeof body === 'object' && body && 'error' in body ? String(body.error) : `HTTP ${res.status}`;
    throw new ApiError(res.status, message);
  }
  return (typeof body === 'object' && body && 'data' in body ? body.data : body) as T;
}

async function tryRefresh(): Promise<boolean> {
  const { refreshToken, setTokens } = useAuthStore.getState();
  if (!refreshToken) return false;
  const res = await fetch(`${API_URL}/api/v1/auth/refresh`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ refreshToken }),
  });
  if (!res.ok) return false;
  const body = await res.json();
  if (!body.success) return false;
  setTokens(body.data.accessToken, body.data.refreshToken);
  return true;
}
