import type { PaymentStore } from '../store.js';
import type { Payment } from '../types.js';

/**
 * Minimal structural shape of a Redis client (ioredis-compatible). tasdid takes
 * no `ioredis`/`redis` dependency — pass your own client. `set(key, value, 'NX')`
 * must return `null` when the key already exists (ioredis semantics).
 */
export interface RedisLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode?: 'NX'): Promise<string | null>;
  sadd(key: string, member: string): Promise<unknown>;
  srem(key: string, member: string): Promise<unknown>;
  smembers(key: string): Promise<string[]>;
}

export interface RedisStoreOptions {
  /** Key prefix (default `tasdid`). */
  prefix?: string;
}

/** A {@link PaymentStore} on Redis. Indexes by idempotency key, order id, order number, and a pending set. */
export function createRedisStore(redis: RedisLike, options: RedisStoreOptions = {}): PaymentStore {
  const prefix = options.prefix ?? 'tasdid';
  const paymentKey = (id: string): string => `${prefix}:payment:${id}`;
  const idemKey = (key: string): string => `${prefix}:key:${key}`;
  const orderKey = (orderId: string): string => `${prefix}:order:${orderId}`;
  const numberKey = (n: string): string => `${prefix}:ordno:${n}`;
  const pendingSet = `${prefix}:pending`;

  async function loadById(id: string): Promise<Payment | null> {
    const raw = await redis.get(paymentKey(id));
    return raw ? (JSON.parse(raw) as Payment) : null;
  }

  async function persist(p: Payment): Promise<void> {
    await redis.set(paymentKey(p.id), JSON.stringify(p));
    await redis.set(idemKey(p.idempotencyKey), p.id);
    await redis.set(numberKey(p.orderNumber), p.id);
    if (p.orderId) await redis.set(orderKey(p.orderId), p.id);
    if (p.status === 'pending' || p.status === 'created') await redis.sadd(pendingSet, p.id);
    else await redis.srem(pendingSet, p.id);
  }

  return {
    async claim(key, init) {
      const locked = await redis.set(idemKey(key), init.id, 'NX');
      if (locked === null) {
        const existingId = await redis.get(idemKey(key));
        const existing = existingId ? await loadById(existingId) : null;
        if (existing) return { payment: existing, created: false };
      }
      const stored: Payment = { ...init, idempotencyKey: key };
      await persist(stored);
      return { payment: stored, created: true };
    },
    load: loadById,
    save: persist,
    async findByOrderId(orderId) {
      const id = await redis.get(orderKey(orderId));
      return id ? loadById(id) : null;
    },
    async findByOrderNumber(orderNumber) {
      const id = await redis.get(numberKey(orderNumber));
      return id ? loadById(id) : null;
    },
    async listPending() {
      const ids = await redis.smembers(pendingSet);
      const out: Payment[] = [];
      for (const id of ids) {
        const p = await loadById(id);
        if (p) out.push(p);
      }
      return out;
    },
  };
}
