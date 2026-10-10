import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { Page } from '../../components/Layout';
import { Badge, Button, Card, EmptyState, ErrorBanner, Field, Input, PageHeader, Select, Spinner, StatusBadge } from '../../components/ui';
import { ApiError, useApi } from '../../lib/api';
import { dateTime, fullName, money, preferredTimeZone, time, todayIn, zonedToIso } from '../../lib/format';
import { useMe } from '../../lib/me';
import type { Appointment } from '../portal/PortalPages';
import { CustomerPicker, type Customer } from './CustomerPicker';
import { RecordPayment } from './StaffPages';

/** Staff home: today's appointments on the left; customer lookup and payment capture on the right. */
export function StaffHome() {
  const { can, me } = useMe();
  const zone = preferredTimeZone(me?.profile.time_zone);
  const today = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric', timeZone: zone }).format(new Date());
  return (
    <Page>
      <PageHeader title="Today" description={today} />
      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_24rem]">
        {can('read', 'appointments') && <TodayAppointments zone={zone} />}
        <div className="grid gap-4">
          {can('read', 'customers') && <CustomerLookup />}
          {can('create', 'payments') && <RecordPayment title="Take a payment" />}
          {can('create', 'appointments') && <BookAppointment />}
        </div>
      </div>
    </Page>
  );
}

type StaffAppointment = Appointment & {
  customer_id: string;
  customer_name: string | null;
  customer_number: string | null;
  employee_id: string | null;
  scheduled_end: string | null;
};

/** Today in the viewer's time zone, as an ISO range for `from`/`to`. */
function todayRange(zone: string) {
  const day = todayIn(zone);
  const [y, m, d] = day.split('-').map(Number);
  const next = new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
  return { from: zonedToIso(day, '00:00', zone), to: zonedToIso(next, '00:00', zone) };
}

function TodayAppointments({ zone }: { zone: string }) {
  const api = useApi();
  const { me } = useMe();
  const [mine, setMine] = useState(false);
  const { from, to } = todayRange(zone);
  const q = useQuery({
    queryKey: ['appointments', 'today', from, mine],
    queryFn: () =>
      api.get<StaffAppointment[]>(`/appointments?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&limit=200${mine ? '&mine=true' : ''}`),
    refetchInterval: 60_000,
  });
  const now = Date.now();
  const nextId = q.data?.find((a) => new Date(a.scheduled_start).getTime() >= now && !['cancelled', 'no_show', 'completed'].includes(a.status))?.id;

  return (
    <Card
      title={`Today's appointments${q.data ? ` · ${q.data.length}` : ''}`}
      actions={
        me?.type === 'employee' && (
          <label className="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-300">
            <input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} /> Only mine
          </label>
        )
      }
    >
      {q.isLoading ? (
        <Spinner />
      ) : q.error ? (
        <ErrorBanner error={q.error} />
      ) : !q.data?.length ? (
        <EmptyState>{mine ? 'You have no appointments today.' : 'No appointments today.'}</EmptyState>
      ) : (
        <ol className="-my-2 divide-y divide-slate-100 dark:divide-slate-800">
          {q.data.map((a) => {
            const over = new Date(a.scheduled_end ?? a.scheduled_start).getTime() < now;
            const inactive = a.status === 'cancelled' || a.status === 'no_show';
            return (
              <li key={a.id} className={`flex gap-4 py-3 ${over || inactive ? 'opacity-60' : ''}`}>
                <div className="w-24 shrink-0 text-sm font-medium tabular-nums">
                  {time(a.scheduled_start, a.time_zone)}
                  {a.id === nextId && <div className="mt-1"><Badge tone="brand">next</Badge></div>}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    {a.customer_name || a.customer_number ? (
                      <Link to={`/staff/customers/${a.customer_id}`} className={`font-medium text-brand-600 hover:underline ${inactive ? 'line-through' : ''}`}>
                        {a.customer_name ?? a.customer_number}
                      </Link>
                    ) : (
                      <span className="font-medium text-slate-500">Customer not visible to you</span>
                    )}
                    <StatusBadge status={a.status} />
                  </div>
                  <p className="text-sm text-slate-500">
                    {[a.service_name, a.employee_name ?? 'Unassigned', a.location_name].join(' · ')}
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

function BookAppointment() {
  const api = useApi();
  const queryClient = useQueryClient();
  const { me } = useMe();
  const services = useQuery({ queryKey: ['services'], queryFn: () => api.get<Service[]>('/services') });
  const locations = useQuery({ queryKey: ['locations'], queryFn: () => api.get<Location[]>('/locations') });
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [serviceId, setServiceId] = useState('');
  const [locationId, setLocationId] = useState('');
  const [employeeId, setEmployeeId] = useState('');
  const [day, setDay] = useState('');
  const [clock, setClock] = useState('');
  const [conflicts, setConflicts] = useState<Conflict[] | null>(null);
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
        employee_id: employeeId || null,
        scheduled_start: zonedToIso(day, clock, location!.time_zone),
        confirm_overlap: confirm || undefined,
      }),
    onSuccess: (res) => {
      setBooked(res.appointment_number);
      setConflicts(null);
      setCustomer(null);
      setRound((r) => r + 1);
      setClock('');
      void queryClient.invalidateQueries({ queryKey: ['appointments'] });
    },
    onError: (err) => {
      if (err instanceof ApiError && err.body.code === 'employee_double_booked') setConflicts(err.body.conflicts as Conflict[]);
    },
  });

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    setBooked(null);
    setConflicts(null);
    book.mutate(false);
  };
  const zone = location ? time(zonedToIso(day || todayIn(location.time_zone), clock || '12:00', location.time_zone), location.time_zone).split(' ').pop() : '';

  return (
    <Card title="Book an appointment">
      <form onSubmit={onSubmit} className="grid gap-4">
        <Field label="Customer">
          <CustomerPicker key={round} value={customer} onChange={setCustomer} />
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
        {book.error && !conflicts && <ErrorBanner error={book.error} />}
        {booked && <p role="status" className="text-sm text-emerald-700">Booked as {booked}.</p>}
        <div>
          <Button type="submit" disabled={!customer || !location || (service && !service.duration_minutes) || book.isPending}>
            Book appointment
          </Button>
        </div>
      </form>
    </Card>
  );
}
