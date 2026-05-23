import { describe, it, expect, vi } from 'vitest';
import { Dinar } from '@bakissation/dinar';
import type { SatimClient } from '@bakissation/satim';
import {
  createCheckout,
  createMemoryStore,
  reconcilePending,
  TasdidError,
  canTransition,
  isTerminal,
  mapSatimStatus,
  failureReason,
} from '../src/index.js';

const da = (n: number): Dinar => Dinar.fromDinars(n);

const registerOk = (orderId = 'MD123', formUrl = 'https://test.satim.dz/pay?mdOrder=MD123') =>
  ({ raw: {}, errorCode: 0, orderId, formUrl, isSuccessful: () => true });
const registerFail = (errorCode = 5) =>
  ({ raw: {}, errorCode, orderId: null, formUrl: null, isSuccessful: () => false });
const statusResp = (orderStatus: number | null, errorCode = 0) => ({
  raw: {},
  errorCode,
  orderStatus,
  amount: 500000,
  depositAmount: orderStatus === 2 ? 500000 : null,
  pan: orderStatus === 2 ? '6280****7215' : null,
  approvalCode: orderStatus === 2 ? '913180' : null,
  actionCodeDescription: orderStatus === 2 ? 'Paiement accepté' : 'Votre carte est bloquée',
  params:
    orderStatus === 2
      ? { respCode: '00', respCode_desc: 'Paiement accepté' }
      : { respCode: '116', respCode_desc: 'Solde insuffisant' },
  isSuccessful: () => errorCode === 0,
  isPaid: () => orderStatus === 2,
});
const refundResp = (errorCode = 0) =>
  ({ raw: {}, errorCode, errorMessage: errorCode === 0 ? null : 'err', isSuccessful: () => errorCode === 0 });

function makeSatim(over: Partial<SatimClient> = {}): SatimClient {
  return {
    register: vi.fn(async () => registerOk()),
    confirm: vi.fn(async () => statusResp(2)),
    getOrderStatus: vi.fn(async () => statusResp(2)),
    refund: vi.fn(async () => refundResp(0)),
    ...over,
  } as unknown as SatimClient;
}

const order = (orderNumber = 'ORD1') => ({
  orderNumber,
  amount: da(5000),
  returnUrl: 'https://shop.dz/return',
});

describe('start', () => {
  it('registers and moves to pending with a redirect URL', async () => {
    const satim = makeSatim();
    const checkout = createCheckout({ satim, store: createMemoryStore() });
    const r = await checkout.start(order());
    expect(r.redirectUrl).toContain('satim.dz');
    expect(r.result.status).toBe('pending');
    expect(r.result.orderId).toBe('MD123');
    expect(r.result.amount.toDinars()).toBe(5000);
    expect(satim.register).toHaveBeenCalledTimes(1);
  });

  it('is idempotent — same orderNumber never double-registers', async () => {
    const satim = makeSatim();
    const checkout = createCheckout({ satim, store: createMemoryStore() });
    const a = await checkout.start(order('ORD1'));
    const b = await checkout.start(order('ORD1'));
    expect(b.paymentId).toBe(a.paymentId);
    expect(satim.register).toHaveBeenCalledTimes(1);
  });

  it('marks failed and throws when register fails', async () => {
    const satim = makeSatim({ register: vi.fn(async () => registerFail(5)) as never });
    const store = createMemoryStore();
    const checkout = createCheckout({ satim, store });
    await expect(checkout.start(order())).rejects.toMatchObject({ code: 'REGISTER_FAILED', satimErrorCode: 5 });
    const p = await store.findByOrderNumber('ORD1');
    expect(p?.status).toBe('failed');
  });
});

describe('reconcile / handleReturn', () => {
  it('pending → paid on OrderStatus 2 and fires onPaid', async () => {
    const onPaid = vi.fn();
    const satim = makeSatim({ getOrderStatus: vi.fn(async () => statusResp(2)) as never });
    const checkout = createCheckout({ satim, store: createMemoryStore(), onPaid });
    const { paymentId } = await checkout.start(order());
    const r = await checkout.reconcile(paymentId);
    expect(r.status).toBe('paid');
    expect(r.paid).toBe(true);
    expect(r.satim.approvalCode).toBe('913180');
    expect(r.satim.pan).toBe('6280****7215');
    expect(onPaid).toHaveBeenCalledTimes(1);
  });

  it('pending → failed on OrderStatus 6', async () => {
    const onFailed = vi.fn();
    const satim = makeSatim({ getOrderStatus: vi.fn(async () => statusResp(6)) as never });
    const checkout = createCheckout({ satim, store: createMemoryStore(), onFailed });
    const { paymentId } = await checkout.start(order());
    const r = await checkout.reconcile(paymentId);
    expect(r.status).toBe('failed');
    expect(onFailed).toHaveBeenCalledTimes(1);
  });

  it('captures the SATIM result reason (respCode_desc → respCodeDesc, actionCodeDescription)', async () => {
    const satim = makeSatim({ getOrderStatus: vi.fn(async () => statusResp(6)) as never });
    const checkout = createCheckout({ satim, store: createMemoryStore() });
    const { paymentId } = await checkout.start(order());
    const r = await checkout.reconcile(paymentId);
    expect(r.status).toBe('failed');
    expect(r.satim.respCode).toBe('116');
    expect(r.satim.respCodeDesc).toBe('Solde insuffisant');
    expect(r.satim.actionCodeDescription).toBe('Votre carte est bloquée');
  });

  it('pending → expired when the gateway no longer knows the order (errorCode 6)', async () => {
    const onExpired = vi.fn();
    const satim = makeSatim({ getOrderStatus: vi.fn(async () => statusResp(null, 6)) as never });
    const checkout = createCheckout({ satim, store: createMemoryStore(), onExpired });
    const { paymentId } = await checkout.start(order());
    const r = await checkout.reconcile(paymentId);
    expect(r.status).toBe('expired');
    expect(onExpired).toHaveBeenCalledTimes(1);
  });

  it('stays pending on OrderStatus 0', async () => {
    const satim = makeSatim({ getOrderStatus: vi.fn(async () => statusResp(0)) as never });
    const checkout = createCheckout({ satim, store: createMemoryStore() });
    const { paymentId } = await checkout.start(order());
    expect((await checkout.reconcile(paymentId)).status).toBe('pending');
  });

  it('handleReturn matches by orderId and reconciles (never trusts the redirect)', async () => {
    const satim = makeSatim({ getOrderStatus: vi.fn(async () => statusResp(2)) as never });
    const checkout = createCheckout({ satim, store: createMemoryStore() });
    await checkout.start(order());
    const r = await checkout.handleReturn({ orderId: 'MD123' });
    expect(r.status).toBe('paid');
    expect(satim.getOrderStatus).toHaveBeenCalled();
  });

  it('reconcile short-circuits once terminal (no gateway call)', async () => {
    const satim = makeSatim({ getOrderStatus: vi.fn(async () => statusResp(6)) as never }); // → failed (terminal)
    const checkout = createCheckout({ satim, store: createMemoryStore() });
    const { paymentId } = await checkout.start(order());
    await checkout.reconcile(paymentId); // pending → failed
    await checkout.reconcile(paymentId); // failed is terminal → short-circuits
    expect(satim.getOrderStatus).toHaveBeenCalledTimes(1);
  });

  it('re-queries a paid payment and converges to refunded on an out-of-band gateway refund', async () => {
    let status = 2;
    const onRefunded = vi.fn();
    const satim = makeSatim({ getOrderStatus: vi.fn(async () => statusResp(status)) as never });
    const checkout = createCheckout({ satim, store: createMemoryStore(), onRefunded });
    const { paymentId } = await checkout.start(order());
    expect((await checkout.reconcile(paymentId)).status).toBe('paid');
    status = 4; // a refund happened directly at SATIM, not through tasdid
    const r = await checkout.reconcile(paymentId);
    expect(r.status).toBe('refunded');
    expect(r.refundedAmount.toDinars()).toBe(5000);
    expect(r.refunds).toHaveLength(1);
    expect(onRefunded).toHaveBeenCalledTimes(1);
  });

  it('leaves a paid payment paid when the gateway still shows deposited', async () => {
    const satim = makeSatim({ getOrderStatus: vi.fn(async () => statusResp(2)) as never });
    const checkout = createCheckout({ satim, store: createMemoryStore() });
    const { paymentId } = await checkout.start(order());
    await checkout.reconcile(paymentId);
    const r = await checkout.reconcile(paymentId); // re-queries, still status 2
    expect(r.status).toBe('paid');
    expect(r.refunds).toHaveLength(0);
    expect(satim.getOrderStatus).toHaveBeenCalledTimes(2);
  });

  it('warns when the gateway amount differs from the recorded amount', async () => {
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const mismatch = { ...statusResp(2), depositAmount: 999_999 };
    const satim = makeSatim({ getOrderStatus: vi.fn(async () => mismatch) as never });
    const checkout = createCheckout({ satim, store: createMemoryStore(), logger });
    const { paymentId } = await checkout.start(order());
    const r = await checkout.reconcile(paymentId);
    expect(r.status).toBe('paid'); // still paid — mismatch is alarmed, not blocking
    expect(logger.warn.mock.calls.some(([msg]) => /amount differs/.test(String(msg)))).toBe(true);
  });

  it('expires a pending payment past its window (SATIM 20-min cancel)', async () => {
    const onExpired = vi.fn();
    const satim = makeSatim({ getOrderStatus: vi.fn(async () => statusResp(0)) as never });
    const store = createMemoryStore();
    const checkout = createCheckout({ satim, store, onExpired });
    const { paymentId } = await checkout.start(order());
    const p = await store.load(paymentId);
    if (p) {
      p.expiresAt = new Date(Date.now() - 1000).toISOString();
      await store.save(p);
    }
    const r = await checkout.reconcile(paymentId);
    expect(r.status).toBe('expired');
    expect(onExpired).toHaveBeenCalledTimes(1);
  });

  it('records an audit history of transitions', async () => {
    const satim = makeSatim({ getOrderStatus: vi.fn(async () => statusResp(2)) as never });
    const checkout = createCheckout({ satim, store: createMemoryStore() });
    const { paymentId } = await checkout.start(order());
    const r = await checkout.reconcile(paymentId);
    expect(r.history.map((h) => `${h.from}->${h.to}`)).toEqual(['created->pending', 'pending->paid']);
    expect(r.history[1]?.satimStatus).toBe(2);
  });
});

describe('refund', () => {
  async function paid() {
    const satim = makeSatim();
    const checkout = createCheckout({ satim, store: createMemoryStore() });
    const { paymentId } = await checkout.start(order());
    await checkout.reconcile(paymentId);
    return { satim, checkout, paymentId };
  }

  it('full refund → refunded', async () => {
    const { checkout, paymentId } = await paid();
    const r = await checkout.refund(paymentId);
    expect(r.status).toBe('refunded');
    expect(r.refundedAmount.toDinars()).toBe(5000);
  });

  it('partial then remainder → partially_refunded → refunded', async () => {
    const { checkout, paymentId } = await paid();
    const r1 = await checkout.refund(paymentId, da(2000));
    expect(r1.status).toBe('partially_refunded');
    expect(r1.refundedAmount.toDinars()).toBe(2000);
    const r2 = await checkout.refund(paymentId, da(3000));
    expect(r2.status).toBe('refunded');
  });

  it('rejects a refund beyond the deposit', async () => {
    const { checkout, paymentId } = await paid();
    await expect(checkout.refund(paymentId, da(6000))).rejects.toMatchObject({ code: 'REFUND_EXCEEDS_DEPOSIT' });
  });

  it('rejects refunding a non-paid payment', async () => {
    const satim = makeSatim({ getOrderStatus: vi.fn(async () => statusResp(0)) as never });
    const checkout = createCheckout({ satim, store: createMemoryStore() });
    const { paymentId } = await checkout.start(order());
    await expect(checkout.refund(paymentId)).rejects.toMatchObject({ code: 'NOT_REFUNDABLE' });
  });

  it('refund idempotency key makes a retry a no-op', async () => {
    const { satim, checkout, paymentId } = await paid();
    const a = await checkout.refund(paymentId, undefined, { idempotencyKey: 'r1' });
    expect(a.status).toBe('refunded');
    const b = await checkout.refund(paymentId, undefined, { idempotencyKey: 'r1' });
    expect(b.status).toBe('refunded');
    expect(b.refunds).toHaveLength(1);
    expect(satim.refund).toHaveBeenCalledTimes(1);
  });
});

describe('reconcilePending (sweep)', () => {
  it('reconciles every pending payment', async () => {
    const satim = makeSatim({ getOrderStatus: vi.fn(async () => statusResp(2)) as never });
    const store = createMemoryStore();
    const checkout = createCheckout({ satim, store });
    await checkout.start(order('A'));
    await checkout.start(order('B'));
    const summary = await reconcilePending(checkout, store);
    expect(summary.reconciled).toBe(2);
    expect(summary.errors).toBe(0);
    expect(summary.results.every((r) => r.status === 'paid')).toBe(true);
    expect((await store.listPending()).length).toBe(0);
  });

  it('classifies outcomes in the report', async () => {
    const satim = makeSatim({ getOrderStatus: vi.fn(async () => statusResp(2)) as never });
    const store = createMemoryStore();
    const checkout = createCheckout({ satim, store });
    await checkout.start(order('A'));
    await checkout.start(order('B'));
    const summary = await reconcilePending(checkout, store);
    expect(summary).toMatchObject({ paid: 2, failed: 0, expired: 0, refunded: 0, stillPending: 0, failures: [] });
  });

  it('collects per-payment failures without aborting the sweep', async () => {
    const satim = makeSatim({
      getOrderStatus: vi.fn(async () => {
        throw new Error('gateway down');
      }) as never,
    });
    const store = createMemoryStore();
    const checkout = createCheckout({ satim, store });
    await checkout.start(order('A'));
    const summary = await reconcilePending(checkout, store);
    expect(summary.errors).toBe(1);
    expect(summary.failures).toHaveLength(1);
    expect(summary.failures[0]?.paymentId).toBeTruthy();
  });
});

describe('get', () => {
  it('reads current state with no gateway call', async () => {
    const satim = makeSatim();
    const checkout = createCheckout({ satim, store: createMemoryStore() });
    const { paymentId } = await checkout.start(order());
    expect((await checkout.get(paymentId))?.status).toBe('pending');
    expect(await checkout.get('nope')).toBeNull();
    expect(satim.getOrderStatus).not.toHaveBeenCalled();
  });
});

describe('state machine & helpers', () => {
  it('guards transitions', () => {
    expect(canTransition('pending', 'paid')).toBe(true);
    expect(canTransition('pending', 'refunded')).toBe(false);
    expect(canTransition('paid', 'pending')).toBe(false);
    expect(isTerminal('failed')).toBe(true);
    expect(isTerminal('pending')).toBe(false);
  });
  it('maps SATIM order statuses', () => {
    expect(mapSatimStatus(2)).toBe('paid');
    expect(mapSatimStatus(6)).toBe('failed');
    expect(mapSatimStatus(0)).toBe('pending');
    expect(mapSatimStatus(4)).toBe('refunded');
  });
  it('failureReason: respCodeDesc → actionCodeDescription → null', () => {
    const base = { orderStatus: 6, approvalCode: null, pan: null };
    expect(failureReason({ ...base, respCode: '116', respCodeDesc: 'Solde insuffisant', actionCodeDescription: 'Refusé' })).toBe('Solde insuffisant');
    expect(failureReason({ ...base, respCode: null, respCodeDesc: null, actionCodeDescription: 'Carte bloquée' })).toBe('Carte bloquée');
    expect(failureReason({ ...base, respCode: null, respCodeDesc: null, actionCodeDescription: null })).toBeNull();
  });
  it('not-found errors are typed', async () => {
    const checkout = createCheckout({ satim: makeSatim(), store: createMemoryStore() });
    await expect(checkout.reconcile('nope')).rejects.toBeInstanceOf(TasdidError);
  });
});

describe('lifecycle hooks (logger / onTransition / clock)', () => {
  const makeLogger = () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });
  function fakeClock(start = new Date('2026-01-01T00:00:00.000Z')) {
    let t = start.getTime();
    return { now: () => new Date(t), advance: (ms: number) => void (t += ms) };
  }

  it('logs every transition through the injected logger', async () => {
    const logger = makeLogger();
    const satim = makeSatim({ getOrderStatus: vi.fn(async () => statusResp(2)) as never });
    const checkout = createCheckout({ satim, store: createMemoryStore(), logger });
    const { paymentId } = await checkout.start(order());
    await checkout.reconcile(paymentId);
    const transitions = logger.info.mock.calls.filter(([msg]) => msg === 'payment transition');
    expect(transitions.map((c) => `${(c[1] as { from: string }).from}->${(c[1] as { to: string }).to}`)).toEqual([
      'created->pending',
      'pending->paid',
    ]);
  });

  it('never logs a PAN', async () => {
    const logger = makeLogger();
    const satim = makeSatim({ getOrderStatus: vi.fn(async () => statusResp(2)) as never });
    const checkout = createCheckout({ satim, store: createMemoryStore(), logger });
    const { paymentId } = await checkout.start(order());
    await checkout.reconcile(paymentId);
    const everything = JSON.stringify([...logger.info.mock.calls, ...logger.debug.mock.calls, ...logger.warn.mock.calls]);
    expect(everything).not.toContain('6280'); // the masked PAN prefix from statusResp
  });

  it('fires onTransition on every state change with payment identity', async () => {
    const seen: string[] = [];
    const onTransition = vi.fn((e: { from: string; to: string }) => void seen.push(`${e.from}->${e.to}`));
    const satim = makeSatim({ getOrderStatus: vi.fn(async () => statusResp(2)) as never });
    const checkout = createCheckout({ satim, store: createMemoryStore(), onTransition });
    const { paymentId } = await checkout.start(order('ORD9'));
    await checkout.reconcile(paymentId);
    expect(seen).toEqual(['created->pending', 'pending->paid']);
    expect(onTransition.mock.calls.at(-1)?.[0]).toMatchObject({
      paymentId,
      orderNumber: 'ORD9',
      to: 'paid',
      satimStatus: 2,
    });
  });

  it('onTransition may be async and is awaited', async () => {
    const order_: string[] = [];
    const onTransition = vi.fn(async () => {
      await Promise.resolve();
      order_.push('hook');
    });
    const satim = makeSatim();
    const checkout = createCheckout({ satim, store: createMemoryStore(), onTransition });
    await checkout.start(order());
    order_.push('after-start');
    expect(order_).toEqual(['hook', 'after-start']);
  });

  it('uses the injected clock for expiry — deterministic, no real waiting', async () => {
    const clock = fakeClock();
    const onExpired = vi.fn();
    const satim = makeSatim({ getOrderStatus: vi.fn(async () => statusResp(0)) as never });
    const checkout = createCheckout({ satim, store: createMemoryStore(), now: clock.now, onExpired });
    const { paymentId, result } = await checkout.start(order());
    expect(result.expiresAt).toBe('2026-01-01T00:20:00.000Z'); // start + 20 min, from the fake clock
    expect((await checkout.reconcile(paymentId)).status).toBe('pending'); // still inside the window
    clock.advance(21 * 60_000); // jump past SATIM's 20-minute auto-cancel
    expect((await checkout.reconcile(paymentId)).status).toBe('expired');
    expect(onExpired).toHaveBeenCalledTimes(1);
  });

  it('stamps history timestamps from the injected clock', async () => {
    const clock = fakeClock();
    const satim = makeSatim();
    const checkout = createCheckout({ satim, store: createMemoryStore(), now: clock.now });
    const { result } = await checkout.start(order());
    expect(result.history[0]).toMatchObject({ from: 'created', to: 'pending', at: '2026-01-01T00:00:00.000Z' });
  });
});
