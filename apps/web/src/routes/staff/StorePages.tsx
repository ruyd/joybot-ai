import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Page } from '../../components/Layout';
import { Badge, Button, Card, EmptyState, ErrorBanner, Field, Input, PageHeader, Select, Spinner } from '../../components/ui';
import { useApi } from '../../lib/api';
import { date, dateTime, money } from '../../lib/format';
import { useMe } from '../../lib/me';
import { type Order, type Product } from '../../lib/store';
import { OrderStatusBadge } from '../portal/OrderPages';
import { ImagePicker } from './WebsiteEditors';

const textareaClass = 'w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-900';

interface StoreSettings {
  enabled: boolean;
  automatic_tax: boolean;
  prices_include_tax: boolean;
  allow_promotion_codes: boolean;
  require_terms: boolean;
  notify_admins: boolean;
  email_customers: boolean;
  max_quantity: number;
  /** The confirmation email; null sends the standard text (confirmation_defaults). */
  confirmation_subject: string | null;
  confirmation_body: string | null;
  confirmation_defaults: { subject: string; body: string };
  /** Placeholder → what it stands for. */
  confirmation_fields: Record<string, string>;
}

function useCurrency() {
  const api = useApi();
  return useQuery({ queryKey: ['settings'], queryFn: () => api.get<{ default_currency: string }>('/settings') }).data?.default_currency ?? 'USD';
}

// Products ------------------------------------------------------------------------------------------

/** Website › Products: what the shop sells (services and digital products). */
export function ProductsPage() {
  const api = useApi();
  const { can } = useMe();
  const currency = useCurrency();
  const q = useQuery({ queryKey: ['products'], queryFn: () => api.get<Product[]>('/products') });
  const store = useQuery({ queryKey: ['store-settings'], queryFn: () => api.get<StoreSettings>('/admin/store'), enabled: can('update', 'settings') });
  const [editing, setEditing] = useState<Product | 'new' | null>(null);

  return (
    <Page>
      <PageHeader
        title="Products"
        description="What the shop on your website sells. Customers sign in to pay by card."
        actions={
          can('create', 'website') && (
            <Button onClick={() => setEditing('new')}>
              <Plus className="size-4" aria-hidden="true" /> New product
            </Button>
          )
        }
      />
      {store.data && !store.data.enabled && (
        <p role="status" className="mb-4 rounded-lg bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-200">
          The shop is closed: products don't show on the website until it's opened in{' '}
          <Link to="/staff/store" className="font-medium underline">
            Settings › Store
          </Link>
          .
        </p>
      )}
      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,28rem)]">
        <Card>
          {q.isLoading ? (
            <Spinner />
          ) : q.error ? (
            <ErrorBanner error={q.error} />
          ) : !q.data?.length ? (
            <EmptyState>No products yet.</EmptyState>
          ) : (
            <ul className="-my-2 divide-y divide-slate-100 dark:divide-slate-800">
              {q.data.map((p) => (
                <li key={p.id}>
                  <button
                    type="button"
                    onClick={() => setEditing(p)}
                    className={`press -mx-2 flex w-[calc(100%+1rem)] items-center gap-3 rounded-lg px-2 py-3 text-left hover:bg-slate-50 dark:hover:bg-slate-800/60 ${editing !== 'new' && editing?.id === p.id ? 'bg-slate-50 dark:bg-slate-800/60' : ''}`}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block font-medium">{p.name}</span>
                      <span className="block truncate text-sm text-slate-500">
                        /shop/{p.slug} · {p.kind === 'digital' ? 'Digital' : 'Service'}
                      </span>
                    </span>
                    <span className="tabular-nums">{money(p.price, currency)}</span>
                    <Badge tone={p.active ? 'green' : 'slate'}>{p.active ? 'on sale' : 'hidden'}</Badge>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Card>
        {editing && <ProductEditor key={editing === 'new' ? 'new' : editing.id} product={editing === 'new' ? null : editing} onDone={() => setEditing(null)} />}
      </div>
    </Page>
  );
}

const slugify = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);

function ProductEditor({ product, onDone }: { product: Product | null; onDone: () => void }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const { can } = useMe();
  const [v, setV] = useState({
    name: product?.name ?? '',
    slug: product?.slug ?? '',
    summary: product?.summary ?? '',
    description: product?.description ?? '',
    kind: product?.kind ?? ('service' as Product['kind']),
    price: product?.price ?? '',
    image_asset_id: product?.image_asset_id ?? null,
    active: product?.active ?? false,
    sort_order: String(product?.sort_order ?? 0),
    delivery: product?.delivery ?? '',
  });
  const [slugTouched, setSlugTouched] = useState(Boolean(product));
  const set = (patch: Partial<typeof v>) => setV({ ...v, ...patch });
  const done = () => {
    void queryClient.invalidateQueries({ queryKey: ['products'] });
    onDone();
  };
  const save = useMutation({
    mutationFn: () => {
      const body = {
        ...v,
        summary: v.summary.trim() || null,
        description: v.description.trim() || null,
        delivery: v.delivery.trim() || null,
        price: Number(v.price),
        sort_order: Number(v.sort_order) || 0,
      };
      return product ? api.put(`/products/${product.id}`, body) : api.post('/products', body);
    },
    onSuccess: done,
  });
  const remove = useMutation({ mutationFn: () => api.del(`/products/${product!.id}`), onSuccess: done });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate();
  };

  return (
    <Card title={product ? `Edit ${product.name}` : 'New product'}>
      <form onSubmit={submit} className="grid gap-3">
        <Field label="Name">
          <Input required maxLength={120} value={v.name} onChange={(e) => set({ name: e.target.value, ...(slugTouched ? {} : { slug: slugify(e.target.value) }) })} />
        </Field>
        <Field label="Address" hint={`/shop/${v.slug || '…'}`}>
          <Input
            required
            maxLength={60}
            pattern="[a-z0-9]+(-[a-z0-9]+)*"
            value={v.slug}
            onChange={(e) => {
              setSlugTouched(true);
              set({ slug: e.target.value });
            }}
          />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Kind">
            <Select value={v.kind} onChange={(e) => set({ kind: e.target.value as Product['kind'] })}>
              <option value="service">Service or package</option>
              <option value="digital">Digital product</option>
            </Select>
          </Field>
          <Field label="Price">
            <Input required type="number" min="0.01" step="0.01" value={v.price} onChange={(e) => set({ price: e.target.value })} />
          </Field>
        </div>
        <Field label="Summary" hint="One line on the product card">
          <Input maxLength={300} value={v.summary} onChange={(e) => set({ summary: e.target.value })} />
        </Field>
        <Field label="Description" hint="Markdown, on the product's own page">
          <textarea className={textareaClass} rows={6} maxLength={10_000} value={v.description} onChange={(e) => set({ description: e.target.value })} />
        </Field>
        <div>
          <p className="mb-1 text-sm font-medium">Image</p>
          <ImagePicker value={v.image_asset_id} onChange={(id) => set({ image_asset_id: id })} compact />
        </div>
        <Field
          label="What the buyer gets once paid"
          hint={v.kind === 'digital' ? 'Markdown: e.g. a download link. Shown in their order as soon as they pay (digital orders are done on payment).' : 'Markdown: e.g. how and when you will be in touch. Shown in their order once they pay.'}
        >
          <textarea className={textareaClass} rows={4} maxLength={4000} value={v.delivery} onChange={(e) => set({ delivery: e.target.value })} />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2 sm:items-end">
          <Field label="Order in the shop" hint="Lower first">
            <Input type="number" min={0} max={10_000} value={v.sort_order} onChange={(e) => set({ sort_order: e.target.value })} />
          </Field>
          <label className="flex items-center gap-2 pb-2 text-sm">
            <input type="checkbox" className="switch" checked={v.active} onChange={(e) => set({ active: e.target.checked })} /> On sale
          </label>
        </div>
        {(save.error || remove.error) && <ErrorBanner error={save.error ?? remove.error} />}
        <div className="flex flex-wrap gap-2">
          <Button type="submit" disabled={save.isPending}>
            {product ? 'Save' : 'Create product'}
          </Button>
          <Button type="button" variant="ghost" onClick={onDone}>
            Cancel
          </Button>
          {product && can('delete', 'website') && (
            <Button
              type="button"
              variant="ghost"
              className="ml-auto"
              disabled={remove.isPending}
              onClick={() => window.confirm(`Delete "${product.name}"? Past orders keep its name and price.`) && remove.mutate()}
            >
              Delete
            </Button>
          )}
        </div>
      </form>
    </Card>
  );
}

// Orders --------------------------------------------------------------------------------------------

const FILTERS = [
  ['open', 'To do'],
  ['fulfilled', 'Done'],
  ['pending', 'Not paid'],
  ['refunded', 'Refunded'],
  ['all', 'All'],
] as const;

/** Orders from the shop: paid ones to do first; open one to fulfil it. */
export function OrdersPage() {
  const api = useApi();
  const [params, setParams] = useSearchParams();
  const status = params.get('status') ?? 'open';
  const selected = params.get('order');
  const [search, setSearch] = useState('');
  const q = useQuery({
    queryKey: ['orders', status, search],
    queryFn: () => api.get<Order[]>(`/orders?status=${status}${search.trim() ? `&q=${encodeURIComponent(search.trim())}` : ''}`),
  });
  const choose = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [k, val] of Object.entries(patch)) if (val === null) next.delete(k); else next.set(k, val);
    setParams(next, { replace: true });
  };

  return (
    <Page>
      <PageHeader title="Orders" description="What customers bought in the shop. Mark services done once delivered." />
      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,28rem)]">
        <Card>
          <div className="mb-4 flex flex-wrap items-center gap-2">
            <div className="flex flex-wrap gap-1" role="tablist" aria-label="Orders">
              {FILTERS.map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  role="tab"
                  aria-selected={status === key}
                  onClick={() => choose({ status: key })}
                  className={`press rounded-full px-3 py-1.5 text-sm font-medium ${status === key ? 'bg-slate-900 text-white dark:bg-white dark:text-slate-900' : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800'}`}
                >
                  {label}
                </button>
              ))}
            </div>
            <div className="ml-auto w-full sm:w-64">
              <Input aria-label="Search orders" placeholder="Order, customer or email" value={search} onChange={(e) => setSearch(e.target.value)} />
            </div>
          </div>
          {q.isLoading ? (
            <Spinner />
          ) : q.error ? (
            <ErrorBanner error={q.error} />
          ) : !q.data?.length ? (
            <EmptyState>{status === 'open' ? 'Nothing to do: every paid order is done.' : 'No orders.'}</EmptyState>
          ) : (
            <ul className="-my-2 divide-y divide-slate-100 dark:divide-slate-800">
              {q.data.map((o) => (
                <li key={o.id}>
                  <button
                    type="button"
                    onClick={() => choose({ order: o.id })}
                    className={`press -mx-2 flex w-[calc(100%+1rem)] items-center gap-3 rounded-lg px-2 py-3 text-left hover:bg-slate-50 dark:hover:bg-slate-800/60 ${selected === o.id ? 'bg-slate-50 dark:bg-slate-800/60' : ''}`}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block font-medium">
                        {o.order_number} · {o.customer_name ?? o.customer_number}
                      </span>
                      <span className="block truncate text-sm text-slate-500">
                        {date(o.created_at)} · {o.summary}
                      </span>
                    </span>
                    <span className="text-right">
                      <span className="block tabular-nums">{money(Number(o.amount_paid) > 0 ? o.amount_paid : o.subtotal, o.currency)}</span>
                      <OrderStatusBadge status={o.status} staff />
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Card>
        {selected && <OrderDetail id={selected} onClose={() => choose({ order: null })} />}
      </div>
    </Page>
  );
}

function OrderDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const { can } = useMe();
  const q = useQuery({ queryKey: ['order', id], queryFn: () => api.get<Order>(`/orders/${id}`) });
  const setStatus = useMutation({
    mutationFn: (status: 'fulfilled' | 'paid' | 'cancelled') => api.post<Order>(`/orders/${id}/status`, { status }),
    onSuccess: (o) => {
      queryClient.setQueryData(['order', id], o);
      void queryClient.invalidateQueries({ queryKey: ['orders'] });
    },
  });
  if (q.isLoading) return <Card><Spinner /></Card>;
  if (q.error || !q.data) return <Card><ErrorBanner error={q.error} /></Card>;
  const o = q.data;
  const billable = can('create', 'payments');

  return (
    <Card
      title={
        <span className="flex items-center gap-2">
          {o.order_number} <OrderStatusBadge status={o.status} staff />
        </span>
      }
      actions={
        <Button size="sm" variant="ghost" onClick={onClose}>
          Close
        </Button>
      }
    >
      <div className="grid gap-4 text-sm">
        <p>
          <Link to={`/staff/customers/${o.customer_id}`} className="font-medium text-brand-700 hover:underline dark:text-brand-600">
            {o.customer_name ?? o.customer_number}
          </Link>
          <span className="text-slate-500"> · ordered {dateTime(o.created_at)}</span>
        </p>
        <ul className="divide-y divide-slate-100 dark:divide-slate-800">
          {(o.lines ?? []).map((l) => (
            <li key={l.id} className="py-2">
              <div className="flex justify-between gap-4">
                <span>
                  {l.quantity} × {l.name} <span className="text-slate-500">({l.kind === 'digital' ? 'digital' : 'service'})</span>
                </span>
                <span className="tabular-nums">{money(l.amount, o.currency)}</span>
              </div>
            </li>
          ))}
        </ul>
        <dl className="grid grid-cols-[1fr_auto] gap-y-1 border-t border-slate-200 pt-3 dark:border-slate-800">
          <dt>Subtotal</dt>
          <dd className="text-right tabular-nums">{money(o.subtotal, o.currency)}</dd>
          <dt className="font-semibold">Paid</dt>
          <dd className="text-right font-semibold tabular-nums">{money(o.amount_paid, o.currency)}</dd>
        </dl>
        {o.payments && o.payments.length > 0 && (
          <ul className="grid gap-1 text-slate-600 dark:text-slate-300">
            {o.payments.map((p) => (
              <li key={p.id}>
                {money(p.amount, p.currency)} · {p.status}
                {p.card_brand ? ` · ${p.card_brand} ${p.card_last4}` : ''}
                {p.paid_at ? ` · ${dateTime(p.paid_at)}` : ''}
              </li>
            ))}
          </ul>
        )}
        {o.fulfilled_at && (
          <p className="text-slate-500">
            Done {dateTime(o.fulfilled_at)}
            {o.fulfilled_by_name ? ` by ${o.fulfilled_by_name}` : ' (digital, on payment)'}
          </p>
        )}
        {setStatus.error && <ErrorBanner error={setStatus.error} />}
        {billable && (
          <div className="flex flex-wrap gap-2">
            {o.status === 'paid' && (
              <Button onClick={() => setStatus.mutate('fulfilled')} disabled={setStatus.isPending}>
                Mark done
              </Button>
            )}
            {o.status === 'fulfilled' && (
              <Button variant="secondary" onClick={() => setStatus.mutate('paid')} disabled={setStatus.isPending}>
                Mark not done
              </Button>
            )}
            {o.status === 'pending' && (
              <Button variant="ghost" onClick={() => window.confirm(`Cancel ${o.order_number}? It hasn't been paid.`) && setStatus.mutate('cancelled')} disabled={setStatus.isPending}>
                Cancel order
              </Button>
            )}
          </div>
        )}
        <p className="text-xs text-slate-500">Refunds are made in Stripe; the order follows within a minute.</p>
      </div>
    </Card>
  );
}

// Settings › Store ------------------------------------------------------------------------------------

const STORE_TABS = [
  ['shop', 'Shop'],
  ['email', 'Confirmation email'],
] as const;
type StoreTab = (typeof STORE_TABS)[number][0];

/** Settings › Store: the shop and how Stripe Checkout behaves (one tab), and the confirmation email. */
export function StoreSettingsPage() {
  const api = useApi();
  const [params, setParams] = useSearchParams();
  const tab = (STORE_TABS.find(([k]) => k === params.get('tab'))?.[0] ?? 'shop') as StoreTab;
  const q = useQuery({ queryKey: ['store-settings'], queryFn: () => api.get<StoreSettings>('/admin/store') });

  return (
    <Page>
      <PageHeader title="Store" description="The shop on your website: products are under Products, orders under Orders." />
      <div role="tablist" aria-label="Store settings" className="mb-4 flex gap-1 overflow-x-auto">
        {STORE_TABS.map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            onClick={() => setParams(key === 'shop' ? {} : { tab: key }, { replace: true })}
            className={`press whitespace-nowrap rounded-full px-3 py-1.5 text-sm ${tab === key ? 'btn-gradient font-medium' : 'hover:bg-slate-100 dark:hover:bg-slate-900'}`}
          >
            {label}
          </button>
        ))}
      </div>
      {q.isLoading ? (
        <Spinner />
      ) : q.error || !q.data ? (
        <ErrorBanner error={q.error} />
      ) : tab === 'email' ? (
        <ConfirmationEmailTab settings={q.data} />
      ) : (
        <ShopTab settings={q.data} />
      )}
    </Page>
  );
}

function useSaveStore() {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (patch: Partial<StoreSettings>) => api.put<StoreSettings>('/admin/store', patch),
    onSuccess: (data) => {
      queryClient.setQueryData(['store-settings'], data);
      void queryClient.invalidateQueries({ queryKey: ['site', 'store'] });
      void queryClient.invalidateQueries({ queryKey: ['me'] });
    },
  });
}

/** The Shop tab: the shop and checkout switches (and the quantity limit), saved together. */
function ShopTab({ settings }: { settings: StoreSettings }) {
  const save = useSaveStore();
  const [draft, setDraft] = useState<Partial<StoreSettings>>({});
  const v = { ...settings, ...draft };
  const set = (patch: Partial<StoreSettings>) => setDraft({ ...draft, ...patch });
  const toggle = (key: keyof StoreSettings, label: string, hint?: string) => (
    <label className="flex items-start gap-3 text-sm">
      <input type="checkbox" className="switch mt-0.5" checked={Boolean(v[key])} onChange={(e) => set({ [key]: e.target.checked })} />
      <span>
        <span className="font-medium">{label}</span>
        {hint && <span className="block text-slate-500">{hint}</span>}
      </span>
    </label>
  );

  return (
    <form
      className="grid max-w-3xl gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate(draft, { onSuccess: () => setDraft({}) });
      }}
    >
      <Card title="Shop">
        <div className="grid gap-4">
          {toggle('enabled', 'Shop open', 'Shows Shop and the cart on the website, and Orders in the customer portal. Card payments also need Settings › Stripe.')}
          <Field label="Largest quantity of one product in an order (1–100)">
            <Input type="number" min={1} max={100} value={v.max_quantity} onChange={(e) => set({ max_quantity: Number(e.target.value) })} className="max-w-32" />
          </Field>
          {toggle('email_customers', 'Email customers a confirmation', 'When an order is paid. Edit it on the Confirmation email tab; sent from Settings › Email.')}
          {toggle('notify_admins', 'Tell admins about new orders', 'A notification in the team drawer when an order is paid.')}
        </div>
      </Card>
      <Card title="Checkout">
        <div className="grid gap-4">
          {toggle('automatic_tax', 'Work out tax with Stripe Tax', 'Set up your tax registrations in Stripe first, or checkout will fail.')}
          {v.automatic_tax && toggle('prices_include_tax', 'Prices include tax', 'Otherwise tax is added on top at checkout.')}
          {toggle('allow_promotion_codes', 'Allow promotion codes', 'Create the codes in Stripe; checkout shows a box to enter one.')}
          {toggle('require_terms', 'Customers accept the terms', 'Checkout asks them to agree. Add your terms page’s address in Stripe’s public details first.')}
        </div>
      </Card>
      {save.error && <ErrorBanner error={save.error} />}
      <div>
        <Button type="submit" disabled={!Object.keys(draft).length || save.isPending}>
          Save
        </Button>
      </div>
    </form>
  );
}

/** The confirmation email: subject and body with placeholders, beside a preview for a made-up order. */
function ConfirmationEmailTab({ settings }: { settings: StoreSettings }) {
  const api = useApi();
  const save = useSaveStore();
  const defaults = settings.confirmation_defaults;
  const [subject, setSubject] = useState(settings.confirmation_subject ?? defaults.subject);
  const [body, setBody] = useState(settings.confirmation_body ?? defaults.body);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const [preview, setPreview] = useState<{ subject: string; text: string; unknown: string[] } | null>(null);

  // The preview follows the editor, a moment after typing stops.
  useEffect(() => {
    const t = setTimeout(() => {
      void api
        .post<{ subject: string; text: string; unknown: string[] }>('/admin/store/confirmation-preview', { subject, body })
        .then(setPreview)
        .catch(() => undefined);
    }, 300);
    return () => clearTimeout(t);
  }, [api, subject, body]);

  const isDefault = subject.trim() === defaults.subject && body.trim() === defaults.body;
  const changed = subject !== (settings.confirmation_subject ?? defaults.subject) || body !== (settings.confirmation_body ?? defaults.body);
  const insert = (field: string) => {
    const el = bodyRef.current;
    const token = `{{${field}}}`;
    if (!el) return setBody(body + token);
    const at = el.selectionStart ?? body.length;
    setBody(body.slice(0, at) + token + body.slice(el.selectionEnd ?? at));
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(at + token.length, at + token.length);
    });
  };

  return (
    <div className="grid items-start gap-4 xl:grid-cols-2">
      <form
        className="grid min-w-0 gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          // The standard text is saved as "none", so later improvements to it still reach you.
          save.mutate(isDefault ? { confirmation_subject: null, confirmation_body: null } : { confirmation_subject: subject, confirmation_body: body });
        }}
      >
        <Card title="Email">
          <div className="grid gap-3 text-sm">
            {!settings.email_customers && (
              <p role="status" className="rounded-lg bg-amber-50 p-3 text-amber-900 dark:bg-amber-950 dark:text-amber-200">
                Confirmation emails are off (Shop tab).
              </p>
            )}
            <Field label="Subject">
              <Input required maxLength={200} value={subject} onChange={(e) => setSubject(e.target.value)} />
            </Field>
            <Field label="Body">
              <textarea ref={bodyRef} className={`${textareaClass} font-mono`} rows={16} maxLength={10_000} required value={body} onChange={(e) => setBody(e.target.value)} />
            </Field>
            <div>
              <p className="mb-1.5 font-medium">Placeholders</p>
              <ul className="flex flex-wrap gap-1.5">
                {Object.entries(settings.confirmation_fields).map(([field, help]) => (
                  <li key={field}>
                    <button
                      type="button"
                      title={help}
                      onClick={() => insert(field)}
                      className="press rounded-full bg-slate-100 px-2.5 py-1 font-mono text-xs hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700"
                    >
                      {`{{${field}}}`}
                    </button>
                  </li>
                ))}
              </ul>
              <p className="mt-1.5 text-xs text-slate-500">Click one to add it to the body where the cursor is; hover for what it stands for.</p>
            </div>
          </div>
        </Card>
        {save.error && <ErrorBanner error={save.error} />}
        <div className="flex flex-wrap gap-2">
          <Button type="submit" disabled={!changed || save.isPending || Boolean(preview?.unknown.length)}>
            Save
          </Button>
          <Button
            type="button"
            variant="ghost"
            disabled={isDefault}
            onClick={() => {
              setSubject(defaults.subject);
              setBody(defaults.body);
            }}
          >
            Use the standard text
          </Button>
        </div>
      </form>
      <Card title="Preview" className="min-w-0">
        {preview ? (
          <div className="grid gap-3 text-sm">
            {preview.unknown.length > 0 && (
              <p role="alert" className="rounded-lg bg-red-50 p-3 text-red-800 dark:bg-red-950 dark:text-red-300">
                Unknown placeholder{preview.unknown.length > 1 ? 's' : ''}: {preview.unknown.map((u) => `{{${u}}}`).join(', ')}
              </p>
            )}
            <p>
              <span className="text-slate-500">Subject: </span>
              <span className="font-medium">{preview.subject}</span>
            </p>
            <pre className="whitespace-pre-wrap break-words rounded-lg bg-slate-50 p-4 font-sans text-sm leading-relaxed dark:bg-slate-800/60">{preview.text}</pre>
            <p className="text-xs text-slate-500">For a made-up order of two products.</p>
          </div>
        ) : (
          <Spinner />
        )}
      </Card>
    </div>
  );
}
