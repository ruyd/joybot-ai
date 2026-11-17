import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Page } from '../../components/Layout';
import { ErrorBanner, Input, PageHeader, Spinner } from '../../components/ui';
import { useApi } from '../../lib/api';
import { dateTime, money, todayIn, zonedToIso } from '../../lib/format';
import { useMe } from '../../lib/me';
import type { CustomerAppointment } from './appointments';

interface Service {
  id: string;
  name: string;
  description: string | null;
  duration_minutes: number | null;
  price: string;
  currency: string;
}

interface Location {
  id: string;
  name: string;
  address: Record<string, unknown> | string | null;
  time_zone: string;
}

const addressOf = (l: Location) =>
  !l.address ? '' : typeof l.address === 'string' ? l.address : Object.values(l.address).filter((v) => typeof v === 'string' && v).join(', ');

/** Start times offered: every half hour from 9:00 to 17:00 (the team confirms or suggests another). */
const TIMES = Array.from({ length: 17 }, (_, i) => `${String(9 + Math.floor(i / 2)).padStart(2, '0')}:${i % 2 ? '30' : '00'}`);
const DAYS_SHOWN = 7;

/** 'YYYY-MM-DD' plus n days. */
const addDays = (day: string, n: number) => {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};
const dayFmt = (day: string, opts: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(undefined, { timeZone: 'UTC', ...opts }).format(new Date(`${day}T12:00:00Z`));
const clockLabel = (clock: string) => new Intl.DateTimeFormat(undefined, { timeZone: 'UTC', hour: 'numeric', minute: '2-digit' }).format(new Date(`2000-01-01T${clock}:00Z`));
const cityOf = (zone: string) => zone.split('/').pop()!.replaceAll('_', ' ');

const box = 'rounded-xl border border-slate-200 bg-white p-6 shadow-xs dark:border-slate-800 dark:bg-slate-900';
const choice = (selected: boolean) =>
  `press rounded-xl border p-4 text-left transition-colors focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:outline-none ${
    selected ? 'border-brand-600 bg-brand-50/70 ring-1 ring-brand-600 dark:bg-slate-800' : 'border-slate-200 hover:border-slate-300 dark:border-slate-700 dark:hover:border-slate-600'
  }`;

function Step({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <section className={box}>
      <h2 className="mb-4 flex items-center gap-3 font-semibold">
        <span className="grid size-6 place-items-center rounded-full bg-brand-700 text-xs font-bold text-white">{n}</span>
        {title}
      </h2>
      {children}
    </section>
  );
}

/** Customers request an appointment; staff confirm it (Review page). `?service=` preselects a service. */
export function BookPage() {
  const api = useApi();
  const queryClient = useQueryClient();
  const { me } = useMe();
  const [params] = useSearchParams();
  const services = useQuery({ queryKey: ['services'], queryFn: () => api.get<Service[]>('/services') });
  const locations = useQuery({ queryKey: ['locations'], queryFn: () => api.get<Location[]>('/locations') });
  const [serviceId, setServiceId] = useState(params.get('service') ?? '');
  const [locationId, setLocationId] = useState('');
  const [firstDay, setFirstDay] = useState('');
  const [day, setDay] = useState('');
  const [clock, setClock] = useState('');
  const [otherTime, setOtherTime] = useState(false);
  const [notes, setNotes] = useState('');
  const [requested, setRequested] = useState<CustomerAppointment | null>(null);

  // Preferred location, or the only one.
  useEffect(() => {
    if (locationId || !locations.data?.length) return;
    const preferred = me?.profile.preferred_location_id as string | undefined;
    if (preferred && locations.data.some((l) => l.id === preferred)) setLocationId(preferred);
    else if (locations.data.length === 1) setLocationId(locations.data[0].id);
  }, [locations.data, locationId, me]);

  const location = locations.data?.find((l) => l.id === locationId);
  const service = services.data?.find((s) => s.id === serviceId);
  const bookable = services.data?.filter((s) => s.duration_minutes) ?? [];
  const zone = location?.time_zone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const today = todayIn(zone);
  const start = firstDay || today;
  const days = Array.from({ length: DAYS_SHOWN }, (_, i) => addDays(start, i));
  // Today: only times still ahead (with a little notice).
  const open = (c: string) => !day || Date.parse(zonedToIso(day, c, zone)) > Date.now() + 30 * 60_000;

  const request = useMutation({
    mutationFn: () =>
      api.post<CustomerAppointment>('/appointments/requests', {
        service_id: serviceId,
        location_id: locationId,
        scheduled_start: zonedToIso(day, clock, zone),
        notes: notes.trim() || undefined,
      }),
    onSuccess: (a) => {
      setRequested(a);
      setClock('');
      setNotes('');
      void queryClient.invalidateQueries({ queryKey: ['appointments'] });
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setRequested(null);
    request.mutate();
  };
  const ready = Boolean(service && location && day && clock);

  return (
    <Page>
      <PageHeader title="Book an appointment" description="Choose a service, a place and a time. We confirm every request, or suggest another time." />
      {services.isLoading || locations.isLoading ? (
        <Spinner />
      ) : (
        <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_21rem]">
          <div className="grid gap-5">
            <Step n={1} title="Choose a service">
              <div className="grid gap-3 sm:grid-cols-2" role="radiogroup" aria-label="Service">
                {bookable.map((s) => (
                  <button key={s.id} type="button" role="radio" aria-checked={s.id === serviceId} onClick={() => setServiceId(s.id)} className={choice(s.id === serviceId)}>
                    <span className="flex items-baseline justify-between gap-3">
                      <span className="font-semibold">{s.name}</span>
                      <span className="font-semibold tabular-nums">{money(s.price, s.currency)}</span>
                    </span>
                    <span className="mt-1 line-clamp-2 block text-sm text-slate-500">
                      {s.duration_minutes} min{s.description ? ` · ${s.description}` : ''}
                    </span>
                  </button>
                ))}
              </div>
              {!bookable.length && <p className="text-sm text-slate-500">Nothing can be booked online yet.</p>}
            </Step>
            <Step n={2} title="Choose a location">
              <div className="grid gap-3 sm:grid-cols-3" role="radiogroup" aria-label="Location">
                {locations.data?.map((l) => (
                  <button key={l.id} type="button" role="radio" aria-checked={l.id === locationId} onClick={() => setLocationId(l.id)} className={`${choice(l.id === locationId)} py-3`}>
                    <span className="block text-sm font-semibold">{l.name}</span>
                    <span className="block truncate text-sm text-slate-500">{addressOf(l) || cityOf(l.time_zone)}</span>
                  </button>
                ))}
              </div>
            </Step>
            <Step n={3} title="Pick a time">
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  aria-label="Earlier days"
                  disabled={start <= today}
                  onClick={() => setFirstDay(addDays(start, -DAYS_SHOWN) < today ? today : addDays(start, -DAYS_SHOWN))}
                  className="press grid size-9 shrink-0 place-items-center rounded-lg text-slate-500 hover:bg-slate-100 disabled:opacity-30 dark:hover:bg-slate-800"
                >
                  <ChevronLeft className="size-4" aria-hidden="true" />
                </button>
                <div className="grid flex-1 grid-cols-7 gap-1.5" role="radiogroup" aria-label="Day">
                  {days.map((d) => (
                    <button
                      key={d}
                      type="button"
                      role="radio"
                      aria-checked={d === day}
                      aria-label={dayFmt(d, { weekday: 'long', month: 'long', day: 'numeric' })}
                      onClick={() => {
                        setDay(d);
                        setClock('');
                      }}
                      className={`press rounded-xl border py-2 text-center leading-tight transition-colors ${
                        d === day ? 'border-brand-700 bg-brand-700 text-white' : 'border-slate-200 hover:border-slate-300 dark:border-slate-700'
                      }`}
                    >
                      <span className="block text-xs font-medium">{dayFmt(d, { weekday: 'short' })}</span>
                      <span className="block text-lg font-bold">{dayFmt(d, { day: 'numeric' })}</span>
                    </button>
                  ))}
                </div>
                <button
                  type="button"
                  aria-label="Later days"
                  onClick={() => setFirstDay(addDays(start, DAYS_SHOWN))}
                  className="press grid size-9 shrink-0 place-items-center rounded-lg text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"
                >
                  <ChevronRight className="size-4" aria-hidden="true" />
                </button>
              </div>
              {day ? (
                <>
                  <div className="mt-4 grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-6" role="radiogroup" aria-label="Time">
                    {TIMES.filter(open).map((c) => (
                      <button
                        key={c}
                        type="button"
                        role="radio"
                        aria-checked={!otherTime && c === clock}
                        onClick={() => {
                          setOtherTime(false);
                          setClock(c);
                        }}
                        className={`press rounded-lg border py-2.5 text-sm font-semibold tabular-nums transition-colors ${
                          !otherTime && c === clock ? 'border-brand-600 bg-brand-50 ring-1 ring-brand-600 dark:bg-slate-800' : 'border-slate-200 hover:border-slate-300 dark:border-slate-700'
                        }`}
                      >
                        {clockLabel(c)}
                      </button>
                    ))}
                  </div>
                  {!TIMES.some(open) && <p className="mt-4 text-sm text-slate-500">No times left today. Pick another day.</p>}
                  <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
                    {otherTime ? (
                      <label className="flex items-center gap-2">
                        Another time
                        <Input type="time" step={900} required value={clock} onChange={(e) => setClock(e.target.value)} className="w-36" />
                      </label>
                    ) : (
                      <button type="button" onClick={() => {
                          setOtherTime(true);
                          setClock('');
                        }} className="font-semibold text-brand-700 hover:underline dark:text-brand-600">
                        Another time…
                      </button>
                    )}
                  </div>
                </>
              ) : (
                <p className="mt-4 text-sm text-slate-500">Pick a day to see times.</p>
              )}
              <p className="mt-4 text-xs text-slate-500">Times in {cityOf(zone)} time{location ? ` (${location.name})` : ''}.</p>
            </Step>
          </div>

          <form onSubmit={submit} className={`${box} lg:sticky lg:top-20`} aria-label="Your request">
            <h2 className="font-semibold">Your request</h2>
            <dl className="mt-3 grid grid-cols-[4.5rem_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-sm">
              <dt className="text-slate-500">Service</dt>
              <dd className="font-semibold">{service ? `${service.name} · ${service.duration_minutes} min` : '—'}</dd>
              <dt className="text-slate-500">Where</dt>
              <dd className="font-semibold">{location?.name ?? '—'}</dd>
              <dt className="text-slate-500">When</dt>
              <dd className="font-semibold">{day && clock ? `${dayFmt(day, { weekday: 'short', month: 'short', day: 'numeric' })} · ${clockLabel(clock)}` : '—'}</dd>
              <dt className="text-slate-500">Price</dt>
              <dd className="font-semibold">{service ? money(service.price, service.currency) : '—'}</dd>
            </dl>
            <label className="mt-4 block text-sm font-semibold" htmlFor="book-notes">
              Anything we should know?
            </label>
            <textarea
              id="book-notes"
              rows={3}
              maxLength={1000}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Optional"
              className="mt-1.5 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-900"
            />
            {request.error && (
              <div className="mt-3">
                <ErrorBanner error={request.error} />
              </div>
            )}
            {requested && (
              <p role="status" className="mt-3 rounded-lg bg-emerald-50 p-3 text-sm text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200">
                Requested {requested.service_name} on {dateTime(requested.scheduled_start, requested.time_zone)}. You'll see it under{' '}
                <Link to="/portal/appointments" className="underline">
                  Appointments
                </Link>
                .
              </p>
            )}
            <button
              type="submit"
              disabled={!ready || request.isPending}
              className="press mt-4 min-h-11 w-full rounded-lg bg-brand-700 px-4 text-sm font-semibold text-white hover:bg-brand-800 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {request.isPending ? 'Sending…' : 'Request this time'}
            </button>
            <p className="mt-3 text-xs text-slate-500">We'll confirm by email, then it shows as confirmed under Appointments.</p>
          </form>
        </div>
      )}
    </Page>
  );
}
