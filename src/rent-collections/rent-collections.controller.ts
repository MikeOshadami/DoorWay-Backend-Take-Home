import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { InitiateCollectionDto } from './dto/initiate-collection.dto';
import { RentCollectionsService } from './rent-collections.service';

@Controller('rent-collections')
@UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }))
export class RentCollectionsController {
  constructor(private readonly service: RentCollectionsService) {}

  /**
   * POST /rent-collections
   *
   * Initiates a rent collection for a lease billing period. Idempotent:
   * posting the same leaseId+period twice returns the existing record and
   * does NOT create a second charge.
   *
   * Returns 200 whether this is the first call or a duplicate — callers should
   * inspect the returned `status` field to distinguish first-creation from
   * already-in-progress / already-settled.
   */
  @Post()
  @HttpCode(HttpStatus.OK)
  async initiate(@Body() dto: InitiateCollectionDto) {
    return this.service.initiateCollection(dto);
  }

  /**
   * POST /rent-collections/reconcile
   *
   * Manually trigger a reconciliation pass. Finds collections that appear
   * stuck (INITIATING or SUBMITTED and older than 10 minutes) and polls
   * VOPay to resolve their current state.
   *
   * In production this would be called by a cron job, not exposed publicly.
   */
  @Post('reconcile')
  @HttpCode(HttpStatus.OK)
  async reconcile() {
    return this.service.reconcile();
  }
}
