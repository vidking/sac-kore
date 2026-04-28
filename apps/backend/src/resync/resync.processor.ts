import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { JOB_NAMES, QUEUE_NAMES } from '../queues/queue.constants';
import { ResyncService } from './resync.service';

@Processor(QUEUE_NAMES.resync)
export class ResyncProcessor extends WorkerHost {
  constructor(private readonly resync: ResyncService) {
    super();
  }

  async process(job: Job<{ sessionName: string; reason?: string }>) {
    if (job.name !== JOB_NAMES.resyncSession) return;
    return this.resync.resyncSession(job.data.sessionName, job.data.reason);
  }
}
