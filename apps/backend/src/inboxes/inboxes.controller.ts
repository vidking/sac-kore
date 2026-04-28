import { Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { ChannelsService } from '../channels/channels.service';
import { SyncLifecycleService } from '../sync/sync-lifecycle.service';

@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('inboxes')
export class InboxesController {
  constructor(
    private readonly channels: ChannelsService,
    private readonly syncLifecycle: SyncLifecycleService,
  ) {}

  @Get(':id/health')
  @Roles('admin')
  async health(@Param('id') id: string) {
    const channel = await this.channels.findById(id);
    const health = await this.syncLifecycle.getSessionStatus(channel.sessionName);

    return {
      inbox: channel,
      health,
    };
  }

  @Get(':id/sync-status')
  @Roles('admin')
  async syncStatus(@Param('id') id: string) {
    const channel = await this.channels.findById(id);
    return this.syncLifecycle.getSessionStatus(channel.sessionName);
  }

  @Post(':id/resync')
  @Roles('admin')
  async resync(@Param('id') id: string) {
    return this.channels.enqueueResync(id);
  }
}
