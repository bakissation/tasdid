import type { Payment } from './types.js';

/**
 * Persistence contract for payments. Implementations must make {@link PaymentStore.claim}
 * atomic (e.g. `INSERT ... ON CONFLICT DO NOTHING`) so concurrent double-submits
 * with the same idempotency key collapse to one payment.
 *
 * Bring your own: an in-memory store ships with tasdid; Prisma/Postgres/Redis are
 * separate adapters or your own implementation of this interface.
 */
export interface PaymentStore {
  /**
   * Atomically get-or-create a payment by idempotency key.
   * @returns the existing payment (`created: false`) or the newly stored one (`created: true`).
   */
  claim(key: string, init: Payment): Promise<{ payment: Payment; created: boolean }>;
  load(id: string): Promise<Payment | null>;
  save(payment: Payment): Promise<void>;
  findByOrderId(orderId: string): Promise<Payment | null>;
  findByOrderNumber(orderNumber: string): Promise<Payment | null>;
  /** Payments still awaiting a final result — for reconciliation sweeps. */
  listPending(): Promise<Payment[]>;
}
