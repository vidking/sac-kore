import { Processor, WorkerHost } from '@nestjs/bullmq';
import { MediaStatus } from '@prisma/client';
import { Job } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { JOB_NAMES, QUEUE_NAMES } from '../queues/queue.constants';
import { MediaService } from './media.service';

@Processor(QUEUE_NAMES.media)
export class MediaProcessor extends WorkerHost {
  constructor(
    private readonly media: MediaService,
    private readonly prisma: PrismaService,
  ) {
    super();
  }

  async process(job: Job<{ mediaId: string }>) {
    if (job.name !== JOB_NAMES.downloadMedia) return;

    try {
      return await this.media.download(job.data.mediaId);
    } catch (error) {
      await this.prisma.media.update({
        where: { id: job.data.mediaId },
        data: { status: MediaStatus.failed },
      });
      throw error;
    }
  }
}
