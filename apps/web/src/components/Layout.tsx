import { ChevronsLeft, ChevronsRight, Menu, Sparkles, type LucideIcon } from 'lucide-react';
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

/** A group in the side menu, with an optional heading. */
export interface SideSection {
  label?: string;
  items: NavLinkItem[];
}

const COLLAPSED_KEY = 'joybot.sidebar.collapsed';

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSED_KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * The staff side menu: the brand, then sections of icon links on dark ink (in both themes). On wide
 * screens it sits beside the page, full height, and collapses to icons only (remembered); on narrow
 * ones it opens over the page from the top bar's menu button.
 */
function SideMenu({
  title,
  base,
  sections,
  collapsed,
  onToggle,
  open,
  onClose,
}: {
  title: string;
  base: string;
  sections: SideSection[];
  collapsed: boolean;
  onToggle: () => void;
  open: boolean;
  onClose: () => void;
}) {
  const location = useLocation();
  useEffect(() => onClose(), [location.pathname]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!open) return;
    const close = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', close);
    return () => document.removeEventListener('keydown', close);
  }, [open, onClose]);
  // Collapsed applies on wide screens only; the overlay on narrow screens always shows labels.
  const narrow = collapsed && !open;
  const hide = narrow ? 'lg:sr-only' : '';
  return (
    <>
      {open && <div className="fixed inset-0 z-30 bg-slate-950/40 lg:hidden" onClick={onClose} aria-hidden="true" />}
      <aside
        aria-label="Pages"
        className={`fixed inset-y-0 left-0 z-40 flex w-64 flex-col bg-[var(--ink)] text-[var(--ink-text)] dark:border-r dark:border-white/[0.06] transition-[width,transform] duration-200 lg:sticky lg:top-0 lg:z-0 lg:h-dvh lg:translate-x-0 ${
          open ? 'translate-x-0 shadow-2xl' : '-translate-x-full'
        } ${narrow ? 'lg:w-[4.5rem]' : 'lg:w-60'}`}
      >
        <Link
          to={base}
          className={`mx-3 mt-4 mb-2 flex items-center gap-2.5 rounded-lg px-2 py-1.5 ${narrow ? 'lg:justify-center lg:px-0' : ''}`}
          aria-label={`${title} home`}
        >
          <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-white/[0.06]">
            <BrandMark className="size-6" onDark />
          </span>
          <span className={`flex min-w-0 flex-col leading-tight ${hide}`}>
            <span className="text-[15px] font-bold tracking-tight text-white">{title}</span>
            <span className="text-xs text-[var(--ink-muted)]">Staff console</span>
          </span>
        </Link>
        <nav className="flex-1 overflow-y-auto px-3 pt-3 pb-4 [scrollbar-color:#2a303a_transparent] [scrollbar-width:thin]">
          {sections.map((section, n) => (
            <div key={section.label ?? n} className="mb-5">
              {section.label && (
                <p className={`mb-1.5 px-2.5 text-[11px] font-semibold tracking-[0.08em] text-[var(--ink-muted)] uppercase ${hide}`}>{section.label}</p>
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
                          `press group flex items-center gap-3 rounded-lg px-2.5 py-2 text-sm font-medium ${narrow ? 'lg:justify-center lg:px-0' : ''} ${
                            isActive ? 'bg-[var(--ink-raised)] text-white' : 'hover:bg-[var(--ink-hover)] hover:text-white'
                          }`
                        }
                      >
                        {({ isActive }) => (
                          <>
                            {Icon && <Icon className={`size-[1.1rem] shrink-0 ${isActive ? 'text-[var(--ink-accent)]' : ''}`} aria-hidden="true" />}
                            <span className={hide}>{i.label}</span>
                          </>
                        )}
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
          className={`press mx-3 mb-4 hidden items-center gap-3 rounded-lg px-2.5 py-2 text-sm font-medium hover:bg-[var(--ink-hover)] hover:text-white lg:flex ${narrow ? 'lg:justify-center lg:px-0' : ''}`}
        >
          {collapsed ? <ChevronsRight className="size-4" aria-hidden="true" /> : <ChevronsLeft className="size-4" aria-hidden="true" />}
          <span className={hide}>Collapse</span>
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
  /**
   * The main pages. With a `sidebar` (staff console) they head the side menu as "Workspace";
   * without one (customer portal) they are the tabs in the top bar.
   */
  nav: NavItem[];
  /** The rest of the side menu (staff console). */
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
  // The app's colors apply while the console or portal is shown (on <html>, so portalled menus match).
  useEffect(() => {
    const root = document.documentElement;
    root.classList.add('app-theme');
    return () => root.classList.remove('app-theme');
  }, []);
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
  // No model configured (Settings › AI): the assistant searches records, so it is called Search.
  const searchOnly = me?.assistant_mode === 'search';
  const relabel = (i: NavLinkItem) => (i.assistant && searchOnly ? { ...i, label: 'Search' } : i);
  const visible = (items: NavLinkItem[]) => items.filter(shown).map(relabel);
  const staffShell = Boolean(sidebar?.length);
  const sections = staffShell
    ? [{ label: 'Workspace', items: nav }, ...(sidebar ?? [])].map((s) => ({ ...s, items: visible(s.items) })).filter((s) => s.items.length > 0)
    : [];
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
  const controls = (
    <div className="flex items-center gap-1">
      <ThemeToggle />
      {me && (me.type === 'employee' ? <TeamDrawer me={me} base={base} /> : <UserMenu me={me} base={base} />)}
    </div>
  );
  const content = (
    <div className={`min-w-0 flex-1 ${dockGap ? 'pb-20' : ''}`} aria-busy={busy}>
      <ErrorBoundary key={location.pathname}>
        <Outlet />
      </ErrorBoundary>
    </div>
  );
  const assistantDock = dock && (
    // Stays mounted across pages (the conversation carries on); hidden on the Assistant page itself.
    <Suspense fallback={null}>
      <AssistantDock audience={dock.audience} fullView={dock.path} hidden={location.pathname === dock.path} />
    </Suspense>
  );

  if (staffShell) {
    return (
      // --side-w: the side menu's width on wide screens, so the assistant dock starts beside it.
      <div className="min-h-dvh lg:flex" style={{ '--side-w': collapsed ? '4.5rem' : '15rem' } as React.CSSProperties}>
        <SideMenu title={title} base={base} sections={sections} collapsed={collapsed} onToggle={toggleCollapsed} open={menuOpen} onClose={closeMenu} />
        <div className="flex min-w-0 flex-1 flex-col">
          <header className="sticky top-0 z-20 flex h-16 items-center gap-3 border-b border-slate-200 bg-white/95 px-4 backdrop-blur sm:px-8 dark:border-slate-800 dark:bg-slate-950/95">
            {/* The accent under the top bar doubles as the loading indicator. */}
            <div aria-hidden="true" className={`nav-accent${busy ? ' is-loading' : ''}`} />
            <button
              type="button"
              onClick={() => setMenuOpen((o) => !o)}
              aria-label="Open the menu"
              aria-expanded={menuOpen}
              className="press -ml-1 grid size-10 place-items-center rounded-lg text-slate-600 hover:bg-slate-100 lg:hidden dark:text-slate-300 dark:hover:bg-slate-800"
            >
              <Menu className="size-5" aria-hidden="true" />
            </button>
            <Link to={base} className="flex items-center gap-2 lg:hidden" aria-label={`${title} home`}>
              <BrandMark className="size-7" />
            </Link>
            <div className="flex-1" />
            {dock && (
              <Link
                to={dock.path}
                className="press hidden min-h-10 items-center gap-2 rounded-lg border border-slate-300 bg-white px-3.5 text-sm font-semibold text-slate-900 shadow-xs hover:bg-slate-50 sm:inline-flex dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 dark:hover:bg-slate-800"
              >
                <Sparkles className="size-4 text-brand-600" aria-hidden="true" />
                {searchOnly ? 'Search' : `Ask ${title}`}
              </Link>
            )}
            {controls}
          </header>
          {content}
        </div>
        {assistantDock}
      </div>
    );
  }

  return (
    <div className="min-h-dvh">
      <header className="sticky top-0 z-30 border-b border-slate-200 bg-white/95 backdrop-blur dark:border-slate-800 dark:bg-slate-950/95">
        <div aria-hidden="true" className={`nav-accent${busy ? ' is-loading' : ''}`} />
        <div className="mx-auto flex h-16 max-w-6xl items-center gap-6 px-4 sm:px-8">
          <Link to={base} className="flex shrink-0 items-center gap-2.5 rounded-md" aria-label={`${title} home`} title={title}>
            <BrandMark className="size-8" />
            <span className="hidden text-base font-bold tracking-tight md:inline">{title}</span>
          </Link>
          <nav aria-label="Main" className="flex h-full flex-1 gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {visible(nav).map((n) => (
              <NavLink
                key={n.to}
                to={n.to}
                end={n.end}
                className={({ isActive }) =>
                  `inline-flex items-center whitespace-nowrap px-3 text-sm transition-colors ${
                    isActive
                      ? 'font-semibold text-slate-900 shadow-[inset_0_-2px_0_var(--color-brand-600)] dark:text-white'
                      : 'font-medium text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white'
                  }`
                }
              >
                {n.label}
              </NavLink>
            ))}
          </nav>
          {controls}
        </div>
      </header>
      <div className="flex">{content}</div>
      {assistantDock}
    </div>
  );
}

/** Wraps a page with the usual width and padding. */
export function Page({ children }: { children: React.ReactNode }) {
  return <main className="mx-auto max-w-6xl px-4 py-7 sm:px-8 lg:py-8">{children}</main>;
}
