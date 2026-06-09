/** Injection token for the VOPay client. */
export const VOPAY_CLIENT = 'VOPAY_CLIENT';

export type VopayDebitResult = {
  transactionId: string;
  /** Provider accepted it for processing; final outcome arrives by webhook. */
  status: 'submitted';
};

export interface VopayClient {
  /**
   * Initiates an EFT debit pull from the tenant's bank account.
   *
   * This call is SLOW and CAN TIME OUT. If it throws you do NOT know whether
   * the debit was created on the provider side — hence the deterministic
   * idempotency key: a retry with the same key is always safe.
   */
  initiateDebit(input: {
    idempotencyKey: string;
    amountCents: number;
    currency: string;
    accountRef: string;
  }): Promise<VopayDebitResult>;

  /**
   * Polls the current status of a known transaction.
   * Used by the reconciliation job for collections stuck in SUBMITTED.
   */
  getTransaction(transactionId: string): Promise<{
    transactionId: string;
    status: 'submitted' | 'funded' | 'failed' | 'returned';
  }>;
}
