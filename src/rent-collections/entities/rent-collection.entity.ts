import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';
import { CollectionStatus } from '../collection-status.enum';

@Entity('rent_collections')
@Unique('uq_rent_collections_lease_period', ['leaseId', 'period'])
export class RentCollection {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** The lease being charged. Used as a logical partition key. */
  @Index()
  @Column({ name: 'lease_id' })
  leaseId: string;

  /**
   * Billing period in YYYY-MM format (e.g. "2026-06").
   * Together with leaseId forms the idempotency scope for the business.
   */
  @Column()
  period: string;

  /** Amount in integer cents. No floats, ever. */
  @Column({ name: 'amount_cents', type: 'int' })
  amountCents: number;

  @Column({ length: 3, default: 'CAD' })
  currency: string;

  /**
   * Deterministic idempotency key sent to VOPay on every attempt.
   * Format: `doorway:rent:<leaseId>:<period>`
   * Unique across collections so a retry with the same key returns the same
   * provider transaction — safe even if our previous request timed out.
   */
  @Column({ name: 'idempotency_key', unique: true })
  idempotencyKey: string;

  @Column({
    type: 'enum',
    enum: CollectionStatus,
    default: CollectionStatus.PENDING,
  })
  status: CollectionStatus;

  /** Set once the provider returns a transactionId. */
  @Index()
  @Column({ name: 'provider_transaction_id', nullable: true })
  providerTransactionId: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamp with time zone' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamp with time zone' })
  updatedAt: Date;
}
