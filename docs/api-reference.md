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
  type PrismaPaymentDelegate, type PrismaPaymentRow, type TransitionRecord, type TransitionEvent, type RefundRecord,
  type RefundOptions, type Logger, noopLogger,
  type SweepOptions, type SweepSummary,
} from '@bakissation/tasdid';
```

## `createCheckout(options): Checkout`
`CheckoutOptions` — `satim` (a `SatimClient`), `store` (`PaymentStore`), `language?` (default `fr`), `expiresInMinutes?` (default `20` — SATIM's auto-cancel window), `generateId?` (default `crypto.randomUUID`).

**Hooks & observability:**
- `onPaid?`/`onFailed?`/`onRefunded?`/`onExpired?` — typed convenience events, each `(result: PaymentResult) => void | Promise<void>`.
- `onTransition?(event: TransitionEvent) => void | Promise<void>` — fires on **every** transition (the superset of the typed events). `TransitionEvent` = `TransitionRecord & { paymentId, orderNumber }`. Use this as the seam for durable, at-least-once delivery (an outbox).
- `logger?: Logger` — structured diagnostics sink; default no-op. Structural interface (`debug`/`info`/`warn`/`error`, each `(msg, fields?) => void`), so `console`/pino/winston satisfy it with no dependency. Only ever receives ids/statuses — **never a PAN or credentials**.
- `now?: () => Date` — clock source (default `() => new Date()`). Inject a controllable clock to make the 20-minute expiry deterministic in tests.

### `Checkout`
| Method | Returns | Notes |
|---|---|---|
| `start(order: StartOrder)` | `Promise<StartResult>` | idempotent register; `{ paymentId, redirectUrl, result }` |
| `handleReturn(params: ReturnParams)` | `Promise<PaymentResult>` | match by `orderId`/`paymentId` → reconcile |
| `reconcile(paymentId)` | `Promise<PaymentResult>` | poll `getOrderStatus`, converge, fire events; short-circuits only once **terminal** (`failed`/`expired`/`refunded`). Re-queries `paid`/`partially_refunded` and converges to `refunded` if the gateway reports a full refund tasdid hasn't recorded (out-of-band refund / crash-after-success); logs a warning if the gateway's amount differs from the recorded amount |
| `refund(paymentId, amount?, opts?: { idempotencyKey? })` | `Promise<PaymentResult>` | full/partial (≤ deposited); reusing an `idempotencyKey` is a no-op |
| `get(paymentId)` | `Promise<PaymentResult \| null>` | read current state, no gateway call (no side effects) |

## Types
- **`StartOrder`** — `orderNumber`, `amount: Dinar`, `returnUrl`, `failUrl?`, `description?`, `language?`, `udf1?`, `idempotencyKey?`, `expiresInMinutes?`, `metadata?`.
- **`PaymentResult`** — `id`, `orderNumber`, `orderId`, `status`, `amount: Dinar`, `refundedAmount: Dinar`, `redirectUrl`, `paid: boolean`, `expiresAt`, `history: TransitionRecord[]`, `refunds: RefundRecord[]`, `satim: { orderStatus, approvalCode, pan, actionCodeDescription, respCode, respCodeDesc }`. On a rejected payment, render `respCodeDesc` (fallback `actionCodeDescription`) as the failure reason — SATIM certification requires it on the return page.
- **`PaymentStatus`** — `created | pending | paid | failed | expired | partially_refunded | refunded`.
- **`Payment`** — the persisted record (money as integer centimes: `amountCentimes`/`refundedCentimes`; plus `expiresAt`, `history`, `refunds`).
- **`TransitionRecord`** — `{ from, to, at, satimStatus? }` (audit trail). **`TransitionEvent`** — `TransitionRecord & { paymentId, orderNumber }` (delivered to `onTransition`). **`RefundRecord`** — `{ idempotencyKey, amountCentimes, at }`.
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
Reconcile every pending payment (run from a cron/queue). `SweepOptions` — `limit?`, `onError?(paymentId, error)`. `SweepSummary` — `{ reconciled, errors, results, paid, failed, expired, refunded, stillPending, failures }`, where `failures: SweepFailure[]` (`{ paymentId, error }`) is the ops-alarm list and the per-status counts summarize the run. Alert on `failures`; watch `stillPending`.

## Helpers & errors
- `isTerminal(status)` · `canTransition(from, to)` · `mapSatimStatus(orderStatus)` (SATIM code → `PaymentStatus`).
- `failureReason(result.satim)` → the message to render on a rejected payment (`respCodeDesc` → `actionCodeDescription` → `null`). The order SATIM certification requires on the return page.
- `generateOrderNumber()` → a SATIM-valid order number (10 uppercase hex chars; SATIM caps it at 10). Use for `StartOrder.orderNumber`.
- `TasdidError` — `code`: `REGISTER_FAILED | NOT_FOUND | NOT_REFUNDABLE | REFUND_EXCEEDS_DEPOSIT | REFUND_FAILED | INVALID_TRANSITION | INVALID_INPUT`; `satimErrorCode?` when the gateway caused it.
