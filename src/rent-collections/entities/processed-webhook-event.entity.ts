import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';

/**
 * Deduplication table for VOPay webhook events.
 * We INSERT the eventId here atomically with the state transition.
 * If the provider delivers the same event twice the INSERT will conflict and
 * we short-circuit before touching the collection — making the handler
 * naturally idempotent.
 */
@Entity('processed_webhook_events')
export class ProcessedWebhookEvent {
  /** VOPay-assigned globally unique event identifier. */
  @PrimaryColumn({ name: 'event_id' })
  eventId: string;

  @CreateDateColumn({ name: 'processed_at', type: 'timestamp with time zone' })
  processedAt: Date;
}
