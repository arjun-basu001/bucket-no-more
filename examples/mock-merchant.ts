/**
 * A configurable in-memory MerchantAdapter for demos and tests.
 *
 * It honours idempotency keys (repeat calls with the same key return the same
 * artifact without new side effects) and can be told to fail at a specific
 * phase, which is exactly what we need to exercise the orchestrator's rollback
 * and refund paths.
 */

import { randomUUID } from 'node:crypto';
import {
  type MerchantAdapter,
  type CheckoutContext,
  type Reservation,
  type Authorization,
  type Settlement,
} from '../src/checkout/merchant-adapter.js';
import type { MerchantSubCart, Result } from '../src/common/types.js';
import { ok, err } from '../src/common/types.js';
import { add } from '../src/common/money.js';

export type FailAt = 'reserve' | 'authorize' | 'capture' | 'confirm' | 'none';

export interface MockMerchantOptions {
  readonly merchantId: string;
  /** Inject a failure at a given phase to test compensation. */
  readonly failAt?: FailAt;
  /** Whether the injected failure is retryable. */
  readonly retryable?: boolean;
  /** Reservation TTL in ms (set low to test expiry handling). */
  readonly reservationTtlMs?: number;
  /** Flat shipping + tax added to the subtotal, in minor units. */
  readonly feesMinor?: number;
  /** Artificial latency per call (ms) to make concurrency visible. */
  readonly latencyMs?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class MockMerchantAdapter implements MerchantAdapter {
  readonly merchantId: string;
  private readonly failAt: FailAt;
  private readonly retryable: boolean;
  private readonly ttl: number;
  private readonly fees: number;
  private readonly latency: number;

  // Idempotency caches keyed by ctx.idempotencyKey.
  private readonly reservations = new Map<string, Reservation>();
  private readonly authorizations = new Map<string, Authorization>();
  private readonly settlements = new Map<string, Settlement>();

  /** Observable side-effect log for assertions/demo output. */
  readonly events: string[] = [];

  constructor(opts: MockMerchantOptions) {
    this.merchantId = opts.merchantId;
    this.failAt = opts.failAt ?? 'none';
    this.retryable = opts.retryable ?? false;
    this.ttl = opts.reservationTtlMs ?? 5 * 60_000;
    this.fees = opts.feesMinor ?? 0;
    this.latency = opts.latencyMs ?? 0;
  }

  private fail(code: string): Result<never> {
    return err({ code, message: `${this.merchantId} injected failure at ${code}`, retryable: this.retryable });
  }

  async reserve(cart: MerchantSubCart, ctx: CheckoutContext): Promise<Result<Reservation>> {
    await sleep(this.latency);
    if (this.failAt === 'reserve') return this.fail('reserve');
    const cached = this.reservations.get(ctx.idempotencyKey);
    if (cached) return ok(cached);
    const total = this.fees
      ? add(cart.subtotal, { amountMinor: this.fees, currency: cart.subtotal.currency })
      : cart.subtotal;
    const reservation: Reservation = {
      reservationId: randomUUID(),
      merchantId: this.merchantId,
      total,
      expiresAt: Date.now() + this.ttl,
    };
    this.reservations.set(ctx.idempotencyKey, reservation);
    this.events.push('reserved');
    return ok(reservation);
  }

  async authorize(reservation: Reservation, ctx: CheckoutContext): Promise<Result<Authorization>> {
    await sleep(this.latency);
    if (this.failAt === 'authorize') return this.fail('authorize');
    const cached = this.authorizations.get(ctx.idempotencyKey);
    if (cached) return ok(cached);
    const authorization: Authorization = {
      authorizationId: randomUUID(),
      merchantId: this.merchantId,
      amount: reservation.total,
    };
    this.authorizations.set(ctx.idempotencyKey, authorization);
    this.events.push('authorized');
    return ok(authorization);
  }

  async capture(authorization: Authorization, ctx: CheckoutContext): Promise<Result<Settlement>> {
    await sleep(this.latency);
    if (this.failAt === 'capture') return this.fail('capture');
    const cached = this.settlements.get(ctx.idempotencyKey);
    if (cached) return ok(cached);
    const settlement: Settlement = {
      orderId: randomUUID(),
      merchantId: this.merchantId,
      captured: authorization.amount,
      confirmationCode: `CONF-${this.merchantId}-${Math.floor(Math.random() * 1e6)}`,
    };
    this.settlements.set(ctx.idempotencyKey, settlement);
    this.events.push('captured');
    return ok(settlement);
  }

  async confirm(settlement: Settlement, _ctx: CheckoutContext): Promise<Result<Settlement>> {
    await sleep(this.latency);
    if (this.failAt === 'confirm') return this.fail('confirm');
    this.events.push('confirmed');
    return ok(settlement);
  }

  async cancelReservation(_reservation: Reservation, _ctx: CheckoutContext): Promise<Result<void>> {
    await sleep(this.latency);
    this.events.push('reservation-cancelled');
    return ok(undefined);
  }

  async voidAuthorization(_authorization: Authorization, _ctx: CheckoutContext): Promise<Result<void>> {
    await sleep(this.latency);
    this.events.push('authorization-voided');
    return ok(undefined);
  }

  async refund(settlement: Settlement, _ctx: CheckoutContext): Promise<Result<void>> {
    await sleep(this.latency);
    this.events.push(`refunded:${settlement.orderId}`);
    return ok(undefined);
  }
}
