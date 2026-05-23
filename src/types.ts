import type { Dinar } from '@bakissation/dinar';

/** Lifecycle state of a payment. Terminal: `failed`, `expired`, `refunded`. */
export type PaymentStatus =
  | 'created'
  | 'pending'
  | 'paid'
  | 'failed'
  | 'expired'
  | 'refunded'
  | 'partially_refunded';

export type SatimLanguage = 'fr' | 'en' | 'ar';

/** One entry in a payment's audit trail. */
export interface TransitionRecord {
  from: PaymentStatus;
  to: PaymentStatus;
  /** ISO timestamp of the transition. */
  at: string;
  /** SATIM `OrderStatus` observed when the transition was driven by reconciliation. */
  satimStatus?: number | null;
}

/** One applied refund — recorded for idempotency and audit. */
export interface RefundRecord {
  /** The caller's idempotency key for this refund, if one was supplied. */
  idempotencyKey: string | null;
  amountCentimes: number;
  at: string;
}

/** The persisted payment record. Money is stored as integer centimes for portable storage. */
export interface Payment {
  /** tasdid payment id (opaque, unique). */
  id: string;
  /** Merchant-side order number (unique per transaction; the idempotency anchor). */
  orderNumber: string;
  /** SATIM gateway order id (`mdOrder`), once registered. */
  orderId: string | null;
  status: PaymentStatus;
  /** Order amount in centimes. */
  amountCentimes: number;
  /** Amount refunded so far, in centimes. */
  refundedCentimes: number;
  currency: string;
  redirectUrl: string | null;
  /** When the SATIM order auto-cancels (default 20 min after register); past this a pending payment is `expired`. */
  expiresAt: string | null;
  /** Last SATIM `OrderStatus` seen on reconcile. */
  satimStatus: number | null;
  approvalCode: string | null;
  pan: string | null;
  idempotencyKey: string;
  /** Append-only audit trail of state transitions. */
  history: TransitionRecord[];
  /** Applied refunds (idempotency + audit). */
  refunds: RefundRecord[];
  createdAt: string;
  updatedAt: string;
  metadata?: Record<string, unknown>;
}

/** Input to {@link Checkout.start}. */
export interface StartOrder {
  /** Unique merchant order number (≤ 10 chars per SATIM). */
  orderNumber: string;
  /** Amount in DZD (minimum 50 DZD). */
  amount: Dinar;
  /** Where SATIM redirects after a successful payment. */
  returnUrl: string;
  /** Where SATIM redirects after a failed payment. */
  failUrl?: string;
  description?: string;
  language?: SatimLanguage;
  /** Merchant-useful value sent to SATIM (defaults to `orderNumber`). */
  udf1?: string;
  /** Idempotency key (defaults to `orderNumber`). Retries with the same key never double-register. */
  idempotencyKey?: string;
  /** Override the expiry window for this payment (minutes; default from the checkout, 20). */
  expiresInMinutes?: number;
  metadata?: Record<string, unknown>;
}

/** Public result returned by every lifecycle method. Money is exposed as `Dinar`. */
export interface PaymentResult {
  id: string;
  orderNumber: string;
  orderId: string | null;
  status: PaymentStatus;
  amount: Dinar;
  refundedAmount: Dinar;
  redirectUrl: string | null;
  /** Convenience: `status === 'paid'`. */
  paid: boolean;
  expiresAt: string | null;
  history: TransitionRecord[];
  refunds: RefundRecord[];
  satim: {
    orderStatus: number | null;
    approvalCode: string | null;
    pan: string | null;
  };
}

/** Parameters parsed from SATIM's return redirect. One of `orderId`/`paymentId` must be present. */
export interface ReturnParams {
  orderId?: string;
  paymentId?: string;
}
