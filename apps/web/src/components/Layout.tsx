import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { useSession } from '../lib/auth';
import { ErrorBoundary } from './ErrorBoundary';
import { fullName } from '../lib/format';
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

export function Layout({ title, nav }: { title: string; nav: NavItem[] }) {
  const session = useSession();
  const location = useLocation();
  const { me, can, isLoading, error } = useMe();
  if (isLoading) return <div className="p-6"><Spinner /></div>;
  if (error) return <div className="p-6"><ErrorBanner error={error} /></div>;

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
        <div className="flex items-center gap-2">
          <span className="hidden text-sm text-slate-500 sm:inline">
            {me ? fullName(me.profile) : ''} {me && me.type === 'employee' ? `· ${me.role}` : me?.role === 'org_admin' ? '· organization admin' : ''}
          </span>
          <Button size="sm" variant="secondary" onClick={() => void session.signOut()}>
            Sign out
          </Button>
        </div>
      </header>
      <ErrorBoundary key={location.pathname}>
        <Outlet />
      </ErrorBoundary>
    </div>
  );
}

/** Wraps a page with the usual width and padding. */
export function Page({ children }: { children: React.ReactNode }) {
  return <main className="mx-auto max-w-6xl px-4 py-6">{children}</main>;
}
