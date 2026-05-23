import { randomUUID } from 'node:crypto';
import { Dinar } from '@bakissation/dinar';
import type { SatimClient } from '@bakissation/satim';
import { TasdidError } from './errors.js';
import { assertTransition } from './state.js';
import { mapSatimStatus } from './status.js';
import type { PaymentStore } from './store.js';
import type {
  Payment,
  PaymentResult,
  PaymentStatus,
  ReturnParams,
  SatimLanguage,
  StartOrder,
  TransitionRecord,
} from './types.js';

/** SATIM auto-cancels an unconfirmed order after 20 minutes. */
const DEFAULT_EXPIRY_MINUTES = 20;

/** Lifecycle hooks fired when a payment reaches a new terminal-ish state. */
export interface CheckoutEvents {
  onPaid?(result: PaymentResult): void | Promise<void>;
  onFailed?(result: PaymentResult): void | Promise<void>;
  onRefunded?(result: PaymentResult): void | Promise<void>;
  onExpired?(result: PaymentResult): void | Promise<void>;
}

export interface CheckoutOptions extends CheckoutEvents {
  /** The merchant's own configured SATIM client (direct model). */
  satim: SatimClient;
  /** Persistence for payments. */
  store: PaymentStore;
  /** Default gateway language (default `fr`). */
  language?: SatimLanguage;
  /** Default expiry window in minutes (default 20 — SATIM's auto-cancel window). */
  expiresInMinutes?: number;
  /** Override the payment-id generator (default `crypto.randomUUID`). */
  generateId?: () => string;
}

export interface StartResult {
  paymentId: string;
  /** SATIM hosted payment page to redirect the buyer to (independent browser context). */
  redirectUrl: string;
  result: PaymentResult;
}

export interface RefundOptions {
  /** Idempotency key — refunding again with the same key is a no-op (returns the current state). */
  idempotencyKey?: string;
}

export interface Checkout {
  start(order: StartOrder): Promise<StartResult>;
  handleReturn(params: ReturnParams): Promise<PaymentResult>;
  reconcile(paymentId: string): Promise<PaymentResult>;
  refund(paymentId: string, amount?: Dinar, options?: RefundOptions): Promise<PaymentResult>;
  /** Read a payment's current state without contacting the gateway (no side effects). */
  get(paymentId: string): Promise<PaymentResult | null>;
}

function toResult(p: Payment): PaymentResult {
  return {
    id: p.id,
    orderNumber: p.orderNumber,
    orderId: p.orderId,
    status: p.status,
    amount: Dinar.fromCentimes(p.amountCentimes),
    refundedAmount: Dinar.fromCentimes(p.refundedCentimes),
    redirectUrl: p.redirectUrl,
    paid: p.status === 'paid',
    expiresAt: p.expiresAt,
    history: p.history,
    refunds: p.refunds,
    satim: { orderStatus: p.satimStatus, approvalCode: p.approvalCode, pan: p.pan },
  };
}

/** Create a headless SATIM checkout bound to a merchant's SATIM client + a payment store. */
export function createCheckout(options: CheckoutOptions): Checkout {
  const {
    satim,
    store,
    language = 'fr',
    expiresInMinutes = DEFAULT_EXPIRY_MINUTES,
    generateId = randomUUID,
  } = options;

  async function fireEvent(prev: PaymentStatus, next: PaymentStatus, result: PaymentResult): Promise<void> {
    if (prev === next) return;
    if (next === 'paid') await options.onPaid?.(result);
    else if (next === 'failed') await options.onFailed?.(result);
    else if (next === 'expired') await options.onExpired?.(result);
    else if (next === 'refunded' || next === 'partially_refunded') await options.onRefunded?.(result);
  }

  async function transition(p: Payment, next: PaymentStatus, satimStatus?: number | null): Promise<void> {
    assertTransition(p.status, next);
    const prev = p.status;
    const record: TransitionRecord = { from: prev, to: next, at: new Date().toISOString() };
    if (satimStatus !== undefined) record.satimStatus = satimStatus;
    p.history.push(record);
    p.status = next;
    p.updatedAt = record.at;
    await store.save(p);
    await fireEvent(prev, next, toResult(p));
  }

  async function start(order: StartOrder): Promise<StartResult> {
    if (!order.orderNumber) throw new TasdidError('orderNumber is required', 'INVALID_INPUT');
    const key = order.idempotencyKey ?? order.orderNumber;
    const now = new Date().toISOString();
    const init: Payment = {
      id: generateId(),
      orderNumber: order.orderNumber,
      orderId: null,
      status: 'created',
      amountCentimes: order.amount.toCentimes(),
      refundedCentimes: 0,
      currency: '012',
      redirectUrl: null,
      expiresAt: null,
      satimStatus: null,
      approvalCode: null,
      pan: null,
      idempotencyKey: key,
      history: [],
      refunds: [],
      createdAt: now,
      updatedAt: now,
      metadata: order.metadata,
    };
    const { payment, created } = await store.claim(key, init);

    // Idempotent: a prior start already registered this order → never double-register.
    if (!created && payment.orderId && payment.redirectUrl) {
      return { paymentId: payment.id, redirectUrl: payment.redirectUrl, result: toResult(payment) };
    }

    const res = await satim.register({
      orderNumber: payment.orderNumber,
      amount: order.amount,
      returnUrl: order.returnUrl,
      failUrl: order.failUrl,
      description: order.description,
      language: order.language ?? language,
      udf1: order.udf1 ?? payment.orderNumber,
    });

    if (!res.isSuccessful() || !res.orderId || !res.formUrl) {
      await transition(payment, 'failed');
      throw new TasdidError(`SATIM register failed (errorCode ${res.errorCode})`, 'REGISTER_FAILED', res.errorCode);
    }

    const minutes = order.expiresInMinutes ?? expiresInMinutes;
    payment.orderId = res.orderId;
    payment.redirectUrl = res.formUrl;
    payment.expiresAt = new Date(Date.now() + minutes * 60_000).toISOString();
    await transition(payment, 'pending');
    return { paymentId: payment.id, redirectUrl: res.formUrl, result: toResult(payment) };
  }

  function isExpired(p: Payment): boolean {
    return p.expiresAt !== null && Date.now() > Date.parse(p.expiresAt);
  }

  async function reconcile(paymentId: string): Promise<PaymentResult> {
    const payment = await store.load(paymentId);
    if (!payment) throw new TasdidError(`Payment not found: ${paymentId}`, 'NOT_FOUND');
    if (payment.status !== 'pending' || !payment.orderId) return toResult(payment);

    const res = await satim.getOrderStatus(payment.orderId, language);

    // Unregistered order id (errorCode 6) ⇒ gateway auto-cancelled the unconfirmed order ⇒ expired.
    if (res.errorCode === 6) {
      await transition(payment, 'expired', res.orderStatus);
      return toResult(payment);
    }

    payment.satimStatus = res.orderStatus;
    if (res.approvalCode) payment.approvalCode = res.approvalCode;
    if (res.pan) payment.pan = res.pan;

    const next = mapSatimStatus(res.orderStatus);
    if (next === 'paid' || next === 'failed') {
      await transition(payment, next, res.orderStatus);
    } else if (isExpired(payment)) {
      // still not paid and the 20-minute window has passed ⇒ SATIM has cancelled it.
      await transition(payment, 'expired', res.orderStatus);
    } else {
      payment.updatedAt = new Date().toISOString();
      await store.save(payment);
    }
    return toResult(payment);
  }

  async function handleReturn(params: ReturnParams): Promise<PaymentResult> {
    let payment: Payment | null = null;
    if (params.paymentId) payment = await store.load(params.paymentId);
    else if (params.orderId) payment = await store.findByOrderId(params.orderId);
    if (!payment) throw new TasdidError('Return could not be matched to a payment', 'NOT_FOUND');
    // Never trust the redirect params — confirm against the gateway.
    return reconcile(payment.id);
  }

  async function refund(paymentId: string, amount?: Dinar, refundOptions: RefundOptions = {}): Promise<PaymentResult> {
    const payment = await store.load(paymentId);
    if (!payment) throw new TasdidError(`Payment not found: ${paymentId}`, 'NOT_FOUND');

    // Idempotent: a refund already applied under this key is a no-op.
    const key = refundOptions.idempotencyKey;
    if (key !== undefined && payment.refunds.some((r) => r.idempotencyKey === key)) {
      return toResult(payment);
    }

    if (payment.status !== 'paid' && payment.status !== 'partially_refunded') {
      throw new TasdidError(`Payment ${paymentId} is not refundable (status: ${payment.status})`, 'NOT_REFUNDABLE');
    }
    if (!payment.orderId) throw new TasdidError('Payment has no gateway order id', 'NOT_REFUNDABLE');

    const remaining = payment.amountCentimes - payment.refundedCentimes;
    const amountCentimes = amount ? amount.toCentimes() : remaining;
    if (amountCentimes <= 0 || amountCentimes > remaining) {
      throw new TasdidError('Refund amount exceeds the refundable balance', 'REFUND_EXCEEDS_DEPOSIT');
    }

    const res = await satim.refund(payment.orderId, Dinar.fromCentimes(amountCentimes), language);
    if (!res.isSuccessful()) {
      throw new TasdidError(`SATIM refund failed (errorCode ${res.errorCode})`, 'REFUND_FAILED', res.errorCode);
    }

    payment.refundedCentimes += amountCentimes;
    payment.refunds.push({ idempotencyKey: key ?? null, amountCentimes, at: new Date().toISOString() });
    const fullyRefunded = payment.refundedCentimes >= payment.amountCentimes;
    await transition(payment, fullyRefunded ? 'refunded' : 'partially_refunded');
    return toResult(payment);
  }

  async function get(paymentId: string): Promise<PaymentResult | null> {
    const payment = await store.load(paymentId);
    return payment ? toResult(payment) : null;
  }

  return { start, handleReturn, reconcile, refund, get };
}
