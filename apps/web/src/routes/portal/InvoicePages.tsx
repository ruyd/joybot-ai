import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { InvoiceStatus, type Invoice } from '../../components/InvoiceDocument';
import { Page } from '../../components/Layout';
import { Card, EmptyState, ErrorBanner, PageHeader, Spinner } from '../../components/ui';
import { useApi } from '../../lib/api';
import { date, money } from '../../lib/format';
import { useMe } from '../../lib/me';

/** Customer portal: invoices sent to you, open ones first. */
export function MyInvoices() {
  const api = useApi();
  const q = useQuery({ queryKey: ['invoices', 'mine'], queryFn: () => api.get<{ items: Invoice[] }>('/invoices?limit=200') });
  const items = [...(q.data?.items ?? [])].sort((a, b) => Number(b.status === 'sent') - Number(a.status === 'sent'));
  return (
    <Page>
      <PageHeader title="Invoices" description="Pay by card online, or by bank transfer." />
      <Card>
        {q.isLoading ? (
          <Spinner />
        ) : q.error ? (
          <ErrorBanner error={q.error} />
        ) : !items.length ? (
          <EmptyState>No invoices yet.</EmptyState>
        ) : (
          <ul className="-my-2 divide-y divide-slate-100 dark:divide-slate-800">
            {items.map((i) => (
              <li key={i.id}>
                <Link to={`/portal/invoices/${i.id}`} className="press -mx-2 flex items-center gap-3 rounded-lg px-2 py-3 hover:bg-slate-50 dark:hover:bg-slate-800/60">
                  <span className="min-w-0 flex-1">
                    <span className="block font-medium">{i.invoice_number}</span>
                    <span className="block text-sm text-slate-500">{i.sent_at ? date(i.sent_at) : ''}</span>
                  </span>
                  <span className="text-right">
                    <span className="block font-medium tabular-nums">{money(i.status === 'sent' ? i.balance : i.total, i.currency)}</span>
                    <InvoiceStatus invoice={i} />
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </Page>
  );
}

interface Location {
  id: string;
  name: string;
  address: Record<string, unknown> | null;
}

const box = 'rounded-xl border border-slate-200 bg-white shadow-xs dark:border-slate-800 dark:bg-slate-900';

/** One invoice as a document, with paying by card (Stripe Checkout) or bank transfer beside it. */
export function MyInvoice() {
  const api = useApi();
  const { me } = useMe();
  const { id } = useParams();
  const [params] = useSearchParams();
  const justPaid = params.get('paid') === '1';
  const [method, setMethod] = useState<'card' | 'bank' | null>(null);
  const q = useQuery({
    queryKey: ['invoice', id],
    queryFn: () => api.get<Invoice>(`/invoices/${id}`),
    // Back from Stripe: the payment arrives by webhook a few seconds later.
    refetchInterval: (query) => (justPaid && query.state.data?.status === 'sent' ? 3000 : false),
  });
  const settings = useQuery({ queryKey: ['settings'], queryFn: () => api.get<{ business_name: string | null }>('/settings') });
  const locations = useQuery({ queryKey: ['locations'], queryFn: () => api.get<Location[]>('/locations') });
  const pay = useMutation({
    mutationFn: () => api.post<{ url: string }>(`/invoices/${id}/checkout`),
    onSuccess: (res) => window.location.assign(res.url),
  });
  if (q.isLoading) return <Page><Spinner /></Page>;
  if (q.error || !q.data) return <Page><ErrorBanner error={q.error} /></Page>;
  const inv = q.data;
  const m = (v: string) => money(v, inv.currency);
  const due = inv.status === 'sent' && Number(inv.balance) > 0;
  const chosen = method ?? (inv.pay?.card ? 'card' : 'bank');
  const business = settings.data?.business_name ?? 'Invoice';
  const location = locations.data?.find((l) => l.id === inv.location_id);
  const address = location?.address ? Object.values(location.address).filter((v): v is string => typeof v === 'string' && !!v) : [];

  return (
    <Page>
      <nav aria-label="Breadcrumb" className="mb-4 text-sm text-slate-500">
        <Link to="/portal/invoices" className="hover:text-slate-900 hover:underline dark:hover:text-white">
          Invoices
        </Link>{' '}
        / <span className="font-semibold text-slate-900 dark:text-white">{inv.invoice_number}</span>
      </nav>
      {justPaid && (
        <p role="status" className="mb-4 rounded-lg bg-emerald-50 p-3 text-sm text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200">
          {inv.status === 'paid' ? 'Thank you, your payment was received.' : 'Thank you! Your card payment is being confirmed; this page updates in a moment.'}
        </p>
      )}
      <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <article className={`${box} p-6 sm:p-9 print:border-0 print:shadow-none`}>
          <header className="flex flex-wrap items-start justify-between gap-6">
            <div>
              <p className="flex items-center gap-2.5 text-lg font-bold tracking-tight">
                <span className="grid size-9 place-items-center rounded-lg bg-brand-700 text-base text-white" aria-hidden="true">
                  {business.charAt(0).toUpperCase()}
                </span>
                {business}
              </p>
              {address.length > 0 && (
                <p className="mt-3 text-sm text-slate-500">
                  {address.map((line) => (
                    <span key={line} className="block">
                      {line}
                    </span>
                  ))}
                </p>
              )}
            </div>
            <div className="sm:text-right">
              <h1 className="text-2xl font-bold tracking-tight">Invoice</h1>
              <p className="mt-1 text-sm text-slate-500">{inv.invoice_number}</p>
              <div className="mt-1.5">
                <InvoiceStatus invoice={inv} />
              </div>
            </div>
          </header>
          <dl className="mt-8 grid gap-4 text-sm sm:grid-cols-3">
            <div>
              <dt className="text-slate-500">Billed to</dt>
              <dd className="font-semibold">{inv.customer_name ?? `${me?.profile.first_name ?? ''} ${me?.profile.last_name ?? ''}`.trim()}</dd>
              {inv.customer_number && <dd className="text-slate-500">{inv.customer_number}</dd>}
            </div>
            <div>
              <dt className="text-slate-500">Issued</dt>
              <dd className="font-semibold">{inv.sent_at ? date(inv.sent_at) : '—'}</dd>
            </div>
            <div>
              <dt className="text-slate-500">Due</dt>
              <dd className={`font-semibold ${inv.overdue ? 'text-red-700 dark:text-red-400' : ''}`}>{inv.due_on ? date(inv.due_on) : '—'}</dd>
            </div>
          </dl>
          <div className="mt-8 overflow-x-auto">
            <table className="w-full min-w-[17rem] text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-left text-xs font-semibold tracking-wide text-slate-500 uppercase dark:border-slate-800">
                  <th scope="col" className="pb-2.5 font-semibold">Item</th>
                  <th scope="col" className="pb-2.5 pl-3 text-right font-semibold">Qty</th>
                  <th scope="col" className="hidden pb-2.5 text-right font-semibold sm:table-cell">Price</th>
                  <th scope="col" className="pb-2.5 pl-3 text-right font-semibold">Amount</th>
                </tr>
              </thead>
              <tbody>
                {inv.lines.map((l) => (
                  <tr key={l.id} className="border-b border-slate-100 dark:border-slate-800">
                    <td className="py-3.5">
                      {l.description}
                      {l.appointment_number && <span className="block text-xs text-slate-500">Appointment {l.appointment_number}</span>}
                    </td>
                    <td className="py-3.5 text-right tabular-nums">{Number(l.quantity)}</td>
                    <td className="hidden py-3.5 text-right tabular-nums sm:table-cell">{m(l.unit_price)}</td>
                    <td className="py-3.5 text-right font-semibold tabular-nums">{m(l.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <dl className="mt-6 ml-auto grid w-full max-w-72 grid-cols-2 gap-y-1.5 text-sm">
            <dt className="text-slate-500">Subtotal</dt>
            <dd className="text-right tabular-nums">{m(inv.total)}</dd>
            <dt className="text-slate-500">Paid</dt>
            <dd className="text-right tabular-nums">{m(inv.amount_paid)}</dd>
            {inv.status !== 'void' && (
              <>
                <dt className="mt-2 border-t border-slate-200 pt-3 text-base font-bold dark:border-slate-700">Amount due</dt>
                <dd className="mt-2 border-t border-slate-200 pt-3 text-right text-lg font-bold tabular-nums dark:border-slate-700">{m(inv.balance)}</dd>
              </>
            )}
          </dl>
          {inv.notes && <p className="mt-6 rounded-lg bg-slate-50 p-3 text-sm whitespace-pre-wrap dark:bg-slate-800/60">{inv.notes}</p>}
          {inv.status === 'void' && inv.void_reason && <p className="mt-6 text-sm text-slate-500">Voided: {inv.void_reason}</p>}
          <button type="button" onClick={() => window.print()} className="mt-8 text-sm font-semibold text-brand-700 hover:underline print:hidden dark:text-brand-600">
            Print or save as PDF
          </button>
        </article>

        <aside className={`${box} p-5 print:hidden`}>
          {due ? (
            <>
              <h2 className="text-lg font-semibold">Pay {m(inv.balance)}</h2>
              {inv.pay?.card && (
                <div role="tablist" aria-label="How to pay" className="mt-3 grid grid-cols-2 gap-1 rounded-lg bg-slate-100 p-1 dark:bg-slate-800">
                  {(
                    [
                      ['card', 'Card'],
                      ['bank', 'Bank transfer'],
                    ] as const
                  ).map(([key, label]) => (
                    <button
                      key={key}
                      type="button"
                      role="tab"
                      aria-selected={chosen === key}
                      onClick={() => setMethod(key)}
                      className={`rounded-md py-2 text-sm font-semibold transition-colors ${
                        chosen === key ? 'bg-white text-slate-900 shadow-xs dark:bg-slate-950 dark:text-white' : 'text-slate-500 hover:text-slate-900 dark:hover:text-white'
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              )}
              {chosen === 'card' ? (
                <div className="mt-4 grid gap-4 text-sm">
                  <p className="text-slate-600 dark:text-slate-300">You'll enter your card on Stripe's secure checkout page, then come back here. We never see your card number.</p>
                  {pay.error && <ErrorBanner error={pay.error} />}
                  <button
                    type="button"
                    disabled={pay.isPending}
                    onClick={() => pay.mutate()}
                    className="press min-h-11 rounded-lg bg-brand-700 px-4 font-semibold text-white hover:bg-brand-800 disabled:opacity-50"
                  >
                    {pay.isPending ? 'Opening…' : 'Continue to secure checkout'}
                  </button>
                </div>
              ) : (
                <div className="mt-4 grid gap-2 text-sm">
                  {inv.pay?.bank_transfer_instructions ? (
                    <p className="whitespace-pre-wrap">{inv.pay.bank_transfer_instructions}</p>
                  ) : (
                    <p className="text-slate-500">Ask us for our bank details.</p>
                  )}
                  <p>
                    Amount: <span className="font-semibold">{m(inv.balance)}</span>
                  </p>
                  <p>
                    Reference: <span className="font-mono font-semibold">{inv.invoice_number}</span>
                  </p>
                  <p className="text-slate-500">We mark the invoice paid when the transfer arrives.</p>
                </div>
              )}
            </>
          ) : (
            <>
              <h2 className="text-lg font-semibold">{inv.status === 'paid' ? 'Paid' : inv.status === 'void' ? 'Void' : 'Nothing to pay'}</h2>
              <p className="mt-1 text-sm text-slate-500">
                {inv.status === 'paid' ? `Paid in full${inv.paid_at ? ` on ${date(inv.paid_at)}` : ''}. Thank you!` : inv.status === 'void' ? 'This invoice was cancelled.' : 'This invoice has no balance.'}
              </p>
            </>
          )}
          <p className="mt-5 border-t border-slate-100 pt-4 text-xs text-slate-500 dark:border-slate-800">
            Questions about this invoice?{' '}
            {me?.assistant !== false && (
              <>
                <Link to={`/portal?q=${encodeURIComponent(`Question about invoice ${inv.invoice_number}`)}`} className="font-semibold text-brand-700 hover:underline dark:text-brand-600">
                  Ask the assistant
                </Link>{' '}
                or{' '}
              </>
            )}
            <Link to="/portal/tickets" className="font-semibold text-brand-700 hover:underline dark:text-brand-600">
              contact support
            </Link>
            .
          </p>
        </aside>
      </div>
    </Page>
  );
}
