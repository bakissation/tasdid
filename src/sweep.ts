import type { Checkout } from './checkout.js';
import type { PaymentStore } from './store.js';
import type { PaymentResult } from './types.js';

export interface SweepOptions {
  /** Max payments to reconcile per run (default: all pending). */
  limit?: number;
  /** Called per failed reconcile; if omitted, errors are swallowed so one failure doesn't stop the sweep. */
  onError?(paymentId: string, error: unknown): void;
}

export interface SweepSummary {
  reconciled: number;
  errors: number;
  results: PaymentResult[];
}

/**
 * Reconcile all pending payments — run from a cron/queue. SATIM has no webhooks
 * and auto-cancels unconfirmed orders, so a periodic sweep is how abandoned
 * payments reach a final state.
 */
export async function reconcilePending(
  checkout: Checkout,
  store: PaymentStore,
  options: SweepOptions = {},
): Promise<SweepSummary> {
  const pending = await store.listPending();
  const batch = options.limit !== undefined ? pending.slice(0, options.limit) : pending;
  const results: PaymentResult[] = [];
  let errors = 0;
  for (const payment of batch) {
    try {
      results.push(await checkout.reconcile(payment.id));
    } catch (error) {
      errors += 1;
      options.onError?.(payment.id, error);
    }
  }
  return { reconciled: results.length, errors, results };
}
