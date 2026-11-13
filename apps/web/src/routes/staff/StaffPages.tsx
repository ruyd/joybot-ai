import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarDays, CreditCard, FileText, Inbox, type LucideIcon } from 'lucide-react';
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { Page } from '../../components/Layout';
import { Badge, Button, Card, EmptyState, ErrorBanner, Field, Input, PageHeader, Pager, Select, Spinner, StatusBadge, Table, Tabs, Td } from '../../components/ui';
import { ApiError, useApi } from '../../lib/api';
import { date, dateTime, fullName, METHOD_LABEL, money } from '../../lib/format';
import { useMe } from '../../lib/me';
import { PaymentStatus, type Appointment, type Payment } from '../portal/PortalPages';
import { CustomerTickets, TicketStatus, type Ticket } from '../portal/TicketPages';
import { InvoiceStatus, type Invoice } from '../../components/InvoiceDocument';
import { BookAppointment } from './HomePage';
import { CustomerPicker, type Customer } from './CustomerPicker';
import { MergeCard } from './ReviewPages';
import { AssignmentsCard, GrantsCard } from './AccessPages';


// Customers ----------------------------------------------------------------------------------

const PAGE_SIZES = [10, 25, 50, 100];

/** Customers: everyone the employee can see, a page at a time with the total; search by name, email, phone or number. */
export function Customers() {
  const api = useApi();
  const [params, setParams] = useSearchParams();
  const term = params.get('q') ?? '';
  const limit = PAGE_SIZES.includes(Number(params.get('size'))) ? Number(params.get('size')) : 25;
  const page = Math.max(1, Math.floor(Number(params.get('page')) || 1));
  const offset = (page - 1) * limit;
  const [q, setQ] = useState(term);
  // Search, page and page size live in the address (back and reload keep them); only non-defaults are written.
  // Typing replaces the history entry; turning pages and changing the size add one.
  const update = (next: { q?: string; page?: number; size?: number }, replace = false) => {
    const v = { q: term, page, size: limit, ...next };
    const out: Record<string, string> = {};
    if (v.q) out.q = v.q;
    if (v.page > 1) out.page = String(v.page);
    if (v.size !== 25) out.size = String(v.size);
    setParams(out, { replace });
  };
  // Search as you type from 2 characters (100 ms after the last key); clearing the box shows everyone.
  // Enter searches right away, whatever the length.
  useEffect(() => {
    const t = q.trim();
    if (t === term || (t.length > 0 && t.length < 2)) return;
    const timer = setTimeout(() => update({ q: t, page: 1 }, true), 100);
    return () => clearTimeout(timer);
  }, [q]); // only typing starts a search
  // Back and forward: the box follows the address.
  useEffect(() => setQ((current) => (current.trim() === term ? current : term)), [term]);
  const query = useQuery({
    queryKey: ['customers', 'list', term, limit, offset],
    queryFn: () => api.get<{ items: Customer[]; total: number }>(`/customers/list?${new URLSearchParams({ ...(term ? { q: term } : {}), limit: String(limit), offset: String(offset) })}`),
    placeholderData: keepPreviousData,
  });
  const items = query.data?.items ?? [];
  const total = query.data?.total ?? 0;

  return (
    <Page>
      <PageHeader title="Customers" description="Only customers you have access to are shown." />
      <form
        className="mb-4 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          update({ q: q.trim(), page: 1 }, true);
        }}
      >
        <Input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search by name, email, phone or customer number"
          aria-label="Search customers"
        />
        {term && (
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              setQ('');
              update({ q: '', page: 1 }, true);
            }}
          >
            Clear
          </Button>
        )}
      </form>
      <Card>
        {query.isLoading ? (
          <Spinner />
        ) : query.error ? (
          <ErrorBanner error={query.error} />
        ) : !items.length ? (
          <EmptyState>{term ? `No customers match “${term}”.` : 'No customers found.'}</EmptyState>
        ) : (
          <div className={query.isPlaceholderData ? 'opacity-60 transition-opacity' : undefined}>
            <Table head={['Customer', 'Number', 'Contact', 'Status']}>
              {items.map((c) => (
                <tr key={c.id} className="transition-colors hover:bg-slate-50 dark:hover:bg-slate-800/60">
                  <Td>
                    <Link to={`/staff/customers/${c.id}`} className="font-medium text-brand-600 hover:underline">
                      {fullName(c)}
                    </Link>
                    {c.restricted && <span className="ml-2"><Badge tone="red">restricted</Badge></span>}
                  </Td>
                  <Td>{c.customer_number}</Td>
                  <Td className="text-slate-500">{[c.email, c.phone].filter(Boolean).join(' · ')}</Td>
                  <Td><StatusBadge status={c.status} /></Td>
                </tr>
              ))}
            </Table>
          </div>
        )}
        {query.data && (total > 0 || offset > 0) && (
          <Pager
            total={total}
            offset={offset}
            limit={limit}
            sizes={PAGE_SIZES}
            busy={query.isFetching}
            label={total === 1 ? 'customer' : 'customers'}
            onOffset={(o) => update({ page: Math.floor(o / limit) + 1 })}
            onLimit={(size) => update({ size, page: 1 })}
          />
        )}
      </Card>
    </Page>
  );
}

type DetailTab = 'overview' | 'appointments' | 'payments' | 'invoices' | 'tickets' | 'access';
type CustomerDetail = Customer & {
  email_verified?: boolean;
  phone_verified?: boolean;
  preferred_location_id?: string | null;
  time_zone?: string | null;
  source?: string | null;
  created_at?: string;
};

const initials = (c: Customer) => `${c.first_name?.[0] ?? ''}${c.last_name?.[0] ?? ''}`.toUpperCase() || '?';
const PAID = ['succeeded', 'partially_refunded'];

/**
 * A customer: a header with their key facts and actions, then tabs. Overview shows summary numbers,
 * one activity timeline (appointments, payments, invoices, tickets) and side cards (details,
 * internal notes, who can access); the other tabs hold the full lists and the access tools.
 */
export function CustomerDetail() {
  const { id } = useParams();
  const api = useApi();
  const { can } = useMe();
  const [params, setParams] = useSearchParams();
  const [booking, setBooking] = useState(false);
  const customer = useQuery({ queryKey: ['customer', id], queryFn: () => api.get<CustomerDetail>(`/customers/${id}`) });
  const appointments = useQuery({
    queryKey: ['appointments', 'customer', id],
    queryFn: () => api.get<(Appointment & { notes_internal?: string; employee_name: string | null })[]>(`/appointments?customer_id=${id}&limit=200`),
  });
  const payments = useQuery({ queryKey: ['payments', 'customer', id], queryFn: () => api.get<Payment[]>(`/payments?customer_id=${id}&limit=200`) });
  const invoices = useQuery({
    queryKey: ['invoices', 'customer', id],
    enabled: can('read', 'payments'),
    // The list endpoint answers { items } (with status counts for the Invoices page).
    queryFn: () => api.get<{ items: Invoice[] }>(`/invoices?customer_id=${id}&limit=200`).then((r) => r.items),
  });
  const tickets = useQuery({ queryKey: ['tickets', 'customer', id], enabled: can('read', 'tickets'), queryFn: () => api.get<Ticket[]>(`/tickets?customer_id=${id}`) });
  const access = useQuery({
    queryKey: ['access', id],
    enabled: can('read', 'access'),
    queryFn: () => api.get<{ user_id: string; first_name: string; last_name: string; role: string; can_read: string; can_update: string | null }[]>(`/customers/${id}/access`),
  });
  const orgId = customer.data?.organization_id;
  const organization = useQuery({ queryKey: ['organization', orgId], enabled: Boolean(orgId), queryFn: () => api.get<{ id: string; name: string }>(`/organizations/${orgId}`) });
  const locations = useQuery({ queryKey: ['locations'], queryFn: () => api.get<{ id: string; name: string }[]>('/locations') });

  if (customer.isLoading) return <Page><Spinner /></Page>;
  if (customer.error) return <Page><ErrorBanner error={customer.error} /></Page>;
  const c = customer.data!;

  const showAccess = can('read', 'access') || can('update', 'access') || can('merge', 'customers');
  const tabs: { key: DetailTab; label: string; count?: number | null }[] = [
    { key: 'overview', label: 'Overview' },
    { key: 'appointments', label: 'Appointments', count: appointments.data?.length ?? null },
    { key: 'payments', label: 'Payments', count: payments.data?.length ?? null },
    ...(can('read', 'payments') ? [{ key: 'invoices' as const, label: 'Invoices', count: invoices.data?.length ?? null }] : []),
    ...(can('read', 'tickets') ? [{ key: 'tickets' as const, label: 'Tickets', count: tickets.data?.length ?? null }] : []),
    ...(showAccess ? [{ key: 'access' as const, label: 'Access' }] : []),
  ];
  const tab = tabs.find((t) => t.key === params.get('tab'))?.key ?? 'overview';
  const setTab = (key: DetailTab) => setParams(key === 'overview' ? {} : { tab: key }, { replace: true });
  const location = locations.data?.find((l) => l.id === c.preferred_location_id)?.name;
  const since = c.created_at ? new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' }).format(new Date(c.created_at)) : null;

  return (
    <Page>
      <header className="mb-6 flex flex-wrap items-center gap-4">
        <span className="grid size-16 shrink-0 place-items-center rounded-full bg-brand-50 text-xl font-bold text-brand-700 dark:bg-slate-800 dark:text-brand-600" aria-hidden="true">
          {initials(c)}
        </span>
        <div className="min-w-0 flex-[1_1_16rem]">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-[1.75rem] leading-tight font-bold tracking-tight">{fullName(c)}</h1>
            <StatusBadge status={c.status} />
            {c.restricted && <Badge tone="red">restricted</Badge>}
            {organization.data && <Badge tone="slate">{c.org_role === 'admin' ? `Org admin · ${organization.data.name}` : organization.data.name}</Badge>}
          </div>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            {[c.customer_number, since && `Customer since ${since}`, c.time_zone?.replaceAll('_', ' ')].filter(Boolean).join(' · ')}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {c.has_login ? <Badge tone="green">portal account</Badge> : can('update', 'customers') && <InviteButtons customer={c} />}
          {can('create', 'payments') && (
            <Link
              to={`/staff/invoices/new?customer=${c.id}`}
              className="press inline-flex min-h-10 items-center rounded-lg border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-900 shadow-xs hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 dark:hover:bg-slate-800"
            >
              New invoice
            </Link>
          )}
          {can('create', 'appointments') && (
            <Button aria-expanded={booking} onClick={() => setBooking((b) => !b)}>
              {booking ? 'Close booking' : 'Book appointment'}
            </Button>
          )}
        </div>
      </header>

      {booking && (
        <div className="mb-6 max-w-xl">
          <BookAppointment customer={c} />
        </div>
      )}

      <Tabs label="Customer sections" tabs={tabs} value={tab} onChange={setTab} />

      {tab === 'overview' && (
        <div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-[minmax(0,1fr)_22rem]">
          <div className="grid min-w-0 grid-cols-1 gap-5">
            <CustomerNumbers appointments={appointments.data} payments={payments.data} invoices={invoices.data} />
            <CustomerActivity
              appointments={appointments.data}
              payments={payments.data}
              invoices={invoices.data}
              tickets={tickets.data}
              loading={appointments.isLoading || payments.isLoading}
            />
          </div>
          <div className="grid min-w-0 grid-cols-1 gap-5">
            <Card title="Details">
              <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2.5 text-sm">
                <dt className="text-slate-500 dark:text-slate-400">Email</dt>
                <dd className="truncate font-medium">
                  {c.email ?? '—'}
                  {c.email && c.email_verified && <span className="font-normal text-brand-700 dark:text-brand-600"> · verified</span>}
                </dd>
                <dt className="text-slate-500 dark:text-slate-400">Phone</dt>
                <dd className="font-medium">
                  {c.phone ?? '—'}
                  {c.phone && c.whatsapp_opt_in_at && <span className="font-normal text-slate-500"> · WhatsApp</span>}
                </dd>
                {organization.data && (
                  <>
                    <dt className="text-slate-500 dark:text-slate-400">Organization</dt>
                    <dd className="font-medium">
                      {organization.data.name}
                      {c.org_role === 'admin' && <span className="font-normal text-slate-500"> · admin</span>}
                    </dd>
                  </>
                )}
                <dt className="text-slate-500 dark:text-slate-400">Location</dt>
                <dd className="font-medium">{location ?? '—'}</dd>
                <dt className="text-slate-500 dark:text-slate-400">Portal</dt>
                <dd className="font-medium">{c.has_login ? 'Signed up' : 'Not signed up yet'}</dd>
              </dl>
            </Card>
            {c.notes_internal && (
              <section className="rounded-xl border border-amber-200 bg-amber-50 p-5 dark:border-amber-900/60 dark:bg-amber-950/40">
                <div className="flex items-center justify-between gap-2">
                  <h2 className="text-base font-semibold">Internal notes</h2>
                  <span className="text-xs font-medium text-amber-800 dark:text-amber-300">Staff only</span>
                </div>
                <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-amber-950 dark:text-amber-100">{c.notes_internal}</p>
              </section>
            )}
            {can('read', 'access') && (
              <Card
                title="Who can access"
                actions={
                  <button type="button" onClick={() => setTab('access')} className="text-sm font-semibold text-brand-700 hover:underline dark:text-brand-600">
                    Manage →
                  </button>
                }
              >
                <p className="text-sm">
                  {c.restricted ? (
                    <span><strong className="font-semibold">Restricted:</strong> only the people listed can see this customer.</span>
                  ) : (
                    <span>Staff at the customer's location can see them, plus anyone listed.</span>
                  )}
                </p>
                <div className="mt-3 flex flex-wrap items-center gap-1.5">
                  {access.data?.slice(0, 6).map((r) => (
                    <span
                      key={r.user_id}
                      title={`${r.first_name} ${r.last_name} · ${r.role}`}
                      className="grid size-8 place-items-center rounded-full bg-slate-200 text-[11px] font-semibold text-slate-700 dark:bg-slate-800 dark:text-slate-200"
                    >
                      {`${r.first_name[0] ?? ''}${r.last_name[0] ?? ''}`.toUpperCase()}
                    </span>
                  ))}
                  {(access.data?.length ?? 0) > 6 && <span className="text-sm text-slate-500">+{access.data!.length - 6}</span>}
                  {access.data && !access.data.length && <span className="text-sm text-slate-500">Only admins.</span>}
                </div>
                {can('update', 'access') && (
                  <div className="mt-4">
                    <RestrictedToggle customer={c} />
                  </div>
                )}
              </Card>
            )}
          </div>
        </div>
      )}

      {tab === 'appointments' && (
        <Card>
          {appointments.data?.length ? (
            <Table head={['When', 'Service', 'With', 'Status']}>
              {appointments.data.map((a) => (
                <tr key={a.id}>
                  <Td>{dateTime(a.scheduled_start, a.time_zone)}</Td>
                  <Td>
                    {a.service_name}
                    {a.notes_internal && <span className="block text-xs text-amber-700">Note: {a.notes_internal}</span>}
                  </Td>
                  <Td>{a.employee_name ?? 'Unassigned'}</Td>
                  <Td><StatusBadge status={a.status} /></Td>
                </tr>
              ))}
            </Table>
          ) : appointments.isLoading ? (
            <Spinner />
          ) : (
            <EmptyState>No appointments.</EmptyState>
          )}
        </Card>
      )}

      {tab === 'payments' && (
        <Card>
          {payments.data?.length ? (
            <Table head={['Date', 'Amount', 'Method', 'Status']}>
              {payments.data.map((p) => (
                <tr key={p.id}>
                  <Td>{dateTime(p.paid_at ?? p.created_at)}</Td>
                  <Td>{money(p.amount, p.currency)}</Td>
                  <Td>{METHOD_LABEL[p.method] ?? p.method}</Td>
                  <Td><PaymentStatus p={p} /></Td>
                </tr>
              ))}
            </Table>
          ) : payments.isLoading ? (
            <Spinner />
          ) : (
            <EmptyState>No payments.</EmptyState>
          )}
        </Card>
      )}

      {tab === 'invoices' && (
        <Card>
          {invoices.data?.length ? (
            <Table head={['Invoice', 'Issued', 'Due', 'Status', 'Total']}>
              {invoices.data.map((i) => (
                <tr key={i.id}>
                  <Td>
                    <Link to={`/staff/invoices/${i.id}`} className="font-semibold text-brand-700 hover:underline dark:text-brand-600">
                      {i.invoice_number}
                    </Link>
                  </Td>
                  <Td>{date((i.sent_at ?? i.created_at).slice(0, 10))}</Td>
                  <Td className={i.overdue ? 'font-semibold text-red-700 dark:text-red-400' : ''}>{i.due_on ? date(i.due_on) : '—'}</Td>
                  <Td><InvoiceStatus invoice={i} /></Td>
                  <Td className="tabular-nums">{money(i.total, i.currency)}</Td>
                </tr>
              ))}
            </Table>
          ) : invoices.isLoading ? (
            <Spinner />
          ) : (
            <EmptyState>No invoices.</EmptyState>
          )}
        </Card>
      )}

      {tab === 'tickets' && <CustomerTickets customerId={c.id} />}

      {tab === 'access' && (
        <div className="grid gap-5 lg:grid-cols-2">
          {can('read', 'access') && (
            <Card title="Who can access this customer" className="lg:col-span-2" actions={can('update', 'access') && <RestrictedToggle customer={c} />}>
              {access.data?.length ? (
                <Table head={['Employee', 'Role', 'Read', 'Update']}>
                  {access.data.map((r) => (
                    <tr key={r.user_id}>
                      <Td>{r.first_name} {r.last_name}</Td>
                      <Td>{r.role}</Td>
                      <Td><Badge tone="brand">{r.can_read}</Badge></Td>
                      <Td>{r.can_update ? <Badge tone="brand">{r.can_update}</Badge> : '—'}</Td>
                    </tr>
                  ))}
                </Table>
              ) : (
                <EmptyState>Only admins.</EmptyState>
              )}
            </Card>
          )}
          {can('update', 'access') && (
            <>
              <AssignmentsCard fixed={{ kind: 'customer', customer: c }} />
              <GrantsCard fixed={{ kind: 'customer', customer: c }} />
            </>
          )}
          {can('merge', 'customers') && <MergeCard key={c.id} customer={c} />}
        </div>
      )}
    </Page>
  );
}

/** Next appointment, visits, paid and balance due, from the lists already loaded. */
function CustomerNumbers({ appointments, payments, invoices }: { appointments?: (Appointment & { employee_name?: string | null })[]; payments?: Payment[]; invoices?: Invoice[] }) {
  const now = Date.now();
  const next = appointments
    ?.filter((a) => new Date(a.scheduled_start).getTime() >= now && !['cancelled', 'no_show', 'completed'].includes(a.status))
    .sort((a, b) => a.scheduled_start.localeCompare(b.scheduled_start))[0];
  const visits = appointments?.filter((a) => a.status === 'completed').length;
  const currency = payments?.[0]?.currency ?? invoices?.[0]?.currency ?? 'USD';
  const paid = payments?.filter((p) => PAID.includes(p.status) && p.currency === currency).reduce((sum, p) => sum + Number(p.amount) - Number(p.amount_refunded), 0);
  const open = invoices?.filter((i) => i.status === 'sent' && i.currency === currency);
  const due = open?.reduce((sum, i) => sum + Number(i.balance), 0);
  const overdue = open?.some((i) => i.overdue);
  const box = 'rounded-xl border border-slate-200 bg-white px-4 py-3.5 shadow-xs dark:border-slate-800 dark:bg-slate-900';
  const label = 'text-xs font-medium text-slate-500 dark:text-slate-400';
  const value = 'mt-1.5 text-lg font-bold tracking-tight tabular-nums';
  return (
    <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
      <div className={box}>
        <div className={label}>Next appointment</div>
        <div className={`${value} whitespace-nowrap !text-base`} title={next ? dateTime(next.scheduled_start, next.time_zone) : undefined}>
          {next
            ? new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: next.time_zone }).format(new Date(next.scheduled_start))
            : '—'}
        </div>
      </div>
      <div className={box}>
        <div className={label}>Visits</div>
        <div className={value}>{visits ?? '—'}</div>
      </div>
      <div className={box}>
        <div className={label}>Paid</div>
        <div className={value}>{paid === undefined ? '—' : money(paid, currency)}</div>
      </div>
      <div className={box}>
        <div className={label}>Balance due</div>
        <div className={`${value} ${overdue ? 'text-red-700 dark:text-red-400' : ''}`}>{due === undefined ? '—' : money(due, currency)}</div>
      </div>
    </div>
  );
}

type ActivityItem = { key: string; when: string; kind: 'appointment' | 'payment' | 'invoice' | 'ticket'; title: ReactNode; detail: string; to?: string };

const KIND: Record<ActivityItem['kind'], { icon: LucideIcon; tone: string }> = {
  appointment: { icon: CalendarDays, tone: 'bg-brand-50 text-brand-700 dark:bg-slate-800 dark:text-brand-600' },
  payment: { icon: CreditCard, tone: 'bg-blue-50 text-blue-700 dark:bg-slate-800 dark:text-blue-300' },
  invoice: { icon: FileText, tone: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300' },
  ticket: { icon: Inbox, tone: 'bg-amber-50 text-amber-800 dark:bg-slate-800 dark:text-amber-300' },
};

/** Appointments, payments, invoices and tickets in one list, newest first (upcoming appointments on top). */
function CustomerActivity({
  appointments,
  payments,
  invoices,
  tickets,
  loading,
}: {
  appointments?: (Appointment & { employee_name?: string | null })[];
  payments?: Payment[];
  invoices?: Invoice[];
  tickets?: Ticket[];
  loading: boolean;
}) {
  const [all, setAll] = useState(false);
  const items: ActivityItem[] = [
    ...(appointments ?? []).map((a) => ({
      key: `a${a.id}`,
      when: a.scheduled_start,
      kind: 'appointment' as const,
      title: (
        <span className="flex flex-wrap items-center gap-2">
          {a.service_name} <StatusBadge status={a.status} />
        </span>
      ),
      detail: [dateTime(a.scheduled_start, a.time_zone), a.employee_name ?? 'Unassigned', a.location_name].filter(Boolean).join(' · '),
    })),
    ...(payments ?? []).map((p) => ({
      key: `p${p.id}`,
      when: p.paid_at ?? p.created_at,
      kind: 'payment' as const,
      title: (
        <span className="flex flex-wrap items-center gap-2">
          Payment · {money(p.amount, p.currency)} <PaymentStatus p={p} />
        </span>
      ),
      detail: [METHOD_LABEL[p.method] ?? p.method, p.payment_number, dateTime(p.paid_at ?? p.created_at)].filter(Boolean).join(' · '),
    })),
    ...(invoices ?? [])
      .filter((i) => i.status !== 'draft')
      .map((i) => ({
        key: `i${i.id}`,
        when: i.sent_at ?? i.created_at,
        kind: 'invoice' as const,
        title: (
          <span className="flex flex-wrap items-center gap-2">
            Invoice {i.invoice_number} · {money(i.total, i.currency)} <InvoiceStatus invoice={i} />
          </span>
        ),
        detail: i.status === 'sent' && i.due_on ? `Due ${date(i.due_on)}${i.overdue ? ' · overdue' : ''}` : dateTime(i.sent_at ?? i.created_at),
        to: `/staff/invoices/${i.id}`,
      })),
    ...(tickets ?? []).map((t) => ({
      key: `t${t.id}`,
      when: t.created_at,
      kind: 'ticket' as const,
      title: (
        <span className="flex flex-wrap items-center gap-2">
          Ticket #{t.id} · {t.subject} <TicketStatus status={t.status} staff />
        </span>
      ),
      detail: `Opened ${dateTime(t.created_at)}`,
      to: `/staff/tickets/${t.id}`,
    })),
  ].sort((a, b) => b.when.localeCompare(a.when));
  const shown = all ? items : items.slice(0, 12);

  return (
    <Card title="Activity" actions={<span className="text-xs text-slate-500 dark:text-slate-400">Appointments, payments, invoices and tickets</span>}>
      {loading && !items.length ? (
        <Spinner />
      ) : !items.length ? (
        <EmptyState>Nothing yet.</EmptyState>
      ) : (
        <>
          <ol className="-my-2 divide-y divide-slate-100 dark:divide-slate-800">
            {shown.map((item) => {
              const { icon: Icon, tone } = KIND[item.kind];
              return (
                <li key={item.key} className="flex gap-3.5 py-3">
                  <span className={`grid size-8 shrink-0 place-items-center rounded-lg ${tone}`} aria-hidden="true">
                    <Icon className="size-4" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-semibold">
                      {item.to ? (
                        <Link to={item.to} className="hover:underline">
                          {item.title}
                        </Link>
                      ) : (
                        item.title
                      )}
                    </div>
                    <p className="mt-0.5 truncate text-sm text-slate-500 dark:text-slate-400">{item.detail}</p>
                  </div>
                </li>
              );
            })}
          </ol>
          {items.length > shown.length && (
            <div className="mt-3">
              <Button size="sm" variant="ghost" onClick={() => setAll(true)}>
                Show all {items.length}
              </Button>
            </div>
          )}
        </>
      )}
    </Card>
  );
}

/** Admins: restricted customers are hidden from location-wide staff access. */
function RestrictedToggle({ customer: c }: { customer: Customer }) {
  const api = useApi();
  const qc = useQueryClient();
  const set = useMutation({
    mutationFn: () => api.put<Customer>(`/customers/${c.id}`, { restricted: !c.restricted }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['customer', c.id] });
      void qc.invalidateQueries({ queryKey: ['access', c.id] });
      void qc.invalidateQueries({ queryKey: ['restricted'] });
    },
  });
  return (
    <Button size="sm" variant="secondary" disabled={set.isPending} onClick={() => set.mutate()} title={set.error ? (set.error as Error).message : undefined}>
      {c.restricted ? 'Remove restriction' : 'Restrict'}
    </Button>
  );
}

function InviteButtons({ customer: c }: { customer: Customer }) {
  const api = useApi();
  const invite = useMutation({ mutationFn: (channel: 'email' | 'whatsapp') => api.post<{ sent_to: string }>(`/customers/${c.id}/invite`, { channel }) });
  if (invite.isSuccess) return <Badge tone="green">invite sent to {invite.data.sent_to}</Badge>;
  return (
    <>
      {c.email && <Button size="sm" variant="secondary" disabled={invite.isPending} onClick={() => invite.mutate('email')}>Invite by email</Button>}
      {c.phone && c.whatsapp_opt_in_at && <Button size="sm" variant="secondary" disabled={invite.isPending} onClick={() => invite.mutate('whatsapp')}>Invite on WhatsApp</Button>}
      {invite.error && <span className="text-sm text-red-600">{(invite.error as Error).message}</span>}
    </>
  );
}

// Payments -----------------------------------------------------------------------------------

export function Payments() {
  const [tab, setTab] = useState<'record' | 'pending' | 'unmatched'>('record');
  const tabs = [
    ['record', 'Record a payment'],
    ['pending', 'Pending bank transfers'],
    ['unmatched', 'Unmatched Stripe payments'],
  ] as const;
  return (
    <Page>
      <PageHeader title="Payments" description="Manual payments (POS, bank transfer, cash) and Stripe follow-ups." />
      <Tabs label="Payments" tabs={tabs.map(([key, label]) => ({ key, label }))} value={tab} onChange={setTab} />
      {tab === 'record' && <RecordPayment />}
      {tab === 'pending' && <PendingTransfers />}
      {tab === 'unmatched' && <UnmatchedStripe />}
    </Page>
  );
}


interface Duplicate {
  id: string;
  payment_number: string;
  source: string;
  method: string;
  amount: string;
  occurred_at: string;
}

/** Also on the staff home page, with a title. */
export function RecordPayment({ title }: { title?: string }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [method, setMethod] = useState<'card_pos' | 'bank_transfer' | 'cash'>('card_pos');
  const [amount, setAmount] = useState('');
  const [reference, setReference] = useState('');
  const [received, setReceived] = useState(true);
  const [expected, setExpected] = useState('');
  const [duplicates, setDuplicates] = useState<Duplicate[] | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const submit = useMutation({
    mutationFn: (confirm: boolean) => {
      const body: Record<string, unknown> = { method, customer_id: customer!.id, amount: Number(amount), confirm_duplicate: confirm || undefined };
      const now = new Date().toISOString();
      if (method === 'card_pos') Object.assign(body, { pos_reference: reference, paid_at: now });
      if (method === 'cash') Object.assign(body, { paid_at: now, receipt_number: reference || undefined });
      if (method === 'bank_transfer') Object.assign(body, received ? { bank_reference: reference, paid_at: now } : { expected_at: expected });
      return api.post<{ payment: { payment_number: string } }>('/payments', body);
    },
    onSuccess: (res) => {
      setSaved(res.payment.payment_number);
      setDuplicates(null);
      setAmount('');
      setReference('');
      void queryClient.invalidateQueries({ queryKey: ['payments'] });
    },
    onError: (err) => {
      if (err instanceof ApiError && err.body.code === 'possible_duplicate') setDuplicates(err.body.candidates as Duplicate[]);
    },
  });

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    setSaved(null);
    submit.mutate(false);
  };

  return (
    <Card title={title}>
      <form onSubmit={onSubmit} className="grid max-w-xl gap-4">
        <Field label="Customer">
          <CustomerPicker value={customer} onChange={setCustomer} />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Method">
            <Select value={method} onChange={(e) => setMethod(e.target.value as typeof method)}>
              <option value="card_pos">Card (POS terminal)</option>
              <option value="bank_transfer">Bank transfer</option>
              <option value="cash">Cash</option>
            </Select>
          </Field>
          <Field label="Amount">
            <Input type="number" min="0.01" step="0.01" required value={amount} onChange={(e) => setAmount(e.target.value)} />
          </Field>
        </div>
        {method === 'bank_transfer' && (
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={received} onChange={(e) => setReceived(e.target.checked)} /> Already received
          </label>
        )}
        {method === 'bank_transfer' && !received ? (
          <Field label="Expected on">
            <Input type="date" required value={expected} onChange={(e) => setExpected(e.target.value)} />
          </Field>
        ) : (
          <Field
            label={method === 'card_pos' ? 'POS reference' : method === 'cash' ? 'Receipt number (optional)' : 'Bank reference'}
            hint={method === 'card_pos' ? 'Transaction or authorization ID printed on the POS receipt.' : undefined}
          >
            <Input required={method !== 'cash'} value={reference} onChange={(e) => setReference(e.target.value)} />
          </Field>
        )}
        {duplicates && (
          <div role="alert" className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-800 dark:bg-amber-950">
            <p className="font-medium">This may already be recorded:</p>
            <ul className="my-2 list-disc pl-5">
              {duplicates.map((d) => (
                <li key={d.id}>
                  {d.payment_number} · {money(d.amount)} · {METHOD_LABEL[d.method] ?? d.method} ({d.source}) · {date(d.occurred_at)}
                </li>
              ))}
            </ul>
            <div className="flex gap-2">
              <Button type="button" size="sm" onClick={() => submit.mutate(true)}>It's a different payment — save</Button>
              <Button type="button" size="sm" variant="secondary" onClick={() => setDuplicates(null)}>Cancel</Button>
            </div>
          </div>
        )}
        {submit.error && !duplicates && <ErrorBanner error={submit.error} />}
        {saved && <p role="status" className="text-sm text-emerald-700">Saved as {saved}.</p>}
        <div>
          <Button type="submit" disabled={!customer || submit.isPending}>Record payment</Button>
        </div>
      </form>
    </Card>
  );
}

function PendingTransfers() {
  const api = useApi();
  const queryClient = useQueryClient();
  const q = useQuery({ queryKey: ['payments', 'pending'], queryFn: () => api.get<(Payment & { overdue: boolean })[]>('/payments/pending-transfers') });
  const [refs, setRefs] = useState<Record<string, string>>({});
  const mark = useMutation({
    mutationFn: (id: string) => api.post(`/payments/${id}/mark-received`, { bank_reference: refs[id], paid_at: new Date().toISOString() }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['payments'] }),
  });
  return (
    <Card>
      {mark.error && <div className="mb-3"><ErrorBanner error={mark.error} /></div>}
      {q.isLoading ? (
        <Spinner />
      ) : !q.data?.length ? (
        <EmptyState>No pending transfers.</EmptyState>
      ) : (
        <Table head={['Payment', 'Amount', 'Expected', '', 'Mark received']}>
          {q.data.map((p) => (
            <tr key={p.id}>
              <Td>{p.payment_number}</Td>
              <Td>{money(p.amount, p.currency)}</Td>
              <Td>{p.expected_at ? date(p.expected_at) : '—'}</Td>
              <Td>{p.overdue && <Badge tone="red">overdue</Badge>}</Td>
              <Td>
                <form
                  className="flex gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    mark.mutate(p.id);
                  }}
                >
                  <Input
                    aria-label={`Bank reference for ${p.payment_number}`}
                    placeholder="Bank reference"
                    required
                    value={refs[p.id] ?? ''}
                    onChange={(e) => setRefs({ ...refs, [p.id]: e.target.value })}
                  />
                  <Button size="sm" type="submit">Received</Button>
                </form>
              </Td>
            </tr>
          ))}
        </Table>
      )}
    </Card>
  );
}

function UnmatchedStripe() {
  const api = useApi();
  const queryClient = useQueryClient();
  const q = useQuery({ queryKey: ['payments', 'unmatched'], queryFn: () => api.get<Payment[]>('/payments?unmatched=true') });
  const [assigning, setAssigning] = useState<string | null>(null);
  const [customer, setCustomer] = useState<Customer | null>(null);
  const assign = useMutation({
    mutationFn: () => api.post(`/payments/${assigning}/assign`, { customer_id: customer!.id }),
    onSuccess: () => {
      setAssigning(null);
      setCustomer(null);
      void queryClient.invalidateQueries({ queryKey: ['payments'] });
    },
  });
  return (
    <Card>
      {q.isLoading ? (
        <Spinner />
      ) : !q.data?.length ? (
        <EmptyState>Every Stripe payment is matched to a customer.</EmptyState>
      ) : (
        <Table head={['Payment', 'Amount', 'Date', 'Card', '']}>
          {q.data.map((p) => (
            <tr key={p.id}>
              <Td>{p.payment_number}</Td>
              <Td>{money(p.amount, p.currency)}</Td>
              <Td>{dateTime(p.paid_at ?? p.created_at)}</Td>
              <Td>{p.card_last4 ? `${p.card_brand} •••• ${p.card_last4}` : '—'}</Td>
              <Td>
                {assigning === p.id ? (
                  <div className="w-72 space-y-2">
                    <CustomerPicker value={customer} onChange={setCustomer} />
                    <div className="flex gap-2">
                      <Button size="sm" disabled={!customer || assign.isPending} onClick={() => assign.mutate()}>Assign</Button>
                      <Button size="sm" variant="ghost" onClick={() => setAssigning(null)}>Cancel</Button>
                    </div>
                    {assign.error && <ErrorBanner error={assign.error} />}
                  </div>
                ) : (
                  <Button size="sm" variant="secondary" onClick={() => setAssigning(p.id)}>Assign to customer</Button>
                )}
              </Td>
            </tr>
          ))}
        </Table>
      )}
    </Card>
  );
}

// Admin --------------------------------------------------------------------------------------

interface Settings {
  business_name: string;
  default_time_zone: string;
  default_currency: string;
  bank_transfer_due_days: number;
  chat_daily_limit_customer: number;
  chat_daily_limit_employee: number;
  team_chat_retention: number;
  invoice_due_days: number;
  bank_transfer_instructions: string | null;
  whatsapp_enabled: boolean;
  whatsapp_phone_number_id: string | null;
  whatsapp_otp_template: string | null;
  whatsapp_invite_template: string | null;
}

export function Admin() {
  return (
    <Page>
      <PageHeader title="Settings" description="Business settings. Stripe has its own page under Settings › Stripe." />
      <div className="max-w-3xl">
        <SettingsCard />
      </div>
    </Page>
  );
}

function SettingsCard() {
  const api = useApi();
  const queryClient = useQueryClient();
  const q = useQuery({ queryKey: ['settings'], queryFn: () => api.get<Settings>('/settings') });
  const [draft, setDraft] = useState<Partial<Settings>>({});
  const save = useMutation({
    mutationFn: () => api.put<Settings>('/admin/settings', draft),
    onSuccess: () => {
      setDraft({});
      void queryClient.invalidateQueries({ queryKey: ['settings'] });
    },
  });
  if (!q.data) return <Card title="General settings"><Spinner /></Card>;
  const v = { ...q.data, ...draft };
  const set = (patch: Partial<Settings>) => setDraft({ ...draft, ...patch });
  return (
    <Card title="General settings">
      <form
        className="grid gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <Field label="Business name"><Input value={v.business_name ?? ''} onChange={(e) => set({ business_name: e.target.value })} /></Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Default time zone" hint="IANA name, e.g. America/New_York"><Input value={v.default_time_zone} onChange={(e) => set({ default_time_zone: e.target.value })} /></Field>
          <Field label="Default currency"><Input value={v.default_currency} maxLength={3} onChange={(e) => set({ default_currency: e.target.value.toUpperCase() })} /></Field>
        </div>
        <Field label="Bank transfers are overdue after (days)">
          <Input type="number" min={1} value={v.bank_transfer_due_days} onChange={(e) => set({ bank_transfer_due_days: Number(e.target.value) })} />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Chat questions per day — customers" hint="Rolling 24 hours, per person">
            <Input type="number" min={1} value={v.chat_daily_limit_customer} onChange={(e) => set({ chat_daily_limit_customer: Number(e.target.value) })} />
          </Field>
          <Field label="Chat questions per day — employees">
            <Input type="number" min={1} value={v.chat_daily_limit_employee} onChange={(e) => set({ chat_daily_limit_employee: Number(e.target.value) })} />
          </Field>
        </div>
        <div className="grid gap-3 sm:grid-cols-[10rem_minmax(0,1fr)]">
          <Field label="Invoices due after (days)">
            <Input type="number" min={0} max={365} value={v.invoice_due_days} onChange={(e) => set({ invoice_due_days: Number(e.target.value) })} />
          </Field>
          <Field label="Bank transfer details for invoices" hint="Shown to customers under “Pay by bank transfer”">
            <textarea
              rows={3}
              maxLength={2000}
              value={v.bank_transfer_instructions ?? ''}
              onChange={(e) => set({ bank_transfer_instructions: e.target.value || null })}
              placeholder={'Bank: …\nAccount name: …\nAccount / IBAN: …'}
              className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-900"
            />
          </Field>
        </div>
        <Field label="Team chat: messages kept per channel" hint="Older messages are deleted as new ones arrive (10–10,000)">
          <Input type="number" min={10} max={10000} value={v.team_chat_retention} onChange={(e) => set({ team_chat_retention: Number(e.target.value) })} />
        </Field>
        <fieldset className="grid gap-3 rounded-lg border border-slate-200 p-3 dark:border-slate-800">
          <legend className="px-1 text-sm font-medium">WhatsApp (sign-in codes)</legend>
          <Field label="Phone number ID" hint="From AWS End User Messaging Social">
            <Input value={v.whatsapp_phone_number_id ?? ''} onChange={(e) => set({ whatsapp_phone_number_id: e.target.value || null })} />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Code template (authentication)"><Input value={v.whatsapp_otp_template ?? ''} onChange={(e) => set({ whatsapp_otp_template: e.target.value || null })} /></Field>
            <Field label="Invite template (utility)" hint="Body: {{1}} name, {{2}} link"><Input value={v.whatsapp_invite_template ?? ''} onChange={(e) => set({ whatsapp_invite_template: e.target.value || null })} /></Field>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" className="switch" checked={v.whatsapp_enabled} onChange={(e) => set({ whatsapp_enabled: e.target.checked })} /> Send codes over WhatsApp
          </label>
        </fieldset>
        {save.error && <ErrorBanner error={save.error} />}
        <div><Button type="submit" disabled={Object.keys(draft).length === 0 || save.isPending}>Save settings</Button></div>
      </form>
    </Card>
  );
}
