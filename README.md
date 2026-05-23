# @bakissation/tasdid

**Headless SATIM (CIB/Edahabia) payment-lifecycle orchestration for Algeria.** Register → redirect → reconcile → refund, behind a guarded state machine with idempotency, pluggable storage, and events. The *direct-integration* model — the merchant's own SATIM creds, money settles to their own bank. `Dinar`-backed.

[![npm](https://img.shields.io/npm/v/@bakissation/tasdid?label=npm&color=cb3837)](https://www.npmjs.com/package/@bakissation/tasdid)
[![CI](https://github.com/bakissation/tasdid/actions/workflows/ci.yml/badge.svg)](https://github.com/bakissation/tasdid/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

```bash
npm install @bakissation/tasdid
```

`@bakissation/satim` and `@bakissation/dinar` come with it (dependencies).

## Why

`@bakissation/satim` is one call per gateway endpoint. Real apps need the *whole lifecycle* — and SATIM has **no webhooks** and **auto-cancels orders you don't confirm**, so reconciliation isn't optional. `tasdid` makes register → confirm → reconcile → refund one coherent, persisted, typed flow, and gets the parts everyone hand-rolls wrong (idempotency, reconciliation, double-refund guards) right.

## Usage

```ts
import { createSatimClient, fromEnv } from '@bakissation/satim';
import { Dinar } from '@bakissation/dinar';
import { createCheckout, createMemoryStore } from '@bakissation/tasdid';

const checkout = createCheckout({
  satim: createSatimClient(fromEnv()),   // the merchant's own creds
  store: createMemoryStore(),            // bring your own (Prisma/Postgres/Redis) in prod
  onPaid: (p) => console.log('paid', p.orderNumber),
});

// 1. Start — register + get the SATIM redirect URL
const { paymentId, redirectUrl } = await checkout.start({
  orderNumber: 'ORD-1001',
  amount: Dinar.fromDinars(5000),
  returnUrl: 'https://shop.dz/checkout/return',
});
// → redirect the buyer to redirectUrl (SATIM hosted page, independent browser context)

// 2. On the return URL — verify against the gateway (never trust the redirect)
const result = await checkout.handleReturn({ orderId: req.query.orderId });
if (result.paid) { /* fulfill */ }

// 3. Buyer never came back? Reconcile (cron/queue) — getOrderStatus is the source of truth
await checkout.reconcile(paymentId);

// 4. Refund (full or partial)
await checkout.refund(paymentId, Dinar.fromDinars(2000));
```

## The model (non-negotiable)

- **Direct integration** — the merchant's own SATIM client/creds; money settles to the merchant. No fund pooling, no hosted multi-tenant service. Self-hosted only.
- **Reconciliation is the source of truth** — SATIM has no webhooks; the return URL is only a *signal to verify*. State advances solely on server-confirmed `getOrderStatus`.
- **Redirect, never iframe** — SATIM requires an "independent browser context", which also keeps the merchant in **PCI-DSS SAQ-A** (the card is only ever entered on SATIM's page; tasdid never sees a PAN).

## State machine

```
created → pending → paid | failed | expired
paid → partially_refunded → refunded
```
Terminal states are immutable (no double-charge, no double-refund); illegal transitions throw.

## API

| Method | Does |
|---|---|
| `createCheckout({ satim, store, language?, onPaid?/…, onTransition?, logger?, now? })` | Build a checkout |
| `start(order)` | Idempotently register + return `{ paymentId, redirectUrl }` |
| `handleReturn({ orderId \| paymentId })` | Match the return → reconcile |
| `reconcile(paymentId)` | Poll `getOrderStatus`, converge state, fire events |
| `refund(paymentId, amount?)` | Full/partial refund (≤ deposited) |
| `get(paymentId)` | Read current state — no gateway call (`PaymentResult \| null`) |
| `reconcilePending(checkout, store)` | Sweep all pending payments (cron/queue) |
| `createMemoryStore()` / `createPostgresStore(db)` / `createRedisStore(client)` / `createPrismaStore(delegate)` | Bundled `PaymentStore` implementations |
| `PaymentStore` | Interface to implement your own |

Amounts are `Dinar` in and out. Every method returns a `PaymentResult`.

## Storage

Four stores ship in the box — **all dependency-free** (you pass your own client; tasdid never depends on `pg`/`ioredis`/`@prisma/client`):

```ts
import {
  createMemoryStore, createPostgresStore, postgresDDL,
  createRedisStore, createPrismaStore, prismaSchema,
} from '@bakissation/tasdid';

createMemoryStore();                  // dev/test
createPostgresStore(pgPool);          // your node-postgres Pool — run postgresDDL() once
createRedisStore(ioredisClient);      // your ioredis-compatible client
createPrismaStore(prisma.tasdidPayment); // your Prisma delegate — add prismaSchema() to your schema
```

Or implement `PaymentStore` yourself — just make `claim` atomic (`INSERT … ON CONFLICT`). Reconcile abandoned payments from a cron with `reconcilePending(checkout, store)`.

## Correctness extras

- **Expiry** — SATIM auto-cancels an unconfirmed order after **20 minutes**; tasdid mirrors that (`expiresInMinutes`, default 20) so abandoned payments reach `expired` on a clock, not just on a gateway error.
- **Refund idempotency** — `refund(id, amount?, { idempotencyKey })`; retrying with the same key is a no-op (no double-refund).
- **Audit history** — every payment carries a `history` of state transitions (and `refunds`), for disputes/debugging.
- **Refund reconciliation** — `reconcile` re-checks `paid` payments and converges to `refunded` if the gateway reports a refund tasdid never recorded (a refund done directly at SATIM, or a crash after the gateway refund succeeded). It never downgrades a paid payment otherwise, and warns if the gateway's amount disagrees with the recorded one.
- **Sweep report** — `reconcilePending` returns a classified `SweepSummary` (`paid`/`failed`/`expired`/`refunded`/`stillPending` counts + a `failures` list) so a cron can alert on what didn't settle — the only real window into health when the gateway has no webhooks.

## Observability

- **`onTransition(event)`** fires on *every* state change (`TransitionRecord & { paymentId, orderNumber }`) — the superset of the typed `onPaid`/`onFailed`/`onRefunded`/`onExpired` events. It's the seam for durable, at-least-once delivery (wire it to an outbox/queue).
- **`logger`** — pass any structural logger (`console`, pino, winston…); tasdid logs each transition and gateway call with correlation fields (`paymentId`/`orderNumber`/`orderId`). It **never logs a PAN or credentials**. Defaults to a no-op.
- **`now`** — inject a clock (`() => Date`) to make the 20-minute expiry deterministic in tests.

```ts
createCheckout({
  satim, store,
  logger: console,
  onTransition: (e) => queue.publish('payment.transition', e), // outbox seam
});
```

## Not tax/PCI advice
Keeps you in SAQ-A *by construction* (redirect-only, never touches card data), but you're still responsible for your site's SAQ-A obligations and SATIM certification (SSL, prominent amount, captcha, CIB logo, receipt) — see the satim-ts certification docs.

## License

MIT © Abdelbaki Berkati

## Credits

Built and maintained by **Abdelbaki Berkati** — [berkati.xyz](https://berkati.xyz) · [@bakissation](https://github.com/bakissation).
