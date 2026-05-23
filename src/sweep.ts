import type { Checkout } from './checkout.js';
import type { PaymentStore } from './store.js';
import type { PaymentResult, PaymentStatus } from './types.js';

export interface SweepOptions {
  /** Max payments to reconcile per run (default: all pending). */
  limit?: number;
  /** Called per failed reconcile; if omitted, errors are swallowed so one failure doesn't stop the sweep. */
  onError?(paymentId: string, error: unknown): void;
}

/** A payment whose reconcile threw — the ops alarm list (gateway down, etc.). */
export interface SweepFailure {
  paymentId: string;
  error: unknown;
}

/**
 * Report of a reconciliation sweep. The `results`/`reconciled`/`errors` fields are
 * the raw outcome; the per-status counts + `failures` are the operational summary
 * (a no-webhook gateway makes this the only window into "did everything settle?").
 */
export interface SweepSummary {
  /** Reconcile calls that returned without throwing (= `results.length`). */
  reconciled: number;
  /** Reconcile calls that threw (= `failures.length`). */
  errors: number;
  /** The reconciled payments (successful calls only). */
  results: PaymentResult[];
  paid: number;
  failed: number;
  expired: number;
  refunded: number;
  /** Reconciled but still awaiting the buyer — re-swept next run. */
  stillPending: number;
  /** Per-payment failures, with detail — these need a human. */
  failures: SweepFailure[];
}

/**
 * Reconcile all pending payments — run from a cron/queue. SATIM has no webhooks
 * and auto-cancels unconfirmed orders, so a periodic sweep is how abandoned
 * payments reach a final state. The returned {@link SweepSummary} classifies the
 * outcome so you can alert on `failures` (and watch `stillPending`).
 */
export async function reconcilePending(
  checkout: Checkout,
  store: PaymentStore,
  options: SweepOptions = {},
): Promise<SweepSummary> {
  const pending = await store.listPending();
  const batch = options.limit !== undefined ? pending.slice(0, options.limit) : pending;
  const results: PaymentResult[] = [];
  const failures: SweepFailure[] = [];
  for (const payment of batch) {
    try {
      results.push(await checkout.reconcile(payment.id));
    } catch (error) {
      options.onError?.(payment.id, error);
      failures.push({ paymentId: payment.id, error });
    }
  }
  const count = (s: PaymentStatus): number => results.filter((r) => r.status === s).length;
  return {
    reconciled: results.length,
    errors: failures.length,
    results,
    paid: count('paid'),
    failed: count('failed'),
    expired: count('expired'),
    refunded: count('refunded'),
    stillPending: count('pending'),
    failures,
  };
}
