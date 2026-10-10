import { lazy, Suspense } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { useSession, type Audience } from '../lib/auth';
import { ErrorBoundary } from './ErrorBoundary';
import { ThemeToggle, UserMenu } from './HeaderControls';
import { useMe } from '../lib/me';
import { Button, ErrorBanner, Spinner } from './ui';

export interface NavItem {
  to: string;
  label: string;
  end?: boolean;
  /** Only shown when the principal has this permission. */
  can?: [string, string];
  /** Only shown for this role. */
  role?: string;
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
          {nav
            .filter((n) => (!n.can || can(n.can[0], n.can[1])) && (!n.role || n.role === me?.role))
            .map((n) => (
              <NavLink
                key={n.to}
                to={n.to}
                end={n.end}
                className={({ isActive }) =>
                  `whitespace-nowrap rounded-lg px-3 py-1.5 text-sm ${
                    isActive ? 'bg-brand-50 font-medium text-brand-700 dark:bg-slate-800 dark:text-brand-100' : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-900'
                  }`
                }
              >
                {n.label}
              </NavLink>
            ))}
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
