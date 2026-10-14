import { ChevronsLeft, ChevronsRight, Menu, type LucideIcon } from 'lucide-react';
import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom';
import { useSession, type Audience } from '../lib/auth';
import { useBusy } from '../lib/loading';
import { ErrorBoundary } from './ErrorBoundary';
import { ThemeToggle, UserMenu } from './HeaderControls';
import { TeamDrawer } from './team/TeamDrawer';
import { useMe } from '../lib/me';
import { BrandMark } from './BrandMark';
import { Button, ErrorBanner, Spinner } from './ui';

export interface NavLinkItem {
  to: string;
  label: string;
  end?: boolean;
  /** Shown in the side menu (always) and when it is collapsed (alone). */
  icon?: LucideIcon;
  /** Only shown when the principal has this permission. */
  can?: [string, string];
  /** Only shown for this role. */
  role?: string;
  /** Only shown while the assistant is on (Admin › AI). */
  assistant?: true;
  /** Only shown while the store is open (Settings › Store). */
  store?: true;
}

export type NavItem = NavLinkItem;

/** A group in the side menu (less frequent pages), with an optional heading. */
export interface SideSection {
  label?: string;
  items: NavLinkItem[];
}

const navClass = (active: boolean) =>
  `press whitespace-nowrap rounded-lg px-3 py-2 text-[15px] ${
    active
      ? 'font-semibold text-slate-900 bg-slate-100 dark:bg-slate-800 dark:text-white'
      : 'font-medium text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white'
  }`;

const COLLAPSED_KEY = 'joybot.sidebar.collapsed';

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSED_KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * The side menu: sections of icon links. On wide screens it sits beside the page and collapses to
 * icons only (remembered); on narrow ones it opens over the page from the header's menu button.
 */
function SideMenu({
  main,
  sections,
  collapsed,
  onToggle,
  open,
  onClose,
  bottomGap,
}: {
  /** The top bar's links, repeated in the menu on narrow screens (the top bar has no room for them). */
  main: NavLinkItem[];
  sections: SideSection[];
  collapsed: boolean;
  onToggle: () => void;
  open: boolean;
  onClose: () => void;
  bottomGap: boolean;
}) {
  const location = useLocation();
  useEffect(() => onClose(), [location.pathname]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!open) return;
    const close = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', close);
    return () => document.removeEventListener('keydown', close);
  }, [open, onClose]);
  const narrow = collapsed && !open;
  return (
    <>
      {open && <div className="fixed inset-0 z-20 bg-slate-900/30 lg:hidden" onClick={onClose} aria-hidden="true" />}
      <aside
        aria-label="More pages"
        className={`fixed top-16 bottom-0 left-0 z-20 flex flex-col border-r border-slate-200 bg-white transition-[width,transform] duration-200 dark:border-slate-800 dark:bg-slate-950 lg:sticky lg:z-0 lg:h-[calc(100dvh-4rem)] lg:translate-x-0 ${
          open ? 'w-64 translate-x-0 shadow-xl lg:shadow-none' : '-translate-x-full'
        } ${narrow ? 'lg:w-[4.25rem]' : 'lg:w-60'}`}
      >
        <nav className={`flex-1 overflow-y-auto px-3 pt-6 ${bottomGap ? 'pb-24' : 'pb-4'}`}>
          <ul className="mb-6 grid gap-0.5 sm:hidden">
            {main.map((i) => (
              <li key={i.to}>
                <NavLink
                  to={i.to}
                  end={i.end}
                  className={({ isActive }) =>
                    `press block rounded-lg px-3 py-2.5 text-[15px] ${isActive ? 'bg-slate-100 font-semibold text-slate-900 dark:bg-slate-800 dark:text-white' : 'font-medium text-slate-600 dark:text-slate-300'}`
                  }
                >
                  {i.label}
                </NavLink>
              </li>
            ))}
          </ul>
          {sections.map((section, n) => (
            <div key={section.label ?? n} className="mb-6">
              {section.label && (
                <p className={`mb-2 px-3 text-xs font-medium tracking-[0.08em] text-slate-400 uppercase ${narrow ? 'lg:sr-only' : ''}`}>{section.label}</p>
              )}
              <ul className="grid gap-0.5">
                {section.items.map((i) => {
                  const Icon = i.icon;
                  return (
                    <li key={i.to}>
                      <NavLink
                        to={i.to}
                        end={i.end}
                        title={narrow ? i.label : undefined}
                        className={({ isActive }) =>
                          `press flex items-center gap-3 rounded-lg px-3 py-2.5 text-[15px] ${narrow ? 'lg:justify-center lg:px-0' : ''} ${
                            isActive
                              ? 'bg-brand-50 font-semibold text-brand-700 dark:bg-slate-800 dark:text-brand-100'
                              : 'font-medium text-slate-600 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-300 dark:hover:bg-slate-900 dark:hover:text-white'
                          }`
                        }
                      >
                        {Icon && <Icon className="size-[1.15rem] shrink-0" aria-hidden="true" />}
                        <span className={narrow ? 'lg:sr-only' : ''}>{i.label}</span>
                      </NavLink>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </nav>
        <button
          type="button"
          onClick={onToggle}
          aria-label={collapsed ? 'Expand the side menu' : 'Collapse the side menu'}
          title={collapsed ? 'Expand' : 'Collapse'}
          className={`press absolute right-0 hidden size-7 translate-x-1/2 place-items-center rounded-full border border-slate-200 bg-white text-slate-500 shadow-sm hover:text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300 lg:grid ${bottomGap ? 'bottom-24' : 'bottom-6'}`}
        >
          {collapsed ? <ChevronsRight className="size-4" aria-hidden="true" /> : <ChevronsLeft className="size-4" aria-hidden="true" />}
        </button>
      </aside>
    </>
  );
}

// Loaded after the page itself, so the markdown renderer stays out of the first bundle.
const AssistantDock = lazy(() => import('./chat/AssistantDock').then((m) => ({ default: m.AssistantDock })));

export function Layout({
  title,
  nav,
  sidebar,
  base,
  assistant,
}: {
  title: string;
  /** The top bar's links: the pages used most. */
  nav: NavItem[];
  /** The side menu (staff console). */
  sidebar?: SideSection[];
  /** Section root, e.g. /staff: the user menu links to `${base}/profile`. */
  base: string;
  assistant?: { audience: Audience; path: string };
}) {
  const session = useSession();
  const location = useLocation();
  const { me, can, isLoading, error } = useMe();
  const busy = useBusy();
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [menuOpen, setMenuOpen] = useState(false);
  const closeMenu = useCallback(() => setMenuOpen(false), []);
  // Admin › AI can turn the assistant off: no dock and no Assistant page.
  const dock = me?.assistant !== false ? assistant : undefined;
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

  const shown = (i: NavLinkItem) => (!i.can || can(i.can[0], i.can[1])) && (!i.role || i.role === me?.role) && (!i.assistant || me?.assistant !== false) && (!i.store || me?.store === true);
  const sections = (sidebar ?? []).map((s) => ({ ...s, items: s.items.filter(shown) })).filter((s) => s.items.length > 0);
  const toggleCollapsed = () =>
    setCollapsed((c) => {
      try {
        localStorage.setItem(COLLAPSED_KEY, c ? '0' : '1');
      } catch {
        // private mode: not remembered
      }
      return !c;
    });
  const dockGap = Boolean(dock && location.pathname !== dock.path);

  return (
    <div className="min-h-dvh">
      <header className="sticky top-0 z-30 flex h-16 items-center gap-6 border-b border-slate-200 bg-white/95 px-4 backdrop-blur sm:px-6 dark:border-slate-800 dark:bg-slate-950/95">
        {/* The logo-coloured accent under the header doubles as the loading indicator. */}
        <div aria-hidden="true" className={`nav-accent${busy ? ' is-loading' : ''}`} />
        {sections.length > 0 && (
          <button
            type="button"
            onClick={() => setMenuOpen((o) => !o)}
            aria-label="Open the side menu"
            aria-expanded={menuOpen}
            className="press -mr-3 grid size-9 place-items-center rounded-lg text-slate-600 hover:bg-slate-100 lg:hidden dark:text-slate-300 dark:hover:bg-slate-800"
          >
            <Menu className="size-5" aria-hidden="true" />
          </button>
        )}
        <Link to={base} className="flex shrink-0 items-center rounded-md" aria-label={`${title} home`} title={title}>
          <BrandMark className="size-8" />
        </Link>
        <nav aria-label="Main" className={`flex-1 gap-1 overflow-x-auto [scrollbar-width:none] ${sections.length ? 'hidden sm:flex' : 'flex'}`}>
          {nav.filter(shown).map((n) => (
            <NavLink key={n.to} to={n.to} end={n.end} className={({ isActive }) => navClass(isActive)}>
              {n.label}
            </NavLink>
          ))}
        </nav>
        <div className={`flex items-center gap-1 ${sections.length ? 'ml-auto sm:ml-0' : ''}`}>
          <ThemeToggle />
          {me && (me.type === 'employee' ? <TeamDrawer me={me} base={base} /> : <UserMenu me={me} base={base} />)}
        </div>
      </header>
      <div className="flex">
        {sections.length > 0 && (
          <SideMenu main={nav.filter(shown)} sections={sections} collapsed={collapsed} onToggle={toggleCollapsed} open={menuOpen} onClose={closeMenu} bottomGap={dockGap} />
        )}
        <div className={`min-w-0 flex-1 ${dockGap ? 'pb-20' : ''}`} aria-busy={busy}>
          <ErrorBoundary key={location.pathname}>
            <Outlet />
          </ErrorBoundary>
        </div>
      </div>
      {dock && (
        // Stays mounted across pages (the conversation carries on); hidden on the Assistant page itself.
        <Suspense fallback={null}>
          <AssistantDock audience={dock.audience} fullView={dock.path} hidden={location.pathname === dock.path} />
        </Suspense>
      )}
    </div>
  );
}

/** Wraps a page with the usual width and padding. */
export function Page({ children }: { children: React.ReactNode }) {
  return <main className="mx-auto max-w-6xl px-4 py-8 sm:px-8 lg:py-10">{children}</main>;
}
