# Architecture

tasdid is a thin, headless orchestration layer over `@bakissation/satim`. No HTTP, no framework — `createCheckout` returns a plain object you call from anywhere.

```
dinar (money) ── @bakissation/satim ^2.0.0 (gateway SDK)
                        │
                        ▼
            @bakissation/tasdid
            checkout.ts ── state.ts · status.ts · store.ts(+memory-store.ts) · types.ts · errors.ts
```

## State machine (`state.ts`)
```
created → pending → paid | failed | expired
paid → partially_refunded → refunded
```
Transitions are table-driven and guarded — `assertTransition` throws `INVALID_TRANSITION` on an illegal move; terminal states (`failed`/`expired`/`refunded`) can't be left. This is what prevents double-charge / double-refund.

## Reconciliation is the source of truth
SATIM has **no webhooks** and **auto-cancels orders that aren't confirmed**. So:
- `handleReturn` treats the redirect as *untrusted* — it only matches the payment, then calls `reconcile`.
- `reconcile` calls `getOrderStatus`, maps the SATIM `OrderStatus` (`status.ts`) to a tasdid status, and transitions. `errorCode 6` (unregistered) on a pending order ⇒ the gateway cancelled it ⇒ `expired`.
- Caller-driven sweep: iterate `store.listPending()` from a cron/queue to catch buyers who never returned. (We don't own infra; no built-in poller.)

## Idempotency
`start` derives a key (`idempotencyKey ?? orderNumber`) and `store.claim`s it. If the order was already registered, it returns the existing payment + redirect URL — never a second `register`. Stores must make `claim` atomic so concurrent double-submits collapse to one payment.

## Money
Stored as integer **centimes** (portable across SQL/Redis); the public surface is `Dinar`. `start` takes a `Dinar` and passes it to satim (itself dinar-backed), so there's one shared money type end-to-end.

## Security / PCI
Redirect-only (no iframe) ⇒ the card is entered solely on SATIM's hosted page ⇒ tasdid never sees a PAN (only the masked `Pan` in the status response). That keeps the merchant in **PCI-DSS SAQ-A**. Creds live in the merchant's `SatimClient` (server-side); tasdid logs nothing sensitive. Validate the return against a known payment and advance state only from the gateway.

## Storage
Four stores ship in core, all **dependency-free** via structural typing (the same trick as satim's `DinarLike`): `createMemoryStore` (dev/test), `createPostgresStore` (any `SqlClient` — `pg` Pool fits), `createRedisStore` (any ioredis-compatible `RedisLike`), `createPrismaStore` (any `PrismaPaymentDelegate` — e.g. `prisma.tasdidPayment`). tasdid takes **no** `pg`/`ioredis`/`@prisma/client` dependency — you pass your own client. Implement `PaymentStore` for anything else; `claim` must be atomic.

## Dependencies
`@bakissation/satim` + `@bakissation/dinar` only (dinar deduped to one copy). Storage drivers are the consumer's — never tasdid's.
