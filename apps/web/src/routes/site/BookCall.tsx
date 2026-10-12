import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, CalendarDays, ChevronLeft, ChevronRight, CircleCheck, Clock, Globe, Video } from 'lucide-react';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { BrandMark } from '../../components/BrandMark';
import { ErrorBanner, Spinner } from '../../components/ui';
import { ApiError } from '../../lib/api';
import { todayIn, zonedToIso } from '../../lib/format';
import { assetUrl, siteGet, sitePost, useSite } from '../../lib/site';

interface SalesCallEvent {
  title: string;
  description: string | null;
  duration_minutes: number;
  /** A meeting link goes out in the confirmation email. */
  has_meeting_url: boolean;
}
interface Slots {
  event: SalesCallEvent;
  slots: string[];
}
interface Booked {
  id: string;
  event: SalesCallEvent;
  starts_at: string;
  ends_at: string;
}

const WEEKDAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
/** How far ahead the API offers times. */
const MONTHS_AHEAD = 2;
const pad = (n: number) => String(n).padStart(2, '0');

const browserZone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
};
const zones = (current: string): string[] => {
  let all: string[] = [];
  try {
    all = Intl.supportedValuesOf('timeZone');
  } catch {
    /* older browsers: only the current zone */
  }
  return all.includes(current) ? all : [current, ...all];
};
const zoneLabel = (tz: string) => tz.replaceAll('_', ' ').replace('/', ' / ');

/** 'YYYY-MM-DD' of an instant in a time zone. */
const dayOf = (iso: string, timeZone: string) => new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
/** "1:00pm" */
const clockOf = (iso: string | Date, timeZone: string) =>
  new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', minute: '2-digit', hour12: true }).format(new Date(iso)).replace(/\s/g, '').toLowerCase();
/** "Monday, September 15" (with the year when asked). */
const longDay = (day: string, year = false) => {
  const [y, m, d] = day.split('-').map(Number);
  return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric', ...(year ? { year: 'numeric' } : {}) }).format(new Date(Date.UTC(y, m - 1, d)));
};

/**
 * /book-a-call: visitors book a sales call (one fixed event type) in three steps, like the usual
 * scheduling pages: pick a day and time in their own time zone, leave a name and email, done.
 */
export function BookCallPage() {
  const site = useSite();
  const queryClient = useQueryClient();
  const [timeZone, setTimeZone] = useState(browserZone);
  const today = todayIn(timeZone);
  const [month, setMonth] = useState(() => today.slice(0, 7)); // 'YYYY-MM'
  const [day, setDay] = useState<string | null>(null);
  const [slot, setSlot] = useState<string | null>(null);
  const [step, setStep] = useState<'pick' | 'details' | 'done'>('pick');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [notes, setNotes] = useState('');

  const [y, m] = month.split('-').map(Number);
  const firstMonth = today.slice(0, 7);
  const lastMonth = (() => {
    const [ty, tm] = firstMonth.split('-').map(Number);
    const d = new Date(Date.UTC(ty, tm - 1 + MONTHS_AHEAD, 1));
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`;
  })();
  const shiftMonth = (delta: number) => {
    const d = new Date(Date.UTC(y, m - 1 + delta, 1));
    setMonth(`${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`);
    setDay(null);
    setSlot(null);
  };

  const slots = useQuery({
    queryKey: ['site', 'sales-call', month, timeZone],
    queryFn: () => {
      const next = new Date(Date.UTC(y, m, 1));
      const from = new Date(Math.max(Date.now(), Date.parse(zonedToIso(`${month}-01`, '00:00', timeZone)))).toISOString();
      const to = zonedToIso(`${next.getUTCFullYear()}-${pad(next.getUTCMonth() + 1)}-01`, '00:00', timeZone);
      return siteGet<Slots>(`/sales-call?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
    },
  });
  const event: SalesCallEvent = slots.data?.event ?? { title: 'Sales call', description: null, duration_minutes: 30, has_meeting_url: false };

  // Open times by local day.
  const byDay = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const s of slots.data?.slots ?? []) {
      const d = dayOf(s, timeZone);
      map.set(d, [...(map.get(d) ?? []), s]);
    }
    return map;
  }, [slots.data, timeZone]);

  // Arriving from a button further down a page.
  useEffect(() => {
    window.scrollTo(0, 0);
  }, []);

  // Start on the first day with open times.
  useEffect(() => {
    if (!day && byDay.size) setDay([...byDay.keys()][0]);
  }, [byDay, day]);

  const name_ = site.data?.name ?? '';
  useEffect(() => {
    document.title = [`Book a ${event.title.toLowerCase()}`, name_].filter(Boolean).join(' · ');
  }, [event.title, name_]);

  const book = useMutation({
    mutationFn: () => sitePost<Booked>('/sales-call', { name, email, start: slot, time_zone: timeZone, notes: notes.trim() || undefined }),
    onSuccess: () => setStep('done'),
    onError: (err) => {
      // Someone else took the time meanwhile: back to the times, refreshed.
      if (err instanceof ApiError && (err.status === 409 || /not available/.test(err.message))) {
        void queryClient.invalidateQueries({ queryKey: ['site', 'sales-call'] });
      }
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    book.mutate();
  };

  const settings = site.data?.settings;
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const lead = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
  const when = slot && `${clockOf(slot, timeZone)} – ${clockOf(new Date(Date.parse(slot) + event.duration_minutes * 60_000), timeZone)}, ${longDay(dayOf(slot, timeZone), true)}`;

  return (
    <main className="px-4 py-8 sm:py-12">
      <div className="mx-auto grid max-w-5xl overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm md:grid-cols-[18rem_minmax(0,1fr)] dark:border-slate-800 dark:bg-slate-900">
        {/* The event */}
        <aside className="relative border-b border-slate-200 md:border-r md:border-b-0 dark:border-slate-800">
          {step === 'details' && (
            <button
              type="button"
              onClick={() => setStep('pick')}
              aria-label="Back to times"
              className="press absolute top-4 left-4 grid size-10 place-items-center rounded-full border border-slate-200 text-brand-700 hover:bg-brand-50 dark:border-slate-700 dark:text-brand-600 dark:hover:bg-slate-800"
            >
              <ArrowLeft className="size-5" aria-hidden="true" />
            </button>
          )}
          <div className="flex items-center justify-center border-b border-slate-200 px-6 py-6 dark:border-slate-800">
            {settings?.logo_asset_id ? (
              <img src={assetUrl(settings.logo_asset_id)} alt={name_} className="h-16 max-w-full object-contain" />
            ) : (
              <span className="flex items-center gap-2 text-lg font-semibold"><BrandMark className="size-9" />{name_}</span>
            )}
          </div>
          <div className="grid gap-4 p-6">
            <div>
              <p className="text-sm font-semibold text-slate-500 dark:text-slate-400">{name_}</p>
              <h1 className="site-plain-heading mt-1 text-2xl font-bold tracking-tight">{event.title}</h1>
            </div>
            <ul className="grid gap-3 text-sm font-semibold text-slate-600 dark:text-slate-300">
              <li className="flex items-center gap-2.5"><Clock className="size-5 shrink-0" aria-hidden="true" />{event.duration_minutes} min</li>
              <li className="flex items-center gap-2.5"><Video className="size-5 shrink-0" aria-hidden="true" />{event.has_meeting_url ? 'Video call, link by email' : 'Video call, details by email'}</li>
              {step !== 'pick' && when && (
                <li className="flex items-start gap-2.5"><CalendarDays className="size-5 shrink-0" aria-hidden="true" />{when}</li>
              )}
              {step !== 'pick' && (
                <li className="flex items-center gap-2.5"><Globe className="size-5 shrink-0" aria-hidden="true" />{zoneLabel(timeZone)}</li>
              )}
            </ul>
            {event.description && <p className="whitespace-pre-line text-slate-600 dark:text-slate-300">{event.description}</p>}
          </div>
        </aside>

        {/* The steps */}
        <section className="min-w-0 p-6 sm:p-8">
          {step === 'pick' && (
            <>
              <h2 className="site-plain-heading text-xl font-bold tracking-tight">Select a date &amp; time</h2>
              <div className="mt-6 grid gap-8 lg:grid-cols-[minmax(0,1fr)_13rem]">
                <div>
                  <div className="flex items-center justify-center gap-6">
                    <button
                      type="button"
                      aria-label="Previous month"
                      disabled={month <= firstMonth}
                      onClick={() => shiftMonth(-1)}
                      className="press grid size-10 place-items-center rounded-full text-brand-700 enabled:bg-brand-50 enabled:hover:bg-brand-100 disabled:text-slate-300 dark:text-brand-600 dark:enabled:bg-slate-800 dark:disabled:text-slate-600"
                    >
                      <ChevronLeft className="size-5" aria-hidden="true" />
                    </button>
                    <p className="min-w-40 text-center font-medium" aria-live="polite">
                      {new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'long', year: 'numeric' }).format(new Date(Date.UTC(y, m - 1, 1)))}
                    </p>
                    <button
                      type="button"
                      aria-label="Next month"
                      disabled={month >= lastMonth}
                      onClick={() => shiftMonth(1)}
                      className="press grid size-10 place-items-center rounded-full text-brand-700 enabled:bg-brand-50 enabled:hover:bg-brand-100 disabled:text-slate-300 dark:text-brand-600 dark:enabled:bg-slate-800 dark:disabled:text-slate-600"
                    >
                      <ChevronRight className="size-5" aria-hidden="true" />
                    </button>
                  </div>
                  <div role="grid" aria-label="Days" className="mt-5 grid grid-cols-7 gap-y-2 text-center">
                    {WEEKDAYS.map((w) => (
                      <span key={w} role="columnheader" className="pb-2 text-xs font-medium text-slate-500">{w}</span>
                    ))}
                    {Array.from({ length: lead }, (_, i) => <span key={`lead${i}`} />)}
                    {Array.from({ length: daysInMonth }, (_, i) => {
                      const key = `${month}-${pad(i + 1)}`;
                      const open = byDay.has(key);
                      const selected = key === day;
                      return (
                        <span key={key} className="grid place-items-center">
                          <button
                            type="button"
                            disabled={!open}
                            aria-pressed={selected}
                            aria-label={`${longDay(key)}${open ? '' : ', no times'}`}
                            onClick={() => {
                              setDay(key);
                              setSlot(null);
                            }}
                            className={`press relative grid size-11 place-items-center rounded-full text-[0.95rem] sm:size-12 ${
                              selected
                                ? 'bg-brand-600 font-bold text-white'
                                : open
                                  ? 'bg-brand-50 font-bold text-brand-700 hover:bg-brand-100 dark:bg-slate-800 dark:text-brand-600 dark:hover:bg-slate-700'
                                  : 'text-slate-400 dark:text-slate-600'
                            }`}
                          >
                            {i + 1}
                            {key === today && <span aria-hidden="true" className={`absolute bottom-1.5 size-1 rounded-full ${selected ? 'bg-white' : 'bg-current'}`} />}
                          </button>
                        </span>
                      );
                    })}
                  </div>
                  {slots.isLoading && <div className="mt-4"><Spinner label="Loading times" /></div>}
                  {slots.error && <div className="mt-4"><ErrorBanner error={slots.error} /></div>}
                  {slots.data && !byDay.size && <p className="mt-4 text-sm text-slate-500">No open times this month{month < lastMonth ? '; try the next one.' : '.'}</p>}

                  <div className="mt-6">
                    <label htmlFor="sales-call-tz" className="text-sm font-semibold">Time zone</label>
                    <div className="mt-1 flex items-center gap-2">
                      <Globe className="size-4 shrink-0 text-slate-500" aria-hidden="true" />
                      <select
                        id="sales-call-tz"
                        value={timeZone}
                        onChange={(e) => {
                          setTimeZone(e.target.value);
                          setDay(null);
                          setSlot(null);
                        }}
                        className="min-w-0 max-w-full rounded-md border-0 bg-transparent py-1 pr-2 text-sm text-slate-700 hover:bg-slate-50 dark:text-slate-200 dark:hover:bg-slate-800"
                      >
                        {zones(timeZone).map((z) => (
                          <option key={z} value={z}>{zoneLabel(z)}{z === timeZone ? ` (${clockOf(new Date(), z)})` : ''}</option>
                        ))}
                      </select>
                    </div>
                  </div>
                </div>

                {day && (
                  <div>
                    <p className="mb-4 font-medium">{longDay(day)}</p>
                    <ul className="grid max-h-[28rem] gap-2.5 overflow-y-auto pr-1">
                      {(byDay.get(day) ?? []).map((s) => (
                        <li key={s}>
                          {slot === s ? (
                            <div className="grid grid-cols-2 gap-2">
                              <span className="grid place-items-center rounded-lg bg-slate-600 py-3 text-sm font-semibold text-white dark:bg-slate-700">{clockOf(s, timeZone)}</span>
                              <button type="button" onClick={() => setStep('details')} className="press rounded-lg bg-brand-600 py-3 text-sm font-semibold text-white hover:bg-brand-700">
                                Next
                              </button>
                            </div>
                          ) : (
                            <button
                              type="button"
                              onClick={() => setSlot(s)}
                              className="press w-full rounded-lg border border-brand-300 py-3 text-sm font-bold text-brand-700 hover:border-brand-600 hover:border-2 dark:border-slate-600 dark:text-brand-600"
                            >
                              {clockOf(s, timeZone)}
                            </button>
                          )}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            </>
          )}

          {step === 'details' && (
            <form onSubmit={submit} className="grid max-w-lg gap-5">
              <h2 className="site-plain-heading text-xl font-bold tracking-tight">Enter details</h2>
              <label className="grid gap-1.5 text-sm font-semibold">
                <span>Name <span aria-hidden="true">*</span></span>
                <input required maxLength={120} autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} className="rounded-lg border border-slate-300 bg-white px-3 py-3 font-normal focus:border-brand-600 dark:border-slate-700 dark:bg-slate-950" />
              </label>
              <label className="grid gap-1.5 text-sm font-semibold">
                <span>Email <span aria-hidden="true">*</span></span>
                <input required type="email" maxLength={254} autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} className="rounded-lg border border-slate-300 bg-white px-3 py-3 font-normal focus:border-brand-600 dark:border-slate-700 dark:bg-slate-950" />
              </label>
              <label className="grid gap-1.5 text-sm font-semibold">
                <span>Please share anything that will help prepare for our meeting.</span>
                <textarea rows={3} maxLength={2000} value={notes} onChange={(e) => setNotes(e.target.value)} className="rounded-lg border border-slate-300 bg-white px-3 py-2 font-normal focus:border-brand-600 dark:border-slate-700 dark:bg-slate-950" />
              </label>
              {book.error && <ErrorBanner error={book.error} />}
              <div>
                <button type="submit" disabled={book.isPending || !slot} className="press rounded-full bg-brand-600 px-6 py-3 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-50">
                  {book.isPending ? 'Scheduling…' : 'Schedule event'}
                </button>
              </div>
            </form>
          )}

          {step === 'done' && book.data && (
            <div role="status" className="grid max-w-lg justify-items-start gap-4 py-6">
              <CircleCheck className="size-12 text-emerald-600" aria-hidden="true" />
              <h2 className="site-plain-heading text-2xl font-bold tracking-tight">You're scheduled</h2>
              <p className="text-slate-600 dark:text-slate-300">
                Your {event.title.toLowerCase()} is booked for <strong>{when}</strong> ({zoneLabel(timeZone)}). We sent a confirmation to <strong>{email}</strong>.
              </p>
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
