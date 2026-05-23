import type { PaymentStore } from '../store.js';
import type { Payment, PaymentStatus, RefundRecord, TransitionRecord } from '../types.js';

/** A row shaped like the recommended Prisma model (camelCase) — what the delegate returns/accepts. */
export interface PrismaPaymentRow {
  id: string;
  orderNumber: string;
  orderId: string | null;
  status: string;
  amountCentimes: bigint | number;
  refundedCentimes: bigint | number;
  currency: string;
  redirectUrl: string | null;
  expiresAt: Date | string | null;
  satimStatus: number | null;
  approvalCode: string | null;
  pan: string | null;
  actionCodeDescription: string | null;
  respCode: string | null;
  respCodeDesc: string | null;
  idempotencyKey: string;
  history: unknown;
  refunds: unknown;
  createdAt: Date | string;
  updatedAt: Date | string;
  metadata: unknown;
}

/**
 * Minimal structural shape of a Prisma model delegate (e.g. `prisma.tasdidPayment`).
 * tasdid takes no `@prisma/client` dependency — you pass your own delegate.
 */
export interface PrismaPaymentDelegate {
  create(args: { data: PrismaPaymentRow }): Promise<PrismaPaymentRow>;
  findUnique(args: { where: { id?: string; idempotencyKey?: string } }): Promise<PrismaPaymentRow | null>;
  findFirst(args: { where: { orderId?: string; orderNumber?: string } }): Promise<PrismaPaymentRow | null>;
  upsert(args: {
    where: { id: string };
    create: PrismaPaymentRow;
    update: PrismaPaymentRow;
  }): Promise<PrismaPaymentRow>;
  findMany(args: { where: { status: { in: string[] } } }): Promise<PrismaPaymentRow[]>;
}

/** The Prisma model to add to your schema for {@link createPrismaStore}. */
export function prismaSchema(model = 'TasdidPayment'): string {
  return `model ${model} {
  id               String    @id
  orderNumber      String
  orderId          String?
  status           String
  amountCentimes   BigInt
  refundedCentimes BigInt    @default(0)
  currency         String
  redirectUrl      String?
  expiresAt        DateTime?
  satimStatus      Int?
  approvalCode     String?
  pan              String?
  actionCodeDescription String?
  respCode         String?
  respCodeDesc     String?
  idempotencyKey   String    @unique
  history          Json      @default("[]")
  refunds          Json      @default("[]")
  createdAt        DateTime
  updatedAt        DateTime
  metadata         Json?

  @@index([orderId])
  @@index([status])
}`;
}

function toIso(value: Date | string | null): string | null {
  if (value == null) return null;
  return value instanceof Date ? value.toISOString() : value;
}

function fromRow(row: PrismaPaymentRow): Payment {
  return {
    id: row.id,
    orderNumber: row.orderNumber,
    orderId: row.orderId ?? null,
    status: row.status as PaymentStatus,
    amountCentimes: Number(row.amountCentimes),
    refundedCentimes: Number(row.refundedCentimes),
    currency: row.currency,
    redirectUrl: row.redirectUrl ?? null,
    expiresAt: toIso(row.expiresAt),
    satimStatus: row.satimStatus ?? null,
    approvalCode: row.approvalCode ?? null,
    pan: row.pan ?? null,
    actionCodeDescription: row.actionCodeDescription ?? null,
    respCode: row.respCode ?? null,
    respCodeDesc: row.respCodeDesc ?? null,
    idempotencyKey: row.idempotencyKey,
    history: (row.history as TransitionRecord[] | null) ?? [],
    refunds: (row.refunds as RefundRecord[] | null) ?? [],
    createdAt: toIso(row.createdAt) ?? new Date().toISOString(),
    updatedAt: toIso(row.updatedAt) ?? new Date().toISOString(),
    metadata: row.metadata == null ? undefined : (row.metadata as Record<string, unknown>),
  };
}

function toRow(p: Payment): PrismaPaymentRow {
  return {
    id: p.id,
    orderNumber: p.orderNumber,
    orderId: p.orderId,
    status: p.status,
    amountCentimes: BigInt(p.amountCentimes),
    refundedCentimes: BigInt(p.refundedCentimes),
    currency: p.currency,
    redirectUrl: p.redirectUrl,
    expiresAt: p.expiresAt,
    satimStatus: p.satimStatus,
    approvalCode: p.approvalCode,
    pan: p.pan,
    actionCodeDescription: p.actionCodeDescription,
    respCode: p.respCode,
    respCodeDesc: p.respCodeDesc,
    idempotencyKey: p.idempotencyKey,
    history: p.history,
    refunds: p.refunds,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    metadata: p.metadata ?? null,
  };
}

/**
 * A durable {@link PaymentStore} on Prisma. Pass your model delegate (e.g. `prisma.tasdidPayment`)
 * after adding {@link prismaSchema} to your schema. `claim` relies on the `idempotencyKey @unique`
 * constraint (a conflicting create raises Prisma's `P2002`).
 */
export function createPrismaStore(delegate: PrismaPaymentDelegate): PaymentStore {
  return {
    async claim(key, init) {
      const data = toRow({ ...init, idempotencyKey: key });
      try {
        const created = await delegate.create({ data });
        return { payment: fromRow(created), created: true };
      } catch (error) {
        if ((error as { code?: unknown }).code !== 'P2002') throw error;
        const existing = await delegate.findUnique({ where: { idempotencyKey: key } });
        if (!existing) throw error;
        return { payment: fromRow(existing), created: false };
      }
    },
    async load(id) {
      const row = await delegate.findUnique({ where: { id } });
      return row ? fromRow(row) : null;
    },
    async save(p) {
      const row = toRow(p);
      await delegate.upsert({ where: { id: p.id }, create: row, update: row });
    },
    async findByOrderId(orderId) {
      const row = await delegate.findFirst({ where: { orderId } });
      return row ? fromRow(row) : null;
    },
    async findByOrderNumber(orderNumber) {
      const row = await delegate.findFirst({ where: { orderNumber } });
      return row ? fromRow(row) : null;
    },
    async listPending() {
      const rows = await delegate.findMany({ where: { status: { in: ['pending', 'created'] } } });
      return rows.map(fromRow);
    },
  };
}
