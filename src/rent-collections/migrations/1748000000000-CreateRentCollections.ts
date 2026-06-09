import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateRentCollections1748000000000 implements MigrationInterface {
  name = 'CreateRentCollections1748000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Enum type for collection status
    await queryRunner.query(`
      CREATE TYPE collection_status AS ENUM (
        'pending',
        'initiating',
        'submitted',
        'funded',
        'failed',
        'returned'
      )
    `);

    // Primary collection table
    await queryRunner.query(`
      CREATE TABLE rent_collections (
        id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        lease_id                VARCHAR          NOT NULL,
        period                  VARCHAR          NOT NULL,
        amount_cents            INTEGER          NOT NULL,
        currency                CHAR(3)          NOT NULL DEFAULT 'CAD',
        idempotency_key         VARCHAR          NOT NULL,
        status                  collection_status NOT NULL DEFAULT 'pending',
        provider_transaction_id VARCHAR,
        created_at              TIMESTAMPTZ      NOT NULL DEFAULT NOW(),
        updated_at              TIMESTAMPTZ      NOT NULL DEFAULT NOW(),

        CONSTRAINT uq_rent_collections_lease_period
          UNIQUE (lease_id, period),
        CONSTRAINT uq_rent_collections_idempotency_key
          UNIQUE (idempotency_key)
      )
    `);

    await queryRunner.query(
      `CREATE INDEX idx_rent_collections_lease_id ON rent_collections (lease_id)`,
    );
    await queryRunner.query(
      `CREATE INDEX idx_rent_collections_provider_tx_id ON rent_collections (provider_transaction_id)`,
    );
    await queryRunner.query(
      `CREATE INDEX idx_rent_collections_status ON rent_collections (status)`,
    );

    // Immutable audit log
    await queryRunner.query(`
      CREATE TABLE rent_collection_audits (
        id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        collection_id UUID        NOT NULL
          REFERENCES rent_collections (id) ON DELETE CASCADE,
        from_status   VARCHAR     NOT NULL,
        to_status     VARCHAR     NOT NULL,
        source        VARCHAR     NOT NULL,
        detail        TEXT,
        occurred_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await queryRunner.query(
      `CREATE INDEX idx_rent_collection_audits_collection_id
       ON rent_collection_audits (collection_id)`,
    );

    // Webhook deduplication
    await queryRunner.query(`
      CREATE TABLE processed_webhook_events (
        event_id     VARCHAR PRIMARY KEY,
        processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS processed_webhook_events`);
    await queryRunner.query(`DROP TABLE IF EXISTS rent_collection_audits`);
    await queryRunner.query(`DROP TABLE IF EXISTS rent_collections`);
    await queryRunner.query(`DROP TYPE IF EXISTS collection_status`);
  }
}
