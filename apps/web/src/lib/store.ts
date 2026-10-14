import { useQuery } from '@tanstack/react-query';
import { useSyncExternalStore } from 'react';
import { retryWhileWaking, siteGet } from './site';

export interface Product {
  id: string;
  slug: string;
  name: string;
  summary: string | null;
  /** Markdown. */
  description: string | null;
  kind: 'service' | 'digital';
  price: string;
  image_asset_id: string | null;
  image_storage: 'db' | 's3' | null;
  active: boolean;
  sort_order: number;
  /** Staff only: what the buyer gets once paid (Markdown). */
  delivery?: string | null;
}

export interface PublicStore {
  enabled: boolean;
  currency: string;
  max_quantity: number;
  automatic_tax: boolean;
  prices_include_tax: boolean;
  products: Product[];
}

export type OrderStatus = 'pending' | 'paid' | 'fulfilled' | 'cancelled' | 'refunded';

export interface Order {
  id: string;
  order_number: string;
  customer_id: string;
  customer_name: string | null;
  customer_number: string | null;
  currency: string;
  status: OrderStatus;
  subtotal: string;
  amount_paid: string;
  paid_at: string | null;
  fulfilled_at: string | null;
  fulfilled_by_name: string | null;
  cancelled_at: string | null;
  created_at: string;
  /** "2 × Coaching pack, 1 × Style guide". */
  summary: string | null;
  lines?: {
    id: string;
    product_id: string | null;
    product_slug: string | null;
    name: string;
    kind: 'service' | 'digital';
    unit_price: string;
    quantity: number;
    amount: string;
    /** What was bought, once paid (Markdown). */
    delivery: string | null;
  }[];
  payments?: { id: string; amount: string; amount_refunded: string; currency: string; status: string; paid_at: string | null; receipt_url: string | null; card_brand: string | null; card_last4: string | null }[];
}

/** Staff see what is left to do; customers see where their order is. */
export const ORDER_STATUS_LABEL: Record<OrderStatus, string> = {
  pending: 'Not paid',
  paid: 'Paid, to do',
  fulfilled: 'Done',
  cancelled: 'Cancelled',
  refunded: 'Refunded',
};
export const CUSTOMER_ORDER_STATUS_LABEL: Record<OrderStatus, string> = {
  pending: 'Not paid',
  paid: 'Paid',
  fulfilled: 'Complete',
  cancelled: 'Cancelled',
  refunded: 'Refunded',
};

/** The store on the public site: open or not, currency, and the products on sale. */
export const usePublicStore = () =>
  useQuery({ queryKey: ['site', 'store'], queryFn: () => siteGet<PublicStore>('/store'), staleTime: 60_000, retry: retryWhileWaking });

// Cart ---------------------------------------------------------------------------------------------
// Kept in this browser (localStorage), shared by the public site and the portal's checkout, and in
// step across tabs. Only ids and quantities: names and prices always come from the store.

export interface CartItem {
  product_id: string;
  quantity: number;
}

const KEY = 'joybot.cart';
const listeners = new Set<() => void>();
let cache: { raw: string | null; items: CartItem[] } = { raw: null, items: [] };

function read(): CartItem[] {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(KEY);
  } catch {
    // storage unavailable: an empty cart
  }
  if (raw === cache.raw) return cache.items;
  let items: CartItem[] = [];
  try {
    const parsed = JSON.parse(raw ?? '[]') as unknown;
    if (Array.isArray(parsed)) {
      items = parsed.filter(
        (i): i is CartItem => typeof i?.product_id === 'string' && Number.isInteger(i?.quantity) && i.quantity > 0,
      );
    }
  } catch {
    items = [];
  }
  cache = { raw, items };
  return items;
}

function write(items: CartItem[]) {
  try {
    if (items.length) localStorage.setItem(KEY, JSON.stringify(items));
    else localStorage.removeItem(KEY);
  } catch {
    // storage unavailable: the cart lasts until the page closes
    cache = { raw: '__memory__', items };
  }
  listeners.forEach((l) => l());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  const onStorage = (e: StorageEvent) => e.key === KEY && listener();
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', onStorage);
  };
}

export const cart = {
  items: read,
  /** Adds `quantity` (capped at `max`). */
  add(productId: string, quantity = 1, max = 10) {
    const items = read();
    const found = items.find((i) => i.product_id === productId);
    write(
      found
        ? items.map((i) => (i.product_id === productId ? { ...i, quantity: Math.min(max, i.quantity + quantity) } : i))
        : [...items, { product_id: productId, quantity: Math.min(max, quantity) }],
    );
  },
  set(productId: string, quantity: number) {
    const items = read();
    write(quantity > 0 ? items.map((i) => (i.product_id === productId ? { ...i, quantity } : i)) : items.filter((i) => i.product_id !== productId));
  },
  clear() {
    write([]);
  },
};

export function useCart(): CartItem[] {
  return useSyncExternalStore(subscribe, read, () => []);
}

/** The cart with each line's product (lines whose product is no longer on sale are left out). */
export function cartLines(items: CartItem[], products: Product[] | undefined) {
  const byId = new Map((products ?? []).map((p) => [p.id, p]));
  return items.flatMap((i) => {
    const product = byId.get(i.product_id);
    return product ? [{ product, quantity: i.quantity, amount: Number(product.price) * i.quantity }] : [];
  });
}
