import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useParams } from 'react-router-dom';
import { BrandMark } from '../../components/BrandMark';
import { ThemeToggle } from '../../components/HeaderControls';
import { SiteLink, SiteModules } from '../../components/site/Modules';
import { SiteTheme } from '../../components/site/Theme';
import { Spinner } from '../../components/ui';
import { ApiError } from '../../lib/api';
import { assetUrl, pagePath, siteGet, type SitePage, type SitePageSummary, type SiteSettings } from '../../lib/site';

interface SiteInfo {
  business_name: string | null;
  settings: SiteSettings | null;
  pages: SitePageSummary[];
}

const useSite = () => useQuery({ queryKey: ['site'], queryFn: () => siteGet<SiteInfo>(''), staleTime: 60_000 });

/** The public website at the root of the app: header (pages, links, customer login), page, footer; in the site's own look. */
export function SiteLayout() {
  const site = useSite();
  const location = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);
  useEffect(() => setMenuOpen(false), [location.pathname, location.hash]);
  const name = site.data?.business_name ?? '';
  const s = site.data?.settings;
  const header = site.data?.pages.filter((p) => p.show_in_header) ?? [];
  const links = s?.header_links ?? [];
  const footer = site.data?.pages.filter((p) => p.show_in_footer) ?? [];
  const showLogin = s?.show_customer_login ?? true;
  const button = s?.header_button_label && s.header_button_url ? { label: s.header_button_label, url: s.header_button_url } : null;
  const navClass = ({ isActive }: { isActive: boolean }) =>
    `rounded-full px-3 py-1.5 text-sm font-medium ${isActive ? 'text-brand-700 dark:text-brand-600' : 'text-slate-600 hover:text-brand-700 dark:text-slate-300 dark:hover:text-brand-600'}`;
  const linkClass = navClass({ isActive: false });
  const nav = (
    <>
      {header.map((p) => (
        <NavLink key={p.slug} to={pagePath(p)} end className={navClass}>
          {p.title}
        </NavLink>
      ))}
      {links.map((l, i) => (
        <SiteLink key={i} href={l.url} className={linkClass}>
          {l.label}
        </SiteLink>
      ))}
    </>
  );

  return (
    <SiteTheme settings={s} className="flex min-h-dvh flex-col">
      <header className="sticky top-0 z-10 bg-white/90 backdrop-blur dark:bg-slate-950/90">
        <div aria-hidden="true" className="nav-accent" />
        <div className="mx-auto flex h-16 max-w-6xl items-center gap-2 px-4 sm:gap-4">
          <Link to="/" className="flex min-w-0 items-center gap-2">
            {s?.logo_asset_id ? <img src={assetUrl(s.logo_asset_id)} alt="" className="size-8 shrink-0 rounded-lg object-contain" /> : <BrandMark className="size-8 shrink-0" />}
            <span className="flex min-w-0 flex-col leading-tight">
              <span className="truncate text-lg font-semibold tracking-tight">{name}</span>
              {s?.tagline && <span className="truncate text-xs text-slate-500 dark:text-slate-400">{s.tagline}</span>}
            </span>
          </Link>
          <nav aria-label="Site" className="ml-auto hidden items-center gap-1 lg:flex">
            {nav}
          </nav>
          <div className="ml-auto flex shrink-0 items-center gap-1 sm:gap-2 lg:ml-0">
            <ThemeToggle />
            {showLogin && (
              <Link
                to="/portal"
                className={
                  button
                    ? 'hidden rounded-full px-3 py-2 text-sm font-medium text-slate-600 hover:text-brand-700 sm:inline dark:text-slate-300 dark:hover:text-brand-600'
                    : 'press btn-gradient whitespace-nowrap rounded-full px-4 py-2 text-sm font-semibold shadow-sm'
                }
              >
                {button ? (
                  'Log in'
                ) : (
                  <>
                    <span className="sm:hidden">Log in</span>
                    <span className="hidden sm:inline">Customer login</span>
                  </>
                )}
              </Link>
            )}
            {button && (
              <SiteLink href={button.url} className="press btn-gradient whitespace-nowrap rounded-full px-4 py-2 text-sm font-semibold shadow-sm">
                {button.label}
              </SiteLink>
            )}
            {(header.length > 0 || links.length > 0 || (button && showLogin)) && (
              <button
                type="button"
                className="press rounded-full p-2 text-slate-600 hover:bg-slate-100 lg:hidden dark:text-slate-300 dark:hover:bg-slate-800"
                aria-expanded={menuOpen}
                aria-controls="site-menu"
                aria-label="Menu"
                onClick={() => setMenuOpen((o) => !o)}
              >
                <svg viewBox="0 0 20 20" className="size-5" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" aria-hidden="true">
                  {menuOpen ? <path d="M5 5l10 10M15 5L5 15" /> : <path d="M3 6h14M3 10h14M3 14h14" />}
                </svg>
              </button>
            )}
          </div>
        </div>
        {menuOpen && (
          <nav id="site-menu" aria-label="Site" className="grid border-t border-slate-200 px-4 py-2 lg:hidden dark:border-slate-800">
            {nav}
            {button && showLogin && (
              <Link to="/portal" className={`${linkClass} sm:hidden`}>
                Customer login
              </Link>
            )}
          </nav>
        )}
      </header>

      <div className="flex-1">
        <Outlet />
      </div>

      <footer className="border-t border-slate-200 dark:border-slate-800">
        <div className="mx-auto flex max-w-6xl flex-col gap-4 px-4 py-8 text-sm text-slate-500 sm:flex-row sm:items-center sm:justify-between">
          <nav aria-label="Footer" className="flex flex-wrap gap-x-5 gap-y-2">
            {footer.map((p) => (
              <Link key={p.slug} to={pagePath(p)} className="hover:text-brand-700 dark:hover:text-brand-600">
                {p.title}
              </Link>
            ))}
          </nav>
          <p className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <span>
              © {new Date().getFullYear()} {name}
            </span>
            <Link to="/staff" className="hover:text-brand-700 dark:hover:text-brand-600">
              Staff sign-in
            </Link>
          </p>
        </div>
      </footer>
    </SiteTheme>
  );
}

/** One published page: the home page at "/", others at "/:slug". */
export function SitePageView({ home }: { home?: boolean }) {
  const { slug } = useParams();
  const { hash } = useLocation();
  const site = useSite();
  const page = useQuery({
    queryKey: ['site', 'page', home ? '' : slug],
    queryFn: () => siteGet<SitePage>(home ? '/home' : `/pages/${encodeURIComponent(slug ?? '')}`),
    retry: (count, err) => !(err instanceof ApiError && err.status === 404) && count < 2,
  });
  const name = site.data?.business_name;

  useEffect(() => {
    if (!page.data) return;
    document.title = page.data.is_home ? (name ?? page.data.title) : [page.data.title, name].filter(Boolean).join(' · ');
    let meta = document.querySelector<HTMLMetaElement>('meta[name="description"]');
    if (!meta) {
      meta = document.createElement('meta');
      meta.name = 'description';
      document.head.append(meta);
    }
    meta.content = page.data.description ?? '';
  }, [page.data, name]);

  // A new page starts at the top, or at its #section; a #section link on the same page scrolls there.
  useEffect(() => {
    if (!page.data) return;
    const target = hash.length > 1 ? document.getElementById(decodeURIComponent(hash.slice(1))) : null;
    if (target) target.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    else window.scrollTo(0, 0);
  }, [page.data, hash]);

  if (page.isLoading) return <div className="p-10"><Spinner /></div>;
  if (page.error || !page.data) {
    const missing = page.error instanceof ApiError && page.error.status === 404;
    return (
      <main className="mx-auto max-w-2xl px-4 py-20 text-center">
        <h1 className="text-3xl font-semibold tracking-tight">{missing ? 'Page not found' : 'Something went wrong'}</h1>
        <p className="mt-3 text-slate-500">{missing ? 'The page you are looking for is not here.' : 'Please try again in a moment.'}</p>
        <Link to="/" className="press btn-gradient mt-6 inline-flex rounded-full px-4 py-2 text-sm font-semibold">
          Go to the home page
        </Link>
      </main>
    );
  }
  return (
    <main>
      <SiteModules modules={page.data.modules} />
    </main>
  );
}
