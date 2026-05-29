'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

const TABS = [
  { slug: 'data-sources', label: 'Data Sources' },
  { slug: 'mcp',          label: 'MCP' },
  { slug: 'model',        label: 'Model' },
  { slug: 'skills',       label: 'Skills' },
  { slug: 'agents',       label: 'Agents' },
] as const;

export function SettingsTabs() {
  const pathname = usePathname();
  return (
    <nav className="flex gap-1 border-b border-border-default px-6 bg-white">
      {TABS.map((t) => {
        const active = pathname === `/settings/${t.slug}`;
        return (
          <Link
            key={t.slug}
            href={`/settings/${t.slug}`}
            className={`px-4 py-2.5 text-sm font-medium border-b-2 -mb-px transition
              ${active
                ? 'border-win-blue-500 text-win-blue-600'
                : 'border-transparent text-text-secondary hover:text-text-primary hover:border-border-default'}`}
          >
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}
