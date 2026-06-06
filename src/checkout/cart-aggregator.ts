/**
 * @module checkout/cart-aggregator
 *
 * Builds a {@link UniversalCart} from a flat list of line items spanning many
 * merchants. This is the "Universal Shopping Cart" assembly step: the shopping
 * agent collects items from multiple merchant agents and the aggregator groups
 * them into per-merchant sub-carts, computes subtotals, and validates currency
 * consistency within each merchant.
 *
 * Design notes / edge cases handled here:
 *  - Line items for the same merchant are merged into a single sub-cart.
 *  - Identical (productId, attributes) lines are coalesced and quantities summed.
 *  - A merchant whose items mix currencies is rejected early (fail fast).
 *  - Empty carts and zero-quantity lines are rejected.
 */

import type {
  CartLineItem,
  MerchantId,
  MerchantSubCart,
  UniversalCart,
  CurrencyCode,
  Result,
} from '../common/types.js';
import { ok, err } from '../common/types.js';
import { add, multiply, zero } from '../common/money.js';

export interface BuildCartInput {
  readonly cartId: string;
  readonly userId: string;
  readonly displayCurrency: CurrencyCode;
  readonly items: readonly CartLineItem[];
}

/** Stable key used to coalesce identical line items. */
function lineKey(item: CartLineItem): string {
  const attrs = item.attributes
    ? Object.keys(item.attributes)
        .sort()
        .map((k) => `${k}=${item.attributes![k]}`)
        .join('&')
    : '';
  return `${item.merchantId}::${item.productId}::${attrs}`;
}

/**
 * Aggregate a flat item list into a Universal Cart. Returns a Result so callers
 * can surface validation failures to the user without throwing.
 */
export function buildUniversalCart(input: BuildCartInput): Result<UniversalCart> {
  if (input.items.length === 0) {
    return err({ code: 'EMPTY_CART', message: 'Cannot build a cart with no items', retryable: false });
  }

  // 1. Coalesce duplicate lines (same merchant/product/attributes).
  const coalesced = new Map<string, CartLineItem>();
  for (const item of input.items) {
    if (item.quantity <= 0 || !Number.isInteger(item.quantity)) {
      return err({
        code: 'INVALID_QUANTITY',
        message: `Line "${item.title}" has invalid quantity ${item.quantity}`,
        retryable: false,
        details: { productId: item.productId },
      });
    }
    const key = lineKey(item);
    const existing = coalesced.get(key);
    if (existing) {
      coalesced.set(key, { ...existing, quantity: existing.quantity + item.quantity });
    } else {
      coalesced.set(key, item);
    }
  }

  // 2. Group by merchant.
  const byMerchant = new Map<MerchantId, CartLineItem[]>();
  for (const item of coalesced.values()) {
    const bucket = byMerchant.get(item.merchantId) ?? [];
    bucket.push(item);
    byMerchant.set(item.merchantId, bucket);
  }

  // 3. Build sub-carts with subtotal + intra-merchant currency validation.
  const subCarts: MerchantSubCart[] = [];
  for (const [merchantId, items] of byMerchant) {
    const merchantCurrency = items[0]!.unitPrice.currency;
    let subtotal = zero(merchantCurrency);
    for (const item of items) {
      if (item.unitPrice.currency !== merchantCurrency) {
        return err({
          code: 'MIXED_CURRENCY_SUBCART',
          message: `Merchant ${merchantId} has line items in multiple currencies`,
          retryable: false,
          details: { merchantId, currencies: [merchantCurrency, item.unitPrice.currency] },
        });
      }
      subtotal = add(subtotal, multiply(item.unitPrice, item.quantity));
    }
    subCarts.push({ merchantId, items, subtotal });
  }

  const now = new Date().toISOString();
  return ok({
    cartId: input.cartId,
    userId: input.userId,
    displayCurrency: input.displayCurrency,
    subCarts,
    createdAt: now,
    updatedAt: now,
  });
}

/** Count the total physical units across every sub-cart. */
export function totalUnits(cart: UniversalCart): number {
  return cart.subCarts.reduce(
    (acc, sc) => acc + sc.items.reduce((s, i) => s + i.quantity, 0),
    0,
  );
}
