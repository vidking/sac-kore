import { Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { ChannelsService } from './channels.service';

@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('channels')
export class ChannelsController {
  constructor(private readonly channels: ChannelsService) {}

  @Get()
  @Roles('admin')
  list() {
    return this.channels.list();
  }

  @Post('bootstrap-default')
  @Roles('admin')
  bootstrapDefault() {
    return this.channels.bootstrapDefault();
  }

  @Post(':id/resync')
  @Roles('admin')
  resync(@Param('id') id: string) {
    return this.channels.enqueueResync(id);
  }
}
