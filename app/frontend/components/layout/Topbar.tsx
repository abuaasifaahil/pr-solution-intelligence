'use client';
import type { ReactNode } from 'react';

export function Topbar({ title, badge, right }: { title: string; badge?: string; right?: ReactNode }) {
  return (
    <header className="h-12 px-5 flex items-center justify-between bg-surface-card border-b border-border-subtle">
      <div className="flex items-center gap-2.5">
        <h2 className="text-[0.95rem] font-semibold">{title}</h2>
        {badge && (
          <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[0.72rem] font-semibold
                           bg-win-blue-50 text-win-blue-600">
            <span className="w-1.5 h-1.5 rounded-full bg-win-green" />
            {badge}
          </span>
        )}
      </div>
      {right}
    </header>
  );
}
