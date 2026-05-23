# Getting started

```bash
npm install @bakissation/tasdid
```

`@bakissation/satim` (gateway) and `@bakissation/dinar` (money) install with it.

## Wire it up

```ts
import { createSatimClient, fromEnv } from '@bakissation/satim';
import { createCheckout, createMemoryStore } from '@bakissation/tasdid';

const checkout = createCheckout({
  satim: createSatimClient(fromEnv()),   // SATIM_USERNAME / SATIM_PASSWORD / SATIM_TERMINAL_ID …
  store: createMemoryStore(),            // swap for a durable PaymentStore in production
  language: 'fr',
  onPaid: async (p) => { /* fulfill the order */ },
});
```

## The lifecycle

```ts
import { Dinar } from '@bakissation/dinar';

// 1. start — idempotent register; returns the SATIM hosted-page URL
const { paymentId, redirectUrl } = await checkout.start({
  orderNumber: 'ORD-1001',         // unique, ≤ 10 chars
  amount: Dinar.fromDinars(5000),  // ≥ 50 DZD
  returnUrl: 'https://shop.dz/return',
  failUrl: 'https://shop.dz/failed',
});
// redirect the buyer to redirectUrl in an independent browser context (not an iframe)

// 2. return URL — verify against the gateway (the redirect itself is untrusted)
app.get('/return', async (req) => {
  const result = await checkout.handleReturn({ orderId: req.query.orderId });
  return result.paid ? ok(result) : pending(result);
});

// 3. reconcile abandoned/uncertain payments from a cron or queue
for (const p of await store.listPending()) await checkout.reconcile(p.id);

// 4. refund
await checkout.refund(paymentId);                       // full
await checkout.refund(paymentId, Dinar.fromDinars(2000)); // partial
```

`start` is **idempotent**: calling it again with the same `orderNumber` (or `idempotencyKey`) returns the same payment and never re-registers.

## Production storage

`createMemoryStore()` is dev/test only. Three durable stores ship in the box — **dependency-free**, you pass your own client (tasdid never depends on `pg`/`ioredis`/`@prisma/client`):

```ts
import { createPostgresStore, postgresDDL, createRedisStore, createPrismaStore, prismaSchema } from '@bakissation/tasdid';
import { Pool } from 'pg';
import Redis from 'ioredis';

// Postgres — run the DDL once (or via your migrations)
await pool.query(postgresDDL());                 // pool: pg.Pool
const store = createPostgresStore(pool);

// Redis
const store = createRedisStore(new Redis(process.env.REDIS_URL));

// Prisma — add prismaSchema() to your schema.prisma, then pass the model delegate
const store = createPrismaStore(prisma.tasdidPayment);
```

Or implement `PaymentStore` against any DB — just make `claim` atomic (`INSERT … ON CONFLICT DO NOTHING`).

## Reconciliation sweep

SATIM has no webhooks and auto-cancels unconfirmed orders, so reconcile abandoned payments periodically:

```ts
import { reconcilePending } from '@bakissation/tasdid';

// from a cron / queue worker
const summary = await reconcilePending(checkout, store, { limit: 100, onError: log });
// → { reconciled, errors, results }
```
