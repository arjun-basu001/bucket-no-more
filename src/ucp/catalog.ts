/**
 * @module ucp/catalog
 *
 * UCP — Universal Commerce Protocol. UCP defines a *unified product schema* so
 * that a shopping agent can read catalogs from many merchants through one shape,
 * regardless of each merchant's internal data model. A merchant agent exposes
 * its catalog as UCP products; the shopping agent queries and composes them
 * into a Universal Cart.
 *
 * This module provides:
 *   - A zod-validated UCP product schema (with money, availability, variants).
 *   - A normalizer that maps arbitrary merchant payloads into UCP products.
 *   - A small in-memory catalog with search/filter operations agents call.
 */

import { z } from 'zod';
import type { CartLineItem } from '../common/types.js';

export const MoneySchema = z.object({
  amountMinor: z.number().int(),
  currency: z.string().length(3),
});

export const AvailabilitySchema = z.enum(['in_stock', 'out_of_stock', 'preorder', 'backorder']);

/** A purchasable variant (size/color/etc.) of a UCP product. */
export const VariantSchema = z.object({
  sku: z.string().min(1),
  attributes: z.record(z.string()),
  price: MoneySchema,
  availability: AvailabilitySchema.default('in_stock'),
  /** Units on hand; undefined means the merchant does not expose it. */
  inventory: z.number().int().nonnegative().optional(),
});

/** The canonical UCP product. */
export const UCPProductSchema = z.object({
  ucpVersion: z.literal('1.0'),
  productId: z.string().min(1),
  merchantId: z.string().min(1),
  title: z.string().min(1),
  description: z.string().default(''),
  brand: z.string().optional(),
  /** Hierarchical category path, e.g. ["Electronics", "Headphones"]. */
  category: z.array(z.string()).default([]),
  /** Base price; variants may override. */
  price: MoneySchema,
  availability: AvailabilitySchema.default('in_stock'),
  imageUrls: z.array(z.string().url()).default([]),
  variants: z.array(VariantSchema).default([]),
  /** Arbitrary merchant-specific fields preserved for round-tripping. */
  attributes: z.record(z.string()).default({}),
});

export type UCPProduct = z.infer<typeof UCPProductSchema>;
export type UCPVariant = z.infer<typeof VariantSchema>;

export class CatalogValidationError extends Error {
  constructor(message: string, readonly issues: unknown) {
    super(message);
    this.name = 'CatalogValidationError';
  }
}

/** Validate an unknown object as a UCP product. */
export function parseProduct(input: unknown): UCPProduct {
  const result = UCPProductSchema.safeParse(input);
  if (!result.success) {
    throw new CatalogValidationError('Invalid UCP product', result.error.format());
  }
  return result.data;
}

/**
 * Map a loosely-typed merchant payload into a UCP product. Real adapters would
 * have merchant-specific field mappings; this shows the normalization seam and
 * sensible defaults. Unknown extra fields are preserved under `attributes`.
 */
export function normalizeToUCP(raw: Record<string, unknown>, merchantId: string): UCPProduct {
  const priceMinor =
    typeof raw['priceMinor'] === 'number'
      ? (raw['priceMinor'] as number)
      : Math.round(Number(raw['price'] ?? 0) * 100);
  return parseProduct({
    ucpVersion: '1.0',
    productId: String(raw['id'] ?? raw['productId'] ?? ''),
    merchantId,
    title: String(raw['title'] ?? raw['name'] ?? ''),
    description: String(raw['description'] ?? ''),
    brand: raw['brand'] ? String(raw['brand']) : undefined,
    category: Array.isArray(raw['category']) ? (raw['category'] as string[]) : [],
    price: { amountMinor: priceMinor, currency: String(raw['currency'] ?? 'USD') },
    availability: (raw['availability'] as UCPProduct['availability']) ?? 'in_stock',
    imageUrls: Array.isArray(raw['imageUrls']) ? (raw['imageUrls'] as string[]) : [],
    variants: Array.isArray(raw['variants']) ? raw['variants'] : [],
    attributes: typeof raw['attributes'] === 'object' && raw['attributes'] ? raw['attributes'] : {},
  });
}

export interface CatalogQuery {
  readonly text?: string;
  readonly category?: string;
  readonly maxPriceMinor?: number;
  readonly inStockOnly?: boolean;
  readonly limit?: number;
}

/** A simple in-memory UCP catalog a merchant agent serves to shopping agents. */
export class UCPCatalog {
  private readonly products = new Map<string, UCPProduct>();

  constructor(readonly merchantId: string) {}

  upsert(product: UCPProduct): void {
    if (product.merchantId !== this.merchantId) {
      throw new CatalogValidationError('Product merchantId mismatch', {
        expected: this.merchantId,
        got: product.merchantId,
      });
    }
    this.products.set(product.productId, product);
  }

  get(productId: string): UCPProduct | undefined {
    return this.products.get(productId);
  }

  /** Query the catalog with text/category/price/availability filters. */
  search(query: CatalogQuery = {}): UCPProduct[] {
    const text = query.text?.toLowerCase();
    let results = [...this.products.values()].filter((p) => {
      if (text && !`${p.title} ${p.description} ${p.brand ?? ''}`.toLowerCase().includes(text)) {
        return false;
      }
      if (query.category && !p.category.includes(query.category)) return false;
      if (query.maxPriceMinor !== undefined && p.price.amountMinor > query.maxPriceMinor) return false;
      if (query.inStockOnly && p.availability !== 'in_stock') return false;
      return true;
    });
    if (query.limit !== undefined) results = results.slice(0, query.limit);
    return results;
  }

  /** Convert a UCP product + quantity into a Universal Cart line item. */
  toLineItem(productId: string, quantity: number, variantSku?: string): CartLineItem {
    const product = this.get(productId);
    if (!product) throw new CatalogValidationError('Unknown product', { productId });
    const variant = variantSku ? product.variants.find((v) => v.sku === variantSku) : undefined;
    const unitPrice = variant?.price ?? product.price;
    return {
      productId,
      merchantId: product.merchantId,
      title: product.title,
      unitPrice,
      quantity,
      attributes: variant?.attributes,
    };
  }

  size(): number {
    return this.products.size;
  }
}
