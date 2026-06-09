# AI Notes

## Tool used

Claude (claude-sonnet-4-6) via Cowork — Anthropic's desktop agentic coding tool.

---

## Representative prompts

1. **Architecture / idempotency framing**
   > "I'm building an EFT rent collection module in NestJS. The provider is async and can time out — I won't know if a debit was actually created. Walk me through how to design idempotency at the DB and provider level so retries are always safe."

   This got me to the three-layer approach: unique constraint, deterministic idempotency key, and SELECT FOR UPDATE + INITIATING status to prevent concurrent calls.

2. **State machine design**
   > "What states does a rent collection need? The debit can succeed provisionally and then bounce (NSF) days later. I want an explicit state machine that rejects invalid transitions. Map it out."

   Claude proposed PENDING → SUBMITTED → FUNDED → RETURNED and FAILED. I added INITIATING after thinking through the "crash between claiming and calling the provider" failure mode.

3. **Webhook deduplication pattern**
   > "The webhook provider may redeliver the same event. How do I make the handler idempotent without a distributed lock? I'm on Postgres."

   The suggestion was a `processed_events` table with a `PRIMARY KEY` on `eventId` and doing the INSERT + state transition in the same transaction. This was exactly right — it's simpler and more correct than an application-level Set or Redis key.

4. **Test structure for TypeORM mocks**
   > "Show me how to mock TypeORM DataSource.transaction in Jest so I can unit-test a service that calls it multiple times with different entity managers."

   This produced the `makeDataSource` helper pattern that queues entity managers and replays them in order. It needed one correction (see below).

5. **Timing-safe comparison for HMAC**
   > "I'm verifying a VOPay webhook signature. I'm comparing hex strings. Is a simple === safe, or do I need constant-time comparison? Show me how to do it in Node."

   Claude correctly flagged that `===` is vulnerable to timing attacks on the hex strings, and suggested `crypto.timingSafeEqual` on `Buffer.from(sig, 'hex')`. I used this directly.

---

## One moment the AI was wrong

When I asked for the webhook deduplication test, Claude initially suggested checking `em.save` call count to verify deduplication — reasoning that a duplicate event would call `save` fewer times. The problem: `save` is also called for audit rows, so the count varies by how many audit rows the rejected path writes. The assertion would have been fragile and wrong in some branches.

I caught this by tracing through the actual code path: on a duplicate eventId, the handler returns before calling `em.getRepository(RentCollection).findOne` at all. The correct assertion is that `findOne` is only called once across two webhook deliveries — that's the precise proof that the second delivery short-circuited. I rewrote the test accordingly.

---

## One thing I deliberately did not delegate to AI

I wrote the state transition table (`VALID_TRANSITIONS`) by hand rather than asking Claude to generate it from the spec.

This is the most critical correctness invariant in the whole system — it determines what money movements are possible. Getting it wrong (e.g. allowing RETURNED → FUNDED, or forgetting that FAILED is terminal) would mean money moving incorrectly in production. I wanted to reason through each edge myself, against the spec, and own the result. A generated table might look right and have a subtle gap I'd only catch during a real NSF scenario.

The state machine is also small enough (6 states, ~8 edges) that generating it isn't a meaningful time saving — it's just risk with no upside.
