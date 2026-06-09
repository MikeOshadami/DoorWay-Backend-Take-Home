import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  UnprocessableEntityException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, LessThan, In, Repository } from 'typeorm';
import { CollectionStatus, VALID_TRANSITIONS } from './collection-status.enum';
import { InitiateCollectionDto } from './dto/initiate-collection.dto';
import { VopayWebhookDto } from './dto/vopay-webhook.dto';
import { RentCollectionAudit } from './entities/rent-collection-audit.entity';
import { RentCollection } from './entities/rent-collection.entity';
import { ProcessedWebhookEvent } from './entities/processed-webhook-event.entity';
import {
  VOPAY_CLIENT,
  VopayClient,
} from './providers/vopay-client.interface';

/** How old a SUBMITTED/INITIATING record must be before reconciliation touches it. */
const STALE_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes

@Injectable()
export class RentCollectionsService {
  private readonly logger = new Logger(RentCollectionsService.name);

  constructor(
    @InjectRepository(RentCollection)
    private readonly collections: Repository<RentCollection>,
    @InjectRepository(RentCollectionAudit)
    private readonly audits: Repository<RentCollectionAudit>,
    @InjectRepository(ProcessedWebhookEvent)
    private readonly webhookEvents: Repository<ProcessedWebhookEvent>,
    private readonly dataSource: DataSource,
    @Inject(VOPAY_CLIENT)
    private readonly vopay: VopayClient,
  ) {}

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Initiate a rent collection for a lease period.
   *
   * Idempotency guarantees:
   *  1. DB unique constraint on (leaseId, period) — only one row per billing cycle.
   *  2. Deterministic idempotency key — the same key is sent to VOPay on every
   *     attempt, so a timeout-then-retry never double-charges.
   *  3. SELECT FOR UPDATE + INITIATING status — concurrent requests for the same
   *     lease/period see the row is claimed and bail out without calling VOPay.
   */
  async initiateCollection(dto: InitiateCollectionDto): Promise<RentCollection> {
    const idempotencyKey = buildIdempotencyKey(dto.leaseId, dto.period);

    // ── Phase 1: claim the row (short transaction, no external I/O) ──────────
    const { collection, claimed } = await this.dataSource.transaction(
      async (em) => {
        // Insert a PENDING row if none exists yet (ON CONFLICT DO NOTHING is
        // atomic; the unique constraint prevents any duplicate from slipping
        // through even under concurrent load).
        await em
          .createQueryBuilder()
          .insert()
          .into(RentCollection)
          .values({
            leaseId: dto.leaseId,
            period: dto.period,
            amountCents: dto.amountCents,
            currency: dto.currency,
            idempotencyKey,
            status: CollectionStatus.PENDING,
          })
          .orIgnore()
          .execute();

        // Lock the row for the remainder of this transaction so no concurrent
        // request can claim it at the same time.
        const row = await em
          .getRepository(RentCollection)
          .findOne({
            where: { leaseId: dto.leaseId, period: dto.period },
            lock: { mode: 'pessimistic_write' },
          });

        if (!row) {
          // Should never happen — we just inserted or a row already existed.
          throw new Error('Invariant violation: collection row missing after upsert');
        }

        // If already past PENDING, someone else handled it (or is handling it).
        if (row.status !== CollectionStatus.PENDING) {
          return { collection: row, claimed: false };
        }

        // Transition to INITIATING so concurrent retries see "in progress".
        await this.applyTransition(em, row, CollectionStatus.INITIATING, 'api');
        return { collection: row, claimed: true };
      },
    );

    if (!claimed) {
      this.logger.log(
        `Collection for lease=${dto.leaseId} period=${dto.period} ` +
          `is already in status=${collection.status} — returning existing record`,
      );
      return collection;
    }

    // ── Phase 2: call VOPay (outside transaction, may be slow / timeout) ─────
    try {
      const result = await this.vopay.initiateDebit({
        idempotencyKey,
        amountCents: dto.amountCents,
        currency: dto.currency,
        // accountRef resolves the tenant's bank account. In a full system this
        // comes from a separate Accounts service; we use leaseId as a stand-in
        // here. See SOLUTION.md for the full discussion.
        accountRef: dto.leaseId,
      });

      // ── Phase 3: persist provider result ────────────────────────────────────
      await this.dataSource.transaction(async (em) => {
        const row = await em
          .getRepository(RentCollection)
          .findOne({ where: { id: collection.id } });

        row.providerTransactionId = result.transactionId;
        await this.applyTransition(em, row, CollectionStatus.SUBMITTED, 'api');
      });

      this.logger.log(
        `Collection ${collection.id} submitted — providerTxId=${result.transactionId}`,
      );

      return {
        ...collection,
        status: CollectionStatus.SUBMITTED,
        providerTransactionId: result.transactionId,
      } as RentCollection;
    } catch (err) {
      // Revert to PENDING so the client can retry safely. The deterministic
      // idempotency key means any subsequent initiateDebit call is harmless even
      // if VOPay actually created the debit (they'll return the same txId).
      this.logger.warn(
        `VOPay initiateDebit failed for collection ${collection.id}: ${err.message} — reverting to PENDING`,
      );

      try {
        await this.dataSource.transaction(async (em) => {
          const row = await em
            .getRepository(RentCollection)
            .findOne({ where: { id: collection.id } });

          await this.applyTransition(
            em,
            row,
            CollectionStatus.PENDING,
            'api',
            `Provider call failed: ${err.message}`,
          );
        });
      } catch (revertErr) {
        // If the revert itself fails (e.g. DB down) the row stays in INITIATING.
        // Reconciliation will recover it. Log and propagate the original error.
        this.logger.error(
          `Failed to revert collection ${collection.id} to PENDING: ${revertErr.message}`,
        );
      }

      throw err;
    }
  }

  /**
   * Process a VOPay settlement webhook.
   *
   * This handler is idempotent: the eventId is written to processed_webhook_events
   * inside the same transaction as the state transition. A duplicate delivery
   * fails the INSERT (unique PK) and we return without re-applying the change.
   *
   * Out-of-order delivery is handled by the state machine: if the transition
   * is invalid (e.g. a stale "funded" event arrives after the record is already
   * "returned") we log it and move on.
   */
  async handleWebhook(payload: VopayWebhookDto): Promise<void> {
    await this.dataSource.transaction(async (em) => {
      // ── Deduplication ───────────────────────────────────────────────────────
      // Try to claim the eventId. If the row already exists the INSERT is
      // silently ignored and we return without touching the collection.
      const insertResult = await em
        .createQueryBuilder()
        .insert()
        .into(ProcessedWebhookEvent)
        .values({ eventId: payload.eventId })
        .orIgnore()
        .execute();

      const alreadyProcessed = insertResult.raw.length === 0;
      if (alreadyProcessed) {
        this.logger.log(`Duplicate webhook eventId=${payload.eventId} — skipping`);
        return;
      }

      // ── Locate the collection ────────────────────────────────────────────────
      const collection = await em
        .getRepository(RentCollection)
        .findOne({ where: { providerTransactionId: payload.transactionId } });

      if (!collection) {
        // Provider may send events for transactions we don't recognise yet
        // (e.g. race between webhook and our DB write). Log and acknowledge.
        this.logger.warn(
          `Webhook for unknown transactionId=${payload.transactionId} (eventId=${payload.eventId})`,
        );
        return;
      }

      // ── State transition ─────────────────────────────────────────────────────
      const targetStatus = webhookStatusToCollectionStatus(payload.status);
      if (!targetStatus) {
        // "submitted" webhooks carry no new information for us
        return;
      }

      const validNext = VALID_TRANSITIONS[collection.status];
      if (!validNext.includes(targetStatus)) {
        // Out-of-order or duplicate status — reject the transition but still
        // acknowledge the webhook (returning an error would cause re-delivery).
        this.logger.warn(
          `Invalid transition ${collection.status} → ${targetStatus} ` +
            `for collection ${collection.id} (eventId=${payload.eventId}) — ignoring`,
        );
        // Record the rejection in the audit trail for observability.
        await em.save(
          em.create(RentCollectionAudit, {
            collectionId: collection.id,
            fromStatus: collection.status,
            toStatus: targetStatus,
            source: 'webhook',
            detail: `Rejected: invalid transition (eventId=${payload.eventId})`,
          }),
        );
        return;
      }

      await this.applyTransition(
        em,
        collection,
        targetStatus,
        'webhook',
        `eventId=${payload.eventId} occurredAt=${payload.occurredAt}`,
      );

      this.logger.log(
        `Collection ${collection.id} transitioned to ${targetStatus} via webhook ${payload.eventId}`,
      );

      // ── TODO: NSF / RETURNED notification (webhook path) ──────────────────
      // When a previously-funded collection bounces back (NSF), the property
      // manager needs to know immediately so they can follow up with the tenant.
      //
      // Suggested implementation:
      //
      //   if (targetStatus === CollectionStatus.RETURNED) {
      //     await this.notificationsService.notifyPropertyManager({
      //       event:       'RENT_COLLECTION_RETURNED',
      //       leaseId:     collection.leaseId,
      //       period:      collection.period,
      //       amountCents: collection.amountCents,
      //       currency:    collection.currency,
      //       occurredAt:  payload.occurredAt,
      //       message:     `Rent collection for lease ${collection.leaseId} ` +
      //                    `(${collection.period}) was returned NSF. ` +
      //                    `Amount: ${collection.currency} ${(collection.amountCents / 100).toFixed(2)}.`,
      //     });
      //   }
      //
      // Options for NotificationsService delivery:
      //   • Email  — nodemailer / SendGrid / AWS SES
      //   • SMS    — Twilio
      //   • Push   — Firebase / OneSignal
      //   • Slack  — Slack Web API (webhook to #property-managers channel)
      //
      // The notification should be sent OUTSIDE this DB transaction (or queued)
      // so a failed email delivery does not roll back the RETURNED state.
      // A Bull/BullMQ job queue (Redis-backed) is the recommended pattern:
      //   emit a CollectionReturnedEvent here, process the notification in a
      //   separate worker that retries on failure.
      // ───────────────────────────────────────────────────────────────────────
    });
  }

  /**
   * Reconcile stale collections against the provider.
   *
   * Handles two stuck states:
   *  - INITIATING: process crashed between claiming the row and getting a
   *    transactionId. Re-call initiateDebit with the deterministic idempotency
   *    key — VOPay returns the existing txId if the debit was already created.
   *  - SUBMITTED: webhook was lost or delayed. Poll getTransaction for the
   *    current status and apply it.
   */
  async reconcile(): Promise<{ reconciled: number; errors: string[] }> {
    const cutoff = new Date(Date.now() - STALE_THRESHOLD_MS);
    const stale = await this.collections.find({
      where: [
        { status: CollectionStatus.INITIATING, updatedAt: LessThan(cutoff) },
        { status: CollectionStatus.SUBMITTED, updatedAt: LessThan(cutoff) },
      ],
    });

    let reconciled = 0;
    const errors: string[] = [];

    for (const collection of stale) {
      try {
        if (collection.status === CollectionStatus.INITIATING) {
          await this.reconcileInitiating(collection);
        } else {
          await this.reconcileSubmitted(collection);
        }
        reconciled++;
      } catch (err) {
        const msg = `collection ${collection.id}: ${err.message}`;
        this.logger.error(`Reconciliation error — ${msg}`);
        errors.push(msg);
      }
    }

    this.logger.log(`Reconciliation done: ${reconciled} updated, ${errors.length} errors`);
    return { reconciled, errors };
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Re-attempts provider submission for a collection stuck in INITIATING.
   * Safe because the idempotency key is deterministic — VOPay will return the
   * same transactionId if the original debit was created.
   */
  private async reconcileInitiating(collection: RentCollection): Promise<void> {
    const result = await this.vopay.initiateDebit({
      idempotencyKey: collection.idempotencyKey,
      amountCents: collection.amountCents,
      currency: collection.currency,
      accountRef: collection.leaseId,
    });

    await this.dataSource.transaction(async (em) => {
      const row = await em
        .getRepository(RentCollection)
        .findOne({ where: { id: collection.id }, lock: { mode: 'pessimistic_write' } });

      // Another process may have already advanced this row.
      if (row.status !== CollectionStatus.INITIATING) return;

      row.providerTransactionId = result.transactionId;
      await this.applyTransition(
        em,
        row,
        CollectionStatus.SUBMITTED,
        'reconciliation',
        'Recovered from INITIATING via reconciliation',
      );
    });
  }

  /** Polls VOPay and applies the result to a SUBMITTED collection. */
  private async reconcileSubmitted(collection: RentCollection): Promise<void> {
    const providerResult = await this.vopay.getTransaction(
      collection.providerTransactionId,
    );

    const targetStatus = webhookStatusToCollectionStatus(providerResult.status);
    if (!targetStatus) return; // Still 'submitted' on provider side — nothing to do

    await this.dataSource.transaction(async (em) => {
      const row = await em
        .getRepository(RentCollection)
        .findOne({ where: { id: collection.id }, lock: { mode: 'pessimistic_write' } });

      if (row.status !== CollectionStatus.SUBMITTED) return; // Already moved on

      await this.applyTransition(
        em,
        row,
        targetStatus,
        'reconciliation',
        `Resolved via polling: provider status=${providerResult.status}`,
      );

      // ── TODO: NSF / RETURNED notification (reconciliation path) ───────────
      // Reconciliation can also discover a RETURNED status when a webhook was
      // lost. The same property-manager notification applies here.
      //
      //   if (targetStatus === CollectionStatus.RETURNED) {
      //     await this.notificationsService.notifyPropertyManager({ ... });
      //   }
      //
      // See the webhook path above for the full implementation sketch.
      // ───────────────────────────────────────────────────────────────────────
    });
  }

  /**
   * Core state-machine enforcer. Validates the transition, persists it, and
   * writes an audit row — all within the caller's EntityManager (transaction).
   */
  async applyTransition(
    em: EntityManager,
    collection: RentCollection,
    toStatus: CollectionStatus,
    source: string,
    detail?: string,
  ): Promise<void> {
    const validNext = VALID_TRANSITIONS[collection.status];
    if (!validNext.includes(toStatus)) {
      throw new UnprocessableEntityException(
        `Invalid status transition: ${collection.status} → ${toStatus}`,
      );
    }

    const fromStatus = collection.status;
    collection.status = toStatus;
    await em.save(collection);

    await em.save(
      em.create(RentCollectionAudit, {
        collectionId: collection.id,
        fromStatus,
        toStatus,
        source,
        detail: detail ?? null,
      }),
    );

    // ── TODO: Domain event emission (general hook point) ────────────────────
    // applyTransition() is the single choke point for every status change.
    // This makes it the right place to emit domain events that other parts of
    // the system (notifications, ledger updates, analytics) can subscribe to.
    //
    // Example using NestJS EventEmitter2:
    //
    //   this.eventEmitter.emit(`collection.${toStatus}`, {
    //     collectionId: collection.id,
    //     leaseId:      collection.leaseId,
    //     period:       collection.period,
    //     amountCents:  collection.amountCents,
    //     currency:     collection.currency,
    //     fromStatus,
    //     toStatus,
    //     source,
    //   });
    //
    // Listeners then handle their own concerns independently:
    //
    //   @OnEvent('collection.returned')
    //   async handleReturned(event: CollectionReturnedEvent) {
    //     await this.notificationsService.notifyPropertyManager(event);
    //     await this.ledgerService.reverseEntry(event);
    //   }
    //
    //   @OnEvent('collection.funded')
    //   async handleFunded(event: CollectionFundedEvent) {
    //     await this.ledgerService.recordReceipt(event);
    //   }
    //
    // IMPORTANT: emit the event AFTER the DB transaction commits, not inside it.
    // If the notification fails, you do not want to roll back the state change.
    // Use a Bull/BullMQ job queue for guaranteed at-least-once delivery.
    // ─────────────────────────────────────────────────────────────────────────
  }
}

// ---------------------------------------------------------------------------
// Module-level helpers (pure functions, easy to test)
// ---------------------------------------------------------------------------

/** Deterministic idempotency key scoped to one billing cycle of one lease. */
export function buildIdempotencyKey(leaseId: string, period: string): string {
  return `doorway:rent:${leaseId}:${period}`;
}

/** Maps VOPay webhook/poll status values to our internal CollectionStatus. */
export function webhookStatusToCollectionStatus(
  providerStatus: string,
): CollectionStatus | null {
  const map: Partial<Record<string, CollectionStatus>> = {
    funded: CollectionStatus.FUNDED,
    failed: CollectionStatus.FAILED,
    returned: CollectionStatus.RETURNED,
  };
  return map[providerStatus] ?? null;
}
