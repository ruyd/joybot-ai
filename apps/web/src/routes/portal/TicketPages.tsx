import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { Page } from '../../components/Layout';
import { Badge, Card, EmptyState, ErrorBanner, PageHeader, Spinner, StatusBadge, Table, Td } from '../../components/ui';
import { useApi } from '../../lib/api';
import { dateTime, fullName } from '../../lib/format';
import { useMe } from '../../lib/me';
import type { Appointment } from './PortalPages';

export interface Ticket {
  id: string;
  subject: string;
  status: string;
  priority: string;
  created_at: string;
  updated_at: string;
  customer_id: string;
  customer_name: string | null;
  url: string | null;
}

interface TicketDetail extends Ticket {
  description: string | null;
  conversation: { id: string; body: string; from: 'customer' | 'support'; private: boolean; created_at: string }[];
}

const TICKET_TONE: Record<string, 'green' | 'amber' | 'slate'> = { open: 'amber', pending: 'amber', resolved: 'green', closed: 'slate' };

export function TicketStatus({ status }: { status: string }) {
  return <Badge tone={TICKET_TONE[status] ?? 'slate'}>{status}</Badge>;
}

/** Tickets table; `base` is where ticket links go (/portal/tickets or /staff/tickets). */
export function TicketsTable({ tickets, base, showCustomer, hint }: { tickets: Ticket[]; base: string; showCustomer?: boolean; hint?: string }) {
  if (tickets.length === 0) return <EmptyState>No support tickets.</EmptyState>;
  return (
    <Table head={['Ticket', 'Subject', ...(showCustomer ? ['Customer'] : []), 'Status', 'Updated']}>
      {tickets.map((t) => (
        <tr key={t.id}>
          <Td>#{t.id}</Td>
          <Td>
            <Link to={`${base}/${t.id}${hint ? `?customer_id=${hint}` : ''}`} className="font-medium text-brand-600 hover:underline">
              {t.subject}
            </Link>
          </Td>
          {showCustomer && <Td>{t.customer_name ?? '—'}</Td>}
          <Td><TicketStatus status={t.status} /></Td>
          <Td>{dateTime(t.updated_at)}</Td>
        </tr>
      ))}
    </Table>
  );
}

function ticketsError(error: unknown) {
  return error && (error as { status?: number }).status === 503 ? (
    <EmptyState>Support tickets are not available right now.</EmptyState>
  ) : (
    <ErrorBanner error={error} />
  );
}

export function MyTickets() {
  const api = useApi();
  const { me } = useMe();
  const [scope, setScope] = useState<'self' | 'org'>('self');
  const q = useQuery({ queryKey: ['tickets', scope], queryFn: () => api.get<Ticket[]>(`/tickets${scope === 'org' ? '?scope=org' : ''}`) });
  return (
    <Page>
      <PageHeader
        title="Support tickets"
        description="Your requests to our support team."
        actions={
          me?.role === 'org_admin' && (
            <div role="tablist" className="flex gap-1">
              {(['self', 'org'] as const).map((s) => (
                <button
                  key={s}
                  role="tab"
                  aria-selected={scope === s}
                  onClick={() => setScope(s)}
                  className={`rounded-lg px-3 py-1.5 text-sm ${scope === s ? 'bg-brand-600 text-white' : 'hover:bg-slate-100 dark:hover:bg-slate-900'}`}
                >
                  {s === 'self' ? 'Mine' : 'Organization'}
                </button>
              ))}
            </div>
          )
        }
      />
      <Card>{q.isLoading ? <Spinner /> : q.error ? ticketsError(q.error) : <TicketsTable tickets={q.data ?? []} base="/portal/tickets" showCustomer={scope === 'org'} />}</Card>
    </Page>
  );
}

export function TicketView({ back }: { back: string }) {
  const { id } = useParams();
  const [params] = useSearchParams();
  const hint = params.get('customer_id');
  const api = useApi();
  const q = useQuery({
    queryKey: ['ticket', id, hint],
    queryFn: () => api.get<TicketDetail>(`/tickets/${id}${hint ? `?customer_id=${encodeURIComponent(hint)}` : ''}`),
  });
  if (q.isLoading) return <Page><Spinner /></Page>;
  if (q.error) return <Page>{(q.error as { status?: number }).status === 404 ? <EmptyState>Ticket not found.</EmptyState> : ticketsError(q.error)}</Page>;
  const t = q.data!;
  return (
    <Page>
      <Link to={hint ? `/staff/customers/${hint}` : back} className="text-sm text-brand-600 hover:underline">← {hint ? 'Back to customer' : 'All tickets'}</Link>
      <PageHeader
        title={`#${t.id} · ${t.subject}`}
        description={`Opened ${dateTime(t.created_at)} · updated ${dateTime(t.updated_at)}${t.customer_name ? ` · ${t.customer_name}` : ''}`}
        actions={<div className="flex items-center gap-2"><TicketStatus status={t.status} />{t.url && <a className="text-sm text-brand-600 underline" href={t.url} target="_blank" rel="noreferrer">Open in Freshdesk</a>}</div>}
      />
      <div className="space-y-3">
        {t.description && <Card title="Request"><p className="whitespace-pre-wrap text-sm">{t.description}</p></Card>}
        {t.conversation.map((c) => (
          <div
            key={c.id}
            className={`rounded-xl border p-4 text-sm ${
              c.private
                ? 'border-amber-300 bg-amber-50 dark:border-amber-900 dark:bg-amber-950'
                : c.from === 'support'
                  ? 'border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900'
                  : 'border-brand-100 bg-brand-50 dark:border-slate-800 dark:bg-slate-900'
            }`}
          >
            <p className="mb-1 text-xs text-slate-500">
              {c.private ? 'Private note (staff only)' : c.from === 'support' ? 'Support' : 'Customer'} · {dateTime(c.created_at)}
            </p>
            <p className="whitespace-pre-wrap">{c.body}</p>
          </div>
        ))}
      </div>
    </Page>
  );
}

interface OrgOverview {
  organization: { id: string; org_number: string; name: string; email: string | null; phone: string | null };
  members: { id: string; customer_number: string; first_name: string | null; last_name: string | null; email: string | null; org_role: string; status: string; has_login: boolean }[];
}

/** Org admins: members, their appointments and the organization's tickets (no payments). */
export function Organization() {
  const api = useApi();
  const org = useQuery({ queryKey: ['org'], queryFn: () => api.get<OrgOverview>('/org') });
  const appointments = useQuery({ queryKey: ['appointments', 'org'], queryFn: () => api.get<Appointment[]>('/appointments?limit=100') });
  const tickets = useQuery({ queryKey: ['tickets', 'org'], queryFn: () => api.get<Ticket[]>('/tickets?scope=org') });
  if (org.isLoading) return <Page><Spinner /></Page>;
  if (org.error) return <Page><ErrorBanner error={org.error} /></Page>;
  const o = org.data!;
  const upcoming = (appointments.data ?? []).filter((a) => new Date(a.scheduled_start).getTime() >= Date.now() && ['scheduled', 'confirmed'].includes(a.status));
  return (
    <Page>
      <PageHeader title={o.organization.name} description={[o.organization.org_number, o.organization.email].filter(Boolean).join(' · ')} />
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title={`Members (${o.members.length})`}>
          <Table head={['Name', 'Email', 'Role', 'Portal']}>
            {o.members.map((m) => (
              <tr key={m.id}>
                <Td>{fullName(m)}</Td>
                <Td className="text-slate-500">{m.email ?? '—'}</Td>
                <Td>{m.org_role === 'org_admin' ? <Badge tone="brand">admin</Badge> : 'member'}</Td>
                <Td>{m.has_login ? <Badge tone="green">signed up</Badge> : <Badge>not yet</Badge>}</Td>
              </tr>
            ))}
          </Table>
        </Card>
        <Card title="Upcoming appointments">
          {upcoming.length === 0 ? (
            <EmptyState>No upcoming appointments.</EmptyState>
          ) : (
            <Table head={['When', 'Service', 'Status']}>
              {upcoming.map((a) => (
                <tr key={a.id}>
                  <Td>{dateTime(a.scheduled_start, a.time_zone)}</Td>
                  <Td>{a.service_name}</Td>
                  <Td><StatusBadge status={a.status} /></Td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
        <Card title="Support tickets" className="lg:col-span-2">
          {tickets.isLoading ? <Spinner /> : tickets.error ? ticketsError(tickets.error) : <TicketsTable tickets={tickets.data ?? []} base="/portal/tickets" showCustomer />}
        </Card>
      </div>
    </Page>
  );
}

/** Staff: tickets card on the customer page. */
export function CustomerTickets({ customerId }: { customerId: string }) {
  const api = useApi();
  const q = useQuery({ queryKey: ['tickets', 'customer', customerId], queryFn: () => api.get<Ticket[]>(`/tickets?customer_id=${customerId}`) });
  return (
    <Card title="Support tickets" className="lg:col-span-2">
      {q.isLoading ? <Spinner /> : q.error ? ticketsError(q.error) : <TicketsTable tickets={q.data ?? []} base="/staff/tickets" hint={customerId} />}
    </Card>
  );
}
