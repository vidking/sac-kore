import { Module } from '@nestjs/common';
import { CoreModule } from './core/core.module';
import { MediaProcessor } from './media/media.processor';
import { MessageIngestionProcessor } from './messages/message-ingestion.processor';
import { OutboxRecoveryService } from './outbox/outbox-recovery.service';
import { OutboxProcessor } from './outbox/outbox.processor';
import { ResyncProcessor } from './resync/resync.processor';

@Module({
  imports: [CoreModule],
  providers: [
    MessageIngestionProcessor,
    OutboxRecoveryService,
    OutboxProcessor,
    ResyncProcessor,
    MediaProcessor,
  ],
})
export class WorkerModule {}
