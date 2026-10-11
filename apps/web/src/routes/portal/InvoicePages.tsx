import { useMutation, useQuery } from '@tanstack/react-query';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { InvoiceDocument, InvoiceStatus, type Invoice } from '../../components/InvoiceDocument';
import { Page } from '../../components/Layout';
import { Button, Card, EmptyState, ErrorBanner, PageHeader, Spinner } from '../../components/ui';
import { useApi } from '../../lib/api';
import { date, money } from '../../lib/format';

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

/** One invoice, with Pay by card (Stripe Checkout) and the bank transfer details. */
export function MyInvoice() {
  const api = useApi();
  const { id } = useParams();
  const [params] = useSearchParams();
  const justPaid = params.get('paid') === '1';
  const q = useQuery({
    queryKey: ['invoice', id],
    queryFn: () => api.get<Invoice>(`/invoices/${id}`),
    // Back from Stripe: the payment arrives by webhook a few seconds later.
    refetchInterval: (query) => (justPaid && query.state.data?.status === 'sent' ? 3000 : false),
  });
  const pay = useMutation({
    mutationFn: () => api.post<{ url: string }>(`/invoices/${id}/checkout`),
    onSuccess: (res) => window.location.assign(res.url),
  });
  if (q.isLoading) return <Page><Spinner /></Page>;
  if (q.error || !q.data) return <Page><ErrorBanner error={q.error} /></Page>;
  const inv = q.data;
  const due = inv.status === 'sent' && Number(inv.balance) > 0;

  return (
    <Page>
      <Link to="/portal/invoices" className="text-sm text-brand-700 hover:underline dark:text-brand-600">
        ← Invoices
      </Link>
      <div className="mb-5 mt-2 flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">Invoice {inv.invoice_number}</h1>
        <InvoiceStatus invoice={inv} />
      </div>
      {justPaid && (
        <p role="status" className="mb-4 rounded-lg bg-emerald-50 p-3 text-sm text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200">
          {inv.status === 'paid' ? 'Thank you, your payment was received.' : 'Thank you! Your card payment is being confirmed; this page updates in a moment.'}
        </p>
      )}
      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <Card>
          <InvoiceDocument invoice={inv} />
        </Card>
        {due && (
          <div className="space-y-4">
            {inv.pay?.card && (
              <Card title="Pay by card">
                <p className="mb-3 text-sm text-slate-500">You'll pay {money(inv.balance, inv.currency)} on a secure Stripe page and come back here.</p>
                {pay.error && <ErrorBanner error={pay.error} />}
                <Button className="w-full" disabled={pay.isPending} onClick={() => pay.mutate()}>
                  {pay.isPending ? 'Opening…' : `Pay ${money(inv.balance, inv.currency)}`}
                </Button>
              </Card>
            )}
            <Card title="Pay by bank transfer">
              <div className="space-y-2 text-sm">
                {inv.pay?.bank_transfer_instructions ? (
                  <p className="whitespace-pre-wrap">{inv.pay.bank_transfer_instructions}</p>
                ) : (
                  <p className="text-slate-500">Ask us for our bank details.</p>
                )}
                <p>
                  Amount: <span className="font-medium">{money(inv.balance, inv.currency)}</span>
                </p>
                <p>
                  Reference: <span className="font-mono font-medium">{inv.invoice_number}</span>
                </p>
                <p className="text-slate-500">We mark the invoice paid when the transfer arrives.</p>
              </div>
            </Card>
          </div>
        )}
      </div>
    </Page>
  );
}
