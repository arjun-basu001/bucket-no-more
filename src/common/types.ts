/**
 * @module common/types
 *
 * Shared domain types for the bucket-no-more agentic commerce stack.
 *
 * These types model the core entities exchanged between shopping agents,
 * merchant agents, the Universal Cart, and the payment layer (AP2). They are
 * intentionally transport-agnostic: the same structures flow over A2A JSON-RPC
 * messages, HTTP APIs, and in-process function calls.
 */

/** ISO-4217 currency code (e.g. "USD", "EUR", "INR"). */
export type CurrencyCode = string;

/**
 * Monetary amounts are always represented in the *minor unit* of the currency
 * (cents for USD, paise for INR) as integers to avoid floating-point drift.
 * Every {@link Money} value carries its own currency to make cross-merchant
 * aggregation explicit rather than assumed.
 */
export interface Money {
  /** Integer amount in the minor unit (e.g. 1099 == $10.99). */
  readonly amountMinor: number;
  readonly currency: CurrencyCode;
}

/** A globally unique merchant identifier within the UCP namespace. */
export type MerchantId = string;

/** A globally unique product identifier, scoped to a merchant. */
export type ProductId = string;

/** Opaque idempotency key used to make mutations safely retryable. */
export type IdempotencyKey = string;

/** A single line item the shopping agent intends to purchase. */
export interface CartLineItem {
  readonly productId: ProductId;
  readonly merchantId: MerchantId;
  readonly title: string;
  /** Unit price quoted by the merchant at the time of add-to-cart. */
  readonly unitPrice: Money;
  readonly quantity: number;
  /** Free-form merchant attributes (size, color, SKU variant, etc.). */
  readonly attributes?: Readonly<Record<string, string>>;
}

/**
 * A per-merchant grouping of line items. The Universal Cart is composed of one
 * sub-cart per participating merchant; this is the unit of checkout that a
 * single merchant agent can fulfil and settle independently.
 */
export interface MerchantSubCart {
  readonly merchantId: MerchantId;
  readonly items: readonly CartLineItem[];
  /** Subtotal for this merchant before tax/shipping, in the merchant currency. */
  readonly subtotal: Money;
}

/**
 * The Universal Cart: a cross-merchant aggregation that a single shopping agent
 * coordinates on behalf of the user. Each sub-cart is settled with its own
 * merchant, but the user experiences a single basket and a single confirmation.
 */
export interface UniversalCart {
  readonly cartId: string;
  readonly userId: string;
  readonly subCarts: readonly MerchantSubCart[];
  /** Display currency the agent normalises totals into for the user. */
  readonly displayCurrency: CurrencyCode;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Lifecycle states for an individual merchant checkout within an orchestration. */
export enum CheckoutStepStatus {
  PENDING = 'PENDING',
  RESERVED = 'RESERVED',
  AUTHORIZED = 'AUTHORIZED',
  CAPTURED = 'CAPTURED',
  CONFIRMED = 'CONFIRMED',
  COMPENSATING = 'COMPENSATING',
  COMPENSATED = 'COMPENSATED',
  FAILED = 'FAILED',
}

/** Overall states for a multi-merchant checkout orchestration. */
export enum OrchestrationStatus {
  PENDING = 'PENDING',
  IN_PROGRESS = 'IN_PROGRESS',
  COMMITTED = 'COMMITTED',
  PARTIALLY_FAILED_ROLLED_BACK = 'PARTIALLY_FAILED_ROLLED_BACK',
  FAILED = 'FAILED',
}

/** A structured, serialisable error that crosses agent boundaries. */
export interface AgentError {
  readonly code: string;
  readonly message: string;
  /** Whether retrying the same request could plausibly succeed. */
  readonly retryable: boolean;
  readonly details?: Readonly<Record<string, unknown>>;
}

/** Discriminated-union result type used throughout the codebase. */
export type Result<T, E = AgentError> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
export const err = <E>(error: E): Result<never, E> => ({ ok: false, error });
