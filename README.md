# DoorWay — Rent Collection Rail

Backend take-home implementation of DoorWay's rent collection module.

**Stack:** TypeScript · NestJS · TypeORM · PostgreSQL · Jest

---

## Project structure

```
src/
  main.ts                          # App bootstrap (rawBody enabled for HMAC)
  app.module.ts                    # Root module + TypeORM config
  rent-collections/
    collection-status.enum.ts      # State machine + valid transitions
    rent-collections.module.ts
    rent-collections.controller.ts # POST /rent-collections, POST /rent-collections/reconcile
    rent-collections.service.ts    # Core logic: initiate, webhook, reconcile
    webhooks.controller.ts         # POST /webhooks/vopay (HMAC verified)
    dto/
      initiate-collection.dto.ts
      vopay-webhook.dto.ts
    entities/
      rent-collection.entity.ts
      rent-collection-audit.entity.ts
      processed-webhook-event.entity.ts
    migrations/
      1748000000000-CreateRentCollections.ts
    providers/
      vopay-client.interface.ts    # VopayClient interface + injection token
      vopay-mock.client.ts         # In-memory mock used in dev/test
test/
  rent-collections.service.spec.ts
  webhooks.controller.spec.ts
SOLUTION.md                        # Design decisions and trade-offs
AI_NOTES.md                        # AI tool usage notes
```

---

## Prerequisites

- Node.js 18+
- PostgreSQL 14+

---

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Create the database

```bash
psql -U postgres -c "CREATE USER doorway WITH PASSWORD 'doorway';"
psql -U postgres -c "CREATE DATABASE doorway OWNER doorway;"
```

### 3. Configure environment

A `.env` file is included at the project root with defaults for local dev. Edit it directly:

```bash
# .env
DB_TYPE=postgres
DB_HOST=localhost
DB_PORT=5432
DB_USER=doorway
DB_PASS=doorway
DB_NAME=doorway

VOPAY_WEBHOOK_SECRET=dev-webhook-secret

PORT=3000
```

| Variable               | Default              | Description                          |
|------------------------|----------------------|--------------------------------------|
| `DB_TYPE`              | `postgres`           | TypeORM database driver              |
| `DB_HOST`              | `localhost`          | Postgres host                        |
| `DB_PORT`              | `5432`               | Postgres port                        |
| `DB_USER`              | `doorway`            | Postgres user                        |
| `DB_PASS`              | `doorway`            | Postgres password                    |
| `DB_NAME`              | `doorway`            | Postgres database                    |
| `VOPAY_WEBHOOK_SECRET` | `dev-webhook-secret` | HMAC secret for webhook verification |
| `PORT`                 | `3000`               | HTTP port                            |

> **Note:** Never commit `.env` files that contain real credentials. Add `.env` to `.gitignore` and use a `.env.example` as the committed template in production projects.

### 4. Run the migration

```bash
npm run migration:run
```

> **Shortcut for local dev:** set `synchronize: true` in `src/app.module.ts` and skip the migration step — NestJS will create the tables automatically on first start. Never use `synchronize: true` in production.

### 5. Start the server

```bash
npm run start:dev
```

The server starts on `http://localhost:3000`.

---

## Running the tests

Unit tests use mocked repositories and a mocked VOPay client — no database required.

```bash
npm test
```

Expected output:

```
PASS test/webhooks.controller.spec.ts
PASS test/rent-collections.service.spec.ts

Tests: 25 passed, 25 total
```

With coverage:

```bash
npm run test:cov
```

---

## Manual testing with curl

### Initiate a collection

```bash
curl -s -X POST http://localhost:3000/rent-collections \
  -H "Content-Type: application/json" \
  -d '{
    "leaseId": "LEASE-1",
    "period": "2026-06",
    "amountCents": 150000,
    "currency": "CAD"
  }' | jq
```

Example response:

```json
{
  "id": "3fa85f64-...",
  "leaseId": "LEASE-1",
  "period": "2026-06",
  "amountCents": 150000,
  "currency": "CAD",
  "status": "submitted",
  "providerTransactionId": "vopay-tx-abc123",
  ...
}
```

### Test idempotency — same request twice, charged once

Run the exact same `curl` command again. The response returns the existing record; the VOPay mock is **not** called a second time.

### Send a settlement webhook

Replace `<transactionId>` with the `providerTransactionId` from the initiate response.

```bash
BODY='{"eventId":"evt-001","transactionId":"<transactionId>","status":"funded","occurredAt":"2026-06-07T10:00:00Z"}'

SIG=$(echo -n "$BODY" | openssl dgst -sha256 -hmac "dev-webhook-secret" | awk '{print $2}')

curl -s -X POST http://localhost:3000/webhooks/vopay \
  -H "Content-Type: application/json" \
  -H "x-vopay-signature: $SIG" \
  -d "$BODY" | jq
```

### Test duplicate webhook delivery

Send the exact same `curl` command again. The response is still `{"received":true}` but the collection state is **not** changed — deduplication via `eventId`.

### Test NSF bounce (funded → returned)

```bash
BODY='{"eventId":"evt-002","transactionId":"<transactionId>","status":"returned","occurredAt":"2026-06-09T08:00:00Z"}'

SIG=$(echo -n "$BODY" | openssl dgst -sha256 -hmac "dev-webhook-secret" | awk '{print $2}')

curl -s -X POST http://localhost:3000/webhooks/vopay \
  -H "Content-Type: application/json" \
  -H "x-vopay-signature: $SIG" \
  -d "$BODY" | jq
```

Collection status transitions to `returned`.

### Test invalid webhook signature — expect 401

```bash
curl -s -X POST http://localhost:3000/webhooks/vopay \
  -H "Content-Type: application/json" \
  -H "x-vopay-signature: deadbeef" \
  -d "$BODY" | jq
```

### Trigger reconciliation

```bash
curl -s -X POST http://localhost:3000/rent-collections/reconcile | jq
```

Finds collections stuck in `initiating` or `submitted` (older than 10 minutes) and polls VOPay to resolve them.

---

## API reference

| Method | Path                           | Description                                              |
|--------|--------------------------------|----------------------------------------------------------|
| `POST` | `/rent-collections`            | Initiate a rent collection. Idempotent on leaseId+period.|
| `POST` | `/rent-collections/reconcile`  | Resolve stale collections by polling the provider.       |
| `POST` | `/webhooks/vopay`              | Receive settlement events from VOPay (HMAC verified).    |

### POST /rent-collections

**Request body:**

```json
{
  "leaseId": "LEASE-1",
  "period": "2026-06",
  "amountCents": 150000,
  "currency": "CAD"
}
```

| Field          | Type    | Notes                              |
|----------------|---------|------------------------------------|
| `leaseId`      | string  | Unique identifier for the lease    |
| `period`       | string  | Billing period in `YYYY-MM` format |
| `amountCents`  | integer | Integer cents — no floats          |
| `currency`     | string  | e.g. `"CAD"`                       |

### POST /webhooks/vopay

**Required header:** `x-vopay-signature: <hex(hmacSHA256(rawBody, WEBHOOK_SECRET))>`

**Payload:**

```json
{
  "eventId": "evt-001",
  "transactionId": "vopay-tx-abc123",
  "status": "funded",
  "occurredAt": "2026-06-07T10:00:00Z"
}
```

Valid `status` values: `submitted` · `funded` · `failed` · `returned`

---

## Collection status lifecycle

```
PENDING ──► INITIATING ──► SUBMITTED ──► FUNDED ──► RETURNED (NSF)
                │                  └──► FAILED
                └──► PENDING  (on provider timeout — safe to retry)
```

See `SOLUTION.md` for the full design rationale.
