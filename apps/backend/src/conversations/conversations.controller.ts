import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ConversationStatus, ConversationType } from '@prisma/client';
import { AuthUser, CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { OutboxService } from '../outbox/outbox.service';
import { ConversationService } from './conversation.service';

@UseGuards(JwtAuthGuard)
@Controller('conversations')
export class ConversationsController {
  constructor(
    private readonly conversations: ConversationService,
    private readonly outbox: OutboxService,
  ) {}

  @Get()
  list(
    @CurrentUser() user: AuthUser,
    @Query('status') status?: ConversationStatus,
    @Query('type') type?: ConversationType,
    @Query('assignedTo') assignedTo?: string,
    @Query('search') search?: string,
    @Query('unread') unread?: string,
  ) {
    return this.conversations.list({
      actor: user,
      status,
      type,
      assignedTo:
        user.role === 'admin'
          ? assignedTo
          : user.sub,
      search,
      unreadOnly: unread === 'true' || unread === '1',
    });
  }

  @Get(':id')
  get(
    @Param('id') id: string,
    @CurrentUser() user: AuthUser,
    @Query('limit') limit?: string,
    @Query('before') before?: string,
    @Query('after') after?: string,
  ) {
    return this.conversations.get(id, {
      actor: user,
      limit: limit ? Number(limit) : undefined,
      before,
      after,
    });
  }

  @Patch(':id')
  async update(
    @Param('id') id: string,
    @CurrentUser() user: AuthUser,
    @Body() body: { status?: ConversationStatus; assignedTo?: string | null; unreadCount?: number },
  ) {
    await this.conversations.assertAccessById(id, user);
    return this.conversations.update(id, user, body);
  }

  @Post(':id/read')
  async markRead(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    await this.conversations.assertAccessById(id, user);
    return this.conversations.markRead(id, user.sub);
  }

  @Post(':id/messages')
  async sendMessage(
    @Param('id') id: string,
    @CurrentUser() user: AuthUser,
    @Body() body: { body: string; clientMessageId?: string },
  ) {
    await this.conversations.assertAccessById(id, user);
    return this.outbox.createTextMessage(id, user.sub, body.body, body.clientMessageId);
  }

  @Get(':id/events')
  async events(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    await this.conversations.assertAccessById(id, user);
    return this.conversations.events(id);
  }

  @Get(':id/debug')
  async debug(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    await this.conversations.assertAccessById(id, user);
    return this.conversations.debug(id, { actor: user });
  }

  @Get(':id/waha-compare')
  async compareWithWaha(
    @Param('id') id: string,
    @CurrentUser() user: AuthUser,
    @Query('limit') limit?: string,
  ) {
    await this.conversations.assertAccessById(id, user);
    return this.conversations.compareWithWaha(id, {
      actor: user,
      limit: limit ? Number(limit) : undefined,
    });
  }

  @Get(':id/notes')
  async notes(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    await this.conversations.assertAccessById(id, user);
    return this.conversations.notes(id);
  }

  @Post(':id/notes')
  async addNote(
    @Param('id') id: string,
    @CurrentUser() user: AuthUser,
    @Body() body: { body: string },
  ) {
    await this.conversations.assertAccessById(id, user);
    return this.conversations.addNote(id, user.sub, body.body);
  }

  @Post(':id/tags')
  async addTag(
    @Param('id') id: string,
    @CurrentUser() user: AuthUser,
    @Body() body: { tagId: string },
  ) {
    await this.conversations.assertAccessById(id, user);
    return this.conversations.addTag(id, body.tagId, user.sub);
  }

  @Delete(':id/tags/:tagId')
  async removeTag(
    @Param('id') id: string,
    @Param('tagId') tagId: string,
    @CurrentUser() user: AuthUser,
  ) {
    await this.conversations.assertAccessById(id, user);
    return this.conversations.removeTag(id, tagId, user.sub);
  }
}
