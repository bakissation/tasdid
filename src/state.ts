import { TasdidError } from './errors.js';
import type { PaymentStatus } from './types.js';

/** Allowed forward transitions of the payment state machine. */
const TRANSITIONS: Record<PaymentStatus, readonly PaymentStatus[]> = {
  created: ['pending', 'failed'],
  pending: ['paid', 'failed', 'expired'],
  paid: ['refunded', 'partially_refunded'],
  partially_refunded: ['refunded', 'partially_refunded'],
  // terminal
  failed: [],
  expired: [],
  refunded: [],
};

/** A status no further transition can leave (except staying itself). */
export function isTerminal(status: PaymentStatus): boolean {
  return TRANSITIONS[status].length === 0;
}

export function canTransition(from: PaymentStatus, to: PaymentStatus): boolean {
  if (from === to) return true;
  return TRANSITIONS[from].includes(to);
}

/** Throw {@link TasdidError} unless `from → to` is a legal transition. */
export function assertTransition(from: PaymentStatus, to: PaymentStatus): void {
  if (!canTransition(from, to)) {
    throw new TasdidError(`Illegal payment transition: ${from} → ${to}`, 'INVALID_TRANSITION');
  }
}
