# tasdid docs

`@bakissation/tasdid` — headless SATIM (CIB/Edahabia) payment-lifecycle orchestration. Direct model, `Dinar`-backed, reconciliation-first.

- [Getting started](./getting-started.md) — install, the lifecycle, wiring storage
- [API reference](./api-reference.md) — every export
- [Architecture](./architecture.md) — state machine, reconciliation, idempotency, security

## In one paragraph

`createCheckout({ satim, store })` gives you a payment lifecycle over `@bakissation/satim`: `start` registers an order idempotently and returns the SATIM redirect URL; `handleReturn`/`reconcile` confirm the result against the gateway (the only source of truth — SATIM has no webhooks); `refund` does full/partial refunds. State lives in a pluggable `PaymentStore`; money is `Dinar`. The card is only ever entered on SATIM's hosted page, so the merchant stays in PCI SAQ-A.
