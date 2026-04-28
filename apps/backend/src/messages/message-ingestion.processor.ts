import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { JOB_NAMES, QUEUE_NAMES } from '../queues/queue.constants';
import { WahaWebhookEvent } from '../waha/waha.types';
import { MessageIngestionService } from './message-ingestion.service';

@Processor(QUEUE_NAMES.inbound)
export class MessageIngestionProcessor extends WorkerHost {
  constructor(private readonly ingestion: MessageIngestionService) {
    super();
  }

  async process(job: Job<{ event: WahaWebhookEvent; metadata?: Record<string, any> }>) {
    if (job.name !== JOB_NAMES.processWahaEvent) return;
    return this.ingestion.ingestWahaEvent(job.data.event, job.data.metadata);
  }
}
