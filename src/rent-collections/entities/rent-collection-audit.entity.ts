import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * Immutable append-only audit log of every status transition.
 * Never delete or update rows here — this is the source of truth for "what
 * happened and why".
 */
@Entity('rent_collection_audits')
export class RentCollectionAudit {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column({ name: 'collection_id' })
  collectionId: string;

  @Column({ name: 'from_status' })
  fromStatus: string;

  @Column({ name: 'to_status' })
  toStatus: string;

  /**
   * Where the transition originated.
   * One of: 'api' | 'webhook' | 'reconciliation'
   */
  @Column()
  source: string;

  /** Free-text context: eventId, error message, etc. */
  @Column({ type: 'text', nullable: true })
  detail: string;

  @CreateDateColumn({ name: 'occurred_at', type: 'timestamp with time zone' })
  occurredAt: Date;
}
