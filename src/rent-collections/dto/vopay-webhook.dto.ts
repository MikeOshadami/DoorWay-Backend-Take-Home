import { IsDateString, IsIn, IsNotEmpty, IsString } from 'class-validator';

export class VopayWebhookDto {
  /** Provider-assigned globally unique event id — used for deduplication. */
  @IsString()
  @IsNotEmpty()
  eventId: string;

  @IsString()
  @IsNotEmpty()
  transactionId: string;

  @IsIn(['submitted', 'funded', 'failed', 'returned'])
  status: 'submitted' | 'funded' | 'failed' | 'returned';

  @IsDateString()
  occurredAt: string;
}
