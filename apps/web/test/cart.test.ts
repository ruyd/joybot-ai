import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cart, cartLines, type Product } from '../src/lib/store';

const product = (id: string, price: string): Product => ({
  id, slug: id, name: id, summary: null, description: null, kind: 'service', price, image_asset_id: null, image_storage: null, active: true, sort_order: 0,
});

describe('cart', () => {
  beforeEach(() => {
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('adds, caps at the store limit, changes and removes items', () => {
    cart.add('a', 1, 3);
    cart.add('a', 5, 3);
    cart.add('b', 2, 3);
    expect(cart.items()).toEqual([{ product_id: 'a', quantity: 3 }, { product_id: 'b', quantity: 2 }]);
    cart.set('b', 1);
    cart.set('a', 0);
    expect(cart.items()).toEqual([{ product_id: 'b', quantity: 1 }]);
    cart.clear();
    expect(cart.items()).toEqual([]);
  });

  it('ignores tampered storage and prices lines from the store, dropping products no longer on sale', () => {
    localStorage.setItem('joybot.cart', JSON.stringify([{ product_id: 'a', quantity: 2 }, { product_id: 'gone', quantity: 1 }, { product_id: 'x', quantity: -4 }, 'junk']));
    const items = cart.items();
    expect(items).toEqual([{ product_id: 'a', quantity: 2 }, { product_id: 'gone', quantity: 1 }]);
    expect(cartLines(items, [product('a', '19.50')])).toEqual([{ product: expect.objectContaining({ id: 'a' }), quantity: 2, amount: 39 }]);
    localStorage.setItem('joybot.cart', 'not json');
    expect(cart.items()).toEqual([]);
  });
});
