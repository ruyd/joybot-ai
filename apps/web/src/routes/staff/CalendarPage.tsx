import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useEffect, useState, type CSSProperties } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Page } from '../../components/Layout';
import { AppointmentTypesDialog, TypeDot, useAppointmentTypes } from '../../components/AppointmentTypes';
import { Button, ErrorBanner, PageHeader, Select, Spinner } from '../../components/ui';
import { useApi } from '../../lib/api';
import { preferredTimeZone, todayIn, zonedToIso } from '../../lib/format';
import { useMe } from '../../lib/me';

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

const HOUR_PX = 48;
const UNASSIGNED = 'unassigned';

/**
 * Calendar: appointments and staff busy times by day (a column per staff member), week or month,
 * in the viewer's time zone. Colleagues' bookings the viewer cannot open show as "Busy".
 * The view, date, location and staff member live in the URL.
 */
export function CalendarPage() {
  const [typesOpen, setTypesOpen] = useState(false);
  const api = useApi();
  const { me } = useMe();
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
  const step = (n: number) =>
    set({
      date: view === 'month' ? addMonths(anchor, n) : addDays(anchor, n * (view === 'week' ? 7 : 1)),
    });
  const openDay = (day: string) => set({ view: 'day', date: day });

  return (
    <Page>
      <PageHeader
        title="Calendar"
        description={`Appointments, busy times and working hours, in your time zone (${zone.replaceAll('_', ' ')}).`}
        actions={
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" size="sm" onClick={() => setTypesOpen(true)}>
              Appointment types
            </Button>
            <Link to="/staff/schedule" className="press btn-outline-gradient rounded-full px-3.5 py-1.5 text-sm font-semibold text-brand-700 dark:text-brand-600">
              Hours &amp; time off
            </Link>
          </div>
        }
      />
      <AppointmentTypesDialog open={typesOpen} onClose={() => setTypesOpen(false)} />
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Button variant="secondary" size="sm" onClick={() => set({ date: '' })}>
          Today
        </Button>
        <div className="flex items-center">
          <Button variant="ghost" size="sm" aria-label={`Previous ${view}`} onClick={() => step(-1)}>
            <Chevron dir="left" />
          </Button>
          <Button variant="ghost" size="sm" aria-label={`Next ${view}`} onClick={() => step(1)}>
            <Chevron dir="right" />
          </Button>
        </div>
        <h2 className="min-w-48 text-lg font-semibold" aria-live="polite">
          {label}
        </h2>
        {q.isFetching && <Spinner />}
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <div role="tablist" aria-label="View" className="flex rounded-full bg-slate-100 p-0.5 dark:bg-slate-800">
            {(['day', 'week', 'month'] as const).map((v) => (
              <button
                key={v}
                role="tab"
                aria-selected={view === v}
                onClick={() => set({ view: v })}
                className={`press rounded-full px-3 py-1 text-sm capitalize ${view === v ? 'btn-gradient font-medium' : 'text-slate-600 hover:text-brand-700 dark:text-slate-300 dark:hover:text-brand-600'}`}
              >
                {v}
              </button>
            ))}
          </div>
          <div className="w-44">
            <Select aria-label="Location" value={locationId} onChange={(e) => set({ location: e.target.value, staff: '' })}>
              <option value="">All locations</option>
              {locations.data?.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </Select>
          </div>
          <div className="w-44">
            <Select aria-label="Staff" value={staffId} onChange={(e) => set({ staff: e.target.value })}>
              <option value="">All staff</option>
              {me && <option value={me.profile.id}>Me</option>}
              {q.data?.staff
                .filter((s) => s.id !== me?.profile.id)
                .map((s) => (
                  <option key={s.id} value={s.id}>
                    {staffName(s.id)}
                  </option>
                ))}
            </Select>
          </div>
        </div>
      </div>

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
              : staffColumns(q.data, items, staffId).map((c) => ({
                  key: c.id,
                  label: staffName(c.id === UNASSIGNED ? null : c.id),
                  day: days[0],
                  items: c.items,
                  open: c.id === UNASSIGNED ? undefined : openFor(c.id, days[0]),
                }))
          }
          zone={zone}
          staffName={view === 'week' ? staffName : undefined}
          emptyNote={view === 'day' && !items.length ? 'Nothing booked this day.' : undefined}
        />
      )}
      <Legend />
    </Page>
  );
}

// Time grids (day and week) -----------------------------------------------------------------------

interface Column {
  key: string;
  label: string;
  day: string;
  items: Item[];
  onOpen?: () => void;
  /** Working intervals (minutes) when this column belongs to someone with hours set: the rest is shaded. */
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

  return (
    <div className="isolate overflow-x-auto rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
      <div
        className="grid min-w-fit"
        style={{
          gridTemplateColumns: `4rem repeat(${columns.length}, minmax(${columns.length > 4 ? 6 : 9}rem, 1fr))`,
        }}
      >
        <div className="sticky left-0 z-10 border-b border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900" />
        {columns.map((c) => (
          <div
            key={c.key}
            className={`border-b border-l border-slate-200 px-2 py-2 text-center text-sm dark:border-slate-800 ${c.day === today && c.onOpen ? 'text-brand-700 dark:text-brand-600' : ''}`}
          >
            {c.onOpen ? (
              <button
                onClick={c.onOpen}
                className="press rounded-full px-2 py-0.5 font-medium hover:bg-slate-100 dark:hover:bg-slate-800"
                title="Open this day"
              >
                {c.label}
              </button>
            ) : (
              <span className="font-medium">{c.label}</span>
            )}
          </div>
        ))}

        <div className="sticky left-0 z-10 bg-white dark:bg-slate-900" style={{ height }}>
          {hours.map((h) => (
            <div key={h} className="relative text-right text-xs text-slate-500" style={{ height: HOUR_PX }}>
              <span className="absolute -top-2 right-2">{h === first ? '' : hourLabel(h)}</span>
            </div>
          ))}
        </div>
        {columns.map((c) => (
          <div key={c.key} className="relative border-l border-slate-200 dark:border-slate-800" style={{ height }}>
            {c.open && (
              <div className="absolute inset-0 bg-slate-100 dark:bg-slate-950/60" title="Outside working hours" aria-hidden="true">
                {c.open.map(([s, e]) => (
                  <div
                    key={s}
                    className="absolute inset-x-0 bg-white dark:bg-slate-900"
                    style={{ top: ((s - first * 60) / 60) * HOUR_PX, height: ((e - s) / 60) * HOUR_PX }}
                  />
                ))}
              </div>
            )}
            {hours.map((h) => (
              <div key={h} className="relative border-t border-slate-100 dark:border-slate-800/70" style={{ height: HOUR_PX }} />
            ))}
            {c.day === today && minutesNow >= first * 60 && minutesNow <= last * 60 && (
              <div
                className="pointer-events-none absolute inset-x-0 z-20 border-t-2 border-red-500"
                style={{ top: ((minutesNow - first * 60) / 60) * HOUR_PX }}
                aria-hidden="true"
              >
                <span className="absolute -left-1 -top-[5px] size-2 rounded-full bg-red-500" />
              </div>
            )}
            {layout(c.items, c.day, zone).map(({ item, lane, lanes }) => {
              const [cs, ce] = clip(item, c.day, zone);
              const s = Math.max(cs, first * 60);
              const e = Math.min(ce, last * 60);
              const style: CSSProperties = {
                top: ((s - first * 60) / 60) * HOUR_PX + 1,
                height: Math.max(((e - s) / 60) * HOUR_PX - 2, 20),
                left: `calc(${(lane / lanes) * 100}% + 2px)`,
                width: `calc(${100 / lanes}% - 4px)`,
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

function Block({ item, zone, style, staffName }: { item: Item; zone: string; style: CSSProperties; staffName?: (id: string | null) => string }) {
  const when = `${clock(item.start, zone)} – ${clock(item.end, zone)}`;
  if (item.kind === 'off') {
    const who = staffName?.(item.employeeId);
    return (
      <div
        style={style}
        title={`Time off${item.reason ? `: ${item.reason}` : ''}${who ? ` · ${who}` : ''}`}
        className="absolute z-10 overflow-hidden rounded-md border border-dashed border-violet-300 bg-violet-50 px-1.5 py-0.5 text-xs text-violet-900 dark:border-violet-700 dark:bg-violet-950/60 dark:text-violet-100"
      >
        <p className="font-medium">Time off</p>
        <p className="truncate">{[who, item.reason].filter(Boolean).join(' · ')}</p>
      </div>
    );
  }
  if (item.kind === 'busy') {
    const who = staffName?.(item.employeeId);
    return (
      <div
        style={style}
        title={`Busy ${when}${who ? ` · ${who}` : ''} (a booking you cannot open)`}
        className="absolute z-10 overflow-hidden rounded-md border border-slate-300 bg-[repeating-linear-gradient(135deg,var(--color-slate-100)_0_6px,var(--color-slate-200)_6px_12px)] px-1.5 py-0.5 text-xs text-slate-600 dark:border-slate-700 dark:bg-[repeating-linear-gradient(135deg,var(--color-slate-800)_0_6px,var(--color-slate-900)_6px_12px)] dark:text-slate-300"
      >
        <p className="font-medium">Busy</p>
        <p className="truncate">
          {who ? `${who} · ` : ''}
          {when}
        </p>
      </div>
    );
  }
  const a = item.a;
  const who = staffName ? (a.employee_name ?? 'Unassigned') : null;
  return (
    <Link
      to={appointmentLink(a)}
      style={{ ...style, borderLeftColor: a.type_color }}
      title={`${a.type_name} · ${a.service_name} · ${a.customer_name ?? a.appointment_number} · ${when}${a.employee_name ? ` · ${a.employee_name}` : ''} · ${a.location_name} · ${a.status}`}
      className={`press absolute z-10 overflow-hidden rounded-md border-l-4 px-1.5 py-0.5 text-xs shadow-sm hover:z-30 hover:shadow-md ${TONE[a.status] ?? TONE.scheduled}`}
    >
      <p className="truncate font-semibold">{a.customer_name ?? a.appointment_number}</p>
      <p className="truncate">
        {a.service_name} · {clock(item.start, zone)}
      </p>
      {who && <p className="truncate opacity-80">{who}</p>}
    </Link>
  );
}

/** Where an appointment opens: its customer, or the sales calls page for a sales call. */
const appointmentLink = (a: CalendarAppointment) => (a.customer_id ? `/staff/customers/${a.customer_id}` : `/staff/sales-calls?call=${a.id}`);

const TONE: Record<string, string> = {
  scheduled: 'bg-brand-100 text-brand-900 hover:bg-brand-200 dark:bg-brand-900 dark:text-brand-100 dark:hover:bg-brand-800',
  confirmed: 'btn-gradient',
  completed: 'bg-slate-200 text-slate-700 hover:bg-slate-300 dark:bg-slate-700 dark:text-slate-100',
  no_show: 'bg-amber-100 text-amber-900 hover:bg-amber-200 dark:bg-amber-900/60 dark:text-amber-100',
};

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

function Legend() {
  const types = useAppointmentTypes();
  return (
    <ul className="mt-3 flex flex-wrap gap-4 text-xs text-slate-500" aria-label="Legend">
      {types.data?.map((t) => (
        <li key={t.id} className="flex items-center gap-1.5">
          <TypeDot color={t.color} /> {t.name}
        </li>
      ))}
      <li className="flex items-center gap-1.5">
        <span className="size-3 rounded bg-brand-100 dark:bg-brand-900" /> Scheduled
      </li>
      <li className="flex items-center gap-1.5">
        <span className="btn-gradient size-3 rounded" /> Confirmed
      </li>
      <li className="flex items-center gap-1.5">
        <span className="size-3 rounded bg-slate-200 dark:bg-slate-700" /> Completed
      </li>
      <li className="flex items-center gap-1.5">
        <span className="size-3 rounded border border-slate-300 bg-[repeating-linear-gradient(135deg,var(--color-slate-100)_0_3px,var(--color-slate-300)_3px_6px)] dark:border-slate-700" />{' '}
        Busy (a colleague's booking you cannot open)
      </li>
      <li className="flex items-center gap-1.5">
        <span className="size-3 rounded border border-dashed border-violet-300 bg-violet-50 dark:border-violet-700 dark:bg-violet-950/60" /> Time off
      </li>
      <li className="flex items-center gap-1.5">
        <span className="size-3 rounded border border-slate-300 bg-slate-100 dark:border-slate-700 dark:bg-slate-950/60" /> Outside working hours
      </li>
    </ul>
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
