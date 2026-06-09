export enum CollectionStatus {
  /** Created locally; provider has not been called yet. Safe to retry. */
  PENDING = 'pending',
  /**
   * Provider call in-flight. We own this row for the duration of the external
   * call. If the process crashes here the record stays INITIATING — the
   * reconciliation job will sort it out via the deterministic idempotency key.
   */
  INITIATING = 'initiating',
  /** Provider accepted the debit; settlement will arrive via webhook. */
  SUBMITTED = 'submitted',
  /** Webhook confirmed the funds were collected successfully. */
  FUNDED = 'funded',
  /** Provider confirmed the debit failed outright (e.g. hard-fail). */
  FAILED = 'failed',
  /**
   * Debit was previously FUNDED but then bounced (NSF). This is the terminal
   * unhappy state — money that came in has been reversed.
   */
  RETURNED = 'returned',
}

/**
 * State machine — the only permitted forward transitions.
 * Any attempt to move outside these edges must be rejected.
 */
export const VALID_TRANSITIONS: Record<CollectionStatus, CollectionStatus[]> = {
  [CollectionStatus.PENDING]: [CollectionStatus.INITIATING],
  [CollectionStatus.INITIATING]: [CollectionStatus.SUBMITTED, CollectionStatus.PENDING],
  [CollectionStatus.SUBMITTED]: [CollectionStatus.FUNDED, CollectionStatus.FAILED],
  [CollectionStatus.FUNDED]: [CollectionStatus.RETURNED],
  [CollectionStatus.FAILED]: [],
  [CollectionStatus.RETURNED]: [],
};
