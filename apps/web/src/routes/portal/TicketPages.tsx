import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Page } from '../../components/Layout';
import { Badge, Button, Card, EmptyState, ErrorBanner, Field, Input, PageHeader, Select, Spinner, StatusBadge, Table, Td } from '../../components/ui';
import { useApi } from '../../lib/api';
import { dateTime, fullName } from '../../lib/format';
import { CustomerPicker, type Customer } from '../staff/CustomerPicker';
import { useMe } from '../../lib/me';
import type { Appointment } from './PortalPages';

export interface Ticket {
  /** The ticket number (#1001), used in addresses. */
  id: string;
  subject: string;
  status: TicketStatusName;
  priority: TicketPriorityName;
  created_at: string;
  updated_at: string;
  last_message_at: string;
  customer_id: string;
  customer_name: string | null;
  assigned_to: string | null;
  assigned_to_name: string | null;
  message_count: number;
}

export interface TicketDetail extends Ticket {
  messages: { id: string; body: string; from: 'customer' | 'support'; author_name: string | null; internal: boolean; created_at: string }[];
}

type TicketStatusName = 'open' | 'pending' | 'resolved' | 'closed';
type TicketPriorityName = 'low' | 'medium' | 'high' | 'urgent';
const STATUS_LABEL: Record<TicketStatusName, string> = { open: 'open', pending: 'waiting on customer', resolved: 'resolved', closed: 'closed' };
const CUSTOMER_STATUS_LABEL: Record<TicketStatusName, string> = { open: 'waiting on support', pending: 'replied', resolved: 'resolved', closed: 'closed' };
const TICKET_TONE: Record<TicketStatusName, 'green' | 'amber' | 'slate' | 'brand'> = { open: 'amber', pending: 'brand', resolved: 'green', closed: 'slate' };
const PRIORITY_TONE: Record<TicketPriorityName, 'red' | 'amber' | 'slate'> = { urgent: 'red', high: 'amber', medium: 'slate', low: 'slate' };

/** Status in the reader's words: staff see whose turn it is; customers whether support has replied. */
export function TicketStatus({ status, staff }: { status: TicketStatusName; staff?: boolean }) {
  return <Badge tone={TICKET_TONE[status] ?? 'slate'}>{(staff ? STATUS_LABEL : CUSTOMER_STATUS_LABEL)[status] ?? status}</Badge>;
}

export function TicketPriority({ priority }: { priority: TicketPriorityName }) {
  return <Badge tone={PRIORITY_TONE[priority] ?? 'slate'}>{priority}</Badge>;
}

/** Tickets table; `base` is where ticket links go (/portal/tickets or /staff/tickets). */
export function TicketsTable({ tickets, base, showCustomer, staff }: { tickets: Ticket[]; base: string; showCustomer?: boolean; staff?: boolean }) {
  if (tickets.length === 0) return <EmptyState>No support tickets.</EmptyState>;
  return (
    <Table head={['Ticket', 'Subject', ...(showCustomer ? ['Customer'] : []), 'Status', ...(staff ? ['Priority', 'Assigned'] : []), 'Last activity']}>
      {tickets.map((t) => (
        <tr key={t.id}>
          <Td>#{t.id}</Td>
          <Td>
            <Link to={`${base}/${t.id}`} className="font-medium text-brand-600 hover:underline">
              {t.subject}
            </Link>
          </Td>
          {showCustomer && <Td>{t.customer_name ?? '—'}</Td>}
          <Td><TicketStatus status={t.status} staff={staff} /></Td>
          {staff && <Td><TicketPriority priority={t.priority} /></Td>}
          {staff && <Td className="text-slate-500">{t.assigned_to_name ?? '—'}</Td>}
          <Td>{dateTime(t.last_message_at)}</Td>
        </tr>
      ))}
    </Table>
  );
}

/** Customers: their tickets, and a form to ask for help. */
export function MyTickets() {
  const api = useApi();
  const { me } = useMe();
  const [scope, setScope] = useState<'self' | 'org'>('self');
  const [asking, setAsking] = useState(false);
  const q = useQuery({ queryKey: ['tickets', scope], queryFn: () => api.get<Ticket[]>(`/tickets${scope === 'org' ? '?scope=org' : ''}`) });
  return (
    <Page>
      <PageHeader
        title="Support"
        description="Your requests to our support team. We reply here and by email."
        actions={
          <div className="flex items-center gap-2">
            {me?.role === 'org_admin' && (
              <div role="tablist" className="flex gap-1">
                {(['self', 'org'] as const).map((s) => (
                  <button
                    key={s}
                    role="tab"
                    aria-selected={scope === s}
                    onClick={() => setScope(s)}
                    className={`press rounded-full px-3 py-1.5 text-sm ${scope === s ? 'btn-gradient font-medium' : 'hover:bg-slate-100 dark:hover:bg-slate-900'}`}
                  >
                    {s === 'self' ? 'Mine' : 'Organization'}
                  </button>
                ))}
              </div>
            )}
            {!asking && <Button onClick={() => setAsking(true)}>New request</Button>}
          </div>
        }
      />
      {asking && <NewTicket onDone={() => setAsking(false)} />}
      <Card>{q.isLoading ? <Spinner /> : q.error ? <ErrorBanner error={q.error} /> : <TicketsTable tickets={q.data ?? []} base="/portal/tickets" showCustomer={scope === 'org'} />}</Card>
    </Page>
  );
}

/** Opens a ticket: for the signed-in customer, or (staff) for `customerId` or a customer they pick. */
export function NewTicket({ customerId, staff: pick, onDone }: { customerId?: string; staff?: boolean; onDone: () => void }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const staff = Boolean(customerId) || Boolean(pick);
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [form, setForm] = useState({ subject: '', message: '', notify: true });
  const forCustomer = customerId ?? customer?.id;
  const create = useMutation({
    mutationFn: () => api.post<TicketDetail>('/tickets', { subject: form.subject, message: form.message, ...(staff ? { customer_id: forCustomer, notify: form.notify } : {}) }),
    onSuccess: (t) => {
      void queryClient.invalidateQueries({ queryKey: ['tickets'] });
      onDone();
      navigate(`${staff ? '/staff' : '/portal'}/tickets/${t.id}`);
    },
  });
  return (
    <Card title={customerId ? 'New ticket for this customer' : staff ? 'New ticket' : 'How can we help?'}>
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate();
        }}
      >
        {staff && !customerId && (
          <Field label="Customer">
            <CustomerPicker value={customer} onChange={setCustomer} />
          </Field>
        )}
        <Field label="Subject">
          <Input required maxLength={200} value={form.subject} onChange={(e) => setForm({ ...form, subject: e.target.value })} />
        </Field>
        <Field label={staff ? 'Message' : 'Tell us what you need'} hint={staff ? 'The first message on the ticket.' : undefined}>
          <TextArea required value={form.message} onChange={(message) => setForm({ ...form, message })} rows={5} />
        </Field>
        {staff && (
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={form.notify} onChange={(e) => setForm({ ...form, notify: e.target.checked })} /> Email the customer this message
          </label>
        )}
        <div className="flex gap-2">
          <Button type="submit" disabled={create.isPending || !form.subject.trim() || !form.message.trim() || (staff && !forCustomer)}>
            {staff ? 'Open ticket' : 'Send request'}
          </Button>
          <Button type="button" variant="ghost" onClick={onDone}>
            Cancel
          </Button>
        </div>
        {create.error && <ErrorBanner error={create.error} />}
      </form>
    </Card>
  );
}

function TextArea({ value, onChange, rows = 4, required, placeholder }: { value: string; onChange: (v: string) => void; rows?: number; required?: boolean; placeholder?: string }) {
  return (
    <textarea
      className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-900"
      rows={rows}
      maxLength={10_000}
      required={required}
      placeholder={placeholder}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

/** Customers: one ticket, its conversation and a reply box (staff use the inbox, TicketInbox.tsx). */
export function TicketView() {
  const { id } = useParams();
  const api = useApi();
  const queryClient = useQueryClient();
  const q = useQuery({ queryKey: ['ticket', id], queryFn: () => api.get<TicketDetail>(`/tickets/${id}`) });
  const refresh = (t: TicketDetail) => {
    queryClient.setQueryData(['ticket', id], t);
    void queryClient.invalidateQueries({ queryKey: ['tickets'] });
  };
  const update = useMutation({ mutationFn: (body: Record<string, unknown>) => api.put<TicketDetail>(`/tickets/${id}`, body), onSuccess: refresh });
  if (q.isLoading) return <Page><Spinner /></Page>;
  if (q.error) return <Page>{(q.error as { status?: number }).status === 404 ? <EmptyState>Ticket not found.</EmptyState> : <ErrorBanner error={q.error} />}</Page>;
  const t = q.data!;
  const done = t.status === 'resolved' || t.status === 'closed';
  return (
    <Page>
      <Link to="/portal/tickets" className="text-sm text-brand-600 hover:underline">
        ← All tickets
      </Link>
      <PageHeader
        title={`#${t.id} · ${t.subject}`}
        description={`Opened ${dateTime(t.created_at)} · last activity ${dateTime(t.last_message_at)}`}
        actions={
          <div className="flex items-center gap-2">
            <TicketStatus status={t.status} />
            {!done && (
              <Button size="sm" variant="secondary" disabled={update.isPending} onClick={() => update.mutate({ status: 'resolved' })}>
                Mark as resolved
              </Button>
            )}
          </div>
        }
      />
      <div className="space-y-3">
          {t.messages.map((m) => (
            <div
              key={m.id}
              className={`rounded-xl border p-4 text-sm ${
                m.internal
                  ? 'border-amber-300 bg-amber-50 dark:border-amber-900 dark:bg-amber-950'
                  : m.from === 'support'
                    ? 'border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900'
                    : 'border-brand-100 bg-brand-50 dark:border-slate-800 dark:bg-slate-900'
              }`}
            >
              <p className="mb-1 text-xs text-slate-500">
                {m.internal ? 'Internal note (staff only)' : m.from === 'support' ? 'Support' : 'Customer'}
                {m.author_name ? ` · ${m.author_name}` : ''} · {dateTime(m.created_at)}
              </p>
              <p className="whitespace-pre-wrap">{m.body}</p>
            </div>
          ))}
          <Reply ticketId={t.id} done={done} onSent={refresh} />
      </div>
    </Page>
  );
}

function Reply({ ticketId, done, onSent }: { ticketId: string; done: boolean; onSent: (t: TicketDetail) => void }) {
  const api = useApi();
  const [body, setBody] = useState('');
  const send = useMutation({
    mutationFn: () => api.post<TicketDetail>(`/tickets/${ticketId}/messages`, { body }),
    onSuccess: (t) => {
      setBody('');
      onSent(t);
    },
  });
  return (
    <Card>
      <form
        className="space-y-2"
        onSubmit={(e) => {
          e.preventDefault();
          send.mutate();
        }}
      >
        <TextArea value={body} onChange={setBody} placeholder={done ? 'Write to reopen this request' : 'Write a reply'} />
        <Button type="submit" disabled={send.isPending || !body.trim()}>
          Send
        </Button>
        {send.error && <ErrorBanner error={send.error} />}
      </form>
    </Card>
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
        <Card title={`Members (${o.members.length})`} actions={<AddMember />}>
          <Table head={['Name', 'Email', 'Role', 'Portal', '']}>
            {o.members.map((m) => (
              <tr key={m.id}>
                <Td>{fullName(m)}</Td>
                <Td className="text-slate-500">{m.email ?? '—'}</Td>
                <Td>{m.org_role === 'org_admin' ? <Badge tone="brand">admin</Badge> : 'member'}</Td>
                <Td>{m.has_login ? <Badge tone="green">signed up</Badge> : <Badge>not yet</Badge>}</Td>
                <Td>{m.org_role !== 'org_admin' && <RemoveMember id={m.id} name={fullName(m)} />}</Td>
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
          {tickets.isLoading ? <Spinner /> : tickets.error ? <ErrorBanner error={tickets.error} /> : <TicketsTable tickets={tickets.data ?? []} base="/portal/tickets" showCustomer />}
        </Card>
      </div>
    </Page>
  );
}

function AddMember() {
  const api = useApi();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ first_name: '', last_name: '', email: '' });
  const add = useMutation({
    mutationFn: () => api.post<{ sent: boolean; reason?: string }>('/org/invites', { ...form, last_name: form.last_name || undefined }),
    onSuccess: () => {
      setOpen(false);
      setForm({ first_name: '', last_name: '', email: '' });
      void queryClient.invalidateQueries({ queryKey: ['org'] });
    },
  });
  if (!open) return <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>Add member</Button>;
  return (
    <form
      className="flex flex-wrap items-end gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        add.mutate();
      }}
    >
      <Input aria-label="First name" placeholder="First name" required className="w-28" value={form.first_name} onChange={(e) => setForm({ ...form, first_name: e.target.value })} />
      <Input aria-label="Last name" placeholder="Last name" className="w-28" value={form.last_name} onChange={(e) => setForm({ ...form, last_name: e.target.value })} />
      <Input aria-label="Email" placeholder="Email" type="email" required className="w-44" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
      <Button size="sm" type="submit" disabled={add.isPending}>Invite</Button>
      <Button size="sm" type="button" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
      {add.error && <ErrorBanner error={add.error} />}
    </form>
  );
}

function RemoveMember({ id, name }: { id: string; name: string }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const remove = useMutation({ mutationFn: () => api.del(`/org/members/${id}`), onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['org'] }) });
  return (
    <Button
      size="sm"
      variant="ghost"
      disabled={remove.isPending}
      onClick={() => {
        if (window.confirm(`Remove ${name} from the organization? They keep their own account.`)) remove.mutate();
      }}
    >
      Remove
    </Button>
  );
}

/** Staff: tickets card on the customer page, with "New ticket" for staff who may open one. */
export function CustomerTickets({ customerId }: { customerId: string }) {
  const api = useApi();
  const { can } = useMe();
  const [opening, setOpening] = useState(false);
  const q = useQuery({ queryKey: ['tickets', 'customer', customerId], queryFn: () => api.get<Ticket[]>(`/tickets?customer_id=${customerId}`) });
  return (
    <Card
      title="Support tickets"
      className="lg:col-span-2"
      actions={
        can('create', 'tickets') && !opening && (
          <Button size="sm" variant="secondary" onClick={() => setOpening(true)}>
            New ticket
          </Button>
        )
      }
    >
      {opening && (
        <div className="mb-4">
          <NewTicket customerId={customerId} onDone={() => setOpening(false)} />
        </div>
      )}
      {q.isLoading ? <Spinner /> : q.error ? <ErrorBanner error={q.error} /> : <TicketsTable tickets={q.data ?? []} base="/staff/tickets" staff />}
    </Card>
  );
}
