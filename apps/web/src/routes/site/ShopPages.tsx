import { useQuery } from '@tanstack/react-query';
import { Minus, Plus, ShoppingBag, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Markdown } from '../../components/site/Modules';
import { PageLoader } from '../../components/site/SiteLoader';
import { ApiError } from '../../lib/api';
import { money } from '../../lib/format';
import { assetUrl, retryWhileWaking, siteGet, useSite } from '../../lib/site';
import { cart, cartLines, useCart, usePublicStore, type Product, type PublicStore } from '../../lib/store';

const KIND_LABEL = { service: 'Service', digital: 'Digital' } as const;

function useTitle(title: string) {
  const name = useSite().data?.name;
  useEffect(() => {
    document.title = [title, name].filter(Boolean).join(' · ');
  }, [title, name]);
}

function Closed() {
  return (
    <main className="mx-auto max-w-2xl px-4 py-20 text-center">
      <h1 className="text-3xl font-semibold tracking-tight">The shop is closed</h1>
      <p className="mt-3 text-slate-500">Please come back soon.</p>
      <Link to="/" className="press btn-gradient mt-6 inline-flex rounded-full px-4 py-2 text-sm font-semibold">
        Go to the home page
      </Link>
    </main>
  );
}

/** "/shop": every product on sale, as cards. */
export function ShopPage() {
  useTitle('Shop');
  const store = usePublicStore();
  if (store.isLoading) return <PageLoader />;
  if (!store.data?.enabled) return <Closed />;
  return (
    <main className="mx-auto max-w-6xl px-4 py-12 sm:py-16">
      <h1 className="mb-10 text-4xl font-semibold tracking-tight">Shop</h1>
      {store.data.products.length ? (
        <ul className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {store.data.products.map((p) => (
            <li key={p.id}>
              <ProductCard product={p} store={store.data} />
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-slate-500">Nothing on sale right now.</p>
      )}
    </main>
  );
}

function ProductImage({ product, className }: { product: Product; className: string }) {
  return product.image_asset_id ? (
    <img src={assetUrl(product.image_asset_id, product.image_storage ?? undefined)} alt="" loading="lazy" className={`${className} object-cover`} />
  ) : (
    <div aria-hidden="true" className={`${className} grid place-items-center bg-slate-100 text-slate-400 dark:bg-slate-800`}>
      <ShoppingBag className="size-10" />
    </div>
  );
}

function ProductCard({ product: p, store }: { product: Product; store: PublicStore }) {
  return (
    <article className="flex h-full flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
      <Link to={`/shop/${p.slug}`} className="block">
        <ProductImage product={p} className="aspect-[4/3] w-full" />
      </Link>
      <div className="flex flex-1 flex-col gap-2 p-5">
        <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">{KIND_LABEL[p.kind]}</p>
        <h2 className="text-lg font-semibold">
          <Link to={`/shop/${p.slug}`} className="hover:underline">
            {p.name}
          </Link>
        </h2>
        {p.summary && <p className="text-sm text-slate-600 dark:text-slate-300">{p.summary}</p>}
        <div className="mt-auto flex items-center justify-between gap-3 pt-3">
          <span className="text-lg font-semibold tabular-nums">{money(p.price, store.currency)}</span>
          <AddToCart product={p} max={store.max_quantity} />
        </div>
      </div>
    </article>
  );
}

function AddToCart({ product, max, quantity = 1 }: { product: Product; max: number; quantity?: number }) {
  const [added, setAdded] = useState(false);
  return (
    <button
      type="button"
      className="press btn-gradient rounded-full px-4 py-2 text-sm font-semibold shadow-sm"
      onClick={() => {
        cart.add(product.id, quantity, max);
        setAdded(true);
        setTimeout(() => setAdded(false), 1500);
      }}
    >
      {added ? 'Added' : 'Add to cart'}
    </button>
  );
}

/** The cart button in the header and on shop pages: how many items, linking to the cart. */
export function CartLink({ className = '' }: { className?: string }) {
  const items = useCart();
  const count = items.reduce((n, i) => n + i.quantity, 0);
  return (
    <Link
      to="/shop/cart"
      aria-label={count ? `Cart, ${count} ${count === 1 ? 'item' : 'items'}` : 'Cart'}
      className={`press relative inline-flex items-center rounded-full p-2 text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800 ${className}`}
    >
      <ShoppingBag className="size-5" aria-hidden="true" />
      {count > 0 && (
        <span className="btn-gradient absolute -right-0.5 -top-0.5 grid min-w-[18px] place-items-center rounded-full px-1 text-[11px] font-semibold leading-[18px]">{count}</span>
      )}
    </Link>
  );
}

/** "/shop/:slug": one product with its description. */
export function ProductPage() {
  const { slug } = useParams();
  const store = usePublicStore();
  const product = useQuery({
    queryKey: ['site', 'store', 'product', slug],
    queryFn: () => siteGet<Product>(`/store/products/${encodeURIComponent(slug ?? '')}`),
    retry: retryWhileWaking,
  });
  const [quantity, setQuantity] = useState(1);
  useTitle(product.data?.name ?? 'Shop');
  if (product.isLoading || store.isLoading) return <PageLoader />;
  if (!store.data?.enabled) return <Closed />;
  if (product.error || !product.data) {
    const missing = product.error instanceof ApiError && product.error.status === 404;
    return (
      <main className="mx-auto max-w-2xl px-4 py-20 text-center">
        <h1 className="text-3xl font-semibold tracking-tight">{missing ? 'Product not found' : 'Something went wrong'}</h1>
        <Link to="/shop" className="press btn-gradient mt-6 inline-flex rounded-full px-4 py-2 text-sm font-semibold">
          Back to the shop
        </Link>
      </main>
    );
  }
  const p = product.data;
  const max = store.data.max_quantity;
  return (
    <main className="mx-auto max-w-6xl px-4 py-12 sm:py-16">
      <Link to="/shop" className="mb-6 inline-block text-sm font-medium text-brand-700 hover:underline dark:text-brand-600">
        ← Shop
      </Link>
      <div className="grid gap-10 md:grid-cols-2">
        <ProductImage product={p} className="aspect-[4/3] w-full rounded-2xl" />
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">{KIND_LABEL[p.kind]}</p>
          <h1 className="mt-2 text-4xl font-semibold tracking-tight">{p.name}</h1>
          <p className="mt-4 text-2xl font-semibold tabular-nums">{money(p.price, store.data.currency)}</p>
          {store.data.automatic_tax && <p className="mt-1 text-sm text-slate-500">{store.data.prices_include_tax ? 'Tax included' : 'Plus tax, worked out at checkout'}</p>}
          {p.summary && <p className="mt-4 text-lg text-slate-600 dark:text-slate-300">{p.summary}</p>}
          <div className="mt-6 flex items-center gap-3">
            <QuantityPicker value={quantity} max={max} onChange={setQuantity} label={p.name} />
            <AddToCart product={p} max={max} quantity={quantity} />
          </div>
          {p.description && (
            <div className="site-prose mt-8 text-slate-700 dark:text-slate-300">
              <Markdown>{p.description}</Markdown>
            </div>
          )}
        </div>
      </div>
    </main>
  );
}

function QuantityPicker({ value, max, onChange, label }: { value: number; max: number; onChange: (n: number) => void; label: string }) {
  const button = 'press grid size-9 place-items-center rounded-full text-slate-600 hover:bg-slate-100 disabled:opacity-40 dark:text-slate-300 dark:hover:bg-slate-800';
  return (
    <div className="inline-flex items-center rounded-full border border-slate-300 dark:border-slate-700" role="group" aria-label={`Quantity of ${label}`}>
      <button type="button" className={button} disabled={value <= 1} onClick={() => onChange(value - 1)} aria-label="One less">
        <Minus className="size-4" aria-hidden="true" />
      </button>
      <span className="w-8 text-center text-sm font-semibold tabular-nums" aria-live="polite">
        {value}
      </span>
      <button type="button" className={button} disabled={value >= max} onClick={() => onChange(value + 1)} aria-label="One more">
        <Plus className="size-4" aria-hidden="true" />
      </button>
    </div>
  );
}

/** "/shop/cart": what's in the cart, and on to checkout (in the portal: customers sign in to pay). */
export function CartPage() {
  useTitle('Cart');
  const store = usePublicStore();
  const items = useCart();
  if (store.isLoading) return <PageLoader />;
  if (!store.data?.enabled) return <Closed />;
  const lines = cartLines(items, store.data.products);
  const total = lines.reduce((n, l) => n + l.amount, 0);
  const max = store.data.max_quantity;

  return (
    <main className="mx-auto max-w-3xl px-4 py-12 sm:py-16">
      <h1 className="mb-8 text-4xl font-semibold tracking-tight">Cart</h1>
      {!lines.length ? (
        <div className="rounded-2xl border border-dashed border-slate-300 p-10 text-center dark:border-slate-700">
          <p className="text-slate-500">Your cart is empty.</p>
          <Link to="/shop" className="press btn-gradient mt-5 inline-flex rounded-full px-4 py-2 text-sm font-semibold">
            Browse the shop
          </Link>
        </div>
      ) : (
        <>
          <ul className="divide-y divide-slate-200 border-y border-slate-200 dark:divide-slate-800 dark:border-slate-800">
            {lines.map(({ product: p, quantity, amount }) => (
              <li key={p.id} className="flex flex-wrap items-center gap-4 py-4">
                <ProductImage product={p} className="size-16 shrink-0 rounded-xl" />
                <div className="min-w-0 flex-1">
                  <Link to={`/shop/${p.slug}`} className="font-medium hover:underline">
                    {p.name}
                  </Link>
                  <p className="text-sm text-slate-500">{money(p.price, store.data.currency)} each</p>
                </div>
                <QuantityPicker value={quantity} max={max} onChange={(n) => cart.set(p.id, n)} label={p.name} />
                <span className="w-24 text-right font-semibold tabular-nums">{money(amount, store.data.currency)}</span>
                <button type="button" className="press rounded-full p-2 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800" onClick={() => cart.set(p.id, 0)} aria-label={`Remove ${p.name}`}>
                  <Trash2 className="size-4" aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
          <div className="mt-6 flex flex-col items-end gap-2">
            <p className="text-lg">
              Subtotal <span className="ml-2 font-semibold tabular-nums">{money(total, store.data.currency)}</span>
            </p>
            {store.data.automatic_tax && !store.data.prices_include_tax && <p className="text-sm text-slate-500">Tax is worked out at checkout.</p>}
            <p className="text-sm text-slate-500">You'll sign in to your account to pay.</p>
            <Link to="/portal/checkout" className="press btn-gradient mt-2 inline-flex rounded-full px-6 py-3 text-base font-semibold shadow-sm">
              Check out
            </Link>
          </div>
        </>
      )}
    </main>
  );
}
