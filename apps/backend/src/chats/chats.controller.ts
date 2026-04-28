import { Body, Controller, Get, NotFoundException, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ConversationStatus, ConversationType } from '@prisma/client';
import { AuthUser, CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ConversationService } from '../conversations/conversation.service';
import { OutboxService } from '../outbox/outbox.service';

@UseGuards(JwtAuthGuard)
@Controller('chats')
export class ChatsController {
  constructor(
    private readonly conversations: ConversationService,
    private readonly outbox: OutboxService,
  ) {}

  @Get()
  list(
    @CurrentUser() user: AuthUser,
    @Query('type') type?: ConversationType,
    @Query('q') search?: string,
    @Query('unread') unread?: string,
    @Query('status') status?: string,
    @Query('assignedTo') assignedTo?: string,
    @Query('channelId') channelId?: string,
    @Query('session') sessionName?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    const effectiveAssignedTo = user.role === 'admin' ? assignedTo : user.sub;

    return this.conversations.listPage({
      actor: user,
      type,
      search,
      status: status as ConversationStatus | undefined,
      assignedTo: effectiveAssignedTo,
      channelId,
      sessionName,
      cursor,
      take: limit ? Number(limit) : undefined,
      unreadOnly: unread === 'true' || unread === '1',
    });
  }

  @Get(':jid/messages')
  async messages(
    @Param('jid') jid: string,
    @CurrentUser() user: AuthUser,
    @Query('channelId') channelId?: string,
    @Query('session') sessionName?: string,
    @Query('limit') limit?: string,
    @Query('before') before?: string,
    @Query('after') after?: string,
  ) {
    const conversation = await this.conversations.getByJid(decodeURIComponent(jid), {
      actor: user,
      channelId,
      sessionName,
      limit: limit ? Number(limit) : undefined,
      before,
      after,
    });
    if (!conversation) return { items: [], pageInfo: { nextCursor: null, hasMore: false } };
    return {
      items: conversation.messages ?? [],
      pageInfo: conversation.messagesPageInfo ?? {
        nextCursor: null,
        hasMore: false,
      },
    };
  }

  @Post(':jid/send')
  async send(
    @Param('jid') jid: string,
    @CurrentUser() user: AuthUser,
    @Body() body: { body: string; clientMessageId?: string },
    @Query('channelId') channelId?: string,
    @Query('session') sessionName?: string,
  ) {
    const conversation = await this.conversations.getByJid(decodeURIComponent(jid), {
      actor: user,
      channelId,
      sessionName,
    });
    if (!conversation) {
      throw new NotFoundException('Chat not found');
    }

    return this.outbox.createTextMessage(
      conversation.id,
      user.sub,
      body.body,
      body.clientMessageId,
    );
  }
}
