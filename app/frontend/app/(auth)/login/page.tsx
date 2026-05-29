import type { Metadata } from 'next';
import { LoginForm } from '../../../components/auth/LoginForm';

export const metadata: Metadata = {
  title: 'Sign in — PR Solution Intelligence',
};

export default function LoginPage() {
  return (
    <main className="min-h-screen flex items-center justify-center
                     bg-gradient-to-br from-win-blue-900 via-win-blue-700 to-win-teal
                     relative overflow-hidden">
      {/* Acrylic card */}
      <div className="relative z-10 w-[420px] max-w-[90vw] p-10
                      bg-white/80 backdrop-blur-2xl border border-white/30
                      rounded-2xl shadow-win-64">
        <div className="flex items-center gap-3 mb-2">
          <div className="w-11 h-11 bg-win-blue-500 rounded-md shadow-win-4 flex items-center justify-center">
            <svg viewBox="0 0 24 24" className="w-6 h-6 text-white" fill="currentColor">
              <path d="M3 3h8v8H3zM13 3h8v8h-8zM3 13h8v8H3zM13 13h8v8h-8z" />
            </svg>
          </div>
          <div className="text-xl font-bold tracking-tight text-text-primary">
            PR Solution Intelligence
          </div>
        </div>
        <p className="text-sm text-text-secondary mb-8">
          Sign in to access your agentic workspace
        </p>
        <LoginForm />
      </div>
    </main>
  );
}
