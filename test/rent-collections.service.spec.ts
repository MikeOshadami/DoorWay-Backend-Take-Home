/**
 * Unit tests for RentCollectionsService.
 *
 * All TypeORM and VOPay dependencies are mocked — no real database or network
 * is required. We focus on the "hard" paths called out in the spec:
 *
 *  ✓ Double initiation → charged once
 *  ✓ Provider timeout → safe to retry (no double charge)
 *  ✓ Duplicate webhook → processed once
 *  ✓ Out-of-order webhook (funded after returned) → invalid transition rejected
 *  ✓ funded → returned (NSF) → ends in RETURNED
 *  ✓ Invalid webhook signature → rejected (covered in webhooks.controller.spec.ts)
 */

import { UnprocessableEntityException } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import {
  CollectionStatus,
  VALID_TRANSITIONS,
} from '../src/rent-collections/collection-status.enum';
import { VopayWebhookDto } from '../src/rent-collections/dto/vopay-webhook.dto';
import { RentCollectionAudit } from '../src/rent-collections/entities/rent-collection-audit.entity';
import { RentCollection } from '../src/rent-collections/entities/rent-collection.entity';
import { ProcessedWebhookEvent } from '../src/rent-collections/entities/processed-webhook-event.entity';
import {
  RentCollectionsService,
  buildIdempotencyKey,
  webhookStatusToCollectionStatus,
} from '../src/rent-collections/rent-collections.service';
import { InitiateCollectionDto } from '../src/rent-collections/dto/initiate-collection.dto';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCollection(overrides: Partial<RentCollection> = {}): RentCollection {
  return Object.assign(new RentCollection(), {
    id: 'col-uuid-1',
    leaseId: 'LEASE-1',
    period: '2026-06',
    amountCents: 150000,
    currency: 'CAD',
    idempotencyKey: buildIdempotencyKey('LEASE-1', '2026-06'),
    status: CollectionStatus.PENDING,
    providerTransactionId: null,
    createdAt: new Date('2026-06-01T00:00:00Z'),
    updatedAt: new Date('2026-06-01T00:00:00Z'),
    ...overrides,
  });
}

/**
 * Creates a minimal EntityManager mock.
 * `findOneReturnValue` is what `em.getRepository(RentCollection).findOne()` will return
 * when the test doesn't need to customise it further.
 */
function makeEntityManager(findOneReturnValue?: RentCollection): jest.Mocked<EntityManager> {
  const repoMock = {
    findOne: jest.fn().mockResolvedValue(findOneReturnValue ?? null),
  };

  return {
    getRepository: jest.fn().mockReturnValue(repoMock),
    save: jest.fn().mockImplementation(async (entity) => entity),
    create: jest.fn().mockImplementation((_cls, data) => data),
    createQueryBuilder: jest.fn().mockReturnValue({
      insert: jest.fn().mockReturnThis(),
      into: jest.fn().mockReturnThis(),
      values: jest.fn().mockReturnThis(),
      orIgnore: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue({ raw: [{ id: 'col-uuid-1' }], affected: 1 }),
    }),
  } as unknown as jest.Mocked<EntityManager>;
}

function makeVopay() {
  return {
    initiateDebit: jest.fn().mockResolvedValue({
      transactionId: 'vopay-tx-abc123',
      status: 'submitted',
    }),
    getTransaction: jest.fn().mockResolvedValue({
      transactionId: 'vopay-tx-abc123',
      status: 'submitted',
    }),
  };
}

function makeCollectionsRepo(findResult?: RentCollection | RentCollection[]) {
  return {
    find: jest.fn().mockResolvedValue(
      findResult === undefined ? [] : Array.isArray(findResult) ? findResult : [findResult],
    ),
    findOne: jest.fn().mockResolvedValue(
      Array.isArray(findResult) ? findResult[0] ?? null : findResult ?? null,
    ),
  };
}

function makeAuditsRepo() {
  return { save: jest.fn() };
}

function makeWebhookEventsRepo() {
  return { save: jest.fn() };
}

/**
 * Builds a DataSource whose `transaction` calls the callback with the given
 * EntityManager. Accepts an array of em values for multi-call sequences.
 */
function makeDataSource(entityManagers: EntityManager | EntityManager[]) {
  const ems = Array.isArray(entityManagers) ? entityManagers : [entityManagers];
  let callIndex = 0;
  return {
    transaction: jest.fn().mockImplementation(async (cb: (em: EntityManager) => Promise<unknown>) => {
      const em = ems[Math.min(callIndex, ems.length - 1)];
      callIndex++;
      return cb(em);
    }),
  } as unknown as DataSource;
}

// ---------------------------------------------------------------------------
// Service factory
// ---------------------------------------------------------------------------

function buildService({
  em,
  ems,
  vopay,
  collectionsRepo,
}: {
  em?: EntityManager;
  ems?: EntityManager[];
  vopay?: ReturnType<typeof makeVopay>;
  collectionsRepo?: ReturnType<typeof makeCollectionsRepo>;
} = {}): RentCollectionsService {
  const resolvedEms = ems ?? (em ? [em] : [makeEntityManager()]);
  const ds = makeDataSource(resolvedEms);
  const service = new RentCollectionsService(
    (collectionsRepo ?? makeCollectionsRepo()) as any,
    makeAuditsRepo() as any,
    makeWebhookEventsRepo() as any,
    ds,
    (vopay ?? makeVopay()) as any,
  );
  return service;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RentCollectionsService', () => {
  // ── Pure helpers ───────────────────────────────────────────────────────────

  describe('buildIdempotencyKey', () => {
    it('produces a deterministic, namespaced key', () => {
      expect(buildIdempotencyKey('LEASE-42', '2026-06')).toBe(
        'doorway:rent:LEASE-42:2026-06',
      );
    });

    it('is the same on every call with the same inputs', () => {
      const key1 = buildIdempotencyKey('L1', '2025-12');
      const key2 = buildIdempotencyKey('L1', '2025-12');
      expect(key1).toBe(key2);
    });
  });

  describe('webhookStatusToCollectionStatus', () => {
    it.each([
      ['funded', CollectionStatus.FUNDED],
      ['failed', CollectionStatus.FAILED],
      ['returned', CollectionStatus.RETURNED],
    ])('maps %s → %s', (input, expected) => {
      expect(webhookStatusToCollectionStatus(input)).toBe(expected);
    });

    it('returns null for submitted (no state change needed)', () => {
      expect(webhookStatusToCollectionStatus('submitted')).toBeNull();
    });
  });

  describe('VALID_TRANSITIONS state machine', () => {
    it('does not allow funded → funded', () => {
      expect(VALID_TRANSITIONS[CollectionStatus.FUNDED]).not.toContain(
        CollectionStatus.FUNDED,
      );
    });

    it('does not allow returned → anything', () => {
      expect(VALID_TRANSITIONS[CollectionStatus.RETURNED]).toHaveLength(0);
    });

    it('allows funded → returned (NSF bounce)', () => {
      expect(VALID_TRANSITIONS[CollectionStatus.FUNDED]).toContain(
        CollectionStatus.RETURNED,
      );
    });
  });

  // ── initiateCollection ─────────────────────────────────────────────────────

  describe('initiateCollection', () => {
    const dto: InitiateCollectionDto = {
      leaseId: 'LEASE-1',
      period: '2026-06',
      amountCents: 150000,
      currency: 'CAD',
    };

    it('happy path: inserts, claims, calls provider, updates to SUBMITTED', async () => {
      const pendingCollection = makeCollection({ status: CollectionStatus.PENDING });
      const initiatingCollection = makeCollection({ status: CollectionStatus.INITIATING });
      const vopay = makeVopay();

      // First transaction: claim — returns INITIATING after transition
      const em1 = makeEntityManager(pendingCollection);
      (em1.getRepository(RentCollection).findOne as jest.Mock).mockResolvedValue(pendingCollection);
      (em1.save as jest.Mock).mockImplementation(async (entity) => {
        if (entity instanceof Object && 'status' in entity) {
          entity.status = CollectionStatus.INITIATING;
        }
        return entity;
      });

      // Second transaction: persist provider result
      const em2 = makeEntityManager(initiatingCollection);

      const service = buildService({ ems: [em1, em2], vopay });
      const result = await service.initiateCollection(dto);

      expect(vopay.initiateDebit).toHaveBeenCalledTimes(1);
      expect(vopay.initiateDebit).toHaveBeenCalledWith(
        expect.objectContaining({
          idempotencyKey: buildIdempotencyKey(dto.leaseId, dto.period),
          amountCents: dto.amountCents,
          currency: dto.currency,
        }),
      );
      expect(result.status).toBe(CollectionStatus.SUBMITTED);
    });

    /**
     * TRICKY PATH 1: Double initiation
     *
     * The second request should find the row already in SUBMITTED (or any
     * non-PENDING state) and return it without calling VOPay a second time.
     */
    it('double initiation: second call does NOT call the provider again', async () => {
      const submittedCollection = makeCollection({
        status: CollectionStatus.SUBMITTED,
        providerTransactionId: 'vopay-tx-abc123',
      });
      const vopay = makeVopay();

      // Both transactions see the row in SUBMITTED → claimed=false
      const em = makeEntityManager(submittedCollection);
      const ds = makeDataSource([em, em]);

      const service = new RentCollectionsService(
        makeCollectionsRepo(submittedCollection) as any,
        makeAuditsRepo() as any,
        makeWebhookEventsRepo() as any,
        ds,
        vopay as any,
      );

      const result1 = await service.initiateCollection(dto);
      const result2 = await service.initiateCollection(dto);

      // Provider was never called — row was already SUBMITTED
      expect(vopay.initiateDebit).not.toHaveBeenCalled();
      expect(result1.status).toBe(CollectionStatus.SUBMITTED);
      expect(result2.status).toBe(CollectionStatus.SUBMITTED);
    });

    /**
     * TRICKY PATH 2: Provider timeout → retry is safe, no double charge
     *
     * Scenario:
     *  - First call: provider times out; service reverts to PENDING and throws.
     *  - Second call: same idempotency key; provider now succeeds and returns
     *    the same transactionId (because VOPay's idempotency handling).
     *
     * We verify initiateDebit is called twice with the SAME idempotency key,
     * and the final state is SUBMITTED.
     */
    it('provider timeout: retry uses same idempotency key and succeeds', async () => {
      const pendingCollection = makeCollection({ status: CollectionStatus.PENDING });
      const vopay = makeVopay();

      // First call: initiateDebit throws
      vopay.initiateDebit
        .mockRejectedValueOnce(new Error('VOPay timeout'))
        // Second call: succeeds
        .mockResolvedValueOnce({ transactionId: 'vopay-tx-abc123', status: 'submitted' });

      // Simulate: em for claim (tx1), em for revert to PENDING (tx2)
      const em1Claim = makeEntityManager(pendingCollection);
      const em1Revert = makeEntityManager(pendingCollection);
      // Second attempt: em for claim again, em for SUBMITTED persist
      const em2Claim = makeEntityManager(pendingCollection);
      const em2Submit = makeEntityManager(makeCollection({ status: CollectionStatus.INITIATING }));

      const ds = makeDataSource([em1Claim, em1Revert, em2Claim, em2Submit]);

      const service = new RentCollectionsService(
        makeCollectionsRepo(pendingCollection) as any,
        makeAuditsRepo() as any,
        makeWebhookEventsRepo() as any,
        ds,
        vopay as any,
      );

      // First call — should throw
      await expect(service.initiateCollection(dto)).rejects.toThrow('VOPay timeout');

      // Second call — should succeed
      const result = await service.initiateCollection(dto);

      // Two provider calls, both with the same deterministic idempotency key
      expect(vopay.initiateDebit).toHaveBeenCalledTimes(2);
      const [call1, call2] = vopay.initiateDebit.mock.calls;
      expect(call1[0].idempotencyKey).toBe(call2[0].idempotencyKey);
      expect(result.status).toBe(CollectionStatus.SUBMITTED);
    });
  });

  // ── handleWebhook ──────────────────────────────────────────────────────────

  describe('handleWebhook', () => {
    function makeWebhookPayload(overrides: Partial<VopayWebhookDto> = {}): VopayWebhookDto {
      return Object.assign(new VopayWebhookDto(), {
        eventId: 'evt-001',
        transactionId: 'vopay-tx-abc123',
        status: 'funded' as const,
        occurredAt: '2026-06-02T10:00:00Z',
        ...overrides,
      });
    }

    /**
     * TRICKY PATH 3: Duplicate webhook delivery
     *
     * The provider delivers the same event twice. The second delivery must be
     * a no-op — the state must not change and no duplicate audit row created.
     */
    it('duplicate webhook: second delivery is a no-op (deduplication by eventId)', async () => {
      const submittedCollection = makeCollection({
        status: CollectionStatus.SUBMITTED,
        providerTransactionId: 'vopay-tx-abc123',
      });
      const payload = makeWebhookPayload();

      let insertCallCount = 0;
      // First insert: returns affected=1 (processed)
      // Second insert: returns raw=[] (conflict, already processed)
      const em = {
        getRepository: jest.fn().mockReturnValue({
          findOne: jest.fn().mockResolvedValue(submittedCollection),
        }),
        save: jest.fn().mockResolvedValue({}),
        create: jest.fn().mockImplementation((_cls, data) => data),
        createQueryBuilder: jest.fn().mockImplementation(() => ({
          insert: jest.fn().mockReturnThis(),
          into: jest.fn().mockReturnThis(),
          values: jest.fn().mockReturnThis(),
          orIgnore: jest.fn().mockReturnThis(),
          execute: jest.fn().mockImplementation(async () => {
            insertCallCount++;
            // First call: success; subsequent: conflict (raw=[])
            return insertCallCount === 1
              ? { raw: [{ event_id: payload.eventId }], affected: 1 }
              : { raw: [], affected: 0 };
          }),
        })),
      } as unknown as EntityManager;

      const ds = makeDataSource([em, em]);
      const service = new RentCollectionsService(
        makeCollectionsRepo(submittedCollection) as any,
        makeAuditsRepo() as any,
        makeWebhookEventsRepo() as any,
        ds,
        makeVopay() as any,
      );

      await service.handleWebhook(payload);
      await service.handleWebhook(payload); // duplicate

      // save should have been called once for the state transition + audit,
      // not a second time for the duplicate.
      // The collection's findOne should only be reached on the FIRST delivery.
      const repoMock = em.getRepository(RentCollection);
      expect(repoMock.findOne).toHaveBeenCalledTimes(1);
    });

    /**
     * TRICKY PATH 4: Out-of-order webhook
     *
     * A "funded" event arrives after the collection is already "returned".
     * The state machine must reject the invalid transition.
     */
    it('out-of-order webhook: funded event after returned is rejected', async () => {
      const returnedCollection = makeCollection({
        status: CollectionStatus.RETURNED,
        providerTransactionId: 'vopay-tx-abc123',
      });
      // Deliver a "funded" event — this would be a late/duplicate event
      const payload = makeWebhookPayload({ status: 'funded', eventId: 'evt-stale' });

      const em = {
        getRepository: jest.fn().mockReturnValue({
          findOne: jest.fn().mockResolvedValue(returnedCollection),
        }),
        save: jest.fn().mockResolvedValue({}),
        create: jest.fn().mockImplementation((_cls, data) => data),
        createQueryBuilder: jest.fn().mockImplementation(() => ({
          insert: jest.fn().mockReturnThis(),
          into: jest.fn().mockReturnThis(),
          values: jest.fn().mockReturnThis(),
          orIgnore: jest.fn().mockReturnThis(),
          // First call is the eventId deduplication insert — succeed
          execute: jest.fn().mockResolvedValue({ raw: [{ event_id: 'evt-stale' }], affected: 1 }),
        })),
      } as unknown as EntityManager;

      const ds = makeDataSource(em);
      const service = new RentCollectionsService(
        makeCollectionsRepo(returnedCollection) as any,
        makeAuditsRepo() as any,
        makeWebhookEventsRepo() as any,
        ds,
        makeVopay() as any,
      );

      // Should NOT throw — webhook must always be acknowledged 200 OK
      await expect(service.handleWebhook(payload)).resolves.toBeUndefined();

      // The collection status must remain RETURNED
      const savedCalls = (em.save as jest.Mock).mock.calls;
      for (const [entity] of savedCalls) {
        if (entity && typeof entity === 'object' && 'status' in entity) {
          expect(entity.status).not.toBe(CollectionStatus.FUNDED);
        }
      }
    });

    /**
     * TRICKY PATH 5: funded → returned (NSF bounce)
     *
     * A collection that successfully settled later receives a "returned" event.
     * This is the canonical NSF scenario — money came in, then bounced back.
     * The final state must be RETURNED.
     */
    it('funded → returned (NSF): valid transition ends in RETURNED', async () => {
      const fundedCollection = makeCollection({
        status: CollectionStatus.FUNDED,
        providerTransactionId: 'vopay-tx-abc123',
      });
      const payload = makeWebhookPayload({ status: 'returned', eventId: 'evt-nsf' });

      const em = {
        getRepository: jest.fn().mockReturnValue({
          findOne: jest.fn().mockResolvedValue(fundedCollection),
        }),
        save: jest.fn().mockImplementation(async (entity) => entity),
        create: jest.fn().mockImplementation((_cls, data) => data),
        createQueryBuilder: jest.fn().mockImplementation(() => ({
          insert: jest.fn().mockReturnThis(),
          into: jest.fn().mockReturnThis(),
          values: jest.fn().mockReturnThis(),
          orIgnore: jest.fn().mockReturnThis(),
          execute: jest.fn().mockResolvedValue({ raw: [{ event_id: 'evt-nsf' }], affected: 1 }),
        })),
      } as unknown as EntityManager;

      const ds = makeDataSource(em);
      const service = new RentCollectionsService(
        makeCollectionsRepo(fundedCollection) as any,
        makeAuditsRepo() as any,
        makeWebhookEventsRepo() as any,
        ds,
        makeVopay() as any,
      );

      await service.handleWebhook(payload);

      // Verify save was called with RETURNED status on the collection
      const savedEntities = (em.save as jest.Mock).mock.calls.map(([e]) => e);
      const collectionSave = savedEntities.find(
        (e) => e && typeof e === 'object' && 'leaseId' in e,
      );
      expect(collectionSave?.status).toBe(CollectionStatus.RETURNED);
    });
  });

  // ── applyTransition ────────────────────────────────────────────────────────

  describe('applyTransition', () => {
    it('throws UnprocessableEntityException for invalid transitions', async () => {
      const service = buildService();
      const collection = makeCollection({ status: CollectionStatus.FUNDED });
      const em = makeEntityManager();

      await expect(
        service.applyTransition(em, collection, CollectionStatus.PENDING, 'test'),
      ).rejects.toThrow(UnprocessableEntityException);
    });

    it('accepts returned → terminal (no further transitions possible)', async () => {
      const service = buildService();
      const collection = makeCollection({ status: CollectionStatus.RETURNED });
      const em = makeEntityManager();

      await expect(
        service.applyTransition(em, collection, CollectionStatus.FUNDED, 'test'),
      ).rejects.toThrow(UnprocessableEntityException);
    });

    it('writes an audit row on every valid transition', async () => {
      const service = buildService();
      const collection = makeCollection({ status: CollectionStatus.PENDING });
      const em = makeEntityManager();

      await service.applyTransition(
        em,
        collection,
        CollectionStatus.INITIATING,
        'api',
        'test detail',
      );

      expect(em.save).toHaveBeenCalledTimes(2); // collection + audit
      const auditCall = (em.create as jest.Mock).mock.calls.find(
        ([_cls, data]) => data && 'fromStatus' in data,
      );
      expect(auditCall[1]).toMatchObject({
        fromStatus: CollectionStatus.PENDING,
        toStatus: CollectionStatus.INITIATING,
        source: 'api',
        detail: 'test detail',
      });
    });
  });

  // ── reconcile ─────────────────────────────────────────────────────────────

  describe('reconcile', () => {
    it('reconciles a stuck SUBMITTED collection when provider says funded', async () => {
      const staleDate = new Date(Date.now() - 20 * 60 * 1000);
      const submittedCollection = makeCollection({
        status: CollectionStatus.SUBMITTED,
        providerTransactionId: 'vopay-tx-abc123',
        updatedAt: staleDate,
      });

      const vopay = makeVopay();
      vopay.getTransaction.mockResolvedValue({
        transactionId: 'vopay-tx-abc123',
        status: 'funded',
      });

      const lockEm = {
        getRepository: jest.fn().mockReturnValue({
          findOne: jest.fn().mockResolvedValue(submittedCollection),
        }),
        save: jest.fn().mockImplementation(async (e) => e),
        create: jest.fn().mockImplementation((_c, d) => d),
      } as unknown as EntityManager;

      const service = new RentCollectionsService(
        makeCollectionsRepo([submittedCollection]) as any,
        makeAuditsRepo() as any,
        makeWebhookEventsRepo() as any,
        makeDataSource(lockEm),
        vopay as any,
      );

      const result = await service.reconcile();
      expect(result.reconciled).toBe(1);
      expect(result.errors).toHaveLength(0);

      const savedEntities = (lockEm.save as jest.Mock).mock.calls.map(([e]) => e);
      const collectionSave = savedEntities.find((e) => e && 'leaseId' in e);
      expect(collectionSave?.status).toBe(CollectionStatus.FUNDED);
    });

    it('returns errors array and does not throw when one collection fails', async () => {
      const staleDate = new Date(Date.now() - 20 * 60 * 1000);
      const collection = makeCollection({
        status: CollectionStatus.SUBMITTED,
        providerTransactionId: 'vopay-tx-bad',
        updatedAt: staleDate,
      });

      const vopay = makeVopay();
      vopay.getTransaction.mockRejectedValue(new Error('VOPay 503'));

      const service = new RentCollectionsService(
        makeCollectionsRepo([collection]) as any,
        makeAuditsRepo() as any,
        makeWebhookEventsRepo() as any,
        makeDataSource(makeEntityManager()) as any,
        vopay as any,
      );

      const result = await service.reconcile();
      expect(result.reconciled).toBe(0);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain('VOPay 503');
    });
  });
});
