import { IsInt, IsNotEmpty, IsPositive, IsString, Matches } from 'class-validator';

export class InitiateCollectionDto {
  @IsString()
  @IsNotEmpty()
  leaseId: string;

  /**
   * Billing period. Must be YYYY-MM to keep the idempotency key stable and
   * sortable, and to prevent ambiguous re-submissions.
   */
  @IsString()
  @Matches(/^\d{4}-\d{2}$/, { message: 'period must be in YYYY-MM format' })
  period: string;

  /** Integer cents — no floats allowed. */
  @IsInt()
  @IsPositive()
  amountCents: number;

  @IsString()
  @IsNotEmpty()
  currency: string;
}
