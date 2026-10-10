import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { NavLink, Outlet, matchPath, useLocation } from 'react-router-dom';
import { useSession, type Audience } from '../lib/auth';
import { ErrorBoundary } from './ErrorBoundary';
import { ThemeToggle, UserMenu } from './HeaderControls';
import { useMe } from '../lib/me';
import { Button, ErrorBanner, Spinner } from './ui';

export interface NavLinkItem {
  to: string;
  label: string;
  end?: boolean;
  /** Only shown when the principal has this permission. */
  can?: [string, string];
  /** Only shown for this role. */
  role?: string;
}

/** A dropdown of links; shown when at least one of them is. */
export interface NavGroup {
  label: string;
  items: NavLinkItem[];
}

export type NavItem = NavLinkItem | NavGroup;

const navClass = (active: boolean) =>
  `whitespace-nowrap rounded-lg px-3 py-1.5 text-sm ${
    active ? 'bg-brand-50 font-medium text-brand-700 dark:bg-slate-800 dark:text-brand-100' : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-900'
  }`;

/**
 * Dropdown in the main nav. The nav scrolls sideways on narrow screens, which would clip an
 * absolutely positioned menu, so the menu is fixed under the button instead.
 */
function NavMenu({ group }: { group: NavGroup }) {
  const location = useLocation();
  const [open, setOpen] = useState<{ top: number; left: number } | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const active = group.items.some((i) => matchPath({ path: i.to, end: !!i.end }, location.pathname));

  useEffect(() => setOpen(null), [location.pathname]);
  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent && e.key !== 'Escape') return;
      if (e instanceof PointerEvent && (button.current?.contains(e.target as Node) || menu.current?.contains(e.target as Node))) return;
      setOpen(null);
    };
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', close);
    window.addEventListener('resize', close);
    window.addEventListener('scroll', close, true);
    return () => {
      document.removeEventListener('pointerdown', close);
      document.removeEventListener('keydown', close);
      window.removeEventListener('resize', close);
      window.removeEventListener('scroll', close, true);
    };
  }, [open]);

  const toggle = () => {
    if (open) return setOpen(null);
    const r = button.current!.getBoundingClientRect();
    setOpen({ top: r.bottom + 4, left: Math.max(8, Math.min(r.left, window.innerWidth - 216)) });
  };
  return (
    <>
      <button ref={button} type="button" aria-haspopup="menu" aria-expanded={!!open} onClick={toggle} className={`${navClass(active)} inline-flex items-center gap-1`}>
        {group.label}
        <svg viewBox="0 0 20 20" className="size-4" fill="currentColor" aria-hidden>
          <path d="M5.5 7.5 10 12l4.5-4.5" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <div
          ref={menu}
          role="menu"
          style={{ top: open.top, left: open.left }}
          className="fixed z-40 w-52 rounded-xl border border-slate-200 bg-white p-1 shadow-lg dark:border-slate-800 dark:bg-slate-900"
        >
          {group.items.map((i) => (
            <NavLink
              key={i.to}
              to={i.to}
              end={i.end}
              role="menuitem"
              className={({ isActive }) =>
                `block rounded-md px-3 py-2 text-sm ${isActive ? 'bg-brand-50 font-medium text-brand-700 dark:bg-slate-800 dark:text-brand-100' : 'hover:bg-slate-100 dark:hover:bg-slate-800'}`
              }
            >
              {i.label}
            </NavLink>
          ))}
        </div>
      )}
    </>
  );
}

// Loaded after the page itself, so the markdown renderer stays out of the first bundle.
const AssistantDock = lazy(() => import('./chat/AssistantDock').then((m) => ({ default: m.AssistantDock })));

export function Layout({
  title,
  nav,
  base,
  assistant,
}: {
  title: string;
  nav: NavItem[];
  /** Section root, e.g. /staff: the user menu links to `${base}/profile`. */
  base: string;
  assistant?: { audience: Audience; path: string };
}) {
  const session = useSession();
  const location = useLocation();
  const { me, can, isLoading, error } = useMe();
  if (isLoading) return <div className="p-6"><Spinner /></div>;
  if (error) {
    // e.g. a new sign-up waiting for staff review (403 account_in_review): let them sign out.
    return (
      <div className="mx-auto max-w-lg space-y-3 p-6">
        <ErrorBanner error={error} />
        <Button size="sm" variant="secondary" onClick={() => void session.signOut()}>Sign out</Button>
      </div>
    );
  }

  return (
    <div className="min-h-dvh">
      <header className="sticky top-0 z-10 flex h-16 items-center gap-4 border-b border-slate-200 bg-white/90 px-4 backdrop-blur dark:border-slate-800 dark:bg-slate-950/90">
        <div className="flex items-center gap-2">
          <img src="/favicon.svg" alt="" className="size-7" />
          <span className="font-semibold">{title}</span>
        </div>
        <nav aria-label="Main" className="flex flex-1 gap-1 overflow-x-auto">
          {nav.map((n) => {
            const shown = (i: NavLinkItem) => (!i.can || can(i.can[0], i.can[1])) && (!i.role || i.role === me?.role);
            if ('items' in n) {
              const items = n.items.filter(shown);
              return items.length ? <NavMenu key={n.label} group={{ ...n, items }} /> : null;
            }
            if (!shown(n)) return null;
            return (
              <NavLink key={n.to} to={n.to} end={n.end} className={({ isActive }) => navClass(isActive)}>
                {n.label}
              </NavLink>
            );
          })}
        </nav>
        <div className="flex items-center gap-1">
          <ThemeToggle />
          {me && <UserMenu me={me} base={base} />}
        </div>
      </header>
      <div className={assistant && location.pathname !== assistant.path ? 'pb-20' : undefined}>
        <ErrorBoundary key={location.pathname}>
          <Outlet />
        </ErrorBoundary>
      </div>
      {assistant && (
        // Stays mounted across pages (the conversation carries on); hidden on the Assistant page itself.
        <Suspense fallback={null}>
          <AssistantDock audience={assistant.audience} fullView={assistant.path} hidden={location.pathname === assistant.path} />
        </Suspense>
      )}
    </div>
  );
}

/** Wraps a page with the usual width and padding. */
export function Page({ children }: { children: React.ReactNode }) {
  return <main className="mx-auto max-w-6xl px-4 py-6">{children}</main>;
}
