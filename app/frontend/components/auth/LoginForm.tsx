'use client';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useAuthStore } from '../../lib/auth-store';
import { apiFetch, ApiError } from '../../lib/api-client';

const LoginSchema = z.object({
  email: z.string().email('Enter a valid email'),
  password: z.string().min(1, 'Password required'),
});
type LoginValues = z.infer<typeof LoginSchema>;

interface LoginResponse {
  user: { id: string; email: string; displayName: string; role: 'admin' | 'analyst' | 'viewer' };
  accessToken: string;
  refreshToken: string;
}

export function LoginForm() {
  const router = useRouter();
  const setAuth = useAuthStore((s) => s.setAuth);
  const [submitting, setSubmitting] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const { register, handleSubmit, formState: { errors } } = useForm<LoginValues>({
    resolver: zodResolver(LoginSchema),
    defaultValues: { email: '', password: '' },
  });

  async function onSubmit(values: LoginValues): Promise<void> {
    setSubmitting(true);
    setServerError(null);
    try {
      const result = await apiFetch<LoginResponse>('/api/v1/auth/login', {
        method: 'POST',
        body: JSON.stringify(values),
      });
      setAuth(result.user, result.accessToken, result.refreshToken);
      router.push('/');
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        setServerError('Invalid email or password.');
      } else {
        setServerError('Something went wrong. Please try again.');
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
      <div>
        <label htmlFor="email" className="block text-sm font-medium text-text-primary mb-1">
          Email
        </label>
        <input
          id="email"
          type="email"
          autoComplete="email"
          {...register('email')}
          className="w-full px-3.5 py-2.5 text-sm border border-border-default rounded-md
                     bg-surface-card text-text-primary outline-none
                     focus:border-win-blue-500 focus:ring-2 focus:ring-win-blue-500/15
                     transition"
        />
        {errors.email && <p className="text-win-red text-xs mt-1">{errors.email.message}</p>}
      </div>

      <div>
        <label htmlFor="password" className="block text-sm font-medium text-text-primary mb-1">
          Password
        </label>
        <input
          id="password"
          type="password"
          autoComplete="current-password"
          {...register('password')}
          className="w-full px-3.5 py-2.5 text-sm border border-border-default rounded-md
                     bg-surface-card text-text-primary outline-none
                     focus:border-win-blue-500 focus:ring-2 focus:ring-win-blue-500/15
                     transition"
        />
        {errors.password && <p className="text-win-red text-xs mt-1">{errors.password.message}</p>}
      </div>

      {serverError && (
        <div role="alert" className="text-win-red text-sm bg-red-50 border border-red-200 rounded-md px-3 py-2">
          {serverError}
        </div>
      )}

      <button
        type="submit"
        disabled={submitting}
        className="w-full py-3 text-sm font-semibold rounded-md
                   bg-win-blue-500 text-white shadow-win-4
                   hover:bg-win-blue-600 active:bg-win-blue-700
                   disabled:opacity-50 disabled:cursor-not-allowed
                   transition"
      >
        {submitting ? 'Signing in…' : 'Sign In'}
      </button>
    </form>
  );
}
