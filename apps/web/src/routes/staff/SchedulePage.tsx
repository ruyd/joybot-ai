import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Page } from '../../components/Layout';
import { Button, Card, EmptyState, ErrorBanner, Field, Input, PageHeader, Select, Spinner } from '../../components/ui';
import { useApi } from '../../lib/api';
import { preferredTimeZone, zonedToIso } from '../../lib/format';
import { useMe } from '../../lib/me';

interface StaffMember {
  id: string;
  first_name: string | null;
  last_name: string | null;
}

interface Interval {
  weekday: number;
  starts: string;
  ends: string;
}

interface Schedule {
  staff: StaffMember;
  locations: { id: string; name: string; time_zone: string }[];
  hours: (Interval & { location_id: string })[];
  time_off: { id: string; starts_at: string; ends_at: string; reason: string | null }[];
  can_edit: boolean;
}

const name = (s: StaffMember) => [s.first_name, s.last_name].filter(Boolean).join(' ') || 'Staff member';
// 2026-01-04 is a Sunday: weekday 0.
const WEEKDAYS = Array.from({ length: 7 }, (_, i) => new Intl.DateTimeFormat(undefined, { weekday: 'long', timeZone: 'UTC' }).format(new Date(Date.UTC(2026, 0, 4 + i))));

/**
 * Working hours (weekly, per location, on the location's clock) and time off for one staff member.
 * Everyone can look; staff change their own, admins anyone's. The calendar shades the time outside
 * the hours, and booking warns when someone is off or outside them.
 */
export function SchedulePage() {
  const api = useApi();
  const { me } = useMe();
  const [params, setParams] = useSearchParams();
  const staffId = params.get('staff') ?? me?.profile.id ?? '';
  const staff = useQuery({ queryKey: ['staff'], queryFn: () => api.get<StaffMember[]>('/staff') });
  const schedule = useQuery({ queryKey: ['schedule', staffId], queryFn: () => api.get<Schedule>(`/staff/${staffId}/schedule`), enabled: !!staffId });

  return (
    <Page>
      <PageHeader
        title="Working hours & time off"
        description="Booking warns when someone is off or outside their hours, and the calendar shades that time."
        actions={
          <Link to="/staff/calendar" className="press btn-outline-gradient rounded-full px-3.5 py-1.5 text-sm font-semibold text-brand-700 dark:text-brand-600">
            Calendar
          </Link>
        }
      />
      <div className="mb-4 w-64">
        <Field label="Staff member">
          <Select value={staffId} onChange={(e) => setParams(e.target.value === me?.profile.id ? {} : { staff: e.target.value }, { replace: true })}>
            {staff.data?.map((s) => (
              <option key={s.id} value={s.id}>
                {name(s)}
                {s.id === me?.profile.id ? ' (me)' : ''}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      {schedule.error && <ErrorBanner error={schedule.error} />}
      {schedule.isLoading || !schedule.data ? (
        <Spinner />
      ) : (
        <div className="grid items-start gap-4 lg:grid-cols-2">
          <WeeklyHours key={staffId} schedule={schedule.data} staffId={staffId} />
          <TimeOff schedule={schedule.data} staffId={staffId} />
        </div>
      )}
    </Page>
  );
}

function WeeklyHours({ schedule, staffId }: { schedule: Schedule; staffId: string }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const [locationId, setLocationId] = useState(schedule.locations[0]?.id ?? '');
  const location = schedule.locations.find((l) => l.id === locationId);
  const saved = schedule.hours.filter((h) => h.location_id === locationId);
  const [days, setDays] = useState<Interval[][]>(() => byDay(saved));
  const [done, setDone] = useState(false);
  // Switching location (or fresh data after saving) shows that location's hours.
  useEffect(() => setDays(byDay(schedule.hours.filter((h) => h.location_id === locationId))), [schedule.hours, locationId]);

  const save = useMutation({
    mutationFn: () => api.put(`/staff/${staffId}/hours`, { location_id: locationId, intervals: days.flat() }),
    onSuccess: () => {
      setDone(true);
      void queryClient.invalidateQueries({ queryKey: ['schedule', staffId] });
      void queryClient.invalidateQueries({ queryKey: ['calendar'] });
    },
  });
  const change = (weekday: number, next: Interval[]) => {
    setDone(false);
    setDays((all) => all.map((d, i) => (i === weekday ? next : d)));
  };
  const edit = schedule.can_edit;

  if (!schedule.locations.length) {
    return (
      <Card title="Weekly hours">
        <EmptyState>{name(schedule.staff)} is not assigned to a location yet.</EmptyState>
      </Card>
    );
  }
  return (
    <Card
      title="Weekly hours"
      actions={
        schedule.locations.length > 1 ? (
          <div className="w-48">
            <Select aria-label="Location" value={locationId} onChange={(e) => setLocationId(e.target.value)}>
              {schedule.locations.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </Select>
          </div>
        ) : (
          <span className="text-sm text-slate-500">{location?.name}</span>
        )
      }
    >
      <form
        className="space-y-1"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <p className="mb-2 text-sm text-slate-500">
          Times at {location?.name} ({location?.time_zone.replaceAll('_', ' ')}). No hours at all means no restriction.
        </p>
        {WEEKDAYS.map((label, weekday) => {
          const list = days[weekday];
          return (
            <div key={label} className="flex flex-wrap items-start gap-x-3 gap-y-1 border-t border-slate-100 py-2 first-of-type:border-t-0 dark:border-slate-800">
              <span className="w-28 pt-1.5 text-sm font-medium">{label}</span>
              <div className="flex flex-1 flex-col gap-1.5">
                {list.length === 0 && <span className="pt-1.5 text-sm text-slate-500">Off</span>}
                {list.map((iv, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <div className="w-32">
                      <Input
                        type="time"
                        aria-label={`${label} start`}
                        value={iv.starts}
                        disabled={!edit}
                        onChange={(e) => change(weekday, list.map((x, j) => (j === i ? { ...x, starts: e.target.value } : x)))}
                      />
                    </div>
                    <span className="text-slate-500">to</span>
                    <div className="w-32">
                      <Input
                        type="time"
                        aria-label={`${label} end`}
                        value={iv.ends}
                        disabled={!edit}
                        onChange={(e) => change(weekday, list.map((x, j) => (j === i ? { ...x, ends: e.target.value } : x)))}
                      />
                    </div>
                    {edit && (
                      <Button type="button" variant="ghost" size="sm" aria-label={`Remove ${label} hours`} onClick={() => change(weekday, list.filter((_, j) => j !== i))}>
                        Remove
                      </Button>
                    )}
                  </div>
                ))}
              </div>
              {edit && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => change(weekday, [...list, list.length ? { weekday, starts: '13:00', ends: '17:00' } : { weekday, starts: '09:00', ends: '17:00' }])}
                >
                  {list.length ? 'Add a split' : 'Add hours'}
                </Button>
              )}
            </div>
          );
        })}
        {edit && (
          <div className="flex flex-wrap items-center gap-2 pt-3">
            <Button type="submit" disabled={save.isPending}>
              Save hours
            </Button>
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                setDone(false);
                setDays((all) => all.map((d, i) => (i >= 2 && i <= 5 ? all[1].map((iv) => ({ ...iv, weekday: i })) : d)));
              }}
            >
              Copy Monday to Tue–Fri
            </Button>
            {done && (
              <span role="status" className="text-sm text-emerald-700 dark:text-emerald-400">
                Saved.
              </span>
            )}
          </div>
        )}
        {save.error && <ErrorBanner error={save.error} />}
      </form>
    </Card>
  );
}

function TimeOff({ schedule, staffId }: { schedule: Schedule; staffId: string }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const { me } = useMe();
  const zone = preferredTimeZone(me?.profile.time_zone);
  const [allDay, setAllDay] = useState(true);
  const [fromDay, setFromDay] = useState('');
  const [toDay, setToDay] = useState('');
  const [fromClock, setFromClock] = useState('09:00');
  const [toClock, setToClock] = useState('17:00');
  const [reason, setReason] = useState('');
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['schedule', staffId] });
    void queryClient.invalidateQueries({ queryKey: ['calendar'] });
  };
  const add = useMutation({
    mutationFn: () =>
      api.post(`/staff/${staffId}/time-off`, {
        starts_at: zonedToIso(fromDay, allDay ? '00:00' : fromClock, zone),
        // All day: through the end of the last day.
        ends_at: allDay ? zonedToIso(nextDay(toDay || fromDay), '00:00', zone) : zonedToIso(toDay || fromDay, toClock, zone),
        reason: reason.trim() || undefined,
      }),
    onSuccess: () => {
      setFromDay('');
      setToDay('');
      setReason('');
      refresh();
    },
  });
  const remove = useMutation({ mutationFn: (id: string) => api.del(`/time-off/${id}`), onSuccess: refresh });
  const edit = schedule.can_edit;

  return (
    <Card title="Time off">
      {schedule.time_off.length === 0 ? (
        <EmptyState>No time off coming up.</EmptyState>
      ) : (
        <ul className="-mt-1 mb-3 divide-y divide-slate-100 dark:divide-slate-800">
          {schedule.time_off.map((t) => (
            <li key={t.id} className="flex items-start justify-between gap-2 py-2.5 text-sm">
              <div>
                <p className="font-medium">{offLabel(t.starts_at, t.ends_at, zone)}</p>
                {t.reason && <p className="text-slate-500">{t.reason}</p>}
              </div>
              {edit && (
                <Button size="sm" variant="ghost" disabled={remove.isPending} onClick={() => remove.mutate(t.id)}>
                  Remove
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {remove.error && <ErrorBanner error={remove.error} />}
      {edit && (
        <form
          className="grid gap-3 border-t border-slate-200 pt-4 dark:border-slate-800"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            add.mutate();
          }}
        >
          <p className="text-sm font-medium">Add time off</p>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={allDay} onChange={(e) => setAllDay(e.target.checked)} /> All day
          </label>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="From">
              <Input type="date" required value={fromDay} onChange={(e) => setFromDay(e.target.value)} />
            </Field>
            <Field label={allDay ? 'To (last day off)' : 'To'}>
              <Input type="date" min={fromDay || undefined} value={toDay} onChange={(e) => setToDay(e.target.value)} placeholder="Same day" />
            </Field>
            {!allDay && (
              <>
                <Field label="Starting at">
                  <Input type="time" required value={fromClock} onChange={(e) => setFromClock(e.target.value)} />
                </Field>
                <Field label="Until">
                  <Input type="time" required value={toClock} onChange={(e) => setToClock(e.target.value)} />
                </Field>
              </>
            )}
          </div>
          <Field label="Reason (optional, shown only to you and admins)">
            <Input value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Vacation" />
          </Field>
          <p className="text-xs text-slate-500">Dates and times in your time zone ({zone.replaceAll('_', ' ')}).</p>
          {add.error && <ErrorBanner error={add.error} />}
          <div>
            <Button type="submit" disabled={!fromDay || add.isPending}>
              Add time off
            </Button>
          </div>
        </form>
      )}
    </Card>
  );
}

function byDay(hours: Interval[]): Interval[][] {
  return Array.from({ length: 7 }, (_, weekday) =>
    hours.filter((h) => h.weekday === weekday).map((h) => ({ weekday, starts: h.starts, ends: h.ends })),
  );
}

const nextDay = (day: string) => new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

/** "Wed, Oct 14", "Oct 14 – Oct 16" for whole days (in `zone`), else "Oct 14, 9:00 AM – 1:00 PM". */
function offLabel(startsAt: string, endsAt: string, zone: string) {
  const parts = (iso: string) => {
    const f = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso));
    return { day: f.slice(0, 10), clock: f.slice(-5) };
  };
  const s = parts(startsAt);
  const e = parts(endsAt);
  const day = (d: string) => new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(`${d}T00:00:00Z`));
  const time = (iso: string) => new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit', timeZone: zone }).format(new Date(iso));
  if (s.clock === '00:00' && e.clock === '00:00') {
    const last = new Date(Date.parse(`${e.day}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
    return last === s.day ? day(s.day) : `${day(s.day)} – ${day(last)}`;
  }
  return s.day === e.day ? `${day(s.day)}, ${time(startsAt)} – ${time(endsAt)}` : `${day(s.day)}, ${time(startsAt)} – ${day(e.day)}, ${time(endsAt)}`;
}
