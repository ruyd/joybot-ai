import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Inbox, Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type { Invoice } from '../../components/InvoiceDocument';
import { Button, EmptyState, ErrorBanner, Input, Select, Spinner, Tabs } from '../../components/ui';
import { useApi } from '../../lib/api';
import { dateTime, fullName, money } from '../../lib/format';
import { useMe } from '../../lib/me';
import type { Appointment, Payment } from '../portal/PortalPages';
import { NewTicket, TicketPriority, TicketStatus, type Ticket, type TicketDetail } from '../portal/TicketPages';
import type { Customer } from './CustomerPicker';

type View = 'active' | 'mine' | 'all';
const ACTIVE = ['open', 'pending'];
const PAID = ['succeeded', 'partially_refunded'];

/** "9:12 AM" today, "Yesterday", then "Nov 7". */
function when(iso: string) {
  const d = new Date(iso);
  const days = Math.round((new Date().setHours(0, 0, 0, 0) - new Date(iso).setHours(0, 0, 0, 0)) / 86_400_000);
  if (days === 0) return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(d);
  if (days === 1) return 'Yesterday';
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(d);
}

const initials = (name: string | null | undefined) =>
  (name ?? '')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0])
    .join('')
    .toUpperCase() || '?';

/**
 * Staff: the support inbox. The ticket list (Active, Mine, All, with search), the selected ticket's
 * conversation and reply box, and the customer beside it. `/staff/tickets/:id` selects a ticket; on
 * small screens the list and the ticket take turns.
 */
export function StaffTickets() {
  const { id } = useParams();
  const api = useApi();
  const { me, can } = useMe();
  const [view, setView] = useState<View>('active');
  const [term, setTerm] = useState('');
  const [creating, setCreating] = useState(false);
  const q = useQuery({ queryKey: ['tickets', 'inbox'], queryFn: () => api.get<Ticket[]>('/tickets') });

  const all = q.data ?? [];
  const active = all.filter((t) => ACTIVE.includes(t.status));
  const mine = active.filter((t) => t.assigned_to === me?.profile.id);
  const shown = useMemo(() => {
    const list = view === 'active' ? active : view === 'mine' ? mine : all;
    const words = term.toLowerCase().split(/\s+/).filter(Boolean);
    return words.length ? list.filter((t) => words.every((w) => `#${t.id} ${t.subject} ${t.customer_name ?? ''}`.toLowerCase().includes(w))) : list;
  }, [view, term, all, active, mine]);

  const pane = 'min-w-0 flex-col lg:flex lg:h-full';
  return (
    <main className="lg:flex lg:h-[calc(100dvh-4rem-var(--dock-gap,0px))]">
      <section aria-label="Tickets" className={`${pane} ${id || creating ? 'hidden' : 'flex'} w-full border-slate-200 lg:w-[22rem] lg:shrink-0 lg:border-r dark:border-slate-800`}>
        <div className="px-4 pt-6 sm:px-5">
          <div className="mb-4 flex items-center justify-between gap-3">
            <h1 className="text-2xl font-bold tracking-tight">Inbox</h1>
            {can('create', 'tickets') && (
              <Button size="sm" onClick={() => setCreating(true)}>
                New ticket
              </Button>
            )}
          </div>
          <label className="relative mb-3 block">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-slate-400" aria-hidden="true" />
            <Input aria-label="Search tickets" placeholder="Search tickets" className="w-full pl-9" value={term} onChange={(e) => setTerm(e.target.value)} />
          </label>
          <Tabs<View>
            label="Which tickets"
            value={view}
            onChange={setView}
            tabs={[
              { key: 'active', label: 'Active', count: q.data ? active.length : null },
              { key: 'mine', label: 'Mine', count: q.data ? mine.length : null },
              { key: 'all', label: 'All' },
            ]}
          />
        </div>
        <div className="flex-1 overflow-y-auto px-2 pb-6 sm:px-3">
          {q.isLoading ? (
            <Spinner />
          ) : q.error ? (
            <ErrorBanner error={q.error} />
          ) : shown.length === 0 ? (
            <EmptyState>{term ? 'No tickets match.' : view === 'mine' ? 'Nothing assigned to you is waiting.' : 'No tickets here.'}</EmptyState>
          ) : (
            <ul className="space-y-0.5">
              {shown.map((t) => (
                <li key={t.id}>
                  <TicketRow ticket={t} selected={t.id === id} />
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      <section aria-label="Ticket" className={`${pane} ${id || creating ? 'flex' : 'hidden'} flex-1 bg-slate-50/60 dark:bg-slate-950`}>
        {creating ? (
          <div className="mx-auto w-full max-w-2xl overflow-y-auto px-4 py-6 sm:px-6">
            <NewTicket staff onDone={() => setCreating(false)} />
          </div>
        ) : id ? (
          <Conversation key={id} id={id} />
        ) : (
          <div className="m-auto flex flex-col items-center gap-2 text-sm text-slate-500">
            <Inbox className="size-8 text-slate-300 dark:text-slate-700" aria-hidden="true" />
            Pick a ticket to read it here.
          </div>
        )}
      </section>
    </main>
  );
}

function TicketRow({ ticket: t, selected }: { ticket: Ticket; selected: boolean }) {
  return (
    <Link
      to={`/staff/tickets/${t.id}`}
      aria-current={selected ? 'page' : undefined}
      className={`block rounded-xl px-3 py-3 ${selected ? 'bg-brand-50 dark:bg-slate-900' : 'hover:bg-slate-50 dark:hover:bg-slate-900/60'}`}
    >
      <div className="flex items-baseline justify-between gap-3">
        <span className="truncate font-semibold">{t.customer_name ?? 'Customer'}</span>
        <span className="shrink-0 text-xs text-slate-500">{when(t.last_message_at)}</span>
      </div>
      <div className="mt-0.5 truncate text-sm text-slate-700 dark:text-slate-300">{t.subject}</div>
      <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-slate-500">
        <TicketStatus status={t.status} staff />
        {(t.priority === 'urgent' || t.priority === 'high') && <TicketPriority priority={t.priority} />}
        <span>
          #{t.id} · {t.assigned_to_name ?? 'Unassigned'}
        </span>
      </div>
    </Link>
  );
}

/** One ticket: header with assignee, priority and resolve; the messages; the reply box; the customer on wide screens. */
function Conversation({ id }: { id: string }) {
  const api = useApi();
  const { can } = useMe();
  const queryClient = useQueryClient();
  const q = useQuery({ queryKey: ['ticket', id], queryFn: () => api.get<TicketDetail>(`/tickets/${id}`) });
  const staffList = useQuery({
    queryKey: ['tickets', 'assignees'],
    enabled: can('update', 'tickets'),
    queryFn: () => api.get<{ id: string; first_name: string | null; last_name: string | null }[]>('/tickets/assignees'),
  });
  const refresh = (t: TicketDetail) => {
    queryClient.setQueryData(['ticket', id], t);
    void queryClient.invalidateQueries({ queryKey: ['tickets'] });
  };
  const update = useMutation({ mutationFn: (body: Record<string, unknown>) => api.put<TicketDetail>(`/tickets/${id}`, body), onSuccess: refresh });

  if (q.isLoading) return <Spinner />;
  if (q.error) return <div className="p-6">{(q.error as { status?: number }).status === 404 ? <EmptyState>Ticket not found.</EmptyState> : <ErrorBanner error={q.error} />}</div>;
  const t = q.data!;
  const done = t.status === 'resolved' || t.status === 'closed';
  const editable = can('update', 'tickets');

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex flex-wrap items-center gap-3 border-b border-slate-200 bg-white px-4 py-4 sm:px-6 dark:border-slate-800 dark:bg-slate-950">
          <Link to="/staff/tickets" className="press -ml-1 grid size-9 place-items-center rounded-lg hover:bg-slate-100 lg:hidden dark:hover:bg-slate-900" aria-label="All tickets">
            <ArrowLeft className="size-4" aria-hidden="true" />
          </Link>
          <div className="min-w-0 flex-[1_1_14rem]">
            <h2 className="truncate text-lg font-bold tracking-tight">{t.subject}</h2>
            <p className="truncate text-sm text-slate-500">
              #{t.id} ·{' '}
              <Link to={`/staff/customers/${t.customer_id}`} className="font-medium text-brand-600 hover:underline">
                {t.customer_name ?? 'Customer'}
              </Link>{' '}
              · opened {dateTime(t.created_at)}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <TicketStatus status={t.status} staff />
            {editable ? (
              <fieldset disabled={update.isPending} className="flex flex-wrap items-center gap-2">
                <Select aria-label="Assigned to" value={t.assigned_to ?? ''} onChange={(e) => update.mutate({ assigned_to: e.target.value || null })}>
                  <option value="">Unassigned</option>
                  {staffList.data?.map((s) => (
                    <option key={s.id} value={s.id}>
                      {fullName(s)}
                    </option>
                  ))}
                </Select>
                <Select aria-label="Priority" value={t.priority} onChange={(e) => update.mutate({ priority: e.target.value })}>
                  {(['low', 'medium', 'high', 'urgent'] as const).map((p) => (
                    <option key={p} value={p}>
                      {p[0].toUpperCase() + p.slice(1)} priority
                    </option>
                  ))}
                </Select>
                <Button variant="secondary" onClick={() => update.mutate({ status: done ? 'open' : 'resolved' })}>
                  {done ? 'Reopen' : 'Resolve'}
                </Button>
              </fieldset>
            ) : (
              <span className="text-sm text-slate-500">{t.assigned_to_name ?? 'Unassigned'}</span>
            )}
          </div>
          {update.error ? <div className="w-full"><ErrorBanner error={update.error} /></div> : null}
        </header>

        <div className="flex-1 space-y-4 overflow-y-auto px-4 py-6 sm:px-6">
          {t.messages.map((m) =>
            m.internal ? (
              <div key={m.id} className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm dark:border-amber-900 dark:bg-amber-950">
                <p className="mb-1 text-xs font-semibold text-amber-800 dark:text-amber-300">
                  Internal note{m.author_name ? ` · ${m.author_name}` : ''} · {dateTime(m.created_at)}
                </p>
                <p className="whitespace-pre-wrap">{m.body}</p>
              </div>
            ) : m.from === 'support' ? (
              <div key={m.id} className="ml-auto max-w-[85%] rounded-xl bg-brand-700 px-4 py-3 text-sm text-white shadow-xs">
                <p className="mb-1 text-xs font-semibold text-white/80">
                  {m.author_name ?? 'Support'} · {dateTime(m.created_at)}
                </p>
                <p className="whitespace-pre-wrap">{m.body}</p>
              </div>
            ) : (
              <div key={m.id} className="mr-auto max-w-[85%] rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm shadow-xs dark:border-slate-800 dark:bg-slate-900">
                <p className="mb-1 text-xs font-semibold text-slate-500">
                  {m.author_name ?? t.customer_name ?? 'Customer'} · {dateTime(m.created_at)}
                </p>
                <p className="whitespace-pre-wrap">{m.body}</p>
              </div>
            ),
          )}
        </div>

        <div className="px-4 pb-5 sm:px-6">
          <Composer ticketId={t.id} firstName={t.customer_name?.split(' ')[0]} onSent={refresh} />
        </div>
      </div>
      <CustomerPanel customerId={t.customer_id} />
    </div>
  );
}

function Composer({ ticketId, firstName, onSent }: { ticketId: string; firstName?: string; onSent: (t: TicketDetail) => void }) {
  const api = useApi();
  const [body, setBody] = useState('');
  const [internal, setInternal] = useState(false);
  const [notify, setNotify] = useState(true);
  const send = useMutation({
    mutationFn: () => api.post<TicketDetail>(`/tickets/${ticketId}/messages`, { body, internal, notify }),
    onSuccess: (t) => {
      setBody('');
      setInternal(false);
      onSent(t);
    },
  });
  return (
    <form
      className={`overflow-hidden rounded-xl border bg-white shadow-xs dark:bg-slate-900 ${internal ? 'border-amber-300 dark:border-amber-900' : 'border-slate-200 dark:border-slate-800'}`}
      onSubmit={(e) => {
        e.preventDefault();
        send.mutate();
      }}
    >
      <textarea
        aria-label={internal ? 'Internal note' : 'Reply'}
        className="block w-full resize-y border-0 bg-transparent px-4 py-3 text-sm focus:ring-0 focus:outline-none"
        rows={3}
        maxLength={10_000}
        placeholder={internal ? 'A note only staff will see' : `Reply to ${firstName ?? 'the customer'}…`}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && body.trim()) send.mutate();
        }}
      />
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-slate-100 px-4 py-2.5 dark:border-slate-800">
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={internal} onChange={(e) => setInternal(e.target.checked)} /> Internal note
        </label>
        {!internal && (
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} /> Email the customer
          </label>
        )}
        <Button type="submit" className="ml-auto" disabled={send.isPending || !body.trim()}>
          {internal ? 'Add note' : 'Send'}
        </Button>
      </div>
      {send.error ? <div className="px-4 pb-3"><ErrorBanner error={send.error} /></div> : null}
    </form>
  );
}

/** The customer beside the ticket (wide screens): next visit, balance, their tickets and recent payments. Shares the customer page's queries. */
function CustomerPanel({ customerId: id }: { customerId: string }) {
  const api = useApi();
  const { can } = useMe();
  const customer = useQuery({ queryKey: ['customer', id], queryFn: () => api.get<Customer & { created_at?: string }>(`/customers/${id}`) });
  const appointments = useQuery({ queryKey: ['appointments', 'customer', id], queryFn: () => api.get<Appointment[]>(`/appointments?customer_id=${id}&limit=200`) });
  const payments = useQuery({ queryKey: ['payments', 'customer', id], queryFn: () => api.get<Payment[]>(`/payments?customer_id=${id}&limit=200`) });
  const invoices = useQuery({
    queryKey: ['invoices', 'customer', id],
    enabled: can('read', 'payments'),
    queryFn: () => api.get<{ items: Invoice[] }>(`/invoices?customer_id=${id}&limit=200`).then((r) => r.items),
  });
  const tickets = useQuery({ queryKey: ['tickets', 'customer', id], queryFn: () => api.get<Ticket[]>(`/tickets?customer_id=${id}`) });
  const orgId = customer.data?.organization_id;
  const organization = useQuery({ queryKey: ['organization', orgId], enabled: Boolean(orgId), queryFn: () => api.get<{ id: string; name: string }>(`/organizations/${orgId}`) });

  const c = customer.data;
  const now = Date.now();
  const next = appointments.data
    ?.filter((a) => new Date(a.scheduled_start).getTime() >= now && !['cancelled', 'no_show', 'completed'].includes(a.status))
    .sort((a, b) => a.scheduled_start.localeCompare(b.scheduled_start))[0];
  const open = invoices.data?.filter((i) => i.status === 'sent');
  const currency = open?.[0]?.currency ?? payments.data?.[0]?.currency ?? 'USD';
  const due = open?.filter((i) => i.currency === currency).reduce((sum, i) => sum + Number(i.balance), 0);
  const dueBy = open?.map((i) => i.due_on).filter(Boolean).sort()[0];
  const overdue = open?.some((i) => i.overdue);
  const activeTickets = tickets.data?.filter((t) => ACTIVE.includes(t.status)).length;
  const doneTickets = tickets.data ? tickets.data.length - (activeTickets ?? 0) : undefined;
  const recent = payments.data?.filter((p) => PAID.includes(p.status)).slice(0, 3);
  const name = c ? fullName(c) : '';

  return (
    <aside aria-label="Customer" className="hidden w-72 shrink-0 overflow-y-auto border-l border-slate-200 bg-white px-5 py-6 xl:block dark:border-slate-800 dark:bg-slate-950">
      {customer.isLoading ? (
        <Spinner />
      ) : customer.error ? (
        <ErrorBanner error={customer.error} />
      ) : (
        c && (
          <>
            <div className="flex items-center gap-3">
              <span className="grid size-11 shrink-0 place-items-center rounded-full bg-brand-50 font-bold text-brand-700 dark:bg-slate-800 dark:text-brand-600" aria-hidden="true">
                {initials(name)}
              </span>
              <div className="min-w-0">
                <div className="truncate font-semibold">{name}</div>
                <div className="truncate text-xs text-slate-500">{[organization.data?.name, c.customer_number].filter(Boolean).join(' · ')}</div>
              </div>
            </div>
            <dl className="mt-5 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
              <dt className="text-slate-500">Next visit</dt>
              <dd className="font-medium">
                {next ? new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: next.time_zone }).format(new Date(next.scheduled_start)) : '—'}
              </dd>
              {can('read', 'payments') && (
                <>
                  <dt className="text-slate-500">Balance</dt>
                  <dd className={`font-medium ${overdue ? 'text-red-700 dark:text-red-400' : ''}`}>
                    {due === undefined ? '—' : due > 0 ? `${money(due, currency)}${dueBy ? ` due ${new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(new Date(`${dueBy}T00:00`))}` : ''}` : 'Nothing due'}
                  </dd>
                </>
              )}
              <dt className="text-slate-500">Tickets</dt>
              <dd className="font-medium">{tickets.data ? `${activeTickets} open · ${doneTickets} resolved` : '—'}</dd>
            </dl>
            {recent && recent.length > 0 && (
              <div className="mt-5 border-t border-slate-100 pt-4 dark:border-slate-800">
                <h3 className="mb-2 text-sm font-semibold">Recent payments</h3>
                <ul className="space-y-1.5 text-sm">
                  {recent.map((p) => (
                    <li key={p.id} className="flex items-baseline justify-between gap-3">
                      <span className="truncate text-slate-600 dark:text-slate-400">
                        {p.payment_number} · {p.card_brand ? `${p.card_brand[0].toUpperCase()}${p.card_brand.slice(1)} card` : p.method.replace(/_/g, ' ')}
                      </span>
                      <span className="font-semibold tabular-nums">{money(p.amount, p.currency)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <Link
              to={`/staff/customers/${id}`}
              className="press mt-5 flex min-h-10 items-center justify-center rounded-lg border border-slate-300 bg-white text-sm font-semibold hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:hover:bg-slate-800"
            >
              Open profile
            </Link>
          </>
        )
      )}
    </aside>
  );
}
