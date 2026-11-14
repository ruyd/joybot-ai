import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { InvoiceDocument, InvoiceStatus, type Invoice } from '../../components/InvoiceDocument';
import { Page } from '../../components/Layout';
import { Button, Card, EmptyState, ErrorBanner, Field, Input, PageHeader, Select, Spinner, StatusBadge, Tabs } from '../../components/ui';
import { ApiError, useApi } from '../../lib/api';
import { date, dateTime, METHOD_LABEL, money } from '../../lib/format';
import { useMe } from '../../lib/me';
import { CustomerPicker, type Customer } from './CustomerPicker';

const TABS = [
  { key: 'all', label: 'All' },
  { key: 'draft', label: 'Draft' },
  { key: 'open', label: 'Sent' },
  { key: 'overdue', label: 'Overdue' },
  { key: 'paid', label: 'Paid' },
  { key: 'void', label: 'Void' },
] as const;

interface InvoiceSummary {
  currency: string;
  outstanding_total: string;
  outstanding_count: number;
  overdue_total: string;
  overdue_count: number;
  overdue_names: string[];
  paid_30d_total: string;
  paid_30d_count: number;
  drafts: number;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const shortDate = (value: string | null | undefined) => {
  if (!value) return '—';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  const d = m && value.length === 10 ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date(value);
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' }).format(d);
};

/** Staff: totals, bank transfers waiting, then invoices by status (drafts first, then sent, newest first). */
export function Invoices() {
  const api = useApi();
  const { can } = useMe();
  const [params, setParams] = useSearchParams();
  const tab = TABS.find((t) => t.key === params.get('status'))?.key ?? 'all';
  const [q, setQ] = useState('');
  const term = useDebounced(q.trim(), 250);
  const list = useQuery({
    queryKey: ['invoices', tab, term],
    queryFn: () => api.get<{ items: Invoice[] }>(`/invoices?status=${tab}${term ? `&q=${encodeURIComponent(term)}` : ''}`),
    placeholderData: keepPreviousData,
  });
  const summary = useQuery({ queryKey: ['invoices', 'summary'], queryFn: () => api.get<InvoiceSummary>('/invoices/summary') });
  const transfers = useQuery({
    queryKey: ['payments', 'pending'],
    queryFn: () => api.get<{ amount: string; currency: string; expected_at: string | null }[]>('/payments/pending-transfers'),
  });
  const s = summary.data;
  const m = (v: string) => money(v, s?.currency);
  const waiting = transfers.data ?? [];
  const oldest = waiting.map((t) => t.expected_at).filter((d): d is string => Boolean(d)).sort()[0];
  const currencies = [...new Set(list.data?.items.map((i) => i.currency) ?? [])];

  return (
    <Page>
      <PageHeader
        title="Invoices"
        description="Bill customers; they pay in the portal by card or bank transfer."
        actions={
          <div className="flex flex-wrap gap-2">
            {can('create', 'payments') && (
              <Link
                to="/staff/payments"
                className="press inline-flex min-h-10 items-center rounded-lg border border-slate-300 bg-white px-4 text-sm font-semibold shadow-xs hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:hover:bg-slate-800"
              >
                Record payment
              </Link>
            )}
            <Link to="/staff/invoices/new" className="press btn-gradient inline-flex min-h-10 items-center rounded-lg px-4 text-sm font-semibold shadow-sm">
              New invoice
            </Link>
          </div>
        }
      />

      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <SummaryTile dot="bg-sky-500" label="Outstanding" value={s ? m(s.outstanding_total) : null} detail={s ? `${plural(s.outstanding_count, 'invoice')} sent` : ''} to="?status=open" />
        <SummaryTile
          dot="bg-red-500"
          label="Overdue"
          value={s ? m(s.overdue_total) : null}
          tone={s && s.overdue_count > 0 ? 'text-red-700 dark:text-red-400' : undefined}
          detail={s ? [plural(s.overdue_count, 'invoice'), s.overdue_names.slice(0, 2).join(', ') + (s.overdue_names.length > 2 ? ` +${s.overdue_names.length - 2}` : '')].filter(Boolean).join(' · ') : ''}
          to="?status=overdue"
        />
        <SummaryTile dot="bg-brand-600" label="Paid, last 30 days" value={s ? m(s.paid_30d_total) : null} detail={s ? plural(s.paid_30d_count, 'invoice') : ''} to="?status=paid" />
        <SummaryTile dot="bg-slate-400" label="Drafts" value={s ? String(s.drafts) : null} detail="Not sent yet" to="?status=draft" />
      </div>
      {summary.error ? <ErrorBanner error={summary.error} /> : null}

      {waiting.length > 0 && (
        <div className="mb-5 flex flex-wrap items-center gap-x-4 gap-y-1 rounded-xl border border-sky-200 bg-sky-50 px-5 py-3.5 text-sm dark:border-sky-900 dark:bg-sky-950/50">
          <span className="font-semibold text-sky-900 dark:text-sky-200">
            {plural(waiting.length, 'bank transfer')} waiting to be matched
          </span>
          <span className="text-slate-600 dark:text-slate-400">
            {new Set(waiting.map((t) => t.currency)).size === 1 ? `${money(waiting.reduce((sum, t) => sum + Number(t.amount), 0), waiting[0].currency)} total` : 'several currencies'}
            {oldest ? ` · oldest expected ${shortDate(oldest)}` : ''}
          </span>
          <Link to="/staff/payments#transfers" className="ml-auto font-semibold text-sky-800 hover:underline dark:text-sky-300">
            Match transfers →
          </Link>
        </div>
      )}

      <section className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-xs dark:border-slate-800 dark:bg-slate-900">
        <div className="px-5 pt-2">
          <Tabs
            label="Status"
            bare
            tabs={TABS}
            value={tab}
            onChange={(key) => setParams(key === 'all' ? {} : { status: key }, { replace: true })}
            aside={
              <div className="relative w-64 max-w-full pb-2">
                <Search className="pointer-events-none absolute top-[calc(50%-4px)] left-3 size-4 -translate-y-1/2 text-slate-400" aria-hidden="true" />
                <Input type="search" className="w-full pl-9" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Invoice or customer" aria-label="Search invoices" />
              </div>
            }
          />
        </div>
        {list.isLoading ? (
          <div className="border-t border-slate-200 p-6 dark:border-slate-800">
            <Spinner />
          </div>
        ) : list.error ? (
          <div className="border-t border-slate-200 p-6 dark:border-slate-800">
            <ErrorBanner error={list.error} />
          </div>
        ) : !list.data?.items.length ? (
          <div className="border-t border-slate-200 dark:border-slate-800">
            <EmptyState>{term ? 'No invoices match that.' : tab === 'all' ? 'No invoices yet.' : 'No invoices here.'}</EmptyState>
          </div>
        ) : (
          <>
            <div className="overflow-x-auto border-t border-slate-200 dark:border-slate-800">
              <table className="w-full min-w-[44rem] text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-left text-xs font-semibold tracking-wide text-slate-500 uppercase dark:border-slate-800">
                    <th scope="col" className="px-5 py-3 font-semibold">Invoice</th>
                    <th scope="col" className="px-5 py-3 font-semibold">Customer</th>
                    <th scope="col" className="px-5 py-3 font-semibold">Issued</th>
                    <th scope="col" className="px-5 py-3 font-semibold">Due</th>
                    <th scope="col" className="px-5 py-3 font-semibold">Status</th>
                    <th scope="col" className="px-5 py-3 text-right font-semibold">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {list.data.items.map((i) => (
                    <tr key={i.id} className="border-b border-slate-100 last:border-0 hover:bg-slate-50 dark:border-slate-800 dark:hover:bg-slate-800/50">
                      <td className="px-5 py-3">
                        <Link to={`/staff/invoices/${i.id}`} className="font-semibold text-brand-700 hover:underline dark:text-brand-600">
                          {i.invoice_number}
                        </Link>
                      </td>
                      <td className="px-5 py-3">
                        {i.customer_name ?? '—'}
                        <span className="block text-xs text-slate-500">{i.customer_number}</span>
                      </td>
                      <td className="px-5 py-3 text-slate-600 dark:text-slate-400">{shortDate(i.sent_at ?? i.created_at)}</td>
                      <td className={`px-5 py-3 ${i.overdue ? 'font-medium text-red-700 dark:text-red-400' : 'text-slate-600 dark:text-slate-400'}`}>{i.status === 'sent' ? shortDate(i.due_on) : '—'}</td>
                      <td className="px-5 py-3">
                        <InvoiceStatus invoice={i} />
                      </td>
                      <td className="px-5 py-3 text-right tabular-nums">
                        <span className="font-semibold">{money(i.total, i.currency)}</span>
                        {i.status === 'sent' && Number(i.amount_paid) > 0 && <span className="block text-xs text-slate-500">{money(i.balance, i.currency)} due</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="flex justify-between gap-4 border-t border-slate-200 px-5 py-3 text-sm text-slate-500 dark:border-slate-800">
              <span>Showing {plural(list.data.items.length, 'invoice')}</span>
              <span>{currencies.join(', ')}</span>
            </div>
          </>
        )}
      </section>
    </Page>
  );
}

function SummaryTile({ dot, label, value, detail, tone, to }: { dot: string; label: string; value: string | null; detail: string; tone?: string; to: string }) {
  return (
    <Link to={to} className="press rounded-xl border border-slate-200 bg-white px-5 py-4 shadow-xs hover:border-slate-300 dark:border-slate-800 dark:bg-slate-900 dark:hover:border-slate-700">
      <div className="flex items-center gap-2 text-sm font-medium text-slate-600 dark:text-slate-400">
        <span className={`size-2 rounded-full ${dot}`} aria-hidden="true" /> {label}
      </div>
      <div className={`mt-1.5 text-2xl font-bold tracking-tight tabular-nums ${tone ?? ''}`}>{value ?? '—'}</div>
      <div className="mt-1 truncate text-xs text-slate-500">{detail}</div>
    </Link>
  );
}

/** /staff/invoices/new and /staff/invoices/:id: drafts are edited, sent ones are viewed. */
export function InvoicePage() {
  const api = useApi();
  const { id } = useParams();
  const q = useQuery({ queryKey: ['invoice', id], queryFn: () => api.get<Invoice>(`/invoices/${id}`), enabled: !!id && id !== 'new' });
  if (!id || id === 'new') return <InvoiceEditor />;
  if (q.isLoading) return <Page><Spinner /></Page>;
  if (q.error || !q.data) return <Page><ErrorBanner error={q.error} /></Page>;
  return q.data.status === 'draft' ? <InvoiceEditor key={q.data.id} invoice={q.data} /> : <InvoiceView invoice={q.data} />;
}

// Draft editor ------------------------------------------------------------------------------------

interface Service {
  id: string;
  name: string;
  price: string;
  currency: string;
}

interface LineDraft {
  key: string;
  description: string;
  quantity: string;
  unit_price: string;
  service_id: string | null;
}

const newLine = (patch: Partial<LineDraft> = {}): LineDraft => ({ key: crypto.randomUUID(), description: '', quantity: '1', unit_price: '', service_id: null, ...patch });

function InvoiceEditor({ invoice }: { invoice?: Invoice }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const services = useQuery({ queryKey: ['services'], queryFn: () => api.get<Service[]>('/services') });
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [lines, setLines] = useState<LineDraft[]>(() =>
    invoice ? invoice.lines.map((l) => newLine({ description: l.description, quantity: String(Number(l.quantity)), unit_price: l.unit_price, service_id: l.service_id })) : [newLine()],
  );
  const [dueOn, setDueOn] = useState(invoice?.due_on ?? '');
  const [notes, setNotes] = useState(invoice?.notes ?? '');
  const [notify, setNotify] = useState(true);

  // A customer from the URL (?customer=…, e.g. from the customer page) or the draft's.
  const customerId = invoice?.customer_id ?? params.get('customer');
  const preset = useQuery({ queryKey: ['customer', customerId], queryFn: () => api.get<Customer>(`/customers/${customerId}`), enabled: !!customerId && !customer });
  useEffect(() => {
    if (preset.data && !customer) setCustomer(preset.data);
  }, [preset.data, customer]);

  const currency = invoice?.currency ?? services.data?.[0]?.currency ?? 'USD';
  const total = lines.reduce((sum, l) => sum + (Number(l.quantity) || 0) * (Number(l.unit_price) || 0), 0);
  const body = () => ({
    due_on: dueOn || null,
    notes: notes.trim() || null,
    lines: lines
      .filter((l) => l.description.trim())
      .map((l) => ({ description: l.description.trim(), quantity: Number(l.quantity) || 1, unit_price: Number(l.unit_price) || 0, service_id: l.service_id })),
  });

  const save = useMutation({
    mutationFn: async (andSend: boolean) => {
      const saved = invoice
        ? await api.put<Invoice>(`/invoices/${invoice.id}`, body())
        : await api.post<Invoice>('/invoices', { customer_id: customer!.id, ...body() });
      if (andSend) await api.post(`/invoices/${saved.id}/send`, { notify });
      return saved;
    },
    onSuccess: (saved) => {
      void queryClient.invalidateQueries({ queryKey: ['invoices'] });
      void queryClient.invalidateQueries({ queryKey: ['invoice', saved.id] });
      navigate(`/staff/invoices/${saved.id}`, { replace: true });
    },
  });
  const remove = useMutation({
    mutationFn: () => api.del(`/invoices/${invoice!.id}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['invoices'] });
      navigate('/staff/invoices?status=draft');
    },
  });

  const setLine = (key: string, patch: Partial<LineDraft>) => setLines((all) => all.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const addService = (serviceId: string) => {
    const s = services.data?.find((x) => x.id === serviceId);
    if (!s) return;
    setLines((all) => [...all.filter((l) => l.description.trim() || l.unit_price), newLine({ description: s.name, unit_price: s.price, service_id: s.id })]);
  };
  const valid = Boolean(customer) && lines.some((l) => l.description.trim()) && total > 0;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate(false);
  };

  return (
    <Page>
      <Link to="/staff/invoices" className="text-sm text-brand-700 hover:underline dark:text-brand-600">
        ← Invoices
      </Link>
      <PageHeader title={invoice ? `Draft ${invoice.invoice_number}` : 'New invoice'} description="Drafts are only visible to staff until you send them." />
      <form onSubmit={submit} className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <Card title="Lines">
          <div className="space-y-3">
            {invoice ? (
              <p className="text-sm">
                Billed to <span className="font-medium">{invoice.customer_name}</span> <span className="text-slate-500">· {invoice.customer_number}</span>
              </p>
            ) : (
              <Field label="Customer">
                <CustomerPicker value={customer} onChange={setCustomer} />
              </Field>
            )}
            <div className="hidden grid-cols-[minmax(0,1fr)_5rem_7rem_6rem_2.5rem] gap-2 text-xs font-medium uppercase tracking-wide text-slate-500 sm:grid">
              <span>Description</span>
              <span className="text-right">Qty</span>
              <span className="text-right">Price</span>
              <span className="text-right">Amount</span>
              <span />
            </div>
            {lines.map((l, i) => (
              <div key={l.key} className="grid grid-cols-[minmax(0,1fr)_5rem_7rem] gap-2 sm:grid-cols-[minmax(0,1fr)_5rem_7rem_6rem_2.5rem] sm:items-center">
                <Input aria-label={`Line ${i + 1} description`} value={l.description} maxLength={300} onChange={(e) => setLine(l.key, { description: e.target.value })} placeholder="What it's for" className="col-span-3 sm:col-span-1" />
                <Input aria-label={`Line ${i + 1} quantity`} type="number" min={0.01} step={0.01} value={l.quantity} onChange={(e) => setLine(l.key, { quantity: e.target.value })} className="text-right" />
                <Input aria-label={`Line ${i + 1} price`} type="number" min={0} step={0.01} value={l.unit_price} onChange={(e) => setLine(l.key, { unit_price: e.target.value })} placeholder="0.00" className="text-right" />
                <span className="text-right text-sm tabular-nums">{money((Number(l.quantity) || 0) * (Number(l.unit_price) || 0), currency)}</span>
                <Button type="button" variant="ghost" size="sm" aria-label={`Remove line ${i + 1}`} disabled={lines.length === 1} onClick={() => setLines((all) => all.filter((x) => x.key !== l.key))}>
                  ×
                </Button>
              </div>
            ))}
            <div className="flex flex-wrap items-center gap-2 pt-1">
              <Button type="button" variant="secondary" size="sm" onClick={() => setLines((all) => [...all, newLine()])}>
                Add line
              </Button>
              <div className="w-56">
                <Select aria-label="Add a service" value="" onChange={(e) => addService(e.target.value)}>
                  <option value="">Add a service…</option>
                  {services.data?.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name} · {money(s.price, s.currency)}
                    </option>
                  ))}
                </Select>
              </div>
              <p className="ml-auto text-sm">
                Total <span className="text-base font-semibold tabular-nums">{money(total, currency)}</span>
              </p>
            </div>
          </div>
        </Card>
        <Card title="Details">
          <div className="grid gap-3">
            <Field label="Due date" hint="Empty: the settings' default days after sending">
              <Input type="date" value={dueOn} onChange={(e) => setDueOn(e.target.value)} />
            </Field>
            <Field label="Note to the customer (optional)">
              <textarea
                rows={3}
                maxLength={2000}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-900"
              />
            </Field>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} /> Email the customer when sending
            </label>
            {save.error && <ErrorBanner error={save.error} />}
            <div className="flex flex-wrap gap-2">
              <Button type="button" disabled={!valid || save.isPending} onClick={() => save.mutate(true)}>
                Send invoice
              </Button>
              <Button type="submit" variant="secondary" disabled={!valid || save.isPending}>
                Save draft
              </Button>
              {invoice && (
                <Button type="button" variant="ghost" disabled={remove.isPending} onClick={() => remove.mutate()}>
                  Delete
                </Button>
              )}
            </div>
            {remove.error && <ErrorBanner error={remove.error} />}
          </div>
        </Card>
      </form>
    </Page>
  );
}

// Sent, paid or void ------------------------------------------------------------------------------

function InvoiceView({ invoice }: { invoice: Invoice }) {
  return (
    <Page>
      <Link to="/staff/invoices" className="text-sm text-brand-700 hover:underline dark:text-brand-600">
        ← Invoices
      </Link>
      <div className="mb-5 mt-2 flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">{invoice.invoice_number}</h1>
        <InvoiceStatus invoice={invoice} />
        <Link to={`/staff/customers/${invoice.customer_id}`} className="text-sm text-brand-700 hover:underline dark:text-brand-600">
          {invoice.customer_name ?? 'Customer'} →
        </Link>
      </div>
      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <Card>
          <InvoiceDocument invoice={invoice} />
        </Card>
        <div className="space-y-4">
          <Payments invoice={invoice} />
          {invoice.status === 'sent' && <RecordPayment invoice={invoice} />}
          {invoice.status === 'sent' && Number(invoice.amount_paid) === 0 && <VoidInvoice invoice={invoice} />}
        </div>
      </div>
    </Page>
  );
}

function Payments({ invoice }: { invoice: Invoice }) {
  return (
    <Card title="Payments">
      {!invoice.payments?.length ? (
        <EmptyState>None yet. Card payments made in the portal appear here.</EmptyState>
      ) : (
        <ul className="-my-2 divide-y divide-slate-100 text-sm dark:divide-slate-800">
          {invoice.payments.map((p) => (
            <li key={p.id} className="flex items-start justify-between gap-2 py-2">
              <div>
                <p className="font-medium">{money(p.amount, p.currency)} · {METHOD_LABEL[p.method] ?? p.method}</p>
                <p className="text-xs text-slate-500">
                  {p.payment_number} · {p.paid_at ? dateTime(p.paid_at) : 'not received yet'}
                </p>
              </div>
              <StatusBadge status={p.status} />
            </li>
          ))}
        </ul>
      )}
      {invoice.paid_at && <p className="mt-3 text-sm text-emerald-700 dark:text-emerald-400">Paid in full {dateTime(invoice.paid_at)}.</p>}
    </Card>
  );
}

/** Cash, card at the front desk or a bank transfer that arrived, counted toward this invoice. */
function RecordPayment({ invoice }: { invoice: Invoice }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const [method, setMethod] = useState<'cash' | 'card_pos' | 'bank_transfer'>('bank_transfer');
  const [amount, setAmount] = useState(invoice.balance);
  const [reference, setReference] = useState(invoice.invoice_number);
  const [duplicate, setDuplicate] = useState(false);
  useEffect(() => setAmount(invoice.balance), [invoice.balance]);
  useEffect(() => setReference(method === 'bank_transfer' ? invoice.invoice_number : ''), [method, invoice.invoice_number]);
  const record = useMutation({
    mutationFn: (confirm: boolean) =>
      api.post('/payments', {
        customer_id: invoice.customer_id,
        invoice_id: invoice.id,
        method,
        amount: Number(amount),
        paid_at: new Date().toISOString(),
        ...(method === 'card_pos' ? { pos_reference: reference } : {}),
        ...(method === 'bank_transfer' ? { bank_reference: reference } : {}),
        ...(confirm ? { confirm_duplicate: true } : {}),
      }),
    onSuccess: () => {
      setDuplicate(false);
      void queryClient.invalidateQueries({ queryKey: ['invoice', invoice.id] });
      void queryClient.invalidateQueries({ queryKey: ['invoices'] });
    },
    onError: (err) => setDuplicate(err instanceof ApiError && err.body.code === 'possible_duplicate'),
  });
  return (
    <Card title="Record a payment">
      <form
        className="grid gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          record.mutate(false);
        }}
      >
        <Field label="Method">
          <Select value={method} onChange={(e) => setMethod(e.target.value as typeof method)}>
            <option value="bank_transfer">Bank transfer received</option>
            <option value="cash">Cash</option>
            <option value="card_pos">Card at the front desk</option>
          </Select>
        </Field>
        <Field label={`Amount (${invoice.currency})`}>
          <Input type="number" min={0.01} step={0.01} required value={amount} onChange={(e) => setAmount(e.target.value)} />
        </Field>
        {method !== 'cash' && (
          <Field label={method === 'bank_transfer' ? 'Transfer reference' : 'POS reference'}>
            <Input required value={reference} onChange={(e) => setReference(e.target.value)} />
          </Field>
        )}
        {duplicate ? (
          <div role="alert" className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-800 dark:bg-amber-950">
            A payment of this amount for this customer was already recorded around today.
            <div className="mt-2 flex gap-2">
              <Button type="button" size="sm" onClick={() => record.mutate(true)}>Record anyway</Button>
              <Button type="button" size="sm" variant="secondary" onClick={() => setDuplicate(false)}>Cancel</Button>
            </div>
          </div>
        ) : (
          record.error && <ErrorBanner error={record.error} />
        )}
        <div>
          <Button type="submit" disabled={record.isPending || !(Number(amount) > 0)}>
            Record payment
          </Button>
        </div>
      </form>
    </Card>
  );
}

function VoidInvoice({ invoice }: { invoice: Invoice }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const voidIt = useMutation({
    mutationFn: () => api.post(`/invoices/${invoice.id}/void`, { reason: reason.trim() }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['invoice', invoice.id] });
      void queryClient.invalidateQueries({ queryKey: ['invoices'] });
    },
  });
  if (!open) {
    return (
      <div className="text-right">
        <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>
          Void this invoice…
        </Button>
      </div>
    );
  }
  return (
    <Card title="Void invoice">
      <form
        className="grid gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          voidIt.mutate();
        }}
      >
        <p className="text-sm text-slate-500">The customer will see it as void and can no longer pay it.</p>
        <Field label="Reason">
          <Input required maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Billed twice" />
        </Field>
        {voidIt.error && <ErrorBanner error={voidIt.error} />}
        <div className="flex gap-2">
          <Button type="submit" variant="danger" disabled={!reason.trim() || voidIt.isPending}>
            Void invoice
          </Button>
          <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
            Cancel
          </Button>
        </div>
      </form>
    </Card>
  );
}

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

