/**
 * @module checkout/orchestration-state
 *
 * Explicit, serialisable state for a multi-merchant checkout. The orchestrator
 * is effectively a distributed saga coordinator; persisting this state after
 * every transition is what lets a crashed orchestrator resume — or roll back —
 * deterministically. Treat this object as the saga log.
 */

import {
  CheckoutStepStatus,
  OrchestrationStatus,
  type MerchantId,
} from '../common/types.js';
import type { Reservation, Authorization, Settlement } from './merchant-adapter.js';

/** Per-merchant branch of the saga, with every artifact needed to compensate. */
export interface MerchantStepState {
  readonly merchantId: MerchantId;
  status: CheckoutStepStatus;
  reservation?: Reservation;
  authorization?: Authorization;
  settlement?: Settlement;
  /** Last error observed for this branch, if any. */
  lastError?: { code: string; message: string };
  /** Monotonic attempt counter for diagnostics. */
  attempts: number;
}

export interface OrchestrationState {
  readonly orchestrationId: string;
  readonly cartId: string;
  readonly userId: string;
  status: OrchestrationStatus;
  readonly steps: Map<MerchantId, MerchantStepState>;
  /** Append-only audit trail of transitions for observability + debugging. */
  readonly history: Array<{ ts: string; merchantId?: MerchantId; from: string; to: string; note?: string }>;
}

/**
 * Legal forward transitions for a single merchant branch. Any transition not
 * present here (other than the compensation paths) is a programming error and
 * is rejected, which catches a whole class of orchestration bugs at runtime.
 */
const FORWARD: Readonly<Record<CheckoutStepStatus, readonly CheckoutStepStatus[]>> = {
  [CheckoutStepStatus.PENDING]: [CheckoutStepStatus.RESERVED, CheckoutStepStatus.FAILED],
  [CheckoutStepStatus.RESERVED]: [
    CheckoutStepStatus.AUTHORIZED,
    CheckoutStepStatus.COMPENSATING,
    CheckoutStepStatus.FAILED,
  ],
  [CheckoutStepStatus.AUTHORIZED]: [
    CheckoutStepStatus.CAPTURED,
    CheckoutStepStatus.COMPENSATING,
    CheckoutStepStatus.FAILED,
  ],
  [CheckoutStepStatus.CAPTURED]: [
    CheckoutStepStatus.CONFIRMED,
    CheckoutStepStatus.COMPENSATING,
    CheckoutStepStatus.FAILED,
  ],
  [CheckoutStepStatus.CONFIRMED]: [CheckoutStepStatus.COMPENSATING],
  [CheckoutStepStatus.COMPENSATING]: [CheckoutStepStatus.COMPENSATED, CheckoutStepStatus.FAILED],
  [CheckoutStepStatus.COMPENSATED]: [],
  [CheckoutStepStatus.FAILED]: [CheckoutStepStatus.COMPENSATING],
};

export function createOrchestrationState(args: {
  orchestrationId: string;
  cartId: string;
  userId: string;
  merchantIds: readonly MerchantId[];
}): OrchestrationState {
  const steps = new Map<MerchantId, MerchantStepState>();
  for (const merchantId of args.merchantIds) {
    steps.set(merchantId, { merchantId, status: CheckoutStepStatus.PENDING, attempts: 0 });
  }
  return {
    orchestrationId: args.orchestrationId,
    cartId: args.cartId,
    userId: args.userId,
    status: OrchestrationStatus.PENDING,
    steps,
    history: [],
  };
}

export class IllegalTransitionError extends Error {
  constructor(merchantId: MerchantId, from: CheckoutStepStatus, to: CheckoutStepStatus) {
    super(`Illegal step transition for ${merchantId}: ${from} -> ${to}`);
    this.name = 'IllegalTransitionError';
  }
}

/** Apply a validated transition to a merchant branch, recording history. */
export function transitionStep(
  state: OrchestrationState,
  merchantId: MerchantId,
  to: CheckoutStepStatus,
  note?: string,
): void {
  const step = state.steps.get(merchantId);
  if (!step) throw new Error(`Unknown merchant branch: ${merchantId}`);
  const allowed = FORWARD[step.status];
  if (!allowed.includes(to)) {
    throw new IllegalTransitionError(merchantId, step.status, to);
  }
  state.history.push({ ts: new Date().toISOString(), merchantId, from: step.status, to, note });
  step.status = to;
}

export function setOrchestrationStatus(
  state: OrchestrationState,
  to: OrchestrationStatus,
  note?: string,
): void {
  state.history.push({ ts: new Date().toISOString(), from: state.status, to, note });
  state.status = to;
}
