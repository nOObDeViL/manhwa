'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  Compass,
  Film,
  FileText,
  HardDrive,
  LayoutDashboard,
  LayoutGrid,
  LogOut,
  Menu,
  Mic,
  RefreshCw,
  Scissors,
  Settings as SettingsIcon,
  X,
} from 'lucide-react';
import { clearToken, getRequiredAccount, initAuth, isWrongAccount, restoreToken, signIn, signOut } from '@/lib/auth';
import { clearFolderCache, getAbout } from '@/lib/drive';
import { ensureRoot, openProject } from '@/lib/projects';
import { useSession, useSettings } from '@/lib/store';
import { cn, errorMessage } from '@/lib/utils';
import { Button, Spinner } from './ui';
import ProjectPicker from './ProjectPicker';

const NAV = [
  { href: '/', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/drive', label: 'Drive Files', icon: HardDrive },
  { href: '/discover', label: 'Discover', icon: Compass },
  { href: '/script', label: 'Script', icon: FileText },
  { href: '/slicer', label: 'Panel Slicer', icon: Scissors },
  { href: '/panels', label: 'Panels', icon: LayoutGrid },
  { href: '/voice', label: 'Voice', icon: Mic },
  { href: '/compose', label: 'Composer', icon: Film },
  { href: '/settings', label: 'Settings', icon: SettingsIcon },
];

export default function AppShell({ children }: { children: ReactNode }) {
  const [mounted, setMounted] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const pathname = usePathname();
  const token = useSession((s) => s.token);
  const clientId = useSettings((s) => s.googleClientId);
  const bootstrapping = useRef(false);

  useEffect(() => {
    restoreToken();
    setMounted(true);
  }, []);

  useEffect(() => {
    if (mounted) initAuth().catch(() => undefined);
  }, [mounted, clientId]);

  useEffect(() => setDrawer(false), [pathname]);

  // After sign-in: verify the account, fetch profile, ensure the Drive folder tree, reopen the last project.
  useEffect(() => {
    if (!token || bootstrapping.current || useSession.getState().rootId) return;
    bootstrapping.current = true;
    const { set, toast } = useSession.getState();
    (async () => {
      try {
        const about = await getAbout();
        if (isWrongAccount(about.user.emailAddress)) {
          signOut();
          toast(
            `Signed in as ${about.user.emailAddress}, but Drive storage is locked to ${getRequiredAccount()}. Sign in again and pick that account.`,
            'error',
          );
          return;
        }
        set({ user: about.user });
        const { rootId, projectsId } = await ensureRoot();
        set({ rootId, projectsId });
        const last = useSettings.getState().lastProjectId;
        if (last && !useSession.getState().project) {
          set({ projectLoading: true });
          try {
            set({ project: await openProject(last) });
          } catch {
            useSettings.getState().update({ lastProjectId: '' });
          } finally {
            set({ projectLoading: false });
          }
        }
      } catch (err) {
        toast(errorMessage(err), 'error');
      } finally {
        bootstrapping.current = false;
      }
    })();
  }, [token]);

  if (!mounted) {
    return (
      <div className="flex min-h-dvh items-center justify-center">
        <Spinner />
      </div>
    );
  }

  const nav = (
    <nav className="flex flex-col gap-0.5 p-3">
      {NAV.map(({ href, label, icon: Icon }) => {
        const active = href === '/' ? pathname === '/' : pathname.startsWith(href);
        return (
          <Link
            key={href}
            href={href}
            className={cn(
              'flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm transition-colors',
              active ? 'bg-violet-600/15 text-violet-200' : 'text-zinc-400 hover:bg-zinc-800/60 hover:text-zinc-100',
            )}
          >
            <Icon className={cn('size-4', active && 'text-violet-400')} />
            {label}
          </Link>
        );
      })}
    </nav>
  );

  const brand = (
    <Link href="/" className="flex items-center gap-2.5 px-5 py-4">
      <img src="/icon.svg" alt="" className="size-8 rounded-lg" />
      <div className="leading-tight">
        <div className="text-sm font-semibold text-white">Manhwa Recap</div>
        <div className="text-[11px] text-violet-300/80">Studio Cloud</div>
      </div>
    </Link>
  );

  return (
    <div className="min-h-dvh bg-[radial-gradient(ellipse_at_top_right,rgba(139,92,246,0.10),transparent_50%)]">
      {/* Desktop / landscape tablet sidebar */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-60 flex-col border-r border-zinc-800/80 bg-zinc-950/80 backdrop-blur lg:flex">
        {brand}
        <div className="min-h-0 flex-1 overflow-y-auto">{nav}</div>
        <div className="border-t border-zinc-800/80 p-3 text-[11px] text-zinc-500">All processing runs in your browser.</div>
      </aside>

      {/* Mobile / portrait tablet drawer */}
      {drawer && (
        <div className="fixed inset-0 z-40 lg:hidden" onClick={() => setDrawer(false)}>
          <div className="absolute inset-0 bg-black/60" />
          <aside className="absolute inset-y-0 left-0 flex w-72 flex-col border-r border-zinc-800 bg-zinc-950" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between pr-3">
              {brand}
              <button onClick={() => setDrawer(false)} className="rounded-lg p-2 text-zinc-400 hover:bg-zinc-800" aria-label="Close menu">
                <X className="size-5" />
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto">{nav}</div>
          </aside>
        </div>
      )}

      <div className="lg:pl-60">
        <TopBar onMenu={() => setDrawer(true)} />
        <main className="mx-auto w-full max-w-7xl px-3 pt-4 pb-16 sm:px-6 sm:pt-6">{children}</main>
      </div>
      <Toasts />
    </div>
  );
}

function TopBar({ onMenu }: { onMenu: () => void }) {
  const { token, expiresAt, user } = useSession();
  const [, force] = useState(0);
  const [busy, setBusy] = useState(false);

  // Re-render every 30s so the expiry state stays current.
  useEffect(() => {
    const t = setInterval(() => force((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);

  const expired = Boolean(token) && Date.now() >= expiresAt;

  const connect = useCallback(async () => {
    setBusy(true);
    try {
      await signIn();
    } catch (err) {
      useSession.getState().toast(errorMessage(err), 'error');
    } finally {
      setBusy(false);
    }
  }, []);

  const logout = () => {
    signOut();
    clearToken();
    clearFolderCache();
    useSettings.getState().update({ lastProjectId: '' });
  };

  return (
    <header className="sticky top-0 z-20 flex h-14 items-center gap-2 border-b border-zinc-800/80 bg-zinc-950/80 px-3 backdrop-blur sm:px-6">
      <button onClick={onMenu} className="rounded-lg p-2 text-zinc-300 hover:bg-zinc-800 lg:hidden" aria-label="Open menu">
        <Menu className="size-5" />
      </button>
      <div className="min-w-0 flex-1">{token && !expired && user ? <ProjectPicker /> : null}</div>

      {!token ? (
        <Button variant="primary" size="sm" onClick={connect} loading={busy}>
          Connect Google Drive
        </Button>
      ) : expired ? (
        <Button variant="primary" size="sm" icon={<RefreshCw className="size-3.5" />} onClick={connect} loading={busy}>
          Reconnect
        </Button>
      ) : (
        <div className="flex items-center gap-2">
          {user?.photoLink ? (
            <img src={user.photoLink} alt="" referrerPolicy="no-referrer" className="size-8 rounded-full border border-zinc-700" />
          ) : (
            <div className="flex size-8 items-center justify-center rounded-full bg-violet-600 text-xs font-semibold">
              {(user?.displayName || user?.emailAddress || '?').slice(0, 1).toUpperCase()}
            </div>
          )}
          <div className="hidden max-w-44 leading-tight md:block">
            <div className="truncate text-xs text-zinc-200">{user?.displayName}</div>
            <div className="truncate text-[11px] text-zinc-500">{user?.emailAddress}</div>
          </div>
          <button onClick={logout} className="rounded-lg p-2 text-zinc-400 hover:bg-zinc-800 hover:text-white" title="Sign out">
            <LogOut className="size-4" />
          </button>
        </div>
      )}
    </header>
  );
}

function Toasts() {
  const toasts = useSession((s) => s.toasts);
  const dismiss = useSession((s) => s.dismissToast);
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-0 z-[60] flex flex-col items-center gap-2 p-4 safe-bottom sm:items-end">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={cn(
            'pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-xl border px-4 py-3 text-sm shadow-2xl backdrop-blur',
            t.kind === 'error' && 'border-red-500/40 bg-red-950/90 text-red-100',
            t.kind === 'success' && 'border-emerald-500/40 bg-emerald-950/90 text-emerald-100',
            t.kind === 'info' && 'border-zinc-700 bg-zinc-900/95 text-zinc-100',
          )}
        >
          <div className="min-w-0 flex-1 break-words">{t.message}</div>
          <button onClick={() => dismiss(t.id)} className="text-current/60 hover:text-current" aria-label="Dismiss">
            <X className="size-4" />
          </button>
        </div>
      ))}
    </div>
  );
}
