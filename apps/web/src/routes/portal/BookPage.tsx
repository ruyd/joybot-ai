import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Page } from '../../components/Layout';
import { Badge, Button, Card, EmptyState, ErrorBanner, Field, Input, PageHeader, Select, Spinner } from '../../components/ui';
import { useApi } from '../../lib/api';
import { dateTime, money, todayIn, zonedToIso } from '../../lib/format';
import { useMe } from '../../lib/me';
import type { Appointment } from './PortalPages';

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
  address: string | null;
  time_zone: string;
}

export type CustomerAppointment = Appointment & { requested_by_customer: boolean; reviewed_at: string | null };

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
  const [day, setDay] = useState('');
  const [clock, setClock] = useState('');
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
  const minDay = location ? todayIn(location.time_zone) : undefined;

  const request = useMutation({
    mutationFn: () =>
      api.post<CustomerAppointment>('/appointments/requests', {
        service_id: serviceId,
        location_id: locationId,
        scheduled_start: zonedToIso(day, clock, location!.time_zone),
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

  return (
    <Page>
      <PageHeader title="Book an appointment" description="Pick a time that suits you; we'll confirm it shortly." />
      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <Card>
          {services.isLoading || locations.isLoading ? (
            <Spinner />
          ) : (
            <form onSubmit={submit} className="grid max-w-xl gap-4">
              <Field label="Service">
                <Select required value={serviceId} onChange={(e) => setServiceId(e.target.value)}>
                  <option value="">Choose a service</option>
                  {bookable.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name} · {money(s.price, s.currency)} · {s.duration_minutes} min
                    </option>
                  ))}
                </Select>
              </Field>
              {service?.description && <p className="-mt-2 text-sm text-slate-500">{service.description}</p>}
              <Field label="Location">
                <Select required value={locationId} onChange={(e) => setLocationId(e.target.value)}>
                  <option value="">Choose a location</option>
                  {locations.data?.map((l) => (
                    <option key={l.id} value={l.id}>{l.name}</option>
                  ))}
                </Select>
              </Field>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Date">
                  <Input type="date" required min={minDay} value={day} onChange={(e) => setDay(e.target.value)} />
                </Field>
                <Field label="Time" hint={location ? `Local time at ${location.name}` : undefined}>
                  <Input type="time" required step={900} value={clock} onChange={(e) => setClock(e.target.value)} />
                </Field>
              </div>
              <Field label="Anything we should know? (optional)">
                <textarea
                  rows={2}
                  maxLength={1000}
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-900"
                />
              </Field>
              {request.error && <ErrorBanner error={request.error} />}
              {requested && (
                <p role="status" className="rounded-lg bg-emerald-50 p-3 text-sm text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200">
                  Requested {requested.service_name} on {dateTime(requested.scheduled_start, requested.time_zone)}. We'll confirm it shortly; you'll see it under{' '}
                  <Link to="/portal/appointments" className="underline">Appointments</Link>.
                </p>
              )}
              <div>
                <Button type="submit" disabled={!service || !location || !day || !clock || request.isPending}>Request this time</Button>
              </div>
            </form>
          )}
        </Card>
        <PendingRequests />
      </div>
    </Page>
  );
}

/** Requests waiting for staff to confirm, with Withdraw. */
export function PendingRequests() {
  const api = useApi();
  const queryClient = useQueryClient();
  const q = useQuery({ queryKey: ['appointments', 'mine'], queryFn: () => api.get<CustomerAppointment[]>('/appointments?limit=100') });
  const withdraw = useMutation({
    mutationFn: (id: string) => api.post(`/appointments/${id}/withdraw`),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['appointments'] }),
  });
  const pending = (q.data ?? []).filter((a) => a.requested_by_customer && !a.reviewed_at && a.status === 'scheduled');
  return (
    <Card title="Waiting for confirmation">
      {q.isLoading ? (
        <Spinner />
      ) : !pending.length ? (
        <EmptyState>No open requests.</EmptyState>
      ) : (
        <ul className="-my-2 divide-y divide-slate-100 dark:divide-slate-800">
          {pending.map((a) => (
            <li key={a.id} className="flex items-start justify-between gap-2 py-2.5">
              <div className="text-sm">
                <p className="font-medium">{a.service_name}</p>
                <p className="text-slate-500">{dateTime(a.scheduled_start, a.time_zone)} · {a.location_name}</p>
              </div>
              <Button size="sm" variant="ghost" disabled={withdraw.isPending} onClick={() => withdraw.mutate(a.id)}>Withdraw</Button>
            </li>
          ))}
        </ul>
      )}
      {withdraw.error && <ErrorBanner error={withdraw.error} />}
    </Card>
  );
}

/** "awaiting confirmation" for requests staff have not reviewed yet. */
export function RequestBadge({ a }: { a: CustomerAppointment }) {
  if (!a.requested_by_customer || a.reviewed_at || a.status !== 'scheduled') return null;
  return <Badge tone="amber">awaiting confirmation</Badge>;
}

