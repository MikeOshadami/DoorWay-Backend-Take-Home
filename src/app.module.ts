import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RentCollectionAudit } from './rent-collections/entities/rent-collection-audit.entity';
import { RentCollection } from './rent-collections/entities/rent-collection.entity';
import { ProcessedWebhookEvent } from './rent-collections/entities/processed-webhook-event.entity';
import { RentCollectionsModule } from './rent-collections/rent-collections.module';

@Module({
  imports: [
    // Loads .env into process.env; isGlobal makes ConfigService available
    // everywhere without re-importing ConfigModule in each feature module.
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
    }),

    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: config.get<string>('DB_TYPE', 'postgres') as 'postgres',
        host:     config.get<string>('DB_HOST', 'localhost'),
        port:     config.get<number>('DB_PORT', 5432),
        username: config.get<string>('DB_USER', 'doorway'),
        password: config.get<string>('DB_PASS', 'doorway'),
        database: config.get<string>('DB_NAME', 'doorway'),
        entities: [RentCollection, RentCollectionAudit, ProcessedWebhookEvent],
        migrations: ['dist/rent-collections/migrations/*.js'],
        migrationsRun: false, // run migrations explicitly via CLI
        synchronize: false,   // never use in production
        logging: config.get<string>('NODE_ENV') !== 'test',
      }),
    }),

    RentCollectionsModule,
  ],
})
export class AppModule {}
