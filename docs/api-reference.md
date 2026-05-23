# API reference

```ts
import {
  createCheckout, reconcilePending, TasdidError,
  createMemoryStore, createPostgresStore, postgresDDL, createRedisStore, createPrismaStore, prismaSchema,
  isTerminal, canTransition, mapSatimStatus,
  type Checkout, type CheckoutOptions, type StartResult,
  type Payment, type PaymentStatus, type StartOrder, type PaymentResult,
  type PaymentStore, type ReturnParams, type SatimLanguage,
  type SqlClient, type PostgresStoreOptions, type RedisLike, type RedisStoreOptions,
  type PrismaPaymentDelegate, type PrismaPaymentRow, type TransitionRecord, type RefundRecord,
  type SweepOptions, type SweepSummary,
} from '@bakissation/tasdid';
```

## `createCheckout(options): Checkout`
`CheckoutOptions` — `satim` (a `SatimClient`), `store` (`PaymentStore`), `language?` (default `fr`), `expiresInMinutes?` (default `20` — SATIM's auto-cancel window), `generateId?` (default `crypto.randomUUID`), and event hooks `onPaid?`/`onFailed?`/`onRefunded?`/`onExpired?` (each `(result: PaymentResult) => void | Promise<void>`).

### `Checkout`
| Method | Returns | Notes |
|---|---|---|
| `start(order: StartOrder)` | `Promise<StartResult>` | idempotent register; `{ paymentId, redirectUrl, result }` |
| `handleReturn(params: ReturnParams)` | `Promise<PaymentResult>` | match by `orderId`/`paymentId` → reconcile |
| `reconcile(paymentId)` | `Promise<PaymentResult>` | poll `getOrderStatus`, converge, fire events; no-op once terminal |
| `refund(paymentId, amount?, opts?: { idempotencyKey? })` | `Promise<PaymentResult>` | full/partial (≤ deposited); reusing an `idempotencyKey` is a no-op |

## Types
- **`StartOrder`** — `orderNumber`, `amount: Dinar`, `returnUrl`, `failUrl?`, `description?`, `language?`, `udf1?`, `idempotencyKey?`, `expiresInMinutes?`, `metadata?`.
- **`PaymentResult`** — `id`, `orderNumber`, `orderId`, `status`, `amount: Dinar`, `refundedAmount: Dinar`, `redirectUrl`, `paid: boolean`, `expiresAt`, `history: TransitionRecord[]`, `refunds: RefundRecord[]`, `satim: { orderStatus, approvalCode, pan }`.
- **`PaymentStatus`** — `created | pending | paid | failed | expired | partially_refunded | refunded`.
- **`Payment`** — the persisted record (money as integer centimes: `amountCentimes`/`refundedCentimes`; plus `expiresAt`, `history`, `refunds`).
- **`TransitionRecord`** — `{ from, to, at, satimStatus? }` (audit trail). **`RefundRecord`** — `{ idempotencyKey, amountCentimes, at }`.
- **`ReturnParams`** — `{ orderId?, paymentId? }`.

## `PaymentStore`
The persistence contract: `claim(key, init)` (atomic get-or-create), `load(id)`, `save(payment)`, `findByOrderId(orderId)`, `findByOrderNumber(orderNumber)`, `listPending()`.

### Bundled stores (all dependency-free — you pass your own client)
- `createMemoryStore()` — dev/test (not durable).
- `createPostgresStore(db: SqlClient, opts?: { table? })` — `db` is any `{ query(text, values?) }` (a `pg` Pool/Client fits). Run `postgresDDL(table?)` once to create the table.
- `createRedisStore(redis: RedisLike, opts?: { prefix? })` — `redis` is an ioredis-compatible client (`get`/`set(…, 'NX')`/`sadd`/`srem`/`smembers`).
- `createPrismaStore(delegate: PrismaPaymentDelegate)` — your Prisma model delegate (e.g. `prisma.tasdidPayment`); add `prismaSchema()` to your schema. Atomic `claim` via the `idempotencyKey @unique` constraint.

`SqlClient`, `RedisLike`, and `PrismaPaymentDelegate` are exported structural types — implement them to wrap any driver.

## `reconcilePending(checkout, store, opts?): Promise<SweepSummary>`
Reconcile every pending payment (run from a cron/queue). `SweepOptions` — `limit?`, `onError?(paymentId, error)`. `SweepSummary` — `{ reconciled, errors, results }`.

## Helpers & errors
- `isTerminal(status)` · `canTransition(from, to)` · `mapSatimStatus(orderStatus)` (SATIM code → `PaymentStatus`).
- `TasdidError` — `code`: `REGISTER_FAILED | NOT_FOUND | NOT_REFUNDABLE | REFUND_EXCEEDS_DEPOSIT | REFUND_FAILED | INVALID_TRANSITION | INVALID_INPUT`; `satimErrorCode?` when the gateway caused it.
