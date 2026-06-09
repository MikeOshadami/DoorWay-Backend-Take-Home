import { Injectable, Logger } from '@nestjs/common';
import { CollectionStatus } from './collection-status.enum';
import { RentCollection } from './entities/rent-collection.entity';

/**
 * Handles outbound notifications triggered by rent collection state transitions.
 *
 * Called exclusively from RentCollectionsService.applyTransition() — the single
 * choke point for every status change — so every path (webhook, reconciliation,
 * API) is covered without duplicating notification logic.
 *
 * Current implementation is a stub. Each method body contains a TODO with the
 * recommended delivery mechanism and the data shape to send.
 */
@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  /**
   * Entry point called after every successful status transition.
   * Routes to the appropriate notification method based on the new status.
   *
   * @param collection - The collection record after the transition is saved.
   * @param fromStatus - The previous status.
   * @param toStatus   - The new status.
   * @param source     - What triggered the transition: 'api' | 'webhook' | 'reconciliation'.
   */
  async onTransition(
    collection: RentCollection,
    fromStatus: CollectionStatus,
    toStatus: CollectionStatus,
    source: string,
  ): Promise<void> {
    switch (toStatus) {
      case CollectionStatus.RETURNED:
        await this.notifyNSF(collection, source);
        break;

      case CollectionStatus.FUNDED:
        await this.notifyFunded(collection, source);
        break;

      case CollectionStatus.FAILED:
        await this.notifyFailed(collection, source);
        break;

      // PENDING / INITIATING / SUBMITTED are internal states — no outbound
      // notification needed for those transitions.
      default:
        break;
    }
  }

  // ---------------------------------------------------------------------------
  // Private notification methods
  // ---------------------------------------------------------------------------

  /**
   * NSF / RETURNED — a previously collected payment has been reversed.
   *
   * This is the most urgent notification: money that appeared to arrive has
   * bounced back. The property manager needs to follow up with the tenant.
   *
   * TODO: Replace the log line with a real delivery mechanism, e.g.:
   *
   *   // Email via SendGrid / AWS SES / nodemailer
   *   await this.mailerService.send({
   *     to:      await this.leasesService.getPropertyManagerEmail(collection.leaseId),
   *     subject: `NSF Alert: Rent returned for lease ${collection.leaseId}`,
   *     body:    `The ${collection.currency} ${(collection.amountCents / 100).toFixed(2)} ` +
   *              `rent collection for lease ${collection.leaseId} (${collection.period}) ` +
   *              `was returned NSF. Please follow up with the tenant.`,
   *   });
   *
   *   // SMS via Twilio
   *   await this.smsService.send({ to: managerPhone, body: '...' });
   *
   *   // Slack channel alert
   *   await this.slackService.post({
   *     channel: '#property-managers',
   *     text: `:warning: NSF on lease ${collection.leaseId} (${collection.period}) — ` +
   *           `${collection.currency} ${(collection.amountCents / 100).toFixed(2)} reversed.`,
   *   });
   *
   * IMPORTANT: This method is called OUTSIDE the DB transaction (after the
   * state has already been committed). A failed notification will not roll back
   * the RETURNED status. For guaranteed delivery, enqueue a Bull/BullMQ job
   * here instead of calling the delivery service directly:
   *
   *   await this.notificationQueue.add('nsf-alert', {
   *     collectionId: collection.id,
   *     leaseId:      collection.leaseId,
   *     period:       collection.period,
   *     amountCents:  collection.amountCents,
   *     currency:     collection.currency,
   *     triggeredBy:  source,
   *   });
   */
  private async notifyNSF(collection: RentCollection, source: string): Promise<void> {
    this.logger.warn(
      `[NSF ALERT] Rent returned for lease=${collection.leaseId} ` +
        `period=${collection.period} ` +
        `amount=${collection.currency} ${(collection.amountCents / 100).toFixed(2)} ` +
        `triggeredBy=${source} — TODO: deliver to property manager`,
    );

    // TODO: implement delivery (email / SMS / Slack / job queue) — see above.
  }

  /**
   * FUNDED — rent collected successfully.
   *
   * TODO: Notify the property manager that payment has settled, or trigger a
   * ledger entry in the accounting system.
   *
   *   await this.ledgerService.recordReceipt({
   *     leaseId:     collection.leaseId,
   *     period:      collection.period,
   *     amountCents: collection.amountCents,
   *     currency:    collection.currency,
   *   });
   */
  private async notifyFunded(collection: RentCollection, source: string): Promise<void> {
    this.logger.log(
      `[FUNDED] lease=${collection.leaseId} period=${collection.period} ` +
        `amount=${collection.currency} ${(collection.amountCents / 100).toFixed(2)} ` +
        `triggeredBy=${source} — TODO: record ledger receipt`,
    );

    // TODO: implement ledger entry / confirmation notification.
  }

  /**
   * FAILED — the debit was rejected at submission time (hard failure).
   *
   * TODO: Notify the property manager so they can investigate the tenant's
   * account details and retry manually.
   *
   *   await this.mailerService.send({
   *     to:      await this.leasesService.getPropertyManagerEmail(collection.leaseId),
   *     subject: `Payment failed for lease ${collection.leaseId}`,
   *     body:    `The rent collection for ${collection.period} failed. ` +
   *              `Please verify the tenant's banking details.`,
   *   });
   */
  private async notifyFailed(collection: RentCollection, source: string): Promise<void> {
    this.logger.warn(
      `[FAILED] lease=${collection.leaseId} period=${collection.period} ` +
        `triggeredBy=${source} — TODO: notify property manager of hard failure`,
    );

    // TODO: implement delivery.
  }
}
