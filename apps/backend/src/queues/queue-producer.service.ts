import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { Queue } from 'bullmq';
import { createHash } from 'crypto';
import { JOB_NAMES, QUEUE_NAMES } from './queue.constants';

@Injectable()
export class QueueProducerService {
  constructor(
    @InjectQueue(QUEUE_NAMES.inbound) private readonly inboundQueue: Queue,
    @InjectQueue(QUEUE_NAMES.outbox) private readonly outboxQueue: Queue,
    @InjectQueue(QUEUE_NAMES.resync) private readonly resyncQueue: Queue,
    @InjectQueue(QUEUE_NAMES.media) private readonly mediaQueue: Queue,
  ) {}

  enqueueWahaEvent(payload: unknown, requestId?: string) {
    return this.inboundQueue.add(JOB_NAMES.processWahaEvent, payload, {
      jobId: sanitizeJobId(requestId ?? stableJobId('inbound', payload)),
      attempts: 5,
      backoff: { type: 'exponential', delay: 2000 },
    });
  }

  enqueueOutbox(outboxId: string, delay = 0) {
    return this.outboxQueue.add(
      JOB_NAMES.sendText,
      { outboxId },
      {
        jobId: sanitizeJobId(`outbox-${outboxId}`),
        attempts: 1,
        delay,
      },
    );
  }

  enqueueResync(sessionName: string, reason: string) {
    const jobId = sanitizeJobId(`resync-${sessionName}`);

    return this.enqueueReplacingStaleJob(this.resyncQueue, JOB_NAMES.resyncSession, jobId, {
      sessionName,
      reason,
    });
  }

  private async enqueueReplacingStaleJob<T extends Record<string, unknown>>(
    queue: Queue,
    name: string,
    jobId: string,
    data: T,
  ) {
    const existing = await queue.getJob(jobId);
    if (existing) {
      const state = await existing.getState();
      if (state !== 'active' && state !== 'waiting' && state !== 'delayed') {
        await existing.remove();
      } else {
        return existing;
      }
    }

    return queue.add(
      name,
      data,
      {
        jobId,
        attempts: 1,
      },
    );
  }

  enqueueMedia(mediaId: string) {
    return this.mediaQueue.add(
      JOB_NAMES.downloadMedia,
      { mediaId },
      { jobId: sanitizeJobId(`media-${mediaId}`), attempts: 5 },
    );
  }
}

function stableJobId(prefix: string, payload: unknown) {
  const hash = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  return `${prefix}-${hash}`;
}

function sanitizeJobId(value: string) {
  return value.replace(/[^a-zA-Z0-9_-]/g, '-');
}
