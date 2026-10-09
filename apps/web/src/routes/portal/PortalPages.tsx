import { useQuery } from '@tanstack/react-query';
import { Page } from '../../components/Layout';
import { Card, EmptyState, ErrorBanner, PageHeader, Spinner, StatusBadge, Table, Td } from '../../components/ui';
import { useApi } from '../../lib/api';
import { dateTime, METHOD_LABEL, money } from '../../lib/format';

export interface Appointment {
  id: string;
  appointment_number: string;
  service_name: string;
  location_name: string;
  time_zone: string;
  employee_name: string | null;
  scheduled_start: string;
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

export function MyAppointments() {
  const q = useList<Appointment>('appointments', '/appointments?limit=100');
  const now = Date.now();
  const upcoming = (q.data ?? []).filter((a) => new Date(a.scheduled_start).getTime() >= now && ['scheduled', 'confirmed'].includes(a.status));
  const past = (q.data ?? []).filter((a) => !upcoming.includes(a)).reverse();
  const table = (rows: Appointment[]) => (
    <Table head={['When', 'Service', 'Where', 'With', 'Status', 'Price']}>
      {rows.map((a) => (
        <tr key={a.id}>
          <Td>{dateTime(a.scheduled_start, a.time_zone)}</Td>
          <Td>{a.service_name}</Td>
          <Td>{a.location_name}</Td>
          <Td>{a.employee_name ?? '—'}</Td>
          <Td><StatusBadge status={a.status} /></Td>
          <Td>{money(a.price_quoted, a.currency)}</Td>
        </tr>
      ))}
    </Table>
  );
  return (
    <Page>
      <PageHeader title="My appointments" description="Times are shown in each location's time zone." />
      <div className="space-y-4">
        <Card title="Upcoming">
          <State q={{ ...q, data: upcoming }} empty="No upcoming appointments.">{table(upcoming)}</State>
        </Card>
        <Card title="Past">
          <State q={{ ...q, data: past }} empty="No past appointments yet.">{table(past)}</State>
        </Card>
      </div>
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
