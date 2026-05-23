import type { PaymentStore } from '../store.js';
import type { Payment, PaymentStatus, RefundRecord, TransitionRecord } from '../types.js';

/**
 * Minimal structural shape of a SQL client. A `node-postgres` `Pool`/`Client`
 * satisfies it directly — so tasdid takes no `pg` dependency; you pass your own.
 */
export interface SqlClient {
  query(text: string, values?: readonly unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}

export interface PostgresStoreOptions {
  /** Table name (default `tasdid_payments`). */
  table?: string;
}

/** DDL for the payments table. Run once (or via your migrations) before using the store. */
export function postgresDDL(table = 'tasdid_payments'): string {
  return `CREATE TABLE IF NOT EXISTS ${table} (
  id text PRIMARY KEY,
  order_number text NOT NULL,
  order_id text,
  status text NOT NULL,
  amount_centimes bigint NOT NULL,
  refunded_centimes bigint NOT NULL DEFAULT 0,
  currency text NOT NULL,
  redirect_url text,
  expires_at timestamptz,
  satim_status integer,
  approval_code text,
  pan text,
  idempotency_key text NOT NULL UNIQUE,
  history jsonb NOT NULL DEFAULT '[]',
  refunds jsonb NOT NULL DEFAULT '[]',
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  metadata jsonb,
  action_code_description text,
  resp_code text,
  resp_code_desc text
);
CREATE INDEX IF NOT EXISTS ${table}_order_id_idx ON ${table} (order_id);
CREATE INDEX IF NOT EXISTS ${table}_status_idx ON ${table} (status);`;
}

const COLS =
  'id, order_number, order_id, status, amount_centimes, refunded_centimes, currency, redirect_url, expires_at, satim_status, approval_code, pan, idempotency_key, history, refunds, created_at, updated_at, metadata, action_code_description, resp_code, resp_code_desc';
const PLACEHOLDERS = '$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21';

function asJson<T>(value: unknown, fallback: T): T {
  if (value == null) return fallback;
  return typeof value === 'string' ? (JSON.parse(value) as T) : (value as T);
}

function asIso(value: unknown): string | null {
  if (value == null) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

function rowToPayment(row: Record<string, unknown>): Payment {
  const meta = row.metadata;
  return {
    id: String(row.id),
    orderNumber: String(row.order_number),
    orderId: (row.order_id as string | null) ?? null,
    status: String(row.status) as PaymentStatus,
    amountCentimes: Number(row.amount_centimes),
    refundedCentimes: Number(row.refunded_centimes),
    currency: String(row.currency),
    redirectUrl: (row.redirect_url as string | null) ?? null,
    expiresAt: asIso(row.expires_at),
    satimStatus: row.satim_status == null ? null : Number(row.satim_status),
    approvalCode: (row.approval_code as string | null) ?? null,
    pan: (row.pan as string | null) ?? null,
    actionCodeDescription: (row.action_code_description as string | null) ?? null,
    respCode: (row.resp_code as string | null) ?? null,
    respCodeDesc: (row.resp_code_desc as string | null) ?? null,
    idempotencyKey: String(row.idempotency_key),
    history: asJson<TransitionRecord[]>(row.history, []),
    refunds: asJson<RefundRecord[]>(row.refunds, []),
    createdAt: asIso(row.created_at) ?? new Date().toISOString(),
    updatedAt: asIso(row.updated_at) ?? new Date().toISOString(),
    metadata: meta == null ? undefined : asJson<Record<string, unknown>>(meta, {}),
  };
}

function paymentValues(p: Payment): readonly unknown[] {
  return [
    p.id, p.orderNumber, p.orderId, p.status, p.amountCentimes, p.refundedCentimes, p.currency,
    p.redirectUrl, p.expiresAt, p.satimStatus, p.approvalCode, p.pan, p.idempotencyKey,
    JSON.stringify(p.history), JSON.stringify(p.refunds), p.createdAt, p.updatedAt,
    p.metadata == null ? null : JSON.stringify(p.metadata),
    p.actionCodeDescription, p.respCode, p.respCodeDesc,
  ];
}

/** A durable {@link PaymentStore} on PostgreSQL. Create the table via {@link postgresDDL} first. */
export function createPostgresStore(db: SqlClient, options: PostgresStoreOptions = {}): PaymentStore {
  const table = options.table ?? 'tasdid_payments';
  return {
    async claim(key, init) {
      const row = { ...init, idempotencyKey: key };
      const ins = await db.query(
        `INSERT INTO ${table} (${COLS}) VALUES (${PLACEHOLDERS}) ON CONFLICT (idempotency_key) DO NOTHING RETURNING ${COLS}`,
        paymentValues(row),
      );
      const inserted = ins.rows[0];
      if (inserted) return { payment: rowToPayment(inserted), created: true };
      const sel = await db.query(`SELECT ${COLS} FROM ${table} WHERE idempotency_key = $1`, [key]);
      const existing = sel.rows[0];
      if (!existing) throw new Error('tasdid: claim conflicted but no existing row found');
      return { payment: rowToPayment(existing), created: false };
    },
    async load(id) {
      const r = await db.query(`SELECT ${COLS} FROM ${table} WHERE id = $1`, [id]);
      const row = r.rows[0];
      return row ? rowToPayment(row) : null;
    },
    async save(p) {
      await db.query(
        `INSERT INTO ${table} (${COLS}) VALUES (${PLACEHOLDERS})
         ON CONFLICT (id) DO UPDATE SET
           order_id = $3, status = $4, amount_centimes = $5, refunded_centimes = $6, currency = $7,
           redirect_url = $8, expires_at = $9, satim_status = $10, approval_code = $11, pan = $12,
           history = $14, refunds = $15, updated_at = $17, metadata = $18,
           action_code_description = $19, resp_code = $20, resp_code_desc = $21`,
        paymentValues(p),
      );
    },
    async findByOrderId(orderId) {
      const r = await db.query(`SELECT ${COLS} FROM ${table} WHERE order_id = $1 LIMIT 1`, [orderId]);
      const row = r.rows[0];
      return row ? rowToPayment(row) : null;
    },
    async findByOrderNumber(orderNumber) {
      const r = await db.query(`SELECT ${COLS} FROM ${table} WHERE order_number = $1 LIMIT 1`, [orderNumber]);
      const row = r.rows[0];
      return row ? rowToPayment(row) : null;
    },
    async listPending() {
      const r = await db.query(`SELECT ${COLS} FROM ${table} WHERE status IN ('pending','created')`);
      return r.rows.map(rowToPayment);
    },
  };
}
