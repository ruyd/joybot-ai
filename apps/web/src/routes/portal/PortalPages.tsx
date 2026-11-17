import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Page } from '../../components/Layout';
import { Card, EmptyState, ErrorBanner, PageHeader, Spinner, StatusBadge, Table, Td } from '../../components/ui';
import { useApi } from '../../lib/api';
import { dateTime, METHOD_LABEL, money } from '../../lib/format';
import { useMe } from '../../lib/me';
import { clockIn, dayLabel, downloadIcs, fmtIn, isRequest, minutesOf, upcomingOf, useMyAppointments, type CustomerAppointment } from './appointments';

export interface Appointment {
  id: string;
  appointment_number: string;
  service_name: string;
  location_name: string;
  time_zone: string;
  employee_name: string | null;
  scheduled_start: string;
  scheduled_end?: string;
  status: string;
  price_quoted: string;
  currency: string;
  notes_customer: string | null;
}

export interface Payment {
  id: string;
  payment_number: string;
  amount: string;
  amount_refunded: string;
  currency: string;
  method: string;
  status: string;
  card_brand: string | null;
  card_last4: string | null;
  receipt_url: string | null;
  failure_reason: string | null;
  paid_at: string | null;
  expected_at: string | null;
  created_at: string;
}

function useList<T>(key: string, path: string) {
  const api = useApi();
  return useQuery({ queryKey: [key, path], queryFn: () => api.get<T[]>(path) });
}

function State({ q, empty, children }: { q: { isLoading: boolean; error: unknown; data?: unknown[] }; empty: string; children: React.ReactNode }) {
  if (q.isLoading) return <Spinner />;
  if (q.error) return <ErrorBanner error={q.error} />;
  if (!q.data?.length) return <EmptyState>{empty}</EmptyState>;
  return <>{children}</>;
}

const box = 'rounded-xl border border-slate-200 bg-white shadow-xs dark:border-slate-800 dark:bg-slate-900';

/** A small calendar tile: the month, the day, and optionally a word under it. */
function DateTile({ iso, timeZone, under, dashed, large }: { iso: string; timeZone: string; under?: string; dashed?: boolean; large?: boolean }) {
  return (
    <span
      className={`grid shrink-0 place-items-center rounded-lg bg-white leading-none text-slate-900 ${large ? 'w-20 rounded-xl py-3' : 'w-12 py-1.5'} ${
        dashed ? 'border border-dashed border-amber-500' : 'border border-slate-200 dark:border-slate-700'
      }`}
    >
      <span className={`font-bold text-red-600 uppercase ${large ? 'text-xs' : 'text-[0.65rem]'}`}>{fmtIn(iso, timeZone, { month: 'short' })}</span>
      <span className={`font-bold ${large ? 'mt-1 text-3xl' : 'mt-0.5 text-lg'}`}>{fmtIn(iso, timeZone, { day: 'numeric' })}</span>
      {under && <span className="mt-1 text-xs text-slate-500">{under}</span>}
    </span>
  );
}

function RequestState({ a, dark }: { a: CustomerAppointment; dark?: boolean }) {
  if (isRequest(a))
    return <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${dark ? 'bg-amber-300 text-amber-950' : 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300'}`}>Waiting for confirmation</span>;
  return <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${dark ? 'bg-emerald-300 text-emerald-950' : 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300'}`}>Confirmed</span>;
}

/** Upcoming appointments (the next one large) and past ones with Book again. */
export function MyAppointments() {
  const api = useApi();
  const queryClient = useQueryClient();
  const { me } = useMe();
  const q = useMyAppointments();
  const withdraw = useMutation({
    mutationFn: (id: string) => api.post(`/appointments/${id}/withdraw`),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['appointments'] }),
  });
  const upcoming = upcomingOf(q.data);
  const past = (q.data ?? []).filter((a) => !upcoming.includes(a)).sort((a, b) => Date.parse(b.scheduled_start) - Date.parse(a.scheduled_start));
  const [next, ...later] = upcoming;
  // Changes go through the assistant (it knows the policy) or, without it, a support request.
  const changeHref = (a: CustomerAppointment) =>
    me?.assistant === false ? '/portal/tickets' : `/portal?q=${encodeURIComponent(`I'd like to change or cancel my ${a.service_name} on ${dayLabel(a.scheduled_start, a.time_zone)} at ${clockIn(a.scheduled_start, a.time_zone)}`)}`;
  const withdrawButton = (a: CustomerAppointment, className: string) => (
    <button
      type="button"
      disabled={withdraw.isPending}
      onClick={() => window.confirm(`Withdraw your request for ${a.service_name}?`) && withdraw.mutate(a.id)}
      className={className}
    >
      Withdraw request
    </button>
  );

  return (
    <Page>
      <PageHeader
        title="My appointments"
        description="Our team confirms every request. Times are shown in each location's time zone."
        actions={
          <Link to="/portal/book" className="press inline-flex min-h-10 items-center rounded-lg bg-brand-700 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-800">
            Book an appointment
          </Link>
        }
      />
      {q.isLoading ? (
        <Spinner />
      ) : q.error ? (
        <ErrorBanner error={q.error} />
      ) : (
        <div className="grid grid-cols-1 gap-5">
          {next ? (
            <section className="flex flex-wrap items-center gap-5 rounded-2xl bg-slate-950 p-6 text-white" aria-label="Next appointment">
              <DateTile large iso={next.scheduled_start} timeZone={next.time_zone} under={dayLabel(next.scheduled_start, next.time_zone) === 'Today' ? 'Today' : fmtIn(next.scheduled_start, next.time_zone, { weekday: 'short' })} />
              <div className="min-w-0 flex-[1_1_18rem]">
                <RequestState a={next} dark />
                <h2 className="mt-2 text-2xl font-bold tracking-tight">
                  {next.service_name} · {clockIn(next.scheduled_start, next.time_zone)}
                </h2>
                <p className="mt-1 text-sm text-slate-300">
                  {[next.employee_name ? `With ${next.employee_name}` : 'Any staff', next.location_name, minutesOf(next) && `${minutesOf(next)} min`].filter(Boolean).join(' · ')}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <button type="button" onClick={() => downloadIcs(next)} className="press rounded-lg bg-white px-4 py-2.5 text-sm font-semibold text-slate-900 hover:bg-slate-100">
                  Add to calendar
                </button>
                {isRequest(next) ? (
                  withdrawButton(next, 'press rounded-lg border border-white/25 px-4 py-2.5 text-sm font-semibold text-red-300 hover:bg-white/10')
                ) : (
                  <Link to={changeHref(next)} className="press rounded-lg border border-white/25 px-4 py-2.5 text-sm font-semibold hover:bg-white/10">
                    Change or cancel
                  </Link>
                )}
              </div>
            </section>
          ) : (
            <section className={`${box} flex flex-wrap items-center justify-between gap-3 p-6`}>
              <p className="text-sm text-slate-500">No upcoming appointments.</p>
              <Link to="/portal/book" className="text-sm font-semibold text-brand-700 hover:underline dark:text-brand-600">
                Book one →
              </Link>
            </section>
          )}
          {withdraw.error && <ErrorBanner error={withdraw.error} />}
          <div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-2">
            <section className={box}>
              <h2 className="border-b border-slate-100 px-5 py-4 font-semibold dark:border-slate-800">Upcoming</h2>
              {!later.length ? (
                <p className="px-5 py-6 text-sm text-slate-500">{next ? 'Nothing else booked.' : 'Nothing booked.'}</p>
              ) : (
                <ul className="divide-y divide-slate-100 dark:divide-slate-800">
                  {later.map((a) => (
                    <li key={a.id} className="px-5 py-3.5">
                      <div className="flex items-center gap-3">
                        <DateTile iso={a.scheduled_start} timeZone={a.time_zone} dashed={isRequest(a)} />
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-semibold">
                            {a.service_name} · {clockIn(a.scheduled_start, a.time_zone)}
                          </p>
                          <p className="truncate text-sm text-slate-500">
                            {a.employee_name ?? 'Any staff'} · {a.location_name}
                          </p>
                        </div>
                        <RequestState a={a} />
                      </div>
                      <div className="mt-2 flex gap-4 pl-15 text-sm font-semibold">
                        <button type="button" onClick={() => downloadIcs(a)} className="text-brand-700 hover:underline dark:text-brand-600">
                          Add to calendar
                        </button>
                        {isRequest(a) ? (
                          withdrawButton(a, 'text-red-700 hover:underline dark:text-red-400')
                        ) : (
                          <Link to={changeHref(a)} className="text-slate-600 hover:underline dark:text-slate-300">
                            Change or cancel
                          </Link>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>
            <section className={box}>
              <h2 className="border-b border-slate-100 px-5 py-4 font-semibold dark:border-slate-800">Past</h2>
              {!past.length ? (
                <p className="px-5 py-6 text-sm text-slate-500">No past appointments yet.</p>
              ) : (
                <ul className="divide-y divide-slate-100 dark:divide-slate-800">
                  {past.map((a) => (
                    <li key={a.id} className="flex items-center gap-4 px-5 py-3">
                      <span className="w-14 shrink-0 text-sm text-slate-500">{fmtIn(a.scheduled_start, a.time_zone, { month: 'short', day: 'numeric' })}</span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-semibold">{a.service_name}</p>
                        <p className="truncate text-sm text-slate-500">
                          {a.employee_name ?? 'Any staff'} · {a.location_name}
                        </p>
                      </div>
                      {(a.status === 'cancelled' || a.status === 'no_show') && <StatusBadge status={a.status} />}
                      {a.service_id && (
                        <Link to={`/portal/book?service=${a.service_id}`} className="shrink-0 text-sm font-semibold text-brand-700 hover:underline dark:text-brand-600">
                          Book again
                        </Link>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        </div>
      )}
    </Page>
  );
}

export function PaymentStatus({ p }: { p: Payment }) {
  if (p.method === 'bank_transfer' && p.status === 'pending') return <StatusBadge status="pending" />;
  return <StatusBadge status={p.status} />;
}

export function MyPayments() {
  const q = useList<Payment>('payments', '/payments?limit=100');
  return (
    <Page>
      <PageHeader title="My payments" description="Card payments, POS receipts and bank transfers." />
      <Card>
        <State q={q} empty="No payments yet.">
          <Table head={['Date', 'Amount', 'Method', 'Status', '']}>
            {q.data?.map((p) => (
              <tr key={p.id}>
                <Td>{dateTime(p.paid_at ?? p.created_at)}</Td>
                <Td>
                  {money(p.amount, p.currency)}
                  {Number(p.amount_refunded) > 0 && <span className="block text-xs text-slate-500">refunded {money(p.amount_refunded, p.currency)}</span>}
                </Td>
                <Td>
                  {METHOD_LABEL[p.method] ?? p.method}
                  {p.card_last4 && <span className="block text-xs text-slate-500">{p.card_brand} •••• {p.card_last4}</span>}
                </Td>
                <Td>
                  <PaymentStatus p={p} />
                  {p.method === 'bank_transfer' && p.status === 'pending' && <span className="block text-xs text-slate-500">Not received yet</span>}
                  {p.failure_reason && <span className="block text-xs text-red-600">{p.failure_reason}</span>}
                </Td>
                <Td>
                  {p.receipt_url && (
                    <a className="text-sm text-brand-600 underline" href={p.receipt_url} target="_blank" rel="noreferrer">
                      Receipt
                    </a>
                  )}
                </Td>
              </tr>
            ))}
          </Table>
        </State>
      </Card>
    </Page>
  );
}

interface Service {
  id: string;
  name: string;
  description: string | null;
  category: string | null;
  duration_minutes: number | null;
  price: string;
  currency: string;
}

export function Services() {
  const q = useList<Service>('services', '/services');
  return (
    <Page>
      <PageHeader title="Services and prices" />
      <State q={q} empty="No services listed.">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {q.data?.map((s) => (
            <Card key={s.id}>
              <div className="flex items-start justify-between gap-2">
                <h2 className="font-medium">{s.name}</h2>
                <span className="font-semibold">{money(s.price, s.currency)}</span>
              </div>
              {s.category && <p className="text-xs text-slate-500">{s.category}{s.duration_minutes ? ` · ${s.duration_minutes} min` : ''}</p>}
              {s.description && <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">{s.description}</p>}
            </Card>
          ))}
        </div>
      </State>
    </Page>
  );
}

interface Location {
  id: string;
  name: string;
  phone: string | null;
  time_zone: string;
  address: Record<string, string> | null;
}

export function Locations() {
  const q = useList<Location>('locations', '/locations');
  return (
    <Page>
      <PageHeader title="Locations" />
      <State q={q} empty="No locations.">
        <div className="grid gap-3 sm:grid-cols-2">
          {q.data?.map((l) => (
            <Card key={l.id}>
              <h2 className="font-medium">{l.name}</h2>
              {l.address && <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">{Object.values(l.address).join(', ')}</p>}
              <p className="mt-1 text-sm text-slate-500">
                {l.phone && <a href={`tel:${l.phone}`}>{l.phone} · </a>}
                {l.time_zone.replace('_', ' ')}
              </p>
            </Card>
          ))}
        </div>
      </State>
    </Page>
  );
}
