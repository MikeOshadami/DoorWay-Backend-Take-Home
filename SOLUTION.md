# Solution Notes

## What I built

A self-contained NestJS module (`RentCollectionsModule`) that:

1. Initiates rent collections against a mocked VOPay EFT rail
2. Processes async settlement webhooks with signature verification and replay safety
3. Reconciles stale collections by polling the provider
4. Notifies stakeholders on key settlement outcomes via a centralised `NotificationsService`

---

## Idempotency strategy

The core problem: EFT rails are asynchronous and reversible, so we have to stay correct even when:
- the same request arrives twice (double-click, client retry)
- a provider call times out and we don't know if it went through
- webhooks arrive late, out of order, or more than once

I handle this at three layers:

### Layer 1 — Database unique constraint
`(lease_id, period)` has a `UNIQUE` constraint. Only one collection record can ever exist for a given lease billing cycle. Any concurrent INSERT hits a conflict and gets the existing row.

### Layer 2 — Deterministic idempotency key + SELECT FOR UPDATE
The idempotency key is `doorway:rent:<leaseId>:<period>` — computed from business keys, not a UUID. This means:
- The exact same key is sent to VOPay on every attempt, including retries after timeouts.
- If our first call timed out and VOPay actually created the debit, a retry with the same key returns the same `transactionId` — no double charge.

A `SELECT FOR UPDATE` on the row inside a short transaction lets us safely transition to `INITIATING` status before calling the provider. Concurrent requests see `INITIATING` and return without calling VOPay.

### Layer 3 — Webhook deduplication table
`processed_webhook_events` stores `eventId` as a `PRIMARY KEY`. The INSERT and the state transition happen in the same database transaction. If the provider delivers the same event twice, the second INSERT hits the PK conflict and we return early — the state is never double-applied.

---

## State machine

```
PENDING ──────────────────────────────► INITIATING
                                             │
                    ┌────────────────────────┘
                    │             (timeout: revert)
                    ▼                        │
               SUBMITTED ◄──────────────────┘
                    │
            ┌───────┴───────┐
            ▼               ▼
          FUNDED           FAILED
            │
            ▼
         RETURNED   ← NSF bounce (arrives after FUNDED)
```

State transitions are validated in `applyTransition()`. Any call that tries to move outside the allowed edges throws `UnprocessableEntityException`. This prevents silent corruption from out-of-order events or bugs — the caller always knows when something unexpected happened.

**INITIATING** is the key addition over a simpler two-state design. It solves two problems:
1. Prevents concurrent requests from calling VOPay simultaneously.
2. Gives the reconciliation job a clear signal that a process may have crashed mid-call.

On a provider timeout, the service reverts to `PENDING` and throws so the client knows to retry. If the revert itself fails (DB down), the row stays `INITIATING` — reconciliation recovers it using the deterministic idempotency key.

---

## Webhook handling

1. **Signature verification first** — HMAC-SHA256 over raw body, constant-time comparison. Reject before parsing.
2. **Deduplication** — eventId INSERT with `ON CONFLICT DO NOTHING`. Atomic with the transition.
3. **Invalid transitions are silently acknowledged** — returning a 4xx would cause the provider to redeliver indefinitely. Out-of-order events are logged in the audit trail but the webhook returns 200.

---

## Reconciliation

Two stuck states handled:

- **INITIATING**: re-call `initiateDebit` with the same idempotency key. VOPay returns the existing `transactionId` if the debit was created; creates a new one otherwise. Either way we get a transactionId and advance to SUBMITTED.
- **SUBMITTED**: poll `getTransaction(transactionId)`. Apply whatever status VOPay reports.

In production this would run as a scheduled job (e.g. every 5 minutes via NestJS `@nestjs/schedule`). It's exposed as `POST /rent-collections/reconcile` for now per the spec.

---

## Notifications

`NotificationsService` is the single point of contact for all outbound alerts triggered by settlement outcomes. It is called from `applyTransition()` — the one method every status change flows through — so the webhook path, the reconciliation path, and the API path all trigger notifications automatically without any duplicated logic.

The service routes on `toStatus`:

| Status     | Notification                                                                 |
|------------|------------------------------------------------------------------------------|
| `RETURNED` | NSF alert to property manager (email / SMS / Slack — stub with TODO)         |
| `FUNDED`   | Receipt confirmation / ledger entry (stub with TODO)                         |
| `FAILED`   | Hard-failure alert to property manager to investigate tenant banking details |

**Key design decision**: the notification call is placed *after* the DB save, outside the transaction. A failed email delivery cannot roll back the state change. For guaranteed delivery in production, `notifyNSF` should enqueue a Bull/BullMQ job rather than call the delivery service directly — the worker retries on failure independently of the main request.

---

## Trade-offs and what I'd do with more time

**`accountRef` lookup**: the spec says `initiateDebit` needs an `accountRef` (the tenant's bank account reference). The input DTO doesn't include it — in a real system this comes from an Accounts/Tenants service. I used `leaseId` as a stand-in and called it out here. With more time I'd add a `BankAccountsService` lookup or accept `accountRef` in the DTO.

**`INITIATING` row lock**: the current approach commits the INITIATING transition in one transaction, then calls the provider, then opens another transaction for the result. This is three round-trips. An alternative is to use PostgreSQL advisory locks (`pg_try_advisory_xact_lock`) to avoid the intermediate INITIATING state entirely. I prefer the explicit status approach because it's visible in the DB and survives process restarts.

**Reconciliation staleness threshold**: 10 minutes is a placeholder. Real EFT rails have SLAs; the threshold should be configurable and based on VOPay's documented settlement window.

**`orIgnore()` vs `upsert()`**: TypeORM's `orIgnore()` maps to `ON CONFLICT DO NOTHING`. I chose this over `upsert` because I don't want to overwrite `amountCents` or `status` on a duplicate — the existing record wins.

**Integration tests**: the unit tests mock TypeORM extensively. I'd add integration tests with a real Postgres (via `pg-mem` or Testcontainers) for the concurrent initiation path — that's the one scenario where mock behaviour diverges most from reality.

**Notification delivery**: `NotificationsService` is currently a stub that logs to console. In production each method would be backed by a real delivery mechanism (SendGrid, Twilio, Slack Web API) and wrapped in a Bull/BullMQ job queue for at-least-once delivery with retries.

**Auth**: skipped per spec. In production, the `/rent-collections` endpoints need tenant-scoped JWT auth; the `/webhooks/vopay` endpoint needs IP allowlisting in addition to HMAC.

**Vendor payouts**: out of scope. The pattern is identical (same state machine shape, same idempotency strategy) but the flow is pull instead of push.
