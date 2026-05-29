'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useAuthStore } from '../../lib/auth-store';
import { listChats, type ChatSummary } from '../../lib/chats';
import { apiFetch } from '../../lib/api-client';

export function Sidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const user = useAuthStore((s) => s.user);
  const clear = useAuthStore((s) => s.clear);
  const [chats, setChats] = useState<ChatSummary[]>([]);

  useEffect(() => {
    listChats().then(setChats).catch(() => setChats([]));
  }, [pathname]);

  async function handleLogout(): Promise<void> {
    try { await apiFetch('/api/v1/auth/session', { method: 'DELETE' }); } catch {}
    clear();
    router.replace('/login');
  }

  const initials = (user?.displayName ?? user?.email ?? 'U')
    .split(' ').map((s) => s[0]).join('').slice(0, 2).toUpperCase();

  return (
    <aside className="w-[272px] min-w-[272px] bg-surface-sidebar border-r border-border-default
                      flex flex-col h-screen">
      <div className="px-3.5 pt-3.5 pb-1.5 flex items-center gap-2.5">
        <div className="w-[30px] h-[30px] bg-win-blue-500 rounded-sm flex items-center justify-center">
          <svg viewBox="0 0 24 24" className="w-4 h-4 text-white" fill="currentColor">
            <path d="M3 3h8v8H3zM13 3h8v8h-8zM3 13h8v8H3zM13 13h8v8h-8z" />
          </svg>
        </div>
        <div className="text-[0.92rem] font-bold tracking-tight">PR Solutions</div>
      </div>

      <Link
        href="/"
        className="mx-2.5 mt-1.5 px-3.5 py-2.5 bg-win-blue-500 text-white rounded-md
                   text-sm font-semibold flex items-center gap-2 hover:bg-win-blue-600 transition"
      >
        + New Chat
      </Link>

      <nav className="px-2.5 py-2">
        <SidebarLink href="/" label="Home" active={pathname === '/'} />
        <SidebarLink
          href="/settings/data-sources"
          label="Settings"
          active={pathname?.startsWith('/settings/') ?? false}
        />
      </nav>

      <div className="px-2 pt-2 pb-1 text-[0.7rem] font-semibold uppercase tracking-wider text-text-tertiary">
        Recent Chats
      </div>
      <div className="flex-1 overflow-y-auto px-2.5 pb-2">
        {chats.length === 0 && (
          <div className="text-xs text-text-tertiary px-2 py-1">No chats yet</div>
        )}
        {chats.map((c) => (
          <Link
            key={c.id}
            href={`/chat/${c.id}`}
            className={`block px-2.5 py-2 rounded-md text-[0.82rem] truncate
                        ${pathname === `/chat/${c.id}` ? 'bg-win-blue-50 text-win-blue-600 font-medium' : 'text-text-secondary hover:bg-surface-hover hover:text-text-primary'}
                        transition`}
          >
            {c.title ?? 'Untitled chat'}
          </Link>
        ))}
      </div>

      <button
        onClick={handleLogout}
        className="px-3.5 py-2.5 border-t border-border-default flex items-center gap-2.5
                   hover:bg-surface-hover transition text-left"
      >
        <div className="w-8 h-8 rounded-full bg-gradient-to-br from-win-blue-500 to-win-teal
                        text-white text-[0.78rem] font-bold flex items-center justify-center">
          {initials}
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-[0.82rem] font-semibold truncate">{user?.displayName}</div>
          <div className="text-[0.7rem] text-text-tertiary truncate">Sign out</div>
        </div>
      </button>
    </aside>
  );
}

function SidebarLink({ href, label, active, disabled }: { href: string; label: string; active: boolean; disabled?: boolean }) {
  const cls = `flex items-center gap-2.5 px-2.5 py-2 rounded-md text-sm transition w-full text-left
               ${active ? 'bg-win-blue-50 text-win-blue-500 font-semibold' : 'text-text-secondary hover:bg-surface-hover hover:text-text-primary'}
               ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`;
  if (disabled) return <div className={cls}>{label}</div>;
  return <Link href={href} className={cls}>{label}</Link>;
}
