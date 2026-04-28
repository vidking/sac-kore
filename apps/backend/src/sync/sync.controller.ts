import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { QueueProducerService } from '../queues/queue-producer.service';
import { SyncLifecycleService } from './sync-lifecycle.service';

@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('sync')
export class SyncController {
  constructor(
    private readonly config: ConfigService,
    private readonly queues: QueueProducerService,
    private readonly syncLifecycle: SyncLifecycleService,
  ) {}

  @Post('waha')
  @Roles('admin')
  async syncWaha(@Body() body: { sessionName?: string; reason?: string }) {
    const sessionName = body.sessionName ?? this.config.get<string>('WAHA_SESSION') ?? 'default';
    await this.queues.enqueueResync(sessionName, body.reason ?? 'manual');
    return { queued: true, sessionName };
  }

  @Get('status')
  @Roles('admin')
  status() {
    return this.syncLifecycle.getStatusSummary();
  }
}
