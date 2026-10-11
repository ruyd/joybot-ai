import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { InvoiceDocument, InvoiceStatus, type Invoice } from '../../components/InvoiceDocument';
import { Page } from '../../components/Layout';
import { Button, Card, EmptyState, ErrorBanner, Field, Input, PageHeader, Select, Spinner, StatusBadge } from '../../components/ui';
import { ApiError, useApi } from '../../lib/api';
import { date, dateTime, METHOD_LABEL, money } from '../../lib/format';
import { CustomerPicker, type Customer } from './CustomerPicker';

const TABS = [
  { key: 'open', label: 'Open' },
  { key: 'draft', label: 'Drafts' },
  { key: 'paid', label: 'Paid' },
  { key: 'void', label: 'Void' },
  { key: 'all', label: 'All' },
] as const;

/** Staff: invoices by status, newest first; open ones show what is due and whether it is overdue. */
export function Invoices() {
  const api = useApi();
  const [params, setParams] = useSearchParams();
  const tab = TABS.find((t) => t.key === params.get('status'))?.key ?? 'open';
  const [q, setQ] = useState('');
  const term = useDebounced(q.trim(), 250);
  const list = useQuery({
    queryKey: ['invoices', tab, term],
    queryFn: () => api.get<{ items: Invoice[] }>(`/invoices?status=${tab}${term ? `&q=${encodeURIComponent(term)}` : ''}`),
    placeholderData: keepPreviousData,
  });
  return (
    <Page>
      <PageHeader
        title="Invoices"
        description="Bill customers; they pay in the portal by card or bank transfer."
        actions={
          <Link to="/staff/invoices/new" className="press btn-gradient rounded-full px-4 py-1.5 text-sm font-semibold shadow-sm">
            New invoice
          </Link>
        }
      />
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div role="tablist" aria-label="Status" className="flex flex-wrap gap-1">
          {TABS.map((t) => (
            <button
              key={t.key}
              role="tab"
              aria-selected={tab === t.key}
              onClick={() => setParams(t.key === 'open' ? {} : { status: t.key }, { replace: true })}
              className={`press rounded-full px-3 py-1.5 text-sm ${tab === t.key ? 'btn-gradient font-medium' : 'hover:bg-slate-100 dark:hover:bg-slate-900'}`}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div className="ml-auto w-72 max-w-full">
          <Input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Invoice number or customer" aria-label="Search invoices" />
        </div>
      </div>
      <Card>
        {list.isLoading ? (
          <Spinner />
        ) : list.error ? (
          <ErrorBanner error={list.error} />
        ) : !list.data?.items.length ? (
          <EmptyState>{term ? 'No invoices match that.' : tab === 'open' ? 'No open invoices.' : 'No invoices here yet.'}</EmptyState>
        ) : (
          <div className="-mx-4 -my-3 overflow-x-auto">
            <table className="w-full min-w-[40rem] text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500 dark:border-slate-800">
                  <th scope="col" className="px-4 py-2 font-medium">Invoice</th>
                  <th scope="col" className="px-4 py-2 font-medium">Customer</th>
                  <th scope="col" className="px-4 py-2 text-right font-medium">Total</th>
                  <th scope="col" className="px-4 py-2 text-right font-medium">Due</th>
                  <th scope="col" className="px-4 py-2 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {list.data.items.map((i) => (
                  <tr key={i.id} className="border-b border-slate-100 last:border-0 hover:bg-slate-50 dark:border-slate-800 dark:hover:bg-slate-800/50">
                    <td className="px-4 py-2.5">
                      <Link to={`/staff/invoices/${i.id}`} className="font-medium text-brand-700 hover:underline dark:text-brand-600">
                        {i.invoice_number}
                      </Link>
                      <span className="block text-xs text-slate-500">{date(i.created_at)}</span>
                    </td>
                    <td className="px-4 py-2.5">
                      {i.customer_name ?? '—'}
                      <span className="block text-xs text-slate-500">{i.customer_number}</span>
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums">{money(i.total, i.currency)}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums">{i.status === 'sent' ? money(i.balance, i.currency) : '—'}</td>
                    <td className="px-4 py-2.5">
                      <InvoiceStatus invoice={i} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </Page>
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

