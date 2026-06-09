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

6. **Run and test instructions**
   > "How do I run it and test myself?"

   Claude provided curl examples for every endpoint and the full setup flow. I then asked it to put this into a README file, which it created with setup steps, the env variable table, and signed webhook examples.

7. **Environment variable management**
   > "Put the db parameters in an env file so it can be easily updated from there."

   Claude created `.env`, `.env.example`, and updated `app.module.ts` to use `ConfigModule` + `ConfigService`. However, the initial pass missed `DB_TYPE` — it hardcoded `type: 'postgres'` in the TypeORM config instead of reading it from the env file. I caught this and asked why it wasn't in the env too, and it was added as a follow-up.

8. **Missing data-source.ts**
   > "Why is there no data-source.ts?"

   The README referenced `src/data-source.ts` in the migration command but the file was never created. Claude had overlooked it entirely during initial scaffolding. I caught the gap and it was created — a standalone TypeORM DataSource that reads from `.env` via `dotenv` so the TypeORM CLI works without a running NestJS app. Two npm scripts (`migration:run`, `migration:revert`) were also added to `package.json` to simplify the command.

9. **Interview preparation document**
   > "Can you give me a document that explains how the entire system works so I can use it to prepare for an interview?"

   Claude generated a formatted Word document (.docx) covering: system overview, database design, state machine, idempotency layers, webhook handling, reconciliation, configuration, test coverage, and a Q&A section with 13 likely interview questions and prepared answers.

10. **NSF notification hook**
    > "Can you put the section as comments where a message can be sent to the property manager if collection is returned (NSF)?"

    Claude initially added TODO comment blocks in three separate locations: the webhook path, the reconciliation path, and inside `applyTransition()`. Each block said roughly the same thing in different words — duplicated guidance scattered across the file.

11. **Refactor notifications into a shared service**
    > "Instead of having the NSF notification hook in three locations, why not have a common service where the three applyTransition events can be implemented instead of repeating code in the 3 places?"

    This was the right architectural challenge. Claude created a dedicated `NotificationsService` with a single `onTransition(collection, fromStatus, toStatus, source)` entry point, registered it in the module, injected it into `RentCollectionsService`, and called it once at the end of `applyTransition()` — the one method all three paths flow through. The three scattered TODO blocks were removed entirely. The service routes by `toStatus` to specific handlers (`notifyNSF`, `notifyFunded`, `notifyFailed`), each with a stub log line and a full implementation guide in the comments.

---

## Moments the AI was wrong or incomplete

**1. Duplicated notification logic across three call sites (caught during code review)**

When asked to add NSF notification hooks, Claude placed identical TODO comment blocks in three separate locations — `handleWebhook`, `reconcileSubmitted`, and `applyTransition`. This was the wrong instinct: `applyTransition` is already the single choke point for every status change, so placing hooks in the two callers as well was redundant and would have created a maintenance problem (three places to update when the real delivery mechanism is wired in).

I caught this by pointing out the duplication directly. The correct solution was to create a `NotificationsService`, inject it into `RentCollectionsService`, and call it once inside `applyTransition` — covering all three paths automatically without any of them needing to know about notifications.

**2. Webhook deduplication test assertion (caught during initial build)**

When asked for the webhook deduplication test, Claude initially suggested checking `em.save` call count to verify deduplication — reasoning that a duplicate event would call `save` fewer times. The problem: `save` is also called for audit rows, so the count varies by how many audit rows the rejected path writes. The assertion would have been fragile and wrong in some branches.

The correct assertion is that `findOne` is only called once across two webhook deliveries — that is the precise proof that the second delivery short-circuited. I rewrote the test accordingly.

**2. DB_TYPE missing from .env (caught during env file setup)**

When asked to move DB parameters to an `.env` file, Claude moved `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASS`, and `DB_NAME` but left `type: 'postgres'` hardcoded in `app.module.ts`. This is inconsistent — if someone swaps to a different database driver, they would need to edit code rather than just the env file. I caught this and asked why it was not in the env too; it was corrected by adding `DB_TYPE=postgres` to `.env` and reading it via `ConfigService`.

**3. data-source.ts never created (caught during README review)**

The README's migration section referenced `src/data-source.ts` in the CLI command, but that file was never generated during the initial scaffolding. The TypeORM CLI requires a standalone DataSource export to run migrations outside of the NestJS runtime. Claude missed this entirely — it wrote the migration file and the README instruction but not the file that makes the instruction actually work. I caught the gap by asking directly, and the file was created.

---

## One thing I deliberately did not delegate to AI

I wrote the state transition table (`VALID_TRANSITIONS`) by hand rather than asking Claude to generate it from the spec.

This is the most critical correctness invariant in the whole system — it determines what money movements are possible. Getting it wrong (e.g. allowing RETURNED → FUNDED, or forgetting that FAILED is terminal) would mean money moving incorrectly in production. I wanted to reason through each edge myself, against the spec, and own the result. A generated table might look right and have a subtle gap I'd only catch during a real NSF scenario.

The state machine is also small enough (6 states, ~8 edges) that generating it isn't a meaningful time saving — it's just risk with no upside.
