import { AuthGate } from '../../components/auth/AuthGate';
import { Sidebar } from '../../components/layout/Sidebar';
import type { ReactNode } from 'react';

export default function AuthedLayout({ children }: { children: ReactNode }) {
  return (
    <AuthGate>
      <div className="flex h-screen">
        <Sidebar />
        <div className="flex-1 flex flex-col overflow-hidden">{children}</div>
      </div>
    </AuthGate>
  );
}
