import { useQuery } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Page } from '../../components/Layout';
import { Card, EmptyState, ErrorBanner, PageHeader, Select, Spinner } from '../../components/ui';
import { useApi } from '../../lib/api';

interface Totals {
  views: number;
  visitors: number;
}

export interface AnalyticsReport {
  days: number;
  today: string;
  totals: Totals;
  previous: Totals;
  daily: (Totals & { day: string })[];
  pages: { path: string; views: number }[];
  sources: { source: string; visits: number }[];
  devices: { device: 'desktop' | 'mobile' | 'tablet'; visitors: number }[];
  countries: { country: string; visitors: number }[];
}

export interface AnalyticsSummary {
  today: Totals;
  week: Totals;
}

const number = (n: number) => new Intl.NumberFormat().format(n);
const DEVICE_LABEL = { desktop: 'Desktop', mobile: 'Phone', tablet: 'Tablet' } as const;

function countryName(code: string) {
  if (!code) return 'Unknown';
  try {
    return new Intl.DisplayNames(undefined, { type: 'region' }).of(code) ?? code;
  } catch {
    return code;
  }
}

/** "Mon 13 Oct" for a YYYY-MM-DD day (a local date, not UTC midnight). */
function dayLabel(day: string, options: Intl.DateTimeFormatOptions = { weekday: 'short', day: 'numeric', month: 'short' }) {
  const [y, m, d] = day.split('-').map(Number);
  return new Intl.DateTimeFormat(undefined, options).format(new Date(y, m - 1, d));
}

/**
 * Website › Analytics: visits to the public site, counted by the API without cookies or a third party
 * (so ad blockers don't hide them), kept only as daily totals.
 */
export function AnalyticsPage() {
  const api = useApi();
  const [days, setDays] = useState('30');
  const q = useQuery({
    queryKey: ['website', 'analytics', days],
    queryFn: () => api.get<AnalyticsReport>(`/website/analytics?days=${days}`),
    refetchInterval: 60_000,
  });
  const r = q.data;

  return (
    <Page>
      <PageHeader
        title="Analytics"
        description="Visits to your public website. No cookies, and no one is identified: visitors are told apart for a day only."
        actions={
          <Select aria-label="Period" value={days} onChange={(e) => setDays(e.target.value)}>
            <option value="7">Last 7 days</option>
            <option value="30">Last 30 days</option>
            <option value="90">Last 90 days</option>
            <option value="365">Last 12 months</option>
          </Select>
        }
      />
      {q.isLoading ? (
        <Spinner />
      ) : q.error ? (
        <ErrorBanner error={q.error} />
      ) : r ? (
        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-3">
            <StatBox label="Visitors" value={r.totals.visitors} previous={r.previous.visitors} hint="Different people each day" />
            <StatBox label="Page views" value={r.totals.views} previous={r.previous.views} />
            <StatBox
              label="Pages per visitor"
              value={r.totals.visitors ? Math.round((r.totals.views / r.totals.visitors) * 10) / 10 : 0}
              previous={r.previous.visitors ? Math.round((r.previous.views / r.previous.visitors) * 10) / 10 : 0}
            />
          </div>
          <Card title="Visitors by day">
            <DailyChart daily={r.daily} />
          </Card>
          <div className="grid gap-4 lg:grid-cols-2">
            <Card title="Top pages">
              <BarList rows={r.pages.map((p) => ({ key: p.path, label: <span className="font-mono text-xs">{p.path}</span>, value: p.views }))} unit="views" empty="No page views yet." />
            </Card>
            <Card title="Sources">
              <BarList rows={r.sources.map((s) => ({ key: s.source, label: s.source, value: s.visits }))} unit="visits" empty="No visits from other sites or campaigns yet." />
              <p className="mt-3 text-xs text-slate-500">
                Other sites that linked here, and campaigns tagged <code>?utm_source=</code>. Visits typed in or from bookmarks aren't listed.
              </p>
            </Card>
            <Card title="Devices">
              <BarList rows={r.devices.map((d) => ({ key: d.device, label: DEVICE_LABEL[d.device], value: d.visitors }))} unit="visitors" empty="No visitors yet." />
            </Card>
            <Card title="Countries">
              <BarList rows={r.countries.map((c) => ({ key: c.country || '-', label: countryName(c.country), value: c.visitors }))} unit="visitors" empty="No visitors yet." />
            </Card>
          </div>
          <p className="text-xs text-slate-500">Updated every minute. Days are in the business time zone (Settings › General).</p>
        </div>
      ) : null}
    </Page>
  );
}

function change(value: number, previous: number) {
  if (!previous) return null;
  return Math.round(((value - previous) / previous) * 100);
}

function StatBox({ label, value, previous, hint, to }: { label: string; value: number; previous?: number; hint?: string; to?: string }) {
  const pct = previous === undefined ? null : change(value, previous);
  const body = (
    <>
      <p className="text-sm font-medium text-slate-500 dark:text-slate-400">{label}</p>
      <p className="mt-1 flex items-baseline gap-2">
        <span className="text-3xl font-semibold tracking-tight tabular-nums">{number(value)}</span>
        {pct !== null && (
          <span className={`text-sm font-medium ${pct >= 0 ? 'text-emerald-700 dark:text-emerald-400' : 'text-red-700 dark:text-red-400'}`} title="Compared with the period before">
            {pct >= 0 ? '↑' : '↓'} {Math.abs(pct)}%
          </span>
        )}
      </p>
      {hint && <p className="mt-1 text-xs text-slate-500">{hint}</p>}
    </>
  );
  const box = 'block rounded-2xl border border-slate-200/80 bg-white px-6 py-5 dark:border-slate-800 dark:bg-slate-900';
  return to ? (
    <Link to={to} className={`${box} press hover:border-brand-300 dark:hover:border-brand-700`}>
      {body}
    </Link>
  ) : (
    <section className={box}>{body}</section>
  );
}

/** One bar per day: visitors, with page views in the tooltip. */
function DailyChart({ daily }: { daily: AnalyticsReport['daily'] }) {
  const max = Math.max(1, ...daily.map((d) => d.visitors));
  if (!daily.some((d) => d.views)) return <EmptyState>No visits in this period yet.</EmptyState>;
  const step = Math.ceil(daily.length / 8);
  return (
    <div>
      <div className="flex h-48 items-end gap-px" role="img" aria-label="Visitors by day">
        {daily.map((d) => (
          <div key={d.day} className="group relative flex h-full flex-1 items-end" title={`${dayLabel(d.day)}: ${number(d.visitors)} visitors, ${number(d.views)} views`}>
            <div className="w-full rounded-t-sm bg-brand-500/80 group-hover:bg-brand-600 dark:bg-brand-600/80" style={{ height: `${(d.visitors / max) * 100}%`, minHeight: d.visitors ? 2 : 0 }} />
          </div>
        ))}
      </div>
      {/* A few dates under their bars (centred on them, so they may be wider than a bar). */}
      <div className="relative mt-2 h-4 text-xs text-slate-500">
        {daily.map((d, i) =>
          (daily.length - 1 - i) % step === 0 ? (
            <span key={d.day} className="absolute -translate-x-1/2 whitespace-nowrap" style={{ left: `${((i + 0.5) / daily.length) * 100}%` }}>
              {dayLabel(d.day, { day: 'numeric', month: 'short' })}
            </span>
          ) : null,
        )}
      </div>
    </div>
  );
}

function BarList({ rows, unit, empty }: { rows: { key: string; label: ReactNode; value: number }[]; unit: string; empty: string }) {
  if (!rows.length) return <EmptyState>{empty}</EmptyState>;
  const max = Math.max(...rows.map((r) => r.value));
  return (
    <ul className="space-y-1.5 text-sm" aria-label={unit}>
      {rows.map((r) => (
        <li key={r.key} className="relative flex items-center justify-between gap-3 overflow-hidden rounded-md px-2 py-1.5">
          <span aria-hidden="true" className="absolute inset-y-0 left-0 rounded-md bg-brand-100/70 dark:bg-slate-800" style={{ width: `${(r.value / max) * 100}%` }} />
          <span className="relative min-w-0 truncate">{r.label}</span>
          <span className="relative tabular-nums text-slate-600 dark:text-slate-300">{number(r.value)}</span>
        </li>
      ))}
    </ul>
  );
}

/** Dashboard boxes: website visitors today and this week, linking to Analytics. */
export function SiteVisitsSummary() {
  const api = useApi();
  const q = useQuery({
    queryKey: ['website', 'analytics', 'summary'],
    queryFn: () => api.get<AnalyticsSummary>('/website/analytics/summary'),
    refetchInterval: 60_000,
  });
  if (q.error) return <ErrorBanner error={q.error} />;
  const s = q.data;
  const views = (t?: Totals) => (t ? `${number(t.views)} page ${t.views === 1 ? 'view' : 'views'}` : ' ');
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <StatBox label="Website visitors today" value={s?.today.visitors ?? 0} hint={views(s?.today)} to="/staff/analytics" />
      <StatBox label="Website visitors this week" value={s?.week.visitors ?? 0} hint={views(s?.week)} to="/staff/analytics" />
    </div>
  );
}
