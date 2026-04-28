import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { JOB_NAMES, QUEUE_NAMES } from '../queues/queue.constants';
import { OutboxService } from './outbox.service';

@Processor(QUEUE_NAMES.outbox)
export class OutboxProcessor extends WorkerHost {
  constructor(private readonly outbox: OutboxService) {
    super();
  }

  async process(job: Job<{ outboxId: string }>) {
    if (job.name !== JOB_NAMES.sendText) return;
    return this.outbox.sendOutbox(job.data.outboxId);
  }
}
