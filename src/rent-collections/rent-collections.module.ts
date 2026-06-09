import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RentCollectionAudit } from './entities/rent-collection-audit.entity';
import { RentCollection } from './entities/rent-collection.entity';
import { ProcessedWebhookEvent } from './entities/processed-webhook-event.entity';
import { VopayMockClient } from './providers/vopay-mock.client';
import { VOPAY_CLIENT } from './providers/vopay-client.interface';
import { RentCollectionsController } from './rent-collections.controller';
import { RentCollectionsService } from './rent-collections.service';
import { WebhooksController } from './webhooks.controller';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      RentCollection,
      RentCollectionAudit,
      ProcessedWebhookEvent,
    ]),
  ],
  controllers: [RentCollectionsController, WebhooksController],
  providers: [
    RentCollectionsService,
    {
      // Swap VopayMockClient for a real HTTP client in production via env flag.
      provide: VOPAY_CLIENT,
      useClass: VopayMockClient,
    },
  ],
  exports: [RentCollectionsService],
})
export class RentCollectionsModule {}
