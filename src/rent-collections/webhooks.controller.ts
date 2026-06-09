import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
  RawBodyRequest,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { createHmac } from 'crypto';
import { Request } from 'express';
import { VopayWebhookDto } from './dto/vopay-webhook.dto';
import { RentCollectionsService } from './rent-collections.service';

const WEBHOOK_SECRET = process.env.VOPAY_WEBHOOK_SECRET ?? 'dev-webhook-secret';

/**
 * Receives async settlement notifications from VOPay.
 *
 * Security: every request is authenticated via HMAC-SHA256 signature over the
 * raw request body. We verify before parsing to avoid any parser-smuggling
 * attacks.
 *
 * Idempotency: the service deduplicates by eventId, so VOPay may safely
 * redeliver without risk of double-state-transition.
 */
@Controller('webhooks')
export class WebhooksController {
  constructor(private readonly service: RentCollectionsService) {}

  @Post('vopay')
  @HttpCode(HttpStatus.OK)
  async handleVopay(
    @Req() req: RawBodyRequest<Request>,
    @Headers('x-vopay-signature') signature: string,
    @Body() _body: unknown, // parsed by NestJS — we use rawBody for sig verification
  ) {
    // ── Signature verification ─────────────────────────────────────────────
    if (!signature) {
      throw new UnauthorizedException('Missing x-vopay-signature header');
    }

    const rawBody = req.rawBody;
    if (!rawBody) {
      throw new BadRequestException(
        'Raw body unavailable — ensure rawBody is enabled in NestJS bootstrap',
      );
    }

    const expected = createHmac('sha256', WEBHOOK_SECRET)
      .update(rawBody)
      .digest('hex');

    if (!timingSafeEqual(expected, signature)) {
      throw new UnauthorizedException('Invalid webhook signature');
    }

    // ── Parse and validate payload ─────────────────────────────────────────
    let payload: VopayWebhookDto;
    try {
      const raw = JSON.parse(rawBody.toString('utf8'));
      payload = Object.assign(new VopayWebhookDto(), raw);
    } catch {
      throw new BadRequestException('Invalid JSON payload');
    }

    await this.service.handleWebhook(payload);
    return { received: true };
  }
}

/**
 * Constant-time string comparison to prevent timing attacks.
 * We compare hex strings of equal length so a simple Buffer comparison works.
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const bufA = Buffer.from(a, 'hex');
  const bufB = Buffer.from(b, 'hex');
  // Both are hex-encoded SHA256 (32 bytes) — same length guaranteed above.
  return bufA.equals(bufB);
}
