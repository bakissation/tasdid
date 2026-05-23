import { describe, it, expect } from 'vitest';
import {
  createMemoryStore,
  createRedisStore,
  createPostgresStore,
  createPrismaStore,
  type RedisLike,
  type SqlClient,
  type PrismaPaymentDelegate,
  type PrismaPaymentRow,
  type PaymentStore,
  type Payment,
} from '../src/index.js';

function fakeRedis(): RedisLike {
  const kv = new Map<string, string>();
  const sets = new Map<string, Set<string>>();
  return {
    async get(k) {
      return kv.get(k) ?? null;
    },
    async set(k, v, mode) {
      if (mode === 'NX' && kv.has(k)) return null;
      kv.set(k, v);
      return 'OK';
    },
    async sadd(k, m) {
      const s = sets.get(k) ?? new Set<string>();
      s.add(m);
      sets.set(k, s);
      return 1;
    },
    async srem(k, m) {
      sets.get(k)?.delete(m);
      return 1;
    },
    async smembers(k) {
      return [...(sets.get(k) ?? [])];
    },
  };
}

const COLNAMES = [
  'id', 'order_number', 'order_id', 'status', 'amount_centimes', 'refunded_centimes', 'currency',
  'redirect_url', 'expires_at', 'satim_status', 'approval_code', 'pan', 'idempotency_key',
  'history', 'refunds', 'created_at', 'updated_at', 'metadata',
] as const;

function fakeSql(): SqlClient {
  const rows = new Map<string, Record<string, unknown>>();
  const toRow = (v: readonly unknown[]): Record<string, unknown> => {
    const r: Record<string, unknown> = {};
    COLNAMES.forEach((c, i) => {
      r[c] = v[i];
    });
    return r;
  };
  return {
    async query(text, values = []) {
      const v = values;
      if (text.startsWith('INSERT') && text.includes('ON CONFLICT (idempotency_key)')) {
        const row = toRow(v);
        if ([...rows.values()].some((r) => r.idempotency_key === row.idempotency_key)) return { rows: [] };
        rows.set(String(row.id), row);
        return { rows: [row] };
      }
      if (text.startsWith('INSERT') && text.includes('ON CONFLICT (id)')) {
        const row = toRow(v);
        rows.set(String(row.id), { ...rows.get(String(row.id)), ...row });
        return { rows: [] };
      }
      if (text.includes('WHERE idempotency_key =')) {
        const r = [...rows.values()].find((x) => x.idempotency_key === v[0]);
        return { rows: r ? [r] : [] };
      }
      if (text.includes('WHERE id =')) {
        const r = rows.get(String(v[0]));
        return { rows: r ? [r] : [] };
      }
      if (text.includes('WHERE order_id =')) {
        const r = [...rows.values()].find((x) => x.order_id === v[0]);
        return { rows: r ? [r] : [] };
      }
      if (text.includes('WHERE order_number =')) {
        const r = [...rows.values()].find((x) => x.order_number === v[0]);
        return { rows: r ? [r] : [] };
      }
      if (text.includes('status IN')) {
        return { rows: [...rows.values()].filter((x) => x.status === 'pending' || x.status === 'created') };
      }
      return { rows: [] };
    },
  };
}

function sample(over: Partial<Payment> = {}): Payment {
  return {
    id: 'p1', orderNumber: 'ORD1', orderId: null, status: 'created', amountCentimes: 500000,
    refundedCentimes: 0, currency: '012', redirectUrl: null, expiresAt: null, satimStatus: null,
    approvalCode: null, pan: null, idempotencyKey: 'k1', history: [], refunds: [],
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', ...over,
  };
}

function fakePrisma(): PrismaPaymentDelegate {
  const rows = new Map<string, PrismaPaymentRow>();
  const byKey = (k: string): PrismaPaymentRow | undefined =>
    [...rows.values()].find((r) => r.idempotencyKey === k);
  return {
    async create({ data }) {
      if (byKey(data.idempotencyKey)) {
        const e = new Error('unique constraint') as Error & { code?: string };
        e.code = 'P2002';
        throw e;
      }
      rows.set(data.id, data);
      return data;
    },
    async findUnique({ where }) {
      if (where.id !== undefined) return rows.get(where.id) ?? null;
      if (where.idempotencyKey !== undefined) return byKey(where.idempotencyKey) ?? null;
      return null;
    },
    async findFirst({ where }) {
      return (
        [...rows.values()].find(
          (r) =>
            (where.orderId !== undefined && r.orderId === where.orderId) ||
            (where.orderNumber !== undefined && r.orderNumber === where.orderNumber),
        ) ?? null
      );
    },
    async upsert({ where, create, update }) {
      const existing = rows.get(where.id);
      const row = existing ? { ...existing, ...update } : create;
      rows.set(where.id, row);
      return row;
    },
    async findMany({ where }) {
      return [...rows.values()].filter((r) => where.status.in.includes(r.status));
    },
  };
}

function contract(name: string, make: () => PaymentStore): void {
  describe(`PaymentStore contract: ${name}`, () => {
    it('claim creates, then returns the existing payment for the same key', async () => {
      const s = make();
      const a = await s.claim('k1', sample());
      expect(a.created).toBe(true);
      const b = await s.claim('k1', sample({ id: 'p2' }));
      expect(b.created).toBe(false);
      expect(b.payment.id).toBe('p1');
    });
    it('save + load + finders + listPending track status', async () => {
      const s = make();
      await s.claim('k1', sample());
      await s.save(sample({ status: 'pending', orderId: 'MD1' }));
      expect((await s.load('p1'))?.status).toBe('pending');
      expect((await s.findByOrderId('MD1'))?.id).toBe('p1');
      expect((await s.findByOrderNumber('ORD1'))?.id).toBe('p1');
      expect((await s.listPending()).length).toBe(1);
      await s.save(sample({ status: 'paid', orderId: 'MD1' }));
      expect((await s.listPending()).length).toBe(0);
      expect(await s.load('missing')).toBeNull();
    });
  });
}

contract('memory', createMemoryStore);
contract('redis', () => createRedisStore(fakeRedis()));
contract('postgres', () => createPostgresStore(fakeSql()));
contract('prisma', () => createPrismaStore(fakePrisma()));
