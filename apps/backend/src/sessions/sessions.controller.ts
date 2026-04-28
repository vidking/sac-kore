import { Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { QueueProducerService } from '../queues/queue-producer.service';
import { SyncLifecycleService } from '../sync/sync-lifecycle.service';

@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('sessions')
export class SessionsController {
  constructor(
    private readonly queues: QueueProducerService,
    private readonly syncLifecycle: SyncLifecycleService,
  ) {}

  @Get(':sessionName/health')
  @Roles('admin')
  async health(@Param('sessionName') sessionName: string) {
    return this.syncLifecycle.getSessionStatus(sessionName);
  }

  @Post(':sessionName/resync')
  @Roles('admin')
  async resync(@Param('sessionName') sessionName: string) {
    await this.queues.enqueueResync(sessionName, 'manual');
    return { queued: true, sessionName };
  }
}
