/**
 * Unit tests for WebhooksController.
 *
 * Focus: webhook signature verification — the security gate that prevents
 * arbitrary callers from injecting fake settlement events.
 *
 * TRICKY PATH: invalid webhook signature → 401 Unauthorized
 */

import { createHmac } from 'crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { UnauthorizedException } from '@nestjs/common';
import { WebhooksController } from '../src/rent-collections/webhooks.controller';
import { RentCollectionsService } from '../src/rent-collections/rent-collections.service';

const WEBHOOK_SECRET = 'dev-webhook-secret';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sign(body: string | Buffer, secret = WEBHOOK_SECRET): string {
  return createHmac('sha256', secret).update(body).digest('hex');
}

function makeRawRequest(body: string): any {
  return {
    rawBody: Buffer.from(body, 'utf8'),
  };
}

const mockService = {
  handleWebhook: jest.fn().mockResolvedValue(undefined),
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('WebhooksController', () => {
  let controller: WebhooksController;

  beforeEach(async () => {
    jest.clearAllMocks();

    // Set the env variable the controller reads at import-time.
    process.env.VOPAY_WEBHOOK_SECRET = WEBHOOK_SECRET;

    const module: TestingModule = await Test.createTestingModule({
      controllers: [WebhooksController],
      providers: [
        { provide: RentCollectionsService, useValue: mockService },
      ],
    }).compile();

    controller = module.get<WebhooksController>(WebhooksController);
  });

  const validPayload = JSON.stringify({
    eventId: 'evt-001',
    transactionId: 'vopay-tx-abc123',
    status: 'funded',
    occurredAt: '2026-06-02T10:00:00Z',
  });

  /**
   * TRICKY PATH 6: Invalid webhook signature → 401
   *
   * If the signature doesn't match the request body, we must reject it before
   * touching any state. This prevents replay attacks and spoofed events.
   */
  it('rejects requests with an invalid signature (401)', async () => {
    const req = makeRawRequest(validPayload);
    const wrongSignature = sign(validPayload, 'wrong-secret');

    await expect(
      controller.handleVopay(req, wrongSignature, {}),
    ).rejects.toThrow(UnauthorizedException);

    expect(mockService.handleWebhook).not.toHaveBeenCalled();
  });

  it('rejects requests with a missing signature header (401)', async () => {
    const req = makeRawRequest(validPayload);

    await expect(
      controller.handleVopay(req, undefined as any, {}),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('accepts a valid signature and calls handleWebhook', async () => {
    const req = makeRawRequest(validPayload);
    const validSignature = sign(validPayload);

    const result = await controller.handleVopay(req, validSignature, {});

    expect(mockService.handleWebhook).toHaveBeenCalledTimes(1);
    expect(mockService.handleWebhook).toHaveBeenCalledWith(
      expect.objectContaining({
        eventId: 'evt-001',
        transactionId: 'vopay-tx-abc123',
        status: 'funded',
      }),
    );
    expect(result).toEqual({ received: true });
  });

  /**
   * Tampered body: the signature was computed over the original body but
   * the body was modified in transit. Must be rejected.
   */
  it('rejects a valid signature over a different (tampered) body (401)', async () => {
    const originalBody = validPayload;
    const tamperedBody = validPayload.replace('"funded"', '"returned"');

    const req = makeRawRequest(tamperedBody);
    const signatureOverOriginal = sign(originalBody); // signed original, not tampered

    await expect(
      controller.handleVopay(req, signatureOverOriginal, {}),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('returns { received: true } on a valid request', async () => {
    const body = JSON.stringify({
      eventId: 'evt-002',
      transactionId: 'vopay-tx-xyz',
      status: 'failed',
      occurredAt: '2026-06-03T08:00:00Z',
    });
    const req = makeRawRequest(body);
    const sig = sign(body);

    const result = await controller.handleVopay(req, sig, {});
    expect(result).toEqual({ received: true });
  });
});
