/**
 * @module checkout/orchestrator
 *
 * MultiMerchantCheckoutOrchestrator — the heart of the Universal Cart checkout.
 *
 * THE PROBLEM
 * -----------
 * A single user basket spans N independent merchants. There is no global 2-phase
 * commit coordinator across third-party commerce backends, so we cannot get true
 * ACID atomicity. What the user actually wants is: "either everything I ordered
 * is placed, or nothing is charged." We approximate this with a SAGA built on
 * the reserve/authorize/capture/confirm primitives of {@link MerchantAdapter}.
 *
 * THE STRATEGY (try-confirm/cancel, a.k.a. TCC)
 * ---------------------------------------------
 *   Phase 1 (reversible, runs for ALL merchants, in parallel):
 *       reserve   -> hold inventory + lock price
 *       authorize -> place a hold on funds (no money moves)
 *     If ANY merchant fails phase 1, we compensate every merchant that got as
 *     far as reserve/authorize (cancelReservation / voidAuthorization). Nothing
 *     was captured, so the user is never charged. Result: clean rollback.
 *
 *   Phase 2 (commit, runs only if ALL merchants passed phase 1):
 *       capture -> move the held funds
 *       confirm -> book the order into fulfilment
 *     Once we begin capturing, we are past the cheap-rollback point. If a
 *     capture/confirm fails here, we attempt best-effort compensation by
 *     REFUNDING already-captured merchants. Refunds can fail or be delayed, so
 *     this path is surfaced loudly for operator/agent follow-up.
 *
 * EDGE CASES EXPLICITLY HANDLED
 * -----------------------------
 *   - Reservation expiry between phase 1 and phase 2 (checked before capture).
 *   - Partial phase-1 success -> full rollback.
 *   - Partial phase-2 success -> best-effort refund + PARTIALLY_FAILED status.
 *   - Idempotent retries via per-step idempotency keys.
 *   - Compensation that itself fails (logged, never throws past the boundary).
 *   - Empty merchant set (rejected before any side effects).
 */

import { randomUUID } from 'node:crypto';
import {
  CheckoutStepStatus,
  OrchestrationStatus,
  type MerchantId,
  type UniversalCart,
  type Result,
} from '../common/types.js';
import { ok, err } from '../common/types.js';
import { Logger, rootLogger } from '../common/logger.js';
import { withRetry } from '../common/retry.js';
import type { MerchantAdapter, CheckoutContext } from './merchant-adapter.js';
import {
  createOrchestrationState,
  transitionStep,
  setOrchestrationStatus,
  type OrchestrationState,
} from './orchestration-state.js';

/** Persistence seam: swap the in-memory store for Postgres/Redis in production. */
export interface StateStore {
  save(state: OrchestrationState): Promise<void>;
  load(orchestrationId: string): Promise<OrchestrationState | undefined>;
}

/** Default in-memory store — fine for demos and tests, not for production. */
export class InMemoryStateStore implements StateStore {
  private readonly db = new Map<string, OrchestrationState>();
  async save(state: OrchestrationState): Promise<void> {
    this.db.set(state.orchestrationId, state);
  }
  async load(orchestrationId: string): Promise<OrchestrationState | undefined> {
    return this.db.get(orchestrationId);
  }
}

export interface CheckoutRequest {
  readonly cart: UniversalCart;
  readonly userId: string;
  /** AP2 payment mandate authorizing charges up to a cap. */
  readonly paymentMandate: string;
  readonly correlationId?: string;
}

export interface CheckoutOutcome {
  readonly orchestrationId: string;
  readonly status: OrchestrationStatus;
  /** Confirmation codes per successfully committed merchant. */
  readonly confirmations: Record<MerchantId, string>;
  /** Merchants that failed, with the reason. */
  readonly failures: Record<MerchantId, string>;
  readonly state: OrchestrationState;
}

export interface OrchestratorConfig {
  /** Retry attempts for transient adapter errors during phase 1. */
  readonly phase1MaxAttempts?: number;
  /** Skew tolerance (ms) when checking reservation expiry before capture. */
  readonly reservationSkewMs?: number;
}

export class MultiMerchantCheckoutOrchestrator {
  private readonly log: Logger;

  constructor(
    private readonly adapters: ReadonlyMap<MerchantId, MerchantAdapter>,
    private readonly store: StateStore = new InMemoryStateStore(),
    private readonly config: OrchestratorConfig = {},
    logger: Logger = rootLogger,
  ) {
    this.log = logger.child('orchestrator');
  }

  /**
   * Execute the full multi-merchant checkout. Never throws for business
   * failures — those come back as a Result with a structured outcome. Only
   * truly exceptional programmer errors propagate.
   */
  async checkout(request: CheckoutRequest): Promise<Result<CheckoutOutcome>> {
    const correlationId = request.correlationId ?? randomUUID();
    const orchestrationId = randomUUID();
    const log = this.log.child('checkout', { correlationId, orchestrationId });

    const merchantIds = request.cart.subCarts.map((sc) => sc.merchantId);
    if (merchantIds.length === 0) {
      return err({ code: 'EMPTY_CART', message: 'No merchants to check out', retryable: false });
    }

    // Verify we actually have an adapter for every merchant before any I/O.
    for (const merchantId of merchantIds) {
      if (!this.adapters.has(merchantId)) {
        return err({
          code: 'NO_ADAPTER',
          message: `No merchant adapter registered for ${merchantId}`,
          retryable: false,
          details: { merchantId },
        });
      }
    }

    const state = createOrchestrationState({
      orchestrationId,
      cartId: request.cart.cartId,
      userId: request.userId,
      merchantIds,
    });
    setOrchestrationStatus(state, OrchestrationStatus.IN_PROGRESS, 'checkout started');
    await this.store.save(state);

    log.info('Starting multi-merchant checkout', { merchants: merchantIds.length });

    // ---- PHASE 1: reserve + authorize across all merchants in parallel. ----
    const phase1 = await this.runPhase1(state, request, correlationId, log);
    await this.store.save(state);

    if (!phase1.ok) {
      // Something in phase 1 failed -> roll everything back. Nothing captured.
      log.warn('Phase 1 failed; rolling back all reservations/authorizations', {
        reason: phase1.error.message,
      });
      await this.compensateAll(state, request, correlationId, log);
      setOrchestrationStatus(state, OrchestrationStatus.PARTIALLY_FAILED_ROLLED_BACK, 'phase1 rollback');
      await this.store.save(state);
      return ok(this.toOutcome(state));
    }

    // ---- PHASE 2: capture + confirm. Past the cheap-rollback boundary. ----
    const phase2 = await this.runPhase2(state, request, correlationId, log);
    await this.store.save(state);

    if (!phase2.ok) {
      log.error('Phase 2 partially failed; attempting best-effort refunds', {
        reason: phase2.error.message,
      });
      await this.refundCaptured(state, request, correlationId, log);
      setOrchestrationStatus(state, OrchestrationStatus.PARTIALLY_FAILED_ROLLED_BACK, 'phase2 refunds');
      await this.store.save(state);
      return ok(this.toOutcome(state));
    }

    setOrchestrationStatus(state, OrchestrationStatus.COMMITTED, 'all merchants confirmed');
    await this.store.save(state);
    log.info('Checkout committed successfully');
    return ok(this.toOutcome(state));
  }

  // -------------------------------------------------------------------------
  // Phase 1: reserve then authorize, for every merchant, concurrently.
  // -------------------------------------------------------------------------
  private async runPhase1(
    state: OrchestrationState,
    request: CheckoutRequest,
    correlationId: string,
    log: Logger,
  ): Promise<Result<void>> {
    const results = await Promise.all(
      request.cart.subCarts.map(async (subCart) => {
        const merchantId = subCart.merchantId;
        const adapter = this.adapters.get(merchantId)!;
        const step = state.steps.get(merchantId)!;

        const ctx = this.contextFor(request, correlationId, merchantId, 'reserve');
        step.attempts += 1;

        // reserve (with bounded retry for transient errors)
        const reservation = await withRetry(() => adapter.reserve(subCart, ctx), {
          maxAttempts: this.config.phase1MaxAttempts ?? 3,
          isRetryable: (e) => isRetryableResult(e),
        }).catch((e) => failureResult(e));

        if (!reservation.ok) {
          this.recordStepFailure(state, merchantId, reservation.error);
          return { merchantId, ok: false as const, error: reservation.error };
        }
        step.reservation = reservation.value;
        transitionStep(state, merchantId, CheckoutStepStatus.RESERVED);

        // authorize
        const authCtx = this.contextFor(request, correlationId, merchantId, 'authorize');
        const authorization = await withRetry(
          () => adapter.authorize(reservation.value, authCtx),
          { maxAttempts: this.config.phase1MaxAttempts ?? 3, isRetryable: (e) => isRetryableResult(e) },
        ).catch((e) => failureResult(e));

        if (!authorization.ok) {
          this.recordStepFailure(state, merchantId, authorization.error);
          return { merchantId, ok: false as const, error: authorization.error };
        }
        step.authorization = authorization.value;
        transitionStep(state, merchantId, CheckoutStepStatus.AUTHORIZED);
        log.debug('Merchant authorized', { merchantId });
        return { merchantId, ok: true as const };
      }),
    );

    const firstFailure = results.find((r) => !r.ok);
    if (firstFailure && !firstFailure.ok) {
      return err({
        code: 'PHASE1_FAILED',
        message: `Phase 1 failed for ${firstFailure.merchantId}: ${firstFailure.error.message}`,
        retryable: false,
        details: { merchantId: firstFailure.merchantId },
      });
    }
    return ok(undefined);
  }

  // -------------------------------------------------------------------------
  // Phase 2: capture then confirm. Sequential per merchant for clear logs;
  // still parallel across merchants. Reservation expiry is re-checked first.
  // -------------------------------------------------------------------------
  private async runPhase2(
    state: OrchestrationState,
    request: CheckoutRequest,
    correlationId: string,
    log: Logger,
  ): Promise<Result<void>> {
    const skew = this.config.reservationSkewMs ?? 2_000;
    const now = Date.now();

    // Guard: if any reservation has expired, do NOT capture anything.
    for (const step of state.steps.values()) {
      if (step.reservation && step.reservation.expiresAt - skew <= now) {
        return err({
          code: 'RESERVATION_EXPIRED',
          message: `Reservation for ${step.merchantId} expired before capture`,
          retryable: false,
          details: { merchantId: step.merchantId },
        });
      }
    }

    const results = await Promise.all(
      [...state.steps.values()].map(async (step) => {
        const merchantId = step.merchantId;
        const adapter = this.adapters.get(merchantId)!;
        if (!step.authorization) {
          return { merchantId, ok: false as const, error: notAuthorized(merchantId) };
        }

        const captureCtx = this.contextFor(request, correlationId, merchantId, 'capture');
        const settlement = await adapter
          .capture(step.authorization, captureCtx)
          .catch((e) => failureResult(e));
        if (!settlement.ok) {
          this.recordStepFailure(state, merchantId, settlement.error);
          return { merchantId, ok: false as const, error: settlement.error };
        }
        step.settlement = settlement.value;
        transitionStep(state, merchantId, CheckoutStepStatus.CAPTURED);

        const confirmCtx = this.contextFor(request, correlationId, merchantId, 'confirm');
        const confirmed = await adapter
          .confirm(settlement.value, confirmCtx)
          .catch((e) => failureResult(e));
        if (!confirmed.ok) {
          this.recordStepFailure(state, merchantId, confirmed.error);
          return { merchantId, ok: false as const, error: confirmed.error };
        }
        step.settlement = confirmed.value;
        transitionStep(state, merchantId, CheckoutStepStatus.CONFIRMED);
        log.debug('Merchant confirmed', { merchantId, orderId: confirmed.value.orderId });
        return { merchantId, ok: true as const };
      }),
    );

    const failure = results.find((r) => !r.ok);
    if (failure && !failure.ok) {
      return err({
        code: 'PHASE2_FAILED',
        message: `Phase 2 failed for ${failure.merchantId}: ${failure.error.message}`,
        retryable: false,
        details: { merchantId: failure.merchantId },
      });
    }
    return ok(undefined);
  }

  // -------------------------------------------------------------------------
  // Compensation paths.
  // -------------------------------------------------------------------------

  /** Roll back everything from phase 1: void auths, then cancel reservations. */
  private async compensateAll(
    state: OrchestrationState,
    request: CheckoutRequest,
    correlationId: string,
    log: Logger,
  ): Promise<void> {
    await Promise.all(
      [...state.steps.values()].map(async (step) => {
        const adapter = this.adapters.get(step.merchantId)!;
        const merchantId = step.merchantId;
        try {
          if (
            step.status === CheckoutStepStatus.AUTHORIZED ||
            step.status === CheckoutStepStatus.RESERVED ||
            step.status === CheckoutStepStatus.FAILED
          ) {
            transitionStep(state, merchantId, CheckoutStepStatus.COMPENSATING, 'phase1 rollback');
          }
          if (step.authorization) {
            const ctx = this.contextFor(request, correlationId, merchantId, 'void');
            const r = await adapter.voidAuthorization(step.authorization, ctx).catch((e) => failureResult(e));
            if (!r.ok) log.warn('void authorization failed', { merchantId, error: r.error.message });
          }
          if (step.reservation) {
            const ctx = this.contextFor(request, correlationId, merchantId, 'cancel');
            const r = await adapter.cancelReservation(step.reservation, ctx).catch((e) => failureResult(e));
            if (!r.ok) log.warn('cancel reservation failed', { merchantId, error: r.error.message });
          }
          if (step.status === CheckoutStepStatus.COMPENSATING) {
            transitionStep(state, merchantId, CheckoutStepStatus.COMPENSATED);
          }
        } catch (e) {
          // Compensation must never throw past this boundary; log and move on.
          log.error('compensation error', { merchantId, error: (e as Error).message });
        }
      }),
    );
  }

  /** Best-effort refunds for merchants captured before a phase-2 failure. */
  private async refundCaptured(
    state: OrchestrationState,
    request: CheckoutRequest,
    correlationId: string,
    log: Logger,
  ): Promise<void> {
    await Promise.all(
      [...state.steps.values()].map(async (step) => {
        const adapter = this.adapters.get(step.merchantId)!;
        const merchantId = step.merchantId;
        const captured =
          step.status === CheckoutStepStatus.CAPTURED ||
          step.status === CheckoutStepStatus.CONFIRMED;
        try {
          if (captured && step.settlement) {
            transitionStep(state, merchantId, CheckoutStepStatus.COMPENSATING, 'phase2 refund');
            const ctx = this.contextFor(request, correlationId, merchantId, 'refund');
            const r = await adapter.refund(step.settlement, ctx).catch((e) => failureResult(e));
            if (r.ok) {
              transitionStep(state, merchantId, CheckoutStepStatus.COMPENSATED);
            } else {
              // A failed refund is an operational incident — surface it loudly.
              transitionStep(state, merchantId, CheckoutStepStatus.FAILED, 'refund failed');
              log.error('REFUND FAILED — requires manual reconciliation', {
                merchantId,
                orderId: step.settlement.orderId,
                error: r.error.message,
              });
            }
          } else if (
            step.status === CheckoutStepStatus.RESERVED ||
            step.status === CheckoutStepStatus.AUTHORIZED
          ) {
            // Authorized-but-not-captured branches still get cleaned up.
            transitionStep(state, merchantId, CheckoutStepStatus.COMPENSATING, 'phase2 cleanup');
            if (step.authorization) {
              const ctx = this.contextFor(request, correlationId, merchantId, 'void');
              await adapter.voidAuthorization(step.authorization, ctx).catch(() => undefined);
            }
            if (step.reservation) {
              const ctx = this.contextFor(request, correlationId, merchantId, 'cancel');
              await adapter.cancelReservation(step.reservation, ctx).catch(() => undefined);
            }
            transitionStep(state, merchantId, CheckoutStepStatus.COMPENSATED);
          }
        } catch (e) {
          log.error('refund/cleanup error', { merchantId, error: (e as Error).message });
        }
      }),
    );
  }

  // -------------------------------------------------------------------------
  // Helpers.
  // -------------------------------------------------------------------------

  private contextFor(
    request: CheckoutRequest,
    correlationId: string,
    merchantId: MerchantId,
    step: string,
  ): CheckoutContext {
    return {
      correlationId,
      userId: request.userId,
      paymentMandate: request.paymentMandate,
      // Deterministic per (orchestration, merchant, step) so retries are idempotent.
      idempotencyKey: `${request.cart.cartId}:${merchantId}:${step}`,
    };
  }

  private recordStepFailure(
    state: OrchestrationState,
    merchantId: MerchantId,
    error: { code: string; message: string },
  ): void {
    const step = state.steps.get(merchantId)!;
    step.lastError = { code: error.code, message: error.message };
    if (step.status !== CheckoutStepStatus.FAILED) {
      try {
        transitionStep(state, merchantId, CheckoutStepStatus.FAILED, error.code);
      } catch {
        /* already terminal — ignore */
      }
    }
  }

  private toOutcome(state: OrchestrationState): CheckoutOutcome {
    const confirmations: Record<MerchantId, string> = {};
    const failures: Record<MerchantId, string> = {};
    for (const step of state.steps.values()) {
      if (step.status === CheckoutStepStatus.CONFIRMED && step.settlement) {
        confirmations[step.merchantId] = step.settlement.confirmationCode;
      } else if (step.lastError) {
        failures[step.merchantId] = step.lastError.message;
      }
    }
    return {
      orchestrationId: state.orchestrationId,
      status: state.status,
      confirmations,
      failures,
      state,
    };
  }
}

// ---- module-private error helpers --------------------------------------

function isRetryableResult(e: unknown): boolean {
  if (e && typeof e === 'object' && 'ok' in e && (e as { ok: boolean }).ok === false) {
    const error = (e as { error?: { retryable?: boolean } }).error;
    return error?.retryable === true;
  }
  // Thrown network-ish errors are treated as retryable.
  return true;
}

function failureResult(e: unknown): Result<never> {
  if (e && typeof e === 'object' && 'ok' in e) return e as Result<never>;
  return err({
    code: 'ADAPTER_EXCEPTION',
    message: e instanceof Error ? e.message : String(e),
    retryable: false,
  });
}

function notAuthorized(merchantId: MerchantId) {
  return { code: 'NOT_AUTHORIZED', message: `No authorization for ${merchantId}`, retryable: false };
}
