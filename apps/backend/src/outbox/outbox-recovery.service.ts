import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OutboxStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { QueueProducerService } from '../queues/queue-producer.service';
import { OutboxService } from './outbox.service';

@Injectable()
export class OutboxRecoveryService implements OnApplicationBootstrap {
  private readonly logger = new Logger(OutboxRecoveryService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly outbox: OutboxService,
    private readonly prisma: PrismaService,
    private readonly queues: QueueProducerService,
  ) {}

  async onApplicationBootstrap() {
    const recovered = await this.outbox.recoverStaleOutbox();
    if (recovered > 0) {
      this.logger.warn(`Recovered ${recovered} stale outbox rows`);
    }

    const enabled = this.config.get<string>('OUTBOX_RECOVERY_ON_START') === 'true';
    if (!enabled) {
      this.logger.log('Outbox recovery on start is disabled');
      return;
    }

    const pending = await this.prisma.outboxMessage.findMany({
      where: {
        status: {
          in: [OutboxStatus.queued, OutboxStatus.retryable_failed],
        },
      },
      orderBy: { createdAt: 'asc' },
      take: 200,
      select: { id: true },
    });

    for (const item of pending) {
      await this.queues.enqueueOutbox(item.id);
    }

    if (pending.length > 0) {
      this.logger.log(`Re-queued ${pending.length} pending outbox messages`);
    }
  }
}
