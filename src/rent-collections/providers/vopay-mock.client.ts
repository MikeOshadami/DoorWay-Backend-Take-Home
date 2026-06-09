import { Injectable } from '@nestjs/common';
import { VopayClient, VopayDebitResult } from './vopay-client.interface';

/**
 * In-memory mock of the VOPay EFT rail.
 *
 * Behaviour is controlled by the static `scenarios` map so tests can inject
 * per-idempotencyKey outcomes without subclassing.
 *
 * Default behaviour: first call succeeds; subsequent calls with the same
 * idempotency key return the same transactionId (idempotent, as a real
 * provider would behave).
 */
@Injectable()
export class VopayMockClient implements VopayClient {
  private readonly store = new Map<
    string,
    { transactionId: string; status: 'submitted' | 'funded' | 'failed' | 'returned' }
  >();

  /** Override per-key for test scenarios. */
  private readonly overrides = new Map<string, () => Promise<VopayDebitResult>>();

  /** Simulate a timeout for a given idempotency key on its next call. */
  simulateTimeout(idempotencyKey: string): void {
    this.overrides.set(idempotencyKey, async () => {
      throw new Error(`VOPay timeout for key ${idempotencyKey}`);
    });
  }

  async initiateDebit(input: {
    idempotencyKey: string;
    amountCents: number;
    currency: string;
    accountRef: string;
  }): Promise<VopayDebitResult> {
    // Check for injected override (e.g. timeout simulation)
    const override = this.overrides.get(input.idempotencyKey);
    if (override) {
      this.overrides.delete(input.idempotencyKey); // one-shot
      return override();
    }

    // Idempotent: if we've seen this key, return the same transactionId
    if (this.store.has(input.idempotencyKey)) {
      const record = this.store.get(input.idempotencyKey);
      return { transactionId: record.transactionId, status: 'submitted' };
    }

    const transactionId = `vopay-tx-${Math.random().toString(36).slice(2)}`;
    this.store.set(input.idempotencyKey, { transactionId, status: 'submitted' });
    return { transactionId, status: 'submitted' };
  }

  async getTransaction(transactionId: string): Promise<{
    transactionId: string;
    status: 'submitted' | 'funded' | 'failed' | 'returned';
  }> {
    for (const record of this.store.values()) {
      if (record.transactionId === transactionId) {
        return record;
      }
    }
    throw new Error(`VOPay: unknown transactionId ${transactionId}`);
  }

  /** Test helper — advance the provider-side status of a transaction. */
  setTransactionStatus(
    transactionId: string,
    status: 'submitted' | 'funded' | 'failed' | 'returned',
  ): void {
    for (const [key, record] of this.store.entries()) {
      if (record.transactionId === transactionId) {
        this.store.set(key, { ...record, status });
        return;
      }
    }
    throw new Error(`Mock: unknown transactionId ${transactionId}`);
  }
}
