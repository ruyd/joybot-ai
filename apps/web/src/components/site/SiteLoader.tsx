import { useEffect, useState } from 'react';

/** What the loader shows before the site's setup arrives: remembered from the last visit (this browser). */
interface Brand {
  name: string;
  logo: string | null;
  accent: string;
}

const KEY = 'joybot.site.brand';

export function rememberBrand(brand: Brand) {
  try {
    localStorage.setItem(KEY, JSON.stringify(brand));
  } catch {
    // storage unavailable: the next visit shows the plain loader
  }
}

function rememberedBrand(): Brand | null {
  try {
    const b = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Brand | null;
    return b && typeof b.name === 'string' && /^#[0-9a-f]{6}$/i.test(b.accent) ? b : null;
  } catch {
    return null;
  }
}

/**
 * The public site while its content loads. On the free-tier deploy the API sleeps when idle and takes
 * up to a minute to wake, so after a few seconds the loader says so instead of leaving a blank page.
 * It shows the site's logo and color from the last visit, if this browser has one.
 */
export function SiteLoader() {
  const [brand] = useState(rememberedBrand);
  // A logo served by the sleeping API (no CDN) can't load yet: show the dot instead.
  const [logoFailed, setLogoFailed] = useState(false);
  const [waited, setWaited] = useState(0);
  useEffect(() => {
    const started = Date.now();
    const timer = setInterval(() => setWaited(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(timer);
  }, []);
  const accent = brand?.accent ?? '#0878ab';

  return (
    <div className="grid min-h-dvh place-items-center bg-white px-6 dark:bg-slate-950">
      <div role="status" aria-live="polite" className="site-loader flex flex-col items-center gap-6 text-center">
        <div className="relative grid size-24 place-items-center">
          <span
            aria-hidden="true"
            className="site-loader-ring absolute inset-0 rounded-full"
            style={{ background: `conic-gradient(from 0deg, transparent 0 25%, ${accent} 100%)` }}
          />
          <span aria-hidden="true" className="absolute inset-[5px] rounded-full bg-white dark:bg-slate-950" />
          {brand?.logo && !logoFailed ? (
            <img src={brand.logo} alt="" onError={() => setLogoFailed(true)} className="site-loader-pulse relative size-14 rounded-2xl object-contain" />
          ) : (
            <span aria-hidden="true" className="site-loader-pulse relative size-3 rounded-full" style={{ background: accent }} />
          )}
        </div>
        <div className="min-h-[3.5rem] text-sm text-slate-500 dark:text-slate-400">
          <p className="font-medium text-slate-700 dark:text-slate-200">{brand?.name ? `Loading ${brand.name}…` : 'Loading…'}</p>
          {waited >= 4 && <p className="mt-1">Just a moment, the site is waking up.</p>}
          {waited >= 15 && <p className="mt-1">This can take up to a minute after a quiet spell.</p>}
        </div>
      </div>
    </div>
  );
}

/** A smaller spinner for a page inside the site (the header is already there). */
export function PageLoader() {
  return (
    <div role="status" className="grid min-h-[50dvh] place-items-center">
      <span aria-hidden="true" className="site-loader-ring size-10 rounded-full" style={{ background: 'conic-gradient(from 0deg, transparent 0 25%, var(--site-accent, #0878ab) 100%)', mask: 'radial-gradient(farthest-side, transparent calc(100% - 4px), #000 calc(100% - 3px))' }} />
      <span className="sr-only">Loading…</span>
    </div>
  );
}

/** After a minute and a half of trying: the API is down rather than asleep. */
export function SiteUnavailable({ onRetry, retrying }: { onRetry: () => void; retrying: boolean }) {
  return (
    <div className="grid min-h-dvh place-items-center bg-white px-6 dark:bg-slate-950">
      <div role="alert" className="max-w-sm text-center">
        <h1 className="text-xl font-semibold tracking-tight text-slate-900 dark:text-slate-100">The site isn't responding</h1>
        <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">It may be starting up or briefly down. Please try again in a moment.</p>
        <button
          type="button"
          onClick={onRetry}
          disabled={retrying}
          className="press mt-6 rounded-full bg-slate-900 px-5 py-2 text-sm font-semibold text-white disabled:opacity-60 dark:bg-white dark:text-slate-900"
        >
          {retrying ? 'Trying…' : 'Try again'}
        </button>
      </div>
    </div>
  );
}
