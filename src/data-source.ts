import 'reflect-metadata';
import { config } from 'dotenv';
import { DataSource } from 'typeorm';
import { RentCollection } from './rent-collections/entities/rent-collection.entity';
import { RentCollectionAudit } from './rent-collections/entities/rent-collection-audit.entity';
import { ProcessedWebhookEvent } from './rent-collections/entities/processed-webhook-event.entity';

// Load .env so the TypeORM CLI picks up DB credentials without a running
// NestJS app (the CLI calls this file directly via -d flag).
config();

export const AppDataSource = new DataSource({
  type: (process.env.DB_TYPE ?? 'postgres') as 'postgres',
  host:     process.env.DB_HOST ?? 'localhost',
  port:     parseInt(process.env.DB_PORT ?? '5432', 10),
  username: process.env.DB_USER ?? 'doorway',
  password: process.env.DB_PASS ?? 'doorway',
  database: process.env.DB_NAME ?? 'doorway',
  entities: [RentCollection, RentCollectionAudit, ProcessedWebhookEvent],
  migrations: ['src/rent-collections/migrations/*.ts'],
  synchronize: false,
  logging: true,
});

export default AppDataSource;
