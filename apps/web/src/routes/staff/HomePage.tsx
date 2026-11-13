import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { CalendarPlus, CreditCard, FileText, Search, Sparkles, type LucideIcon } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useAppointmentTypes } from '../../components/AppointmentTypes';
import { Page } from '../../components/Layout';
import { Badge, Button, Card, EmptyState, ErrorBanner, Field, Input, PageHeader, Select, Spinner, StatusBadge } from '../../components/ui';
import { ApiError, useApi } from '../../lib/api';
import { dateTime, fullName, money, preferredTimeZone, time, todayIn, zonedToIso } from '../../lib/format';
import { useMe } from '../../lib/me';
import type { Appointment } from '../portal/PortalPages';
import type { AnalyticsReport } from './AnalyticsPage';
import { CustomerPicker, type Customer } from './CustomerPicker';
import { RecordPayment } from './StaffPages';
import { PendingTodos } from './TodoPages';

/**
 * Staff dashboard: a greeting, summary numbers (appointments, tickets, money in, overdue invoices),
 * today's appointments and to-dos on the left; quick actions, Ask JoyBot and website visits on the right.
 * Each part shows only with the permission it needs.
 */
export function StaffHome() {
  const { can, me } = useMe();
  const api = useApi();
  const zone = preferredTimeZone(me?.profile.time_zone);
  const [mine, setMine] = useState(false);
  const today = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric', timeZone: zone }).format(new Date());
  const hour = Number(new Intl.DateTimeFormat('en-US', { hour: 'numeric', hourCycle: 'h23', timeZone: zone }).format(new Date()));
  const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  const name = me?.profile.first_name;

  const readsAppointments = can('read', 'appointments');
  const { from, to } = todayRange(zone);
  const appointments = useQuery({
    queryKey: ['appointments', 'today', from, mine],
    queryFn: () =>
      api.get<StaffAppointment[]>(`/appointments?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&limit=200${mine ? '&mine=true' : ''}`),
    refetchInterval: 60_000,
    enabled: readsAppointments,
  });
  const summary = useQuery({
    queryKey: ['dashboard'],
    queryFn: () => api.get<DashboardSummary>('/dashboard'),
    refetchInterval: 60_000,
    enabled: me?.type === 'employee',
  });

  return (
    <Page>
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-sm font-semibold text-slate-500 dark:text-slate-400">{today}</p>
          <h1 className="mt-1 text-[1.75rem] leading-tight font-bold tracking-tight">{name ? `${greeting}, ${name}` : greeting}</h1>
        </div>
        {readsAppointments && me?.type === 'employee' && (
          <div role="group" aria-label="Whose appointments" className="flex gap-1 rounded-lg bg-slate-200/70 p-1 dark:bg-slate-800">
            {[
              [false, 'Everyone'],
              [true, 'Only mine'],
            ].map(([value, label]) => (
              <button
                key={String(value)}
                type="button"
                aria-pressed={mine === value}
                onClick={() => setMine(value as boolean)}
                className={`press min-h-8 rounded-md px-3.5 text-sm font-semibold ${
                  mine === value ? 'bg-white text-slate-900 shadow-xs dark:bg-slate-950 dark:text-white' : 'text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white'
                }`}
              >
                {label as string}
              </button>
            ))}
          </div>
        )}
      </div>

      <SummaryTiles zone={zone} appointments={readsAppointments ? appointments.data : undefined} summary={summary.data} />
      {summary.error && <div className="mb-6"><ErrorBanner error={summary.error} /></div>}

      <div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="grid min-w-0 grid-cols-1 gap-5">
          {readsAppointments && <TodayAppointments zone={zone} mine={mine} query={appointments} />}
          {can('read', 'tasks') && <PendingTodos />}
        </div>
        <div className="grid min-w-0 grid-cols-1 gap-5">
          <QuickActions />
          {me?.assistant !== false && <AskJoyBot searchOnly={me?.assistant_mode === 'search'} />}
          {can('read', 'website') && <WebsiteWeek />}
        </div>
      </div>
    </Page>
  );
}

/** GET /api/dashboard: sections appear only with the matching permission. */
interface DashboardSummary {
  currency: string;
  tickets?: { open: number; pending: number; oldest_open_at: string | null };
  payments?: { collected_week: string; collected_last_week: string; pending_transfers: number };
  invoices?: { overdue_total: string; overdue_count: number; overdue_names: string[] };
}

type StaffAppointment = Appointment & {
  /** Null for sales calls (customer_name is the visitor). */
  customer_id: string | null;
  customer_name: string | null;
  customer_number: string | null;
  employee_id: string | null;
  scheduled_end: string | null;
  type_color?: string;
};

const INACTIVE = ['cancelled', 'no_show'];
const DONE = ['cancelled', 'no_show', 'completed'];

/** Today in the viewer's time zone, as an ISO range for `from`/`to`. */
function todayRange(zone: string) {
  const day = todayIn(zone);
  const [y, m, d] = day.split('-').map(Number);
  const next = new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
  return { from: zonedToIso(day, '00:00', zone), to: zonedToIso(next, '00:00', zone) };
}

/** Time of day without the zone name (the list header names the zone). */
function clock(iso: string, zone: string) {
  return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit', timeZone: zone }).format(new Date(iso));
}

/** "EDT (New York)": the zone's short name and city, for the list header. */
function zoneLabel(zone: string) {
  const abbr = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'short' }).formatToParts(new Date()).find((p) => p.type === 'timeZoneName')?.value;
  const city = zone.split('/').pop()?.replaceAll('_', ' ');
  return abbr && city && abbr !== city ? `${abbr} (${city})` : (abbr ?? zone);
}

/** "2 days ago", "3 hours ago". */
function ago(iso: string) {
  const minutes = (new Date(iso).getTime() - Date.now()) / 60_000;
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  if (minutes > -60) return rtf.format(Math.round(minutes), 'minute');
  if (minutes > -60 * 24) return rtf.format(Math.round(minutes / 60), 'hour');
  return rtf.format(Math.round(minutes / (60 * 24)), 'day');
}

/** The first upcoming appointment that is still on. */
function nextUp(list: StaffAppointment[] | undefined) {
  const now = Date.now();
  return list?.find((a) => new Date(a.scheduled_start).getTime() >= now && !DONE.includes(a.status));
}

const TONE = { good: 'text-brand-700 dark:text-brand-600', warn: 'text-amber-700 dark:text-amber-400', bad: 'text-red-700 dark:text-red-400', muted: 'text-slate-500 dark:text-slate-400' };

function StatTile({ label, value, trend, tone = 'muted', note, to }: { label: string; value: string; trend?: string; tone?: keyof typeof TONE; note: string; to: string }) {
  return (
    <Link
      to={to}
      className="press flex flex-col gap-2.5 rounded-xl border border-slate-200 bg-white px-5 py-4 shadow-xs hover:border-slate-300 dark:border-slate-800 dark:bg-slate-900 dark:hover:border-slate-700"
    >
      <span className="text-sm font-medium text-slate-500 dark:text-slate-400">{label}</span>
      <span className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
        <span className="text-[1.75rem] leading-none font-bold tracking-tight tabular-nums">{value}</span>
        {trend && <span className={`text-xs font-semibold ${TONE[tone]}`}>{trend}</span>}
      </span>
      <span className="truncate text-xs text-slate-500 dark:text-slate-400">{note}</span>
    </Link>
  );
}

function SummaryTiles({ zone, appointments, summary }: { zone: string; appointments?: StaffAppointment[]; summary?: DashboardSummary }) {
  const tiles: React.ReactNode[] = [];
  if (appointments) {
    const on = appointments.filter((a) => !INACTIVE.includes(a.status));
    const left = on.filter((a) => new Date(a.scheduled_start).getTime() >= Date.now() && !DONE.includes(a.status)).length;
    const next = nextUp(appointments);
    tiles.push(
      <StatTile
        key="appointments"
        label="Appointments today"
        value={String(on.length)}
        trend={on.length ? (left ? `${left} still to come` : 'all done for today') : undefined}
        tone={left ? 'good' : 'muted'}
        note={next ? `Next: ${next.customer_name ?? next.service_name} at ${clock(next.scheduled_start, zone)}` : 'Nothing else today'}
        to="/staff/calendar"
      />,
    );
  }
  const t = summary?.tickets;
  if (t) {
    tiles.push(
      <StatTile
        key="tickets"
        label="Open tickets"
        value={String(t.open + t.pending)}
        trend={t.open ? `${t.open} waiting on you` : t.pending ? 'all waiting on customers' : undefined}
        tone={t.open ? 'warn' : 'muted'}
        note={t.oldest_open_at ? `Oldest opened ${ago(t.oldest_open_at)}` : 'No open tickets'}
        to="/staff/tickets"
      />,
    );
  }
  const p = summary?.payments;
  if (p && summary) {
    const week = Number(p.collected_week);
    const last = Number(p.collected_last_week);
    const change = last > 0 ? Math.round(((week - last) / last) * 100) : null;
    tiles.push(
      <StatTile
        key="payments"
        label="Collected this week"
        value={money(p.collected_week, summary.currency)}
        trend={change === null ? undefined : `${change >= 0 ? '+' : ''}${change}% vs last week`}
        tone={change === null ? 'muted' : change >= 0 ? 'good' : 'bad'}
        note={p.pending_transfers ? `${p.pending_transfers} bank ${p.pending_transfers === 1 ? 'transfer' : 'transfers'} pending` : 'No bank transfers pending'}
        to="/staff/payments"
      />,
    );
  }
  const i = summary?.invoices;
  if (i && summary) {
    const names = i.overdue_names.length > 2 ? `${i.overdue_names.slice(0, 2).join(', ')} and ${i.overdue_names.length - 2} more` : i.overdue_names.join(', ');
    tiles.push(
      <StatTile
        key="invoices"
        label="Overdue invoices"
        value={money(i.overdue_total, summary.currency)}
        trend={i.overdue_count ? `${i.overdue_count} ${i.overdue_count === 1 ? 'invoice' : 'invoices'}` : undefined}
        tone={i.overdue_count ? 'bad' : 'muted'}
        note={i.overdue_count ? names || 'Customers you can’t see' : 'Nothing overdue'}
        to="/staff/invoices"
      />,
    );
  }
  if (!tiles.length) return null;
  return <div className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">{tiles}</div>;
}

function TodayAppointments({ zone, mine, query }: { zone: string; mine: boolean; query: UseQueryResult<StaffAppointment[]> }) {
  const { can } = useMe();
  const now = Date.now();
  const nextId = nextUp(query.data)?.id;

  return (
    <Card
      title={
        <span>
          Today's appointments
          <span className="mt-0.5 block text-xs font-normal text-slate-500 dark:text-slate-400">
            {query.data ? `${query.data.length} booked · ` : ''}times in {zoneLabel(zone)}
          </span>
        </span>
      }
      actions={
        <Link to="/staff/calendar" className="text-sm font-semibold text-brand-700 hover:underline dark:text-brand-600">
          Open calendar →
        </Link>
      }
    >
      {query.isLoading ? (
        <Spinner />
      ) : query.error ? (
        <ErrorBanner error={query.error} />
      ) : !query.data?.length ? (
        <EmptyState>{mine ? 'You have no appointments today.' : 'No appointments today.'}</EmptyState>
      ) : (
        <ol className="-mx-6 -my-2">
          {query.data.map((a) => {
            const over = new Date(a.scheduled_end ?? a.scheduled_start).getTime() < now;
            const inactive = INACTIVE.includes(a.status);
            const dim = over || inactive;
            return (
              <li key={a.id} className={`flex items-stretch gap-4 px-6 py-3 ${dim ? 'opacity-60' : ''}`}>
                <div className="w-20 shrink-0 self-center text-sm tabular-nums">
                  {/* In the viewer's zone so the list reads in order; the location's own time when it differs. */}
                  <span className="font-semibold">{clock(a.scheduled_start, zone)}</span>
                  {time(a.scheduled_start, a.time_zone) !== time(a.scheduled_start, zone) && (
                    <span className="block text-xs text-slate-500" title={`Local time at ${a.location_name}`}>
                      {time(a.scheduled_start, a.time_zone)} there
                    </span>
                  )}
                </div>
                <span
                  aria-hidden="true"
                  className="w-[3px] shrink-0 rounded-full bg-slate-300 dark:bg-slate-700"
                  style={!dim && a.type_color ? { backgroundColor: a.type_color } : undefined}
                />
                <div className="min-w-0 flex-1 self-center">
                  <div className="flex flex-wrap items-center gap-2">
                    {!a.customer_id && a.customer_name ? (
                      // A sales call: the visitor has no customer record; open the call (when allowed).
                      can('read', 'website') ? (
                        <Link to={`/staff/sales-calls?call=${a.id}`} className={`font-semibold hover:underline ${inactive ? 'line-through' : ''}`}>
                          {a.customer_name}
                        </Link>
                      ) : (
                        <span className={`font-semibold ${inactive ? 'line-through' : ''}`}>{a.customer_name}</span>
                      )
                    ) : a.customer_name || a.customer_number ? (
                      <Link to={`/staff/customers/${a.customer_id}`} className={`font-semibold hover:underline ${inactive ? 'line-through' : ''}`}>
                        {a.customer_name ?? a.customer_number}
                      </Link>
                    ) : (
                      <span className="font-semibold text-slate-500">Customer not visible to you</span>
                    )}
                    <StatusBadge status={a.status} />
                    {a.id === nextId && <Badge tone="brand">next</Badge>}
                  </div>
                  <p className="mt-0.5 truncate text-sm text-slate-500 dark:text-slate-400">
                    {[a.service_name, a.employee_name ?? 'Unassigned', a.location_name].filter(Boolean).join(' · ')}
                  </p>
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </Card>
  );
}

type Action = 'payment' | 'book' | 'lookup';

/** Shortcuts; the payment, booking and lookup forms open right below them. */
function QuickActions() {
  const { can } = useMe();
  const [open, setOpen] = useState<Action | null>(null);
  const items: { key: Action | 'invoice'; label: string; icon: LucideIcon; show: boolean }[] = [
    { key: 'payment', label: 'Take a payment', icon: CreditCard, show: can('create', 'payments') },
    { key: 'book', label: 'Book appointment', icon: CalendarPlus, show: can('create', 'appointments') },
    { key: 'invoice', label: 'New invoice', icon: FileText, show: can('create', 'payments') },
    { key: 'lookup', label: 'Find customer', icon: Search, show: can('read', 'customers') },
  ];
  const shown = items.filter((i) => i.show);
  if (!shown.length) return null;
  const tile =
    'press flex min-h-11 flex-col items-start gap-2 rounded-lg border p-3 text-left text-sm font-semibold transition-colors';
  return (
    <>
      <Card title="Quick actions">
        <div className="grid grid-cols-2 gap-2.5">
          {shown.map(({ key, label, icon: Icon }) => {
            const inner = (
              <>
                <span className="grid size-8 place-items-center rounded-lg bg-brand-50 text-brand-700 dark:bg-slate-800 dark:text-brand-600">
                  <Icon className="size-4" aria-hidden="true" />
                </span>
                {label}
              </>
            );
            if (key === 'invoice') {
              return (
                <Link key={key} to="/staff/invoices" className={`${tile} border-slate-200 hover:border-slate-300 dark:border-slate-800 dark:hover:border-slate-700`}>
                  {inner}
                </Link>
              );
            }
            const active = open === key;
            return (
              <button
                key={key}
                type="button"
                aria-expanded={active}
                onClick={() => setOpen(active ? null : key)}
                className={`${tile} ${active ? 'border-brand-600 bg-brand-50/60 dark:bg-slate-800' : 'border-slate-200 hover:border-slate-300 dark:border-slate-800 dark:hover:border-slate-700'}`}
              >
                {inner}
              </button>
            );
          })}
        </div>
      </Card>
      {open === 'payment' && <RecordPayment title="Take a payment" />}
      {open === 'book' && <BookAppointment />}
      {open === 'lookup' && <CustomerLookup />}
    </>
  );
}

const SUGGESTIONS = ['Who has unpaid invoices over 30 days?', 'Overdue bank transfers', 'My schedule this week'];

/** Starts a conversation on the Assistant page with a suggested question. */
function AskJoyBot({ searchOnly }: { searchOnly: boolean }) {
  return (
    <section className="rounded-xl bg-[var(--ink)] p-5 text-[var(--ink-text)]">
      <h2 className="flex items-center gap-2 text-[15px] font-semibold text-white">
        <Sparkles className="size-4 text-[var(--ink-accent)]" aria-hidden="true" />
        {searchOnly ? 'Search' : 'Ask JoyBot'}
      </h2>
      <p className="mt-1.5 text-sm leading-relaxed">{searchOnly ? 'Find records and saved answers. Try:' : 'Answers from your own records, with sources. Try:'}</p>
      <div className="mt-3 grid gap-2">
        {SUGGESTIONS.map((q) => (
          <Link
            key={q}
            to={`/staff/assistant?q=${encodeURIComponent(q)}`}
            className="press flex min-h-10 items-center rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 text-sm text-slate-100 hover:bg-white/[0.08]"
          >
            {q}
          </Link>
        ))}
      </div>
    </section>
  );
}

/** Website visitors per day over the last week. */
function WebsiteWeek() {
  const api = useApi();
  const q = useQuery({ queryKey: ['website', 'analytics', 7], queryFn: () => api.get<AnalyticsReport>('/website/analytics?days=7'), refetchInterval: 300_000 });
  const daily = q.data?.daily ?? [];
  const max = Math.max(1, ...daily.map((d) => d.visitors));
  const weekday = (day: string) => new Intl.DateTimeFormat(undefined, { weekday: 'short' }).format(new Date(`${day}T12:00:00`));
  return (
    <Card
      title="Website, last 7 days"
      actions={
        <Link to="/staff/analytics" className="text-sm font-semibold text-brand-700 hover:underline dark:text-brand-600">
          Analytics →
        </Link>
      }
    >
      {q.error ? (
        <ErrorBanner error={q.error} />
      ) : (
        <>
          <p className="mb-3 text-sm text-slate-500 dark:text-slate-400">
            <strong className="text-lg font-bold text-slate-900 tabular-nums dark:text-white">{(q.data?.totals.visitors ?? 0).toLocaleString()}</strong> visitors
          </p>
          <div className="flex h-20 items-end gap-1.5" role="img" aria-label={daily.map((d) => `${weekday(d.day)}: ${d.visitors}`).join(', ') || 'No visits yet'}>
            {daily.map((d, n) => (
              <div
                key={d.day}
                title={`${weekday(d.day)}: ${d.visitors} visitors`}
                className={`flex-1 rounded-t ${n === daily.length - 1 ? 'bg-brand-600' : 'bg-brand-200 dark:bg-brand-900'}`}
                style={{ height: `${Math.max(4, (d.visitors / max) * 100)}%` }}
              />
            ))}
          </div>
          {daily.length > 0 && (
            <div className="mt-1.5 flex justify-between text-[11px] text-slate-500">
              <span>{weekday(daily[0].day)}</span>
              <span>{weekday(daily[daily.length - 1].day)}</span>
            </div>
          )}
        </>
      )}
    </Card>
  );
}

function CustomerLookup() {
  const api = useApi();
  const [q, setQ] = useState('');
  const term = q.trim();
  const results = useQuery({
    queryKey: ['customer-lookup', term],
    enabled: term.length >= 2,
    queryFn: () => api.get<Customer[]>(`/customers?q=${encodeURIComponent(term)}&limit=8`),
  });
  return (
    <Card title="Customer lookup">
      <Input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name, email, phone or customer number" aria-label="Find a customer" />
      {term.length >= 2 && (
        <div className="mt-2">
          {results.isLoading ? (
            <Spinner />
          ) : results.error ? (
            <ErrorBanner error={results.error} />
          ) : !results.data?.length ? (
            <p className="text-sm text-slate-500">No customers found.</p>
          ) : (
            <>
              <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200 dark:divide-slate-800 dark:border-slate-800">
                {results.data.map((c) => (
                  <li key={c.id}>
                    <Link to={`/staff/customers/${c.id}`} className="block px-3 py-2 text-sm hover:bg-slate-50 dark:hover:bg-slate-900">
                      <span className="font-medium">{fullName(c)}</span>
                      {c.restricted && <span className="ml-2"><Badge tone="red">restricted</Badge></span>}
                      <span className="block truncate text-slate-500">{[c.customer_number, c.email ?? c.phone].filter(Boolean).join(' · ')}</span>
                    </Link>
                  </li>
                ))}
              </ul>
              {results.data.length === 8 && (
                <Link to={`/staff/customers?q=${encodeURIComponent(term)}`} className="mt-2 inline-block text-sm text-brand-600 hover:underline">
                  See all results
                </Link>
              )}
            </>
          )}
        </div>
      )}
    </Card>
  );
}

interface Service {
  id: string;
  name: string;
  duration_minutes: number | null;
  price: string;
  currency: string;
}

interface Location {
  id: string;
  name: string;
  time_zone: string;
}

interface Conflict {
  appointment_number: string;
  scheduled_start: string;
  scheduled_end: string;
}

/** Book an appointment; `customer` starts it for that customer (the customer page). */
export function BookAppointment({ customer: initialCustomer = null }: { customer?: Customer | null } = {}) {
  const api = useApi();
  const queryClient = useQueryClient();
  const { me } = useMe();
  const services = useQuery({ queryKey: ['services'], queryFn: () => api.get<Service[]>('/services') });
  const locations = useQuery({ queryKey: ['locations'], queryFn: () => api.get<Location[]>('/locations') });
  const [params] = useSearchParams();
  const cardRef = useRef<HTMLDivElement>(null);
  const [customer, setCustomer] = useState<Customer | null>(initialCustomer);
  // ?book=<service id>: from the assistant's "Book" button or a service in search results. Followed
  // while the dashboard is already open too, so the service is picked whenever the link changes.
  const bookParam = params.get('book');
  const [serviceId, setServiceId] = useState(bookParam ?? '');
  useEffect(() => {
    if (bookParam === null) return;
    if (bookParam) setServiceId(bookParam);
    cardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [bookParam]);
  const [locationId, setLocationId] = useState('');
  const [typeId, setTypeId] = useState('');
  const types = useAppointmentTypes();
  const bookableTypes = types.data?.filter((t) => !t.system) ?? [];
  const [employeeId, setEmployeeId] = useState('');
  const [day, setDay] = useState('');
  const [clock, setClock] = useState('');
  const [conflicts, setConflicts] = useState<Conflict[] | null>(null);
  /** Time off or outside working hours (the API's message). */
  const [unavailable, setUnavailable] = useState<string | null>(null);
  const [booked, setBooked] = useState<string | null>(null);
  const [round, setRound] = useState(0); // remounts the customer picker (clears its search) after a booking

  const location = locations.data?.find((l) => l.id === locationId);
  const service = services.data?.find((s) => s.id === serviceId);
  const staff = useQuery({
    queryKey: ['location-staff', locationId],
    enabled: !!locationId,
    queryFn: () => api.get<{ id: string; first_name: string; last_name: string }[]>(`/locations/${locationId}/staff`),
  });

  // One location: pick it. New location: default the date to today there, and the staff member to
  // the signed-in employee when they work there.
  useEffect(() => {
    if (!locationId && locations.data?.length === 1) setLocationId(locations.data[0].id);
  }, [locations.data, locationId]);
  useEffect(() => {
    if (location && !day) setDay(todayIn(location.time_zone));
  }, [location, day]);
  useEffect(() => {
    setEmployeeId(staff.data?.some((s) => s.id === me?.profile.id) ? me!.profile.id : '');
  }, [staff.data, me]);

  const book = useMutation({
    mutationFn: (confirm: boolean) =>
      api.post<{ appointment_number: string }>('/appointments', {
        customer_id: customer!.id,
        service_id: serviceId,
        location_id: locationId,
        type_id: typeId || undefined,
        employee_id: employeeId || null,
        scheduled_start: zonedToIso(day, clock, location!.time_zone),
        confirm_overlap: confirm || undefined,
      }),
    onSuccess: (res) => {
      setBooked(res.appointment_number);
      setConflicts(null);
      setUnavailable(null);
      setCustomer(initialCustomer); // on a customer's page, the next booking is for them too
      setRound((r) => r + 1);
      setClock('');
      void queryClient.invalidateQueries({ queryKey: ['appointments'] });
    },
    onError: (err) => {
      if (err instanceof ApiError && err.body.code === 'employee_double_booked') setConflicts(err.body.conflicts as Conflict[]);
      if (err instanceof ApiError && err.body.code === 'employee_unavailable') setUnavailable(err.message);
    },
  });

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    setBooked(null);
    setConflicts(null);
    setUnavailable(null);
    book.mutate(false);
  };
  const zone = location ? time(zonedToIso(day || todayIn(location.time_zone), clock || '12:00', location.time_zone), location.time_zone).split(' ').pop() : '';

  return (
    <div ref={cardRef} className="scroll-mt-20">
    <Card title="Book an appointment">
      <form onSubmit={onSubmit} className="grid gap-4">
        <Field label="Customer">
          <CustomerPicker key={round} value={customer} onChange={setCustomer} />
        </Field>
        <Field label="Type">
          <Select value={typeId || (bookableTypes.find((t) => t.key === 'service')?.id ?? '')} onChange={(e) => setTypeId(e.target.value)}>
            {bookableTypes.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Service">
          <Select required value={serviceId} onChange={(e) => setServiceId(e.target.value)}>
            <option value="">Choose a service</option>
            {services.data?.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} · {money(s.price, s.currency)}{s.duration_minutes ? ` · ${s.duration_minutes} min` : ''}
              </option>
            ))}
          </Select>
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Location">
            <Select required value={locationId} onChange={(e) => setLocationId(e.target.value)}>
              <option value="">Choose a location</option>
              {locations.data?.map((l) => (
                <option key={l.id} value={l.id}>{l.name}</option>
              ))}
            </Select>
          </Field>
          <Field label="Staff">
            <Select value={employeeId} onChange={(e) => setEmployeeId(e.target.value)} disabled={!locationId}>
              <option value="">Unassigned</option>
              {staff.data?.map((s) => (
                <option key={s.id} value={s.id}>{s.first_name} {s.last_name}</option>
              ))}
            </Select>
          </Field>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Date">
            <Input type="date" required value={day} onChange={(e) => setDay(e.target.value)} />
          </Field>
          <Field label={zone ? `Time (${zone})` : 'Time'} hint={location ? `Local time at ${location.name}` : undefined}>
            <Input type="time" required step={300} value={clock} onChange={(e) => setClock(e.target.value)} />
          </Field>
        </div>
        {service && !service.duration_minutes && (
          <p className="text-sm text-amber-700">This service has no set duration, so it can't be booked here yet.</p>
        )}
        {conflicts && (
          <div role="alert" className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-800 dark:bg-amber-950">
            <p className="font-medium">The staff member is already booked then:</p>
            <ul className="my-2 list-disc pl-5">
              {conflicts.map((c) => (
                <li key={c.appointment_number}>{c.appointment_number} · {dateTime(c.scheduled_start, location?.time_zone)}</li>
              ))}
            </ul>
            <div className="flex gap-2">
              <Button type="button" size="sm" onClick={() => book.mutate(true)}>Book anyway</Button>
              <Button type="button" size="sm" variant="secondary" onClick={() => setConflicts(null)}>Cancel</Button>
            </div>
          </div>
        )}
        {unavailable && !conflicts && (
          <div role="alert" className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-800 dark:bg-amber-950">
            <p className="font-medium">{unavailable}.</p>
            <div className="mt-2 flex gap-2">
              <Button type="button" size="sm" onClick={() => book.mutate(true)}>Book anyway</Button>
              <Button type="button" size="sm" variant="secondary" onClick={() => setUnavailable(null)}>Cancel</Button>
            </div>
          </div>
        )}
        {book.error && !conflicts && !unavailable && <ErrorBanner error={book.error} />}
        {booked && <p role="status" className="text-sm text-emerald-700">Booked as {booked}.</p>}
        <div>
          <Button type="submit" disabled={!customer || !location || (service && !service.duration_minutes) || book.isPending}>
            Book appointment
          </Button>
        </div>
      </form>
    </Card>
    </div>
  );
}
