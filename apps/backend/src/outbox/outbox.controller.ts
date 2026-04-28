import { Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { OutboxService } from './outbox.service';

@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('outbox')
export class OutboxController {
  constructor(private readonly outbox: OutboxService) {}

  @Get('pending')
  @Roles('admin')
  pending() {
    return this.outbox.listPending();
  }

  @Post('retry-pending')
  @Roles('admin')
  retryPending() {
    return this.outbox.retryPending();
  }

  @Post(':id/retry')
  @Roles('admin')
  retryOne(@Param('id') id: string) {
    return this.outbox.retryOne(id);
  }
}
