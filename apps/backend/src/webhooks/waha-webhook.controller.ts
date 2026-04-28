import {
  BadRequestException,
  Body,
  Controller,
  Logger,
  Headers,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'crypto';
import { Request } from 'express';
import { PrismaService } from '../prisma/prisma.service';
import { QueueProducerService } from '../queues/queue-producer.service';
import { WahaWebhookEvent } from '../waha/waha.types';

type RawBodyRequest = Request & { rawBody?: Buffer };

@Controller(['webhooks/waha', 'waha/webhook'])
export class WahaWebhookController {
  private readonly logger = new Logger(WahaWebhookController.name);

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly queues: QueueProducerService,
  ) {}

  @Post()
  async handle(
    @Body() event: WahaWebhookEvent,
    @Headers() headers: Record<string, string>,
    @Req() request: RawBodyRequest,
  ) {
    this.verifyHmac(request, headers);

    if (!event?.event || !event?.session) {
      throw new BadRequestException('Invalid WAHA webhook payload');
    }

    const requestId = headers['x-webhook-request-id'];
    this.logger.log(
      JSON.stringify({
        action: 'received',
        event: event.event,
        session: event.session,
        requestId,
      }),
    );

    const receipt = {
      requestId,
      event: event.event,
      session: event.session,
      rawPayload: event as any,
    };

    if (requestId) {
      const existing = await this.prisma.webhookReceipt.findUnique({
        where: { requestId },
      });
      if (existing) {
        return { accepted: true, duplicate: true };
      }
    }

    await this.queues.enqueueWahaEvent(
      {
        event,
        metadata: {
          requestId,
          timestamp: headers['x-webhook-timestamp'],
          source: 'webhook',
        },
      },
      requestId,
    );

    this.logger.log(
      JSON.stringify({
        action: 'enqueued',
        event: event.event,
        session: event.session,
        requestId,
      }),
    );

    try {
      await this.prisma.webhookReceipt.create({ data: receipt });
    } catch (error: any) {
      if (error?.code !== 'P2002') throw error;
    }

    return { accepted: true };
  }

  private verifyHmac(request: RawBodyRequest, headers: Record<string, string>) {
    const secret = this.config.get<string>('WAHA_WEBHOOK_HMAC_KEY');
    if (!secret) {
      throw new UnauthorizedException('WAHA webhook HMAC is not configured');
    }

    const provided = headers['x-webhook-hmac'];
    if (!provided) {
      throw new UnauthorizedException('Missing WAHA HMAC');
    }

    const rawBody = request.rawBody;
    if (!rawBody) {
      throw new UnauthorizedException('Missing raw request body for HMAC');
    }

    const computed = createHmac('sha512', secret).update(rawBody).digest('hex');
    const left = Buffer.from(computed, 'hex');
    const right = Buffer.from(provided, 'hex');

    if (left.length !== right.length || !timingSafeEqual(left, right)) {
      throw new UnauthorizedException('Invalid WAHA HMAC');
    }
  }
}
