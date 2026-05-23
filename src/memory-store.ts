import type { PaymentStore } from './store.js';
import type { Payment } from './types.js';

function clone(payment: Payment): Payment {
  return {
    ...payment,
    history: payment.history.map((h) => ({ ...h })),
    refunds: payment.refunds.map((r) => ({ ...r })),
    metadata: payment.metadata ? { ...payment.metadata } : undefined,
  };
}

/**
 * In-memory {@link PaymentStore} for development and tests. Not durable — do not
 * use in production (state is lost on restart and not shared across processes).
 */
export function createMemoryStore(): PaymentStore {
  const byId = new Map<string, Payment>();
  const idByKey = new Map<string, string>();

  return {
    async claim(key, init) {
      const existingId = idByKey.get(key);
      if (existingId !== undefined) {
        const existing = byId.get(existingId);
        if (existing) return { payment: clone(existing), created: false };
      }
      const stored = clone(init);
      byId.set(stored.id, stored);
      idByKey.set(key, stored.id);
      return { payment: clone(stored), created: true };
    },
    async load(id) {
      const found = byId.get(id);
      return found ? clone(found) : null;
    },
    async save(payment) {
      byId.set(payment.id, clone(payment));
      idByKey.set(payment.idempotencyKey, payment.id);
    },
    async findByOrderId(orderId) {
      for (const p of byId.values()) {
        if (p.orderId === orderId) return clone(p);
      }
      return null;
    },
    async findByOrderNumber(orderNumber) {
      for (const p of byId.values()) {
        if (p.orderNumber === orderNumber) return clone(p);
      }
      return null;
    },
    async listPending() {
      const out: Payment[] = [];
      for (const p of byId.values()) {
        if (p.status === 'pending' || p.status === 'created') out.push(clone(p));
      }
      return out;
    },
  };
}
