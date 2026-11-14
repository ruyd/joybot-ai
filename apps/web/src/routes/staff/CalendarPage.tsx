import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { AppointmentTypesDialog, useAppointmentTypes } from '../../components/AppointmentTypes';
import { Button, ErrorBanner, Select, Spinner } from '../../components/ui';
import { useApi } from '../../lib/api';
import { preferredTimeZone, todayIn, zonedToIso } from '../../lib/format';
import { useMe } from '../../lib/me';
import { BookAppointment } from './HomePage';

type View = 'day' | 'week' | 'month';

interface CalendarAppointment {
  id: string;
  appointment_number: string;
  /** Null for sales calls (the visitor's name is in customer_name). */
  customer_id: string | null;
  customer_name: string | null;
  service_name: string;
  type_key: string;
  type_name: string;
  type_color: string;
  location_name: string;
  employee_id: string | null;
  employee_name: string | null;
  scheduled_start: string;
  scheduled_end: string;
  status: string;
}

interface Busy {
  employee_id: string;
  location_id: string;
  scheduled_start: string;
  scheduled_end: string;
}

interface Staff {
  id: string;
  first_name: string | null;
  last_name: string | null;
}

interface Location {
  id: string;
  name: string;
}

interface CalendarData {
  appointments: CalendarAppointment[];
  busy: Busy[];
  staff: Staff[];
  /** Working hours as concrete intervals. */
  shifts: { employee_id: string; location_id: string; starts_at: string; ends_at: string }[];
  /** Reason only for whoever may change that schedule. */
  time_off: { id: string; employee_id: string; starts_at: string; ends_at: string; reason: string | null }[];
  /** Staff with working hours set: a day without shifts is a day off for them; others are unrestricted. */
  staff_with_hours: string[];
}

/** One block on the calendar: an appointment the viewer can see, a colleague's busy time, or time off. */
type Item =
  | {
      kind: 'appointment';
      key: string;
      start: string;
      end: string;
      employeeId: string | null;
      a: CalendarAppointment;
    }
  | {
      kind: 'busy';
      key: string;
      start: string;
      end: string;
      employeeId: string;
    }
  | {
      kind: 'off';
      key: string;
      start: string;
      end: string;
      employeeId: string;
      reason: string | null;
    };

const HOUR_PX = 64;
const UNASSIGNED = 'unassigned';
const AVATAR = ['bg-violet-600', 'bg-brand-700', 'bg-slate-700', 'bg-sky-600', 'bg-rose-600', 'bg-amber-600'];

/**
 * Calendar: appointments and staff busy times by day (a column per staff member), week or month,
 * in the viewer's time zone. Colleagues' bookings the viewer cannot open show as "Busy".
 * The view, date, location and staff member live in the URL; the side rail picks them and lists
 * bookings nobody is assigned to.
 */
export function CalendarPage() {
  const [typesOpen, setTypesOpen] = useState(false);
  const [booking, setBooking] = useState(false);
  const api = useApi();
  const { me, can } = useMe();
  const types = useAppointmentTypes();
  const zone = preferredTimeZone(me?.profile.time_zone);
  const [params, setParams] = useSearchParams();
  const view = (['day', 'week', 'month'] as const).find((v) => v === params.get('view')) ?? 'week';
  const anchor = /^\d{4}-\d{2}-\d{2}$/.test(params.get('date') ?? '') ? params.get('date')! : todayIn(zone);
  const locationId = params.get('location') ?? '';
  const staffId = params.get('staff') ?? '';
  const set = (changes: Record<string, string>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(changes)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    setParams(next, { replace: true });
  };

  const { days, label } = rangeFor(view, anchor);
  const from = zonedToIso(days[0], '00:00', zone);
  const to = zonedToIso(addDays(days[days.length - 1], 1), '00:00', zone);
  const locations = useQuery({
    queryKey: ['locations'],
    queryFn: () => api.get<Location[]>('/locations'),
  });
  const q = useQuery({
    queryKey: ['calendar', from, to, locationId, staffId],
    queryFn: () =>
      api.get<CalendarData>(
        `/appointments/calendar?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}` +
          (locationId ? `&location_id=${locationId}` : '') +
          (staffId ? `&employee_id=${staffId}` : ''),
      ),
    placeholderData: keepPreviousData,
  });

  const staffName = (id: string | null) => {
    if (!id) return 'Unassigned';
    const s = q.data?.staff.find((x) => x.id === id);
    return s ? [s.first_name, s.last_name].filter(Boolean).join(' ') : 'Staff';
  };
  const items: Item[] = [
    ...(q.data?.appointments ?? []).map((a): Item => ({
      kind: 'appointment',
      key: a.id,
      start: a.scheduled_start,
      end: a.scheduled_end,
      employeeId: a.employee_id,
      a,
    })),
    ...(q.data?.busy ?? []).map((b, i): Item => ({
      kind: 'busy',
      key: `busy-${i}`,
      start: b.scheduled_start,
      end: b.scheduled_end,
      employeeId: b.employee_id,
    })),
    ...(q.data?.time_off ?? []).map((t): Item => ({
      kind: 'off',
      key: `off-${t.id}`,
      start: t.starts_at,
      end: t.ends_at,
      employeeId: t.employee_id,
      reason: t.reason,
    })),
  ];
  /** Working intervals of one staff member on one day, in minutes; undefined when they have no hours set. */
  const openFor = (employeeId: string, day: string): [number, number][] | undefined =>
    q.data?.staff_with_hours.includes(employeeId)
      ? q.data.shifts
          .filter((sh) => sh.employee_id === employeeId)
          .map((sh) => ({ start: sh.starts_at, end: sh.ends_at }))
          .filter((sh) => overlapsDay(sh, day, zone))
          .map((sh) => clip(sh, day, zone))
      : undefined;
  /** "8:00–4:00", "Not working", or nothing when they have no hours set. */
  const hoursLabel = (employeeId: string, day: string) => {
    const open = openFor(employeeId, day);
    if (!open) return undefined;
    if (!open.length) return 'Not working';
    return `${shortClock(Math.min(...open.map(([s]) => s)))}–${shortClock(Math.max(...open.map(([, e]) => e)))}`;
  };
  const step = (n: number) =>
    set({
      date: view === 'month' ? addMonths(anchor, n) : addDays(anchor, n * (view === 'week' ? 7 : 1)),
    });
  const openDay = (day: string) => set({ view: 'day', date: day });
  // Upcoming bookings in view that nobody is assigned to (requests from the website or the assistant).
  const needsReview = (q.data?.appointments ?? [])
    .filter((a) => !a.employee_id && new Date(a.scheduled_end).getTime() > Date.now() && !['cancelled', 'completed', 'no_show'].includes(a.status))
    .sort((x, y) => x.scheduled_start.localeCompare(y.scheduled_start));
  const firstReview = needsReview[0];
  const navButton = 'press grid h-9 min-w-9 place-items-center rounded-lg border border-slate-300 bg-white px-2.5 text-sm font-semibold hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:hover:bg-slate-800';
  const rail = 'rounded-xl border border-slate-200 bg-white p-4 shadow-xs dark:border-slate-800 dark:bg-slate-900';

  return (
    <main className="px-4 py-6 sm:px-8">
      <header className="mb-5 flex flex-wrap items-center gap-x-4 gap-y-3">
        <h1 className="text-2xl font-bold tracking-tight">Calendar</h1>
        <div className="flex items-center gap-1.5">
          <button className={navButton} aria-label={`Previous ${view}`} onClick={() => step(-1)}>
            <Chevron dir="left" />
          </button>
          <button className={navButton} onClick={() => set({ date: '' })}>
            Today
          </button>
          <button className={navButton} aria-label={`Next ${view}`} onClick={() => step(1)}>
            <Chevron dir="right" />
          </button>
        </div>
        <h2 className="font-semibold" aria-live="polite">
          {label} <span className="ml-1.5 text-sm font-normal text-slate-500">{zoneLabel(zone)}</span>
        </h2>
        {q.isFetching && <Spinner />}
        <div className="ml-auto flex flex-wrap items-center gap-3">
          <div role="tablist" aria-label="View" className="flex rounded-lg bg-slate-100 p-1 dark:bg-slate-800">
            {(['day', 'week', 'month'] as const).map((v) => (
              <button
                key={v}
                role="tab"
                aria-selected={view === v}
                onClick={() => set({ view: v })}
                className={`press rounded-md px-3.5 py-1.5 text-sm font-semibold capitalize ${view === v ? 'bg-white text-slate-900 shadow-xs dark:bg-slate-950 dark:text-slate-100' : 'text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100'}`}
              >
                {v}
              </button>
            ))}
          </div>
          {can('create', 'appointments') && <Button onClick={() => setBooking(true)}>Book appointment</Button>}
        </div>
      </header>
      <AppointmentTypesDialog open={typesOpen} onClose={() => setTypesOpen(false)} />
      <BookDialog open={booking} onClose={() => setBooking(false)} />

      <div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-[14rem_minmax(0,1fr)]">
        <aside className="order-last grid gap-4 sm:grid-cols-2 lg:order-first lg:grid-cols-1" aria-label="Calendar filters">
          <fieldset className={rail}>
            <legend className="float-left mb-2 w-full text-sm font-semibold">Location</legend>
            <div className="clear-both grid gap-2 text-sm">
              {[{ id: '', name: 'All locations' }, ...(locations.data ?? [])].map((l) => (
                <label key={l.id} className="flex items-center gap-2.5">
                  <input type="radio" name="location" checked={locationId === l.id} onChange={() => set({ location: l.id, staff: '' })} /> {l.name}
                </label>
              ))}
            </div>
          </fieldset>
          <div className={rail}>
            <label className="mb-2 block text-sm font-semibold" htmlFor="calendar-staff">
              Staff
            </label>
            <Select id="calendar-staff" value={staffId} onChange={(e) => set({ staff: e.target.value })}>
              <option value="">Everyone</option>
              {me && <option value={me.profile.id}>Me</option>}
              {q.data?.staff
                .filter((s) => s.id !== me?.profile.id)
                .map((s) => (
                  <option key={s.id} value={s.id}>
                    {staffName(s.id)}
                  </option>
                ))}
            </Select>
            <Link to="/staff/schedule" className="mt-3 inline-block text-sm font-semibold text-brand-700 hover:underline dark:text-brand-600">
              Hours &amp; time off →
            </Link>
          </div>
          <div className={rail}>
            <div className="mb-2 flex items-center justify-between gap-2">
              <h3 className="text-sm font-semibold">Services</h3>
              <button onClick={() => setTypesOpen(true)} className="press text-xs font-semibold text-brand-700 hover:underline dark:text-brand-600">
                Edit
              </button>
            </div>
            <ul className="grid gap-2 text-sm">
              {types.data?.map((t) => (
                <li key={t.id} className="flex items-center gap-2.5">
                  <span className="size-2.5 shrink-0 rounded-sm" style={{ backgroundColor: t.color }} aria-hidden="true" /> {t.name}
                </li>
              ))}
            </ul>
            <ul className="mt-3 grid gap-1.5 border-t border-slate-100 pt-3 text-xs text-slate-500 dark:border-slate-800" aria-label="Legend">
              <li className="flex items-center gap-2">
                <span className={`size-3 rounded ${STRIPES_BUSY}`} /> Busy (a booking you can't open)
              </li>
              <li className="flex items-center gap-2">
                <span className="size-3 rounded border border-dashed border-violet-300 bg-violet-50 dark:border-violet-700 dark:bg-violet-950/60" /> Time off
              </li>
              <li className="flex items-center gap-2">
                <span className={`size-3 rounded border border-slate-200 dark:border-slate-700 ${STRIPES_OFF}`} /> Not working
              </li>
            </ul>
          </div>
          {firstReview && (
            <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm dark:border-amber-900 dark:bg-amber-950/50">
              <h3 className="mb-1 font-semibold">Needs review · {needsReview.length}</h3>
              <p className="text-slate-700 dark:text-slate-300">
                {firstReview.customer_name ?? 'A visitor'} booked {article(firstReview.type_name)} {firstReview.type_name.toLowerCase()} on{' '}
                {new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: zone }).format(new Date(firstReview.scheduled_start))}{' '}
                with no one assigned.
              </p>
              <button
                onClick={() => set({ view: 'day', date: dayIn(firstReview.scheduled_start, zone), staff: '' })}
                className="press mt-2 font-semibold text-brand-700 hover:underline dark:text-brand-600"
              >
                Assign staff →
              </button>
            </div>
          )}
        </aside>

        <div className="min-w-0">
          {q.error && <ErrorBanner error={q.error} />}
          {!q.data && q.isLoading ? (
            <Spinner />
          ) : view === 'month' ? (
            <MonthGrid days={days} month={anchor.slice(0, 7)} items={items} zone={zone} staffName={staffName} onOpenDay={openDay} />
          ) : (
            <TimeGrid
              columns={
                view === 'week'
                  ? days.map((d) => ({
                      key: d,
                      label: dayLabel(d, view),
                      day: d,
                      items: items.filter((it) => overlapsDay(it, d, zone)),
                      onOpen: () => openDay(d),
                      open: staffId ? openFor(staffId, d) : undefined,
                    }))
                  : staffColumns(q.data, items, staffId).map((c, i) => {
                      const unassigned = c.id === UNASSIGNED;
                      const name = staffName(unassigned ? null : c.id);
                      return {
                        key: c.id,
                        label: name,
                        sub: unassigned ? 'Requests' : hoursLabel(c.id, days[0]),
                        avatar: { text: unassigned ? '?' : initialsOf(name), tone: unassigned ? 'bg-slate-400' : AVATAR[i % AVATAR.length] },
                        day: days[0],
                        items: c.items,
                        open: unassigned ? undefined : openFor(c.id, days[0]),
                      };
                    })
              }
              zone={zone}
              staffName={view === 'week' ? staffName : undefined}
              emptyNote={view === 'day' && !items.length ? 'Nothing booked this day.' : undefined}
            />
          )}
        </div>
      </div>
    </main>
  );
}

/** The dashboard's booking form in a dialog. */
function BookDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onClick={(e) => e.target === ref.current && onClose()}
      aria-label="Book appointment"
      className="m-auto w-[min(36rem,calc(100vw-2rem))] rounded-xl bg-transparent p-0 text-slate-900 backdrop:bg-slate-950/40 dark:text-slate-100"
    >
      <div className="relative">
        <button type="button" onClick={onClose} aria-label="Close" className="press absolute top-3 right-3 z-10 rounded-full p-1 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800">
          <X className="size-4" aria-hidden="true" />
        </button>
        {open && <BookAppointment />}
      </div>
    </dialog>
  );
}

const STRIPES_BUSY =
  'border border-slate-300 bg-[repeating-linear-gradient(135deg,var(--color-slate-100)_0_6px,var(--color-slate-200)_6px_12px)] dark:border-slate-700 dark:bg-[repeating-linear-gradient(135deg,var(--color-slate-800)_0_6px,var(--color-slate-900)_6px_12px)]';
const STRIPES_OFF =
  'bg-[repeating-linear-gradient(135deg,var(--color-slate-50)_0_8px,var(--color-slate-100)_8px_16px)] dark:bg-[repeating-linear-gradient(135deg,var(--color-slate-950)_0_8px,var(--color-slate-900)_8px_16px)]';

const initialsOf = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0])
    .join('')
    .toUpperCase() || '?';
const article = (word: string) => (/^[aeiou]/i.test(word) ? 'an' : 'a');

// Time grids (day and week) -----------------------------------------------------------------------

interface Column {
  key: string;
  label: string;
  /** Day view: the staff member's hours that day ("8:00–4:00", "Not working") or "Requests". */
  sub?: string;
  avatar?: { text: string; tone: string };
  day: string;
  items: Item[];
  onOpen?: () => void;
  /** Working intervals (minutes) when this column belongs to someone with hours set: the rest is striped. */
  open?: [number, number][];
}

function TimeGrid({ columns, zone, staffName, emptyNote }: { columns: Column[]; zone: string; staffName?: (id: string | null) => string; emptyNote?: string }) {
  const now = useNow();
  const today = todayIn(zone);
  // 8 AM to 8 PM, widened to fit anything booked earlier or later.
  let first = 8;
  let last = 20;
  for (const c of columns) {
    // Time off (often whole days) does not widen the grid; it is cut to it below.
    for (const [s, e] of [...c.items.filter((it) => it.kind !== 'off').map((it) => clip(it, c.day, zone)), ...(c.open ?? [])]) {
      first = Math.min(first, Math.floor(s / 60));
      last = Math.max(last, Math.ceil(e / 60));
    }
  }
  const hours = Array.from({ length: last - first }, (_, i) => first + i);
  const height = hours.length * HOUR_PX;
  const minutesNow = minutesIn(now.toISOString(), zone);
  const top = (m: number) => ((m - first * 60) / 60) * HOUR_PX;

  return (
    <div className="isolate overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-xs dark:border-slate-800 dark:bg-slate-900">
      <div
        className="grid min-w-fit"
        style={{
          gridTemplateColumns: `4rem repeat(${columns.length}, minmax(${columns.length > 4 ? 7 : 10}rem, 1fr))`,
        }}
      >
        <div className="sticky left-0 z-30 border-b border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900" />
        {columns.map((c) => (
          <div key={c.key} className="flex min-h-14 items-center gap-2.5 border-b border-l border-slate-200 px-3 py-2.5 text-sm dark:border-slate-800">
            {c.avatar && (
              <span className={`grid size-8 shrink-0 place-items-center rounded-full text-xs font-bold text-white ${c.avatar.tone}`} aria-hidden="true">
                {c.avatar.text}
              </span>
            )}
            {c.onOpen ? (
              <button
                onClick={c.onOpen}
                className={`press -mx-1 rounded-md px-1 py-0.5 font-semibold hover:bg-slate-100 dark:hover:bg-slate-800 ${c.day === today ? 'text-brand-700 dark:text-brand-600' : ''}`}
                title="Open this day"
              >
                {c.label}
              </button>
            ) : (
              <div className="min-w-0">
                <div className="truncate font-semibold">{c.label}</div>
                {c.sub && <div className="truncate text-xs text-slate-500">{c.sub}</div>}
              </div>
            )}
          </div>
        ))}

        <div className="sticky left-0 z-30 bg-white dark:bg-slate-900" style={{ height }}>
          {hours.map((h) => (
            <div key={h} className="relative text-right text-xs text-slate-500" style={{ height: HOUR_PX }}>
              <span className="absolute top-1.5 right-2">{hourLabel(h)}</span>
            </div>
          ))}
        </div>
        {columns.map((c, ci) => (
          <div key={c.key} className="relative border-l border-slate-200 dark:border-slate-800" style={{ height }}>
            {c.open && (
              <div className={`absolute inset-0 ${STRIPES_OFF}`} title="Outside working hours" aria-hidden="true">
                {c.open.length === 0 && <span className="absolute top-2 left-2 text-xs text-slate-500">Not working</span>}
                {c.open.map(([s, e]) => (
                  <div key={s} className="absolute inset-x-0 bg-white dark:bg-slate-900" style={{ top: top(s), height: ((e - s) / 60) * HOUR_PX }} />
                ))}
              </div>
            )}
            {hours.map((h) => (
              <div key={h} className="relative border-t border-slate-100 dark:border-slate-800/70" style={{ height: HOUR_PX }} />
            ))}
            {c.day === today && minutesNow >= first * 60 && minutesNow <= last * 60 && (
              <div className="pointer-events-none absolute inset-x-0 z-20 border-t-2 border-red-500" style={{ top: top(minutesNow) }} aria-hidden="true">
                {(ci === 0 || columns[ci - 1].day !== c.day) && <span className="absolute -top-[5px] -left-1 size-2 rounded-full bg-red-500" />}
              </div>
            )}
            {layout(c.items, c.day, zone).map(({ item, lane, lanes }) => {
              const [cs, ce] = clip(item, c.day, zone);
              const s = Math.max(cs, first * 60);
              const e = Math.min(ce, last * 60);
              const style: CSSProperties = {
                top: top(s) + 2,
                height: Math.max(((e - s) / 60) * HOUR_PX - 4, 22),
                left: `calc(${(lane / lanes) * 100}% + 4px)`,
                width: `calc(${100 / lanes}% - 8px)`,
              };
              return <Block key={item.key} item={item} zone={zone} style={style} staffName={staffName} />;
            })}
          </div>
        ))}
      </div>
      {emptyNote && <p className="border-t border-slate-200 py-3 text-center text-sm text-slate-500 dark:border-slate-800">{emptyNote}</p>}
    </div>
  );
}

const STATUS_NOTE: Record<string, string> = { confirmed: 'confirmed', completed: 'done', no_show: 'no-show', checked_in: 'checked in' };

function Block({ item, zone, style, staffName }: { item: Item; zone: string; style: CSSProperties; staffName?: (id: string | null) => string }) {
  const when = `${clock(item.start, zone)} – ${clock(item.end, zone)}`;
  if (item.kind === 'off') {
    const who = staffName?.(item.employeeId);
    return (
      <div
        style={style}
        title={`Time off${item.reason ? `: ${item.reason}` : ''}${who ? ` · ${who}` : ''}`}
        className="absolute z-10 overflow-hidden rounded-md border border-dashed border-violet-300 bg-violet-50 px-2 py-1 text-xs text-violet-900 dark:border-violet-700 dark:bg-violet-950/60 dark:text-violet-100"
      >
        <p className="font-semibold">Time off</p>
        <p className="truncate">{[who, item.reason].filter(Boolean).join(' · ')}</p>
      </div>
    );
  }
  if (item.kind === 'busy') {
    const who = staffName?.(item.employeeId);
    return (
      <div style={style} title={`Busy ${when}${who ? ` · ${who}` : ''} (a booking you cannot open)`} className={`absolute z-10 overflow-hidden rounded-md px-2 py-1 text-xs text-slate-600 dark:text-slate-300 ${STRIPES_BUSY}`}>
        <p className="font-semibold">Busy</p>
        <p className="truncate">
          {who ? `${who} · ` : ''}
          {when}
        </p>
      </div>
    );
  }
  const a = item.a;
  const who = staffName ? (a.employee_name ?? 'Unassigned') : null;
  const note = a.employee_id ? STATUS_NOTE[a.status] : 'requested';
  return (
    <Link
      to={appointmentLink(a)}
      style={{ ...style, '--c': a.type_color } as CSSProperties}
      title={`${a.type_name} · ${a.service_name} · ${a.customer_name ?? a.appointment_number} · ${when}${a.employee_name ? ` · ${a.employee_name}` : ''} · ${a.location_name} · ${a.status}`}
      className={`press absolute z-10 overflow-hidden rounded-md px-2 py-1 text-xs text-slate-900 hover:z-30 hover:shadow-md dark:text-slate-100 ${
        a.employee_id
          ? 'border-l-[3px] border-[var(--c)] bg-[color-mix(in_srgb,var(--c)_13%,white)] hover:bg-[color-mix(in_srgb,var(--c)_20%,white)] dark:bg-[color-mix(in_srgb,var(--c)_24%,var(--color-slate-900))]'
          : 'border-2 border-dashed border-amber-400 bg-amber-50 hover:bg-amber-100 dark:border-amber-700 dark:bg-amber-950/60'
      } ${a.status === 'completed' ? 'opacity-70' : ''} ${a.status === 'no_show' ? 'line-through decoration-slate-400' : ''}`}
    >
      <p className="truncate font-semibold">{a.customer_name ?? a.appointment_number}</p>
      <p className="truncate text-slate-600 dark:text-slate-300">{[clock(item.start, zone), a.service_name, note].filter(Boolean).join(' · ')}</p>
      {who && <p className="truncate text-slate-500">{who}</p>}
    </Link>
  );
}

/** Where an appointment opens: its customer, or the sales calls page for a sales call. */
const appointmentLink = (a: CalendarAppointment) => (a.customer_id ? `/staff/customers/${a.customer_id}` : `/staff/sales-calls?call=${a.id}`);

/** Day view columns: each staff member (or the one picked), plus "Unassigned" when something is. */
function staffColumns(data: CalendarData | undefined, items: Item[], staffId: string) {
  const staff = (data?.staff ?? []).filter((s) => !staffId || s.id === staffId);
  const ids = new Set(staff.map((s) => s.id));
  // Someone booked here but not on this location's list (another location's staff) still gets a column.
  for (const it of items) if (it.employeeId && !ids.has(it.employeeId) && (!staffId || it.employeeId === staffId)) ids.add(it.employeeId);
  const columns = [...ids].map((id) => ({
    id,
    items: items.filter((it) => it.employeeId === id),
  }));
  const unassigned = items.filter((it) => !it.employeeId);
  if (!staffId && unassigned.length) columns.push({ id: UNASSIGNED, items: unassigned });
  return columns;
}

/** Side-by-side lanes for overlapping blocks within one column. */
function layout(items: Item[], day: string, zone: string) {
  const sorted = [...items].sort((x, y) => x.start.localeCompare(y.start) || y.end.localeCompare(x.end));
  const out: { item: Item; lane: number; lanes: number }[] = [];
  let cluster: { item: Item; lane: number; lanes: number }[] = [];
  let laneEnds: number[] = [];
  let clusterEnd = -1;
  const flush = () => {
    for (const c of cluster) c.lanes = laneEnds.length;
    out.push(...cluster);
    cluster = [];
    laneEnds = [];
  };
  for (const item of sorted) {
    const [s, e] = clip(item, day, zone);
    if (s >= clusterEnd) flush();
    let lane = laneEnds.findIndex((end) => end <= s);
    if (lane < 0) lane = laneEnds.push(e) - 1;
    else laneEnds[lane] = e;
    cluster.push({ item, lane, lanes: 1 });
    clusterEnd = Math.max(clusterEnd, e);
  }
  flush();
  return out;
}

// Month grid --------------------------------------------------------------------------------------

function MonthGrid({
  days,
  month,
  items,
  zone,
  staffName,
  onOpenDay,
}: {
  days: string[];
  month: string;
  items: Item[];
  zone: string;
  staffName: (id: string | null) => string;
  onOpenDay: (day: string) => void;
}) {
  const today = todayIn(zone);
  const SHOWN = 3;
  return (
    <div className="isolate overflow-x-auto rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
      <div className="grid min-w-[44rem] grid-cols-7">
        {days.slice(0, 7).map((d) => (
          <div
            key={d}
            className="border-b border-slate-200 px-2 py-2 text-center text-xs font-semibold uppercase tracking-wide text-slate-500 dark:border-slate-800"
          >
            {new Intl.DateTimeFormat(undefined, {
              weekday: 'short',
              timeZone: 'UTC',
            }).format(utc(d))}
          </div>
        ))}
        {days.map((d, i) => {
          // Bookings on the day they start; time off on every day it covers.
          const dayItems = items
            .filter((it) => (it.kind === 'off' ? overlapsDay(it, d, zone) : dayIn(it.start, zone) === d))
            .sort((x, y) => x.start.localeCompare(y.start));
          const inMonth = d.startsWith(month);
          return (
            <div
              key={d}
              className={`min-h-28 border-slate-200 p-1.5 dark:border-slate-800 ${i % 7 ? 'border-l' : ''} ${i >= 7 ? 'border-t' : ''} ${inMonth ? '' : 'bg-slate-50 dark:bg-slate-950/40'}`}
            >
              <button
                onClick={() => onOpenDay(d)}
                aria-label={`Open ${dayLabel(d, 'day')}`}
                className={`press mb-1 flex size-7 items-center justify-center rounded-full text-sm ${
                  d === today
                    ? 'btn-gradient font-semibold'
                    : inMonth
                      ? 'hover:bg-slate-100 dark:hover:bg-slate-800'
                      : 'text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800'
                }`}
              >
                {Number(d.slice(8))}
              </button>
              <ul className="space-y-0.5">
                {dayItems.slice(0, SHOWN).map((it) => (
                  <li key={it.key}>
                    {it.kind === 'appointment' ? (
                      <Link
                        to={appointmentLink(it.a)}
                        title={`${it.a.type_name} · ${it.a.service_name} · ${it.a.customer_name ?? it.a.appointment_number} · ${it.a.employee_name ?? 'Unassigned'}`}
                        className="press block truncate rounded px-1 py-0.5 text-xs hover:bg-brand-50 dark:hover:bg-slate-800"
                      >
                        <span
                          className={`mr-1 inline-block size-1.5 rounded-full align-middle ${it.a.status === 'completed' ? 'opacity-50' : ''}`}
                          style={{ backgroundColor: it.a.type_color }}
                        />
                        <span className="font-medium">{clock(it.start, zone)}</span> {it.a.customer_name ?? it.a.service_name}
                      </Link>
                    ) : it.kind === 'off' ? (
                      <p className="truncate px-1 py-0.5 text-xs text-violet-800 dark:text-violet-200" title={`Time off${it.reason ? `: ${it.reason}` : ''}`}>
                        <span className="mr-1 inline-block size-1.5 rounded-full bg-violet-400 align-middle" />
                        Time off · {staffName(it.employeeId)}
                      </p>
                    ) : (
                      <p className="truncate px-1 py-0.5 text-xs text-slate-500" title="A booking you cannot open">
                        <span className="mr-1 inline-block size-1.5 rounded-full bg-slate-400 align-middle" />
                        <span className="font-medium">{clock(it.start, zone)}</span> Busy · {staffName(it.employeeId)}
                      </p>
                    )}
                  </li>
                ))}
              </ul>
              {dayItems.length > SHOWN && (
                <button
                  onClick={() => onOpenDay(d)}
                  className="press mt-0.5 rounded px-1 text-xs font-medium text-brand-700 hover:underline dark:text-brand-600"
                >
                  +{dayItems.length - SHOWN} more
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Chevron({ dir }: { dir: 'left' | 'right' }) {
  return (
    <svg
      viewBox="0 0 20 20"
      className="size-4"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={dir === 'left' ? 'M12 4l-6 6 6 6' : 'M8 4l6 6-6 6'} />
    </svg>
  );
}

// Dates: days are 'YYYY-MM-DD' strings on the viewer's wall clock --------------------------------

const utc = (day: string) => new Date(`${day}T00:00:00Z`);
const addDays = (day: string, n: number) => new Date(utc(day).getTime() + n * 86_400_000).toISOString().slice(0, 10);
function addMonths(day: string, n: number) {
  const d = utc(day);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1)).toISOString().slice(0, 10);
}
const startOfWeek = (day: string) => addDays(day, -utc(day).getUTCDay()); // weeks start on Sunday

function rangeFor(view: View, anchor: string): { days: string[]; label: string } {
  const fmt = (o: Intl.DateTimeFormatOptions, d: string) => new Intl.DateTimeFormat(undefined, { ...o, timeZone: 'UTC' }).format(utc(d));
  if (view === 'day')
    return {
      days: [anchor],
      label: fmt({ weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }, anchor),
    };
  if (view === 'week') {
    const start = startOfWeek(anchor);
    const days = Array.from({ length: 7 }, (_, i) => addDays(start, i));
    return {
      days,
      label: `${fmt({ month: 'short', day: 'numeric' }, days[0])} – ${fmt({ month: 'short', day: 'numeric', year: 'numeric' }, days[6])}`,
    };
  }
  // Month: six full weeks around it (42 days; the API allows 45).
  const start = startOfWeek(`${anchor.slice(0, 7)}-01`);
  return {
    days: Array.from({ length: 42 }, (_, i) => addDays(start, i)),
    label: fmt({ month: 'long', year: 'numeric' }, anchor),
  };
}

function dayLabel(day: string, view: View) {
  return new Intl.DateTimeFormat(
    undefined,
    view === 'day' ? { weekday: 'long', month: 'short', day: 'numeric', timeZone: 'UTC' } : { weekday: 'short', day: 'numeric', timeZone: 'UTC' },
  ).format(utc(day));
}

/** The wall-clock day of an instant in `zone`. */
const dayIn = (iso: string, zone: string) =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(iso));

/** Minutes after midnight on the wall clock in `zone`. */
function minutesIn(iso: string, zone: string) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      hour: 'numeric',
      minute: 'numeric',
    })
      .formatToParts(new Date(iso))
      .map((x) => [x.type, Number(x.value)]),
  );
  return p.hour * 60 + p.minute;
}

function overlapsDay(it: { start: string; end: string }, day: string, zone: string) {
  return dayIn(it.start, zone) <= day && dayIn(new Date(new Date(it.end).getTime() - 1).toISOString(), zone) >= day;
}

/** [start, end] minutes of an item within one day (cut at midnight). */
function clip(it: { start: string; end: string }, day: string, zone: string): [number, number] {
  const s = dayIn(it.start, zone) < day ? 0 : minutesIn(it.start, zone);
  const e = dayIn(it.end, zone) > day ? 24 * 60 : minutesIn(it.end, zone);
  return [s, Math.max(e, s + 15)];
}

const clock = (iso: string, zone: string) =>
  new Intl.DateTimeFormat(undefined, {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: zone,
  }).format(new Date(iso));
/** 480 → "8:00", 1020 → "5:00" (12-hour, no AM/PM: the column reads as a shift). */
const shortClock = (m: number) => `${((Math.floor(m / 60) + 11) % 12) + 1}:${String(m % 60).padStart(2, '0')}`;
/** "EST (New York)". */
function zoneLabel(zone: string) {
  const abbr = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'short' }).formatToParts(new Date()).find((p) => p.type === 'timeZoneName')?.value;
  const city = zone.split('/').pop()?.replaceAll('_', ' ');
  return abbr && city && abbr !== zone ? `${abbr} (${city})` : zone.replaceAll('_', ' ');
}
const hourLabel = (h: number) =>
  new Intl.DateTimeFormat(undefined, {
    hour: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(2000, 0, 1, h)));

/** The current time, refreshed every minute (for the "now" line). */
function useNow() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(t);
  }, []);
  return now;
}
