import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { Page } from '../../components/Layout';
import { Markdown } from '../../components/site/Modules';
import { Badge, Button, Card, EmptyState, ErrorBanner, PageHeader, Spinner } from '../../components/ui';
import { useApi } from '../../lib/api';
import { date, dateTime, money } from '../../lib/format';
import { cart, cartLines, CUSTOMER_ORDER_STATUS_LABEL, ORDER_STATUS_LABEL, useCart, usePublicStore, type Order } from '../../lib/store';

export function OrderStatusBadge({ status, staff }: { status: Order['status']; staff?: boolean }) {
  const tone = status === 'fulfilled' ? 'green' : status === 'paid' ? 'brand' : status === 'pending' ? 'amber' : 'slate';
  return <Badge tone={tone}>{(staff ? ORDER_STATUS_LABEL : CUSTOMER_ORDER_STATUS_LABEL)[status]}</Badge>;
}

/** "/portal/checkout": the cart from the website, then Stripe Checkout. */
export function CheckoutPage() {
  const api = useApi();
  const store = usePublicStore();
  const items = useCart();
  const lines = cartLines(items, store.data?.products);
  const total = lines.reduce((n, l) => n + l.amount, 0);
  const pay = useMutation({
    mutationFn: () => api.post<{ url: string }>('/orders/checkout', { items: lines.map((l) => ({ product_id: l.product.id, quantity: l.quantity })) }),
    onSuccess: (res) => window.location.assign(res.url),
  });
  if (store.isLoading) return <Page><Spinner /></Page>;
  const currency = store.data?.currency ?? 'USD';

  return (
    <Page>
      <PageHeader title="Checkout" description="Check your order, then pay securely with Stripe." />
      <Card className="max-w-2xl">
        {!store.data?.enabled ? (
          <EmptyState>The shop is closed right now.</EmptyState>
        ) : !lines.length ? (
          <EmptyState>
            Your cart is empty.{' '}
            <a href="/shop" className="font-medium text-brand-700 hover:underline dark:text-brand-600">
              Browse the shop
            </a>
          </EmptyState>
        ) : (
          <div className="grid gap-4">
            <ul className="divide-y divide-slate-100 dark:divide-slate-800">
              {lines.map((l) => (
                <li key={l.product.id} className="flex justify-between gap-4 py-2.5 text-sm">
                  <span>
                    {l.quantity} × {l.product.name}
                  </span>
                  <span className="tabular-nums">{money(l.amount, currency)}</span>
                </li>
              ))}
            </ul>
            <p className="flex justify-between border-t border-slate-200 pt-3 font-semibold dark:border-slate-800">
              <span>Subtotal</span>
              <span className="tabular-nums">{money(total, currency)}</span>
            </p>
            {store.data.automatic_tax && !store.data.prices_include_tax && <p className="text-sm text-slate-500">Tax is added on the next page.</p>}
            {pay.error && <ErrorBanner error={pay.error} />}
            <div className="flex flex-wrap gap-2">
              <Button onClick={() => pay.mutate()} disabled={pay.isPending}>
                {pay.isPending ? 'Opening checkout…' : 'Pay with card'}
              </Button>
              <a href="/shop/cart" className="press inline-flex items-center rounded-full px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800">
                Edit cart
              </a>
            </div>
          </div>
        )}
      </Card>
    </Page>
  );
}

/** "/portal/orders": what you bought. */
export function MyOrders() {
  const api = useApi();
  const q = useQuery({ queryKey: ['orders', 'mine'], queryFn: () => api.get<Order[]>('/orders') });
  return (
    <Page>
      <PageHeader title="Orders" description="What you bought from the shop, and what you get with it." />
      <Card>
        {q.isLoading ? (
          <Spinner />
        ) : q.error ? (
          <ErrorBanner error={q.error} />
        ) : !q.data?.length ? (
          <EmptyState>
            No orders yet.{' '}
            <a href="/shop" className="font-medium text-brand-700 hover:underline dark:text-brand-600">
              Visit the shop
            </a>
          </EmptyState>
        ) : (
          <ul className="-my-2 divide-y divide-slate-100 dark:divide-slate-800">
            {q.data.map((o) => (
              <li key={o.id}>
                <Link to={`/portal/orders/${o.id}`} className="press -mx-2 flex items-center gap-3 rounded-lg px-2 py-3 hover:bg-slate-50 dark:hover:bg-slate-800/60">
                  <span className="min-w-0 flex-1">
                    <span className="block font-medium">{o.order_number}</span>
                    <span className="block truncate text-sm text-slate-500">
                      {date(o.created_at)} · {o.summary}
                    </span>
                  </span>
                  <span className="text-right">
                    <span className="block font-medium tabular-nums">{money(Number(o.amount_paid) > 0 ? o.amount_paid : o.subtotal, o.currency)}</span>
                    <OrderStatusBadge status={o.status} />
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

/** "/portal/orders/:id": one order; once paid, what was bought (download links, next steps). */
export function MyOrder() {
  const api = useApi();
  const { id } = useParams();
  const [params] = useSearchParams();
  const justPaid = params.get('paid') === '1';
  const q = useQuery({
    queryKey: ['order', id],
    queryFn: () => api.get<Order>(`/orders/${id}`),
    // Back from Stripe: the payment arrives by webhook a few seconds later.
    refetchInterval: (query) => (justPaid && query.state.data?.status === 'pending' ? 3000 : false),
  });
  // Paid: the cart has done its job.
  useEffect(() => {
    if (justPaid) cart.clear();
  }, [justPaid]);
  if (q.isLoading) return <Page><Spinner /></Page>;
  if (q.error || !q.data) return <Page><ErrorBanner error={q.error} /></Page>;
  const o = q.data;
  const deliveries = (o.lines ?? []).filter((l) => l.delivery);

  return (
    <Page>
      <Link to="/portal/orders" className="text-sm text-brand-700 hover:underline dark:text-brand-600">
        ← Orders
      </Link>
      <div className="mb-5 mt-2 flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">Order {o.order_number}</h1>
        <OrderStatusBadge status={o.status} />
      </div>
      {justPaid && o.status === 'pending' && (
        <p role="status" className="mb-4 max-w-2xl rounded-lg bg-slate-50 p-3 text-sm text-slate-700 dark:bg-slate-800 dark:text-slate-300">
          Thank you! We're confirming your payment with Stripe; this takes a few seconds.
        </p>
      )}
      <div className="grid max-w-2xl gap-4">
        {deliveries.length > 0 && (
          <Card title="What you get">
            <div className="grid gap-5">
              {deliveries.map((l) => (
                <section key={l.id}>
                  <h3 className="mb-1 font-semibold">{l.name}</h3>
                  <div className="site-prose text-sm text-slate-700 dark:text-slate-300">
                    <Markdown>{l.delivery ?? ''}</Markdown>
                  </div>
                </section>
              ))}
            </div>
          </Card>
        )}
        <Card title="Summary">
          <ul className="divide-y divide-slate-100 text-sm dark:divide-slate-800">
            {(o.lines ?? []).map((l) => (
              <li key={l.id} className="flex justify-between gap-4 py-2.5">
                <span>
                  {l.quantity} × {l.name}
                </span>
                <span className="tabular-nums">{money(l.amount, o.currency)}</span>
              </li>
            ))}
          </ul>
          <dl className="mt-3 grid grid-cols-[1fr_auto] gap-y-1 border-t border-slate-200 pt-3 text-sm dark:border-slate-800">
            <dt>Subtotal</dt>
            <dd className="text-right tabular-nums">{money(o.subtotal, o.currency)}</dd>
            {Number(o.amount_paid) > 0 && (
              <>
                <dt className="font-semibold">Paid</dt>
                <dd className="text-right font-semibold tabular-nums">{money(o.amount_paid, o.currency)}</dd>
              </>
            )}
          </dl>
          {o.paid_at && <p className="mt-3 text-xs text-slate-500">Paid {dateTime(o.paid_at)}</p>}
          {o.payments?.map((p) =>
            p.receipt_url ? (
              <a key={p.id} href={p.receipt_url} target="_blank" rel="noreferrer" className="mt-2 inline-block text-sm font-medium text-brand-700 hover:underline dark:text-brand-600">
                Stripe receipt
              </a>
            ) : null,
          )}
        </Card>
      </div>
    </Page>
  );
}
