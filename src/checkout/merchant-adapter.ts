/**
 * @module checkout/merchant-adapter
 *
 * The MerchantAdapter is the seam between the orchestrator and a single
 * merchant's commerce backend (exposed as an A2A merchant agent, an Agentic
 * Commerce API, or a legacy REST checkout). The orchestrator never talks to a
 * merchant directly; it speaks this interface, which models a two-phase,
 * compensatable checkout:
 *
 *   reserve  -> authorize -> capture -> confirm     (happy path)
 *               \------ cancelReservation / refund ------/   (compensation)
 *
 * Splitting "authorize" (put a hold on funds) from "capture" (actually move the
 * money) is what makes an atomic-ish multi-merchant checkout possible. We hold
 * funds and inventory across *every* merchant first, and only capture once the
 * whole basket is guaranteed to succeed. This mirrors the AP2 mandate model.
 */

import type {
  MerchantId,
  MerchantSubCart,
  Money,
  IdempotencyKey,
  Result,
} from '../common/types.js';

/** Inventory + price hold for one merchant. Expires if not progressed. */
export interface Reservation {
  readonly reservationId: string;
  readonly merchantId: MerchantId;
  /** Authoritative total (incl. tax + shipping) computed by the merchant. */
  readonly total: Money;
  /** Unix epoch millis after which the hold is released automatically. */
  readonly expiresAt: number;
}

/** Result of placing a payment authorization (a hold) against the user mandate. */
export interface Authorization {
  readonly authorizationId: string;
  readonly merchantId: MerchantId;
  readonly amount: Money;
}

/** Final settlement record once funds are captured and the order is booked. */
export interface Settlement {
  readonly orderId: string;
  readonly merchantId: MerchantId;
  readonly captured: Money;
  readonly confirmationCode: string;
}

/** Context threaded through every adapter call for tracing + idempotency. */
export interface CheckoutContext {
  readonly correlationId: string;
  readonly userId: string;
  /** Payment mandate token (AP2) authorizing charges up to a limit. */
  readonly paymentMandate: string;
  /** Per-step idempotency key so retries never double-charge. */
  readonly idempotencyKey: IdempotencyKey;
}

/**
 * Contract every merchant integration must satisfy. Each method MUST be
 * idempotent with respect to `ctx.idempotencyKey`: calling it twice with the
 * same key returns the same result without side effects. This is the single
 * most important property for safe retries and rollback.
 */
export interface MerchantAdapter {
  readonly merchantId: MerchantId;

  /** Phase 1a: hold inventory and lock a price. Cheap to compensate. */
  reserve(cart: MerchantSubCart, ctx: CheckoutContext): Promise<Result<Reservation>>;

  /** Phase 1b: place a hold on funds via the AP2 mandate. No money moves yet. */
  authorize(reservation: Reservation, ctx: CheckoutContext): Promise<Result<Authorization>>;

  /** Phase 2a: capture previously authorized funds. The point of no easy return. */
  capture(authorization: Authorization, ctx: CheckoutContext): Promise<Result<Settlement>>;

  /** Phase 2b: confirm the order to the merchant fulfilment pipeline. */
  confirm(settlement: Settlement, ctx: CheckoutContext): Promise<Result<Settlement>>;

  /** Compensation: release an inventory/price hold. Safe to call if expired. */
  cancelReservation(reservation: Reservation, ctx: CheckoutContext): Promise<Result<void>>;

  /** Compensation: void an authorization hold before capture. */
  voidAuthorization(authorization: Authorization, ctx: CheckoutContext): Promise<Result<void>>;

  /** Compensation: refund a captured settlement (the expensive rollback). */
  refund(settlement: Settlement, ctx: CheckoutContext): Promise<Result<void>>;
}
