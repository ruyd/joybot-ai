import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Page } from '../../components/Layout';
import { Badge, Button, Card, EmptyState, ErrorBanner, Field, Input, PageHeader, Select, Spinner, StatusBadge, Table, Td } from '../../components/ui';
import { ApiError, useApi } from '../../lib/api';
import { date, dateTime, fullName, METHOD_LABEL, money } from '../../lib/format';
import { useMe } from '../../lib/me';
import { PaymentStatus, type Appointment, type Payment } from '../portal/PortalPages';
import { CustomerTickets } from '../portal/TicketPages';
import { CustomerPicker, type Customer } from './CustomerPicker';
import { MergeCard } from './ReviewPages';


// Customers ----------------------------------------------------------------------------------

export function Customers() {
  const api = useApi();
  const [q, setQ] = useState('');
  const [term, setTerm] = useState('');
  const query = useQuery({ queryKey: ['customers', term], queryFn: () => api.get<Customer[]>(`/customers?q=${encodeURIComponent(term)}`) });
  return (
    <Page>
      <PageHeader title="Customers" description="Only customers you have access to are shown." />
      <form
        className="mb-4 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          setTerm(q.trim());
        }}
      >
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name, email, phone or customer number" aria-label="Search customers" />
        <Button type="submit">Search</Button>
      </form>
      <Card>
        {query.isLoading ? (
          <Spinner />
        ) : query.error ? (
          <ErrorBanner error={query.error} />
        ) : !query.data?.length ? (
          <EmptyState>No customers found.</EmptyState>
        ) : (
          <Table head={['Customer', 'Number', 'Contact', 'Status']}>
            {query.data.map((c) => (
              <tr key={c.id}>
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
        )}
      </Card>
    </Page>
  );
}

export function CustomerDetail() {
  const { id } = useParams();
  const api = useApi();
  const { can } = useMe();
  const customer = useQuery({ queryKey: ['customer', id], queryFn: () => api.get<Customer>(`/customers/${id}`) });
  const appointments = useQuery({ queryKey: ['appointments', 'customer', id], queryFn: () => api.get<(Appointment & { notes_internal?: string })[]>(`/appointments?customer_id=${id}&limit=50`) });
  const payments = useQuery({ queryKey: ['payments', 'customer', id], queryFn: () => api.get<Payment[]>(`/payments?customer_id=${id}`) });
  const access = useQuery({
    queryKey: ['access', id],
    enabled: can('read', 'access'),
    queryFn: () => api.get<{ user_id: string; first_name: string; last_name: string; role: string; can_read: string; can_update: string | null }[]>(`/customers/${id}/access`),
  });

  if (customer.isLoading) return <Page><Spinner /></Page>;
  if (customer.error) return <Page><ErrorBanner error={customer.error} /></Page>;
  const c = customer.data!;
  return (
    <Page>
      <PageHeader
        title={fullName(c)}
        description={[c.customer_number, c.email, c.phone].filter(Boolean).join(' · ')}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {c.restricted && <Badge tone="red">restricted</Badge>}
            <StatusBadge status={c.status} />
            {c.has_login ? <Badge tone="green">portal account</Badge> : can('update', 'customers') && <InviteButtons customer={c} />}
          </div>
        }
      />
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Appointments">
          {appointments.data?.length ? (
            <Table head={['When', 'Service', 'Status']}>
              {appointments.data.map((a) => (
                <tr key={a.id}>
                  <Td>{dateTime(a.scheduled_start, a.time_zone)}</Td>
                  <Td>{a.service_name}{a.notes_internal && <span className="block text-xs text-amber-700">Note: {a.notes_internal}</span>}</Td>
                  <Td><StatusBadge status={a.status} /></Td>
                </tr>
              ))}
            </Table>
          ) : (
            <EmptyState>No appointments.</EmptyState>
          )}
        </Card>
        <Card title="Payments">
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
          ) : (
            <EmptyState>No payments.</EmptyState>
          )}
        </Card>
        {can('read', 'tickets') && <CustomerTickets customerId={c.id} />}
        {c.notes_internal && (
          <Card title="Internal notes">
            <p className="whitespace-pre-wrap text-sm">{c.notes_internal}</p>
          </Card>
        )}
        {can('read', 'access') && (
          <Card title="Who can access this customer">
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
        {can('merge', 'customers') && <MergeCard key={c.id} customer={c} />}
      </div>
    </Page>
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
      <div role="tablist" className="mb-4 flex gap-1 overflow-x-auto">
        {tabs.map(([key, label]) => (
          <button
            key={key}
            role="tab"
            aria-selected={tab === key}
            onClick={() => setTab(key)}
            className={`whitespace-nowrap rounded-lg px-3 py-1.5 text-sm ${tab === key ? 'bg-brand-600 text-white' : 'hover:bg-slate-100 dark:hover:bg-slate-900'}`}
          >
            {label}
          </button>
        ))}
      </div>
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

function RecordPayment() {
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
    <Card>
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
  stripe_enabled: boolean;
  bank_transfer_due_days: number;
  whatsapp_enabled: boolean;
  whatsapp_phone_number_id: string | null;
  whatsapp_otp_template: string | null;
  whatsapp_invite_template: string | null;
  freshdesk_domain: string | null;
  freshdesk_portal_url: string | null;
}

export function Admin() {
  return (
    <Page>
      <PageHeader title="Admin" />
      <div className="grid gap-4 lg:grid-cols-2">
        <SettingsCard />
        <StripeCard />
        <EmployeesCard />
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
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={v.stripe_enabled} onChange={(e) => set({ stripe_enabled: e.target.checked })} /> Stripe sync enabled
        </label>
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
            <input type="checkbox" checked={v.whatsapp_enabled} onChange={(e) => set({ whatsapp_enabled: e.target.checked })} /> Send codes over WhatsApp
          </label>
        </fieldset>
        <fieldset className="grid gap-3 rounded-lg border border-slate-200 p-3 dark:border-slate-800">
          <legend className="px-1 text-sm font-medium">Freshdesk (support tickets)</legend>
          <Field label="Freshdesk domain" hint="e.g. yourco.freshdesk.com — the API key lives in Secrets Manager">
            <Input value={v.freshdesk_domain ?? ''} onChange={(e) => set({ freshdesk_domain: e.target.value || null })} />
          </Field>
          <Field label="Customer portal URL" hint="Where customers open their tickets, e.g. https://support.yourco.com">
            <Input value={v.freshdesk_portal_url ?? ''} onChange={(e) => set({ freshdesk_portal_url: e.target.value || null })} />
          </Field>
          <FreshdeskTest />
        </fieldset>
        {save.error && <ErrorBanner error={save.error} />}
        <div><Button type="submit" disabled={Object.keys(draft).length === 0 || save.isPending}>Save settings</Button></div>
      </form>
    </Card>
  );
}

function FreshdeskTest() {
  const api = useApi();
  const test = useMutation({ mutationFn: () => api.post<{ ok: boolean }>('/admin/settings/freshdesk/test') });
  return (
    <div className="flex items-center gap-3 text-sm">
      <Button type="button" size="sm" variant="secondary" disabled={test.isPending} onClick={() => test.mutate()}>Test connection</Button>
      {test.isSuccess && <span className="text-emerald-700">Connected.</span>}
      {test.error && <span className="text-red-600">{(test.error as Error).message}</span>}
    </div>
  );
}

function StripeCard() {
  const api = useApi();
  const queryClient = useQueryClient();
  const q = useQuery({
    queryKey: ['stripe-status'],
    queryFn: () => api.get<{ events: { status: string; count: number }[]; unmatchedPayments: number; lastReconcile: { status: string; finished_at: string | null; result: Record<string, unknown> | null } | null }>('/admin/stripe/status'),
    refetchInterval: 15_000,
  });
  const reconcile = useMutation({ mutationFn: () => api.post('/admin/stripe/reconcile', { days: 3 }), onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['stripe-status'] }) });
  return (
    <Card title="Stripe sync" actions={<Button size="sm" variant="secondary" disabled={reconcile.isPending} onClick={() => reconcile.mutate()}>Reconcile now</Button>}>
      {!q.data ? (
        <Spinner />
      ) : (
        <dl className="grid grid-cols-2 gap-y-2 text-sm">
          {q.data.events.map((e) => (
            <div key={e.status} className="contents">
              <dt className="text-slate-500">Events {e.status}</dt>
              <dd>{e.count}</dd>
            </div>
          ))}
          <dt className="text-slate-500">Unmatched payments</dt>
          <dd>{q.data.unmatchedPayments}</dd>
          <dt className="text-slate-500">Last reconcile</dt>
          <dd>{q.data.lastReconcile ? `${q.data.lastReconcile.status}${q.data.lastReconcile.finished_at ? ` · ${dateTime(q.data.lastReconcile.finished_at)}` : ''}` : 'never'}</dd>
        </dl>
      )}
      {reconcile.error && <ErrorBanner error={reconcile.error} />}
    </Card>
  );
}

interface Employee {
  id: string;
  first_name: string;
  last_name: string;
  email: string;
  role: string;
  active: boolean;
  has_login: boolean;
}

function EmployeesCard() {
  const api = useApi();
  const queryClient = useQueryClient();
  const q = useQuery({ queryKey: ['employees'], queryFn: () => api.get<Employee[]>('/admin/users?include_inactive=true') });
  const [form, setForm] = useState({ first_name: '', last_name: '', email: '', role: 'staff' });
  const add = useMutation({
    mutationFn: () => api.post('/admin/users', form),
    onSuccess: () => {
      setForm({ first_name: '', last_name: '', email: '', role: 'staff' });
      void queryClient.invalidateQueries({ queryKey: ['employees'] });
    },
  });
  return (
    <Card title="Employees" className="lg:col-span-2">
      {q.data && (
        <Table head={['Name', 'Email', 'Role', 'Status']}>
          {q.data.map((u) => (
            <tr key={u.id}>
              <Td>{u.first_name} {u.last_name}</Td>
              <Td>{u.email}</Td>
              <Td>{u.role}</Td>
              <Td>{!u.active ? <Badge tone="red">inactive</Badge> : u.has_login ? <Badge tone="green">active</Badge> : <Badge tone="amber">invited</Badge>}</Td>
            </tr>
          ))}
        </Table>
      )}
      <form
        className="mt-4 grid gap-3 sm:grid-cols-[1fr_1fr_1.5fr_8rem_auto] sm:items-end"
        onSubmit={(e) => {
          e.preventDefault();
          add.mutate();
        }}
      >
        <Field label="First name"><Input required value={form.first_name} onChange={(e) => setForm({ ...form, first_name: e.target.value })} /></Field>
        <Field label="Last name"><Input required value={form.last_name} onChange={(e) => setForm({ ...form, last_name: e.target.value })} /></Field>
        <Field label="Email"><Input type="email" required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></Field>
        <Field label="Role">
          <Select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
            <option value="staff">Staff</option>
            <option value="admin">Admin</option>
          </Select>
        </Field>
        <Button type="submit" disabled={add.isPending}>Invite</Button>
      </form>
      {add.error && <div className="mt-2"><ErrorBanner error={add.error} /></div>}
    </Card>
  );
}
