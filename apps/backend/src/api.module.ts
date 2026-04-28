import { Module } from '@nestjs/common';
import { AuthModule } from './auth/auth.module';
import { ChatsController } from './chats/chats.controller';
import { ChannelsController } from './channels/channels.controller';
import { ConversationsController } from './conversations/conversations.controller';
import { HealthController } from './core/health.controller';
import { CoreModule } from './core/core.module';
import { InboxesController } from './inboxes/inboxes.controller';
import { OutboxController } from './outbox/outbox.controller';
import { MessagesController } from './messages/messages.controller';
import { SessionsController } from './sessions/sessions.controller';
import { RealtimeGateway } from './realtime/realtime.gateway';
import { SyncController } from './sync/sync.controller';
import { TagsController } from './tags/tags.controller';
import { UsersController } from './users/users.controller';
import { WahaWebhookController } from './webhooks/waha-webhook.controller';

@Module({
  imports: [CoreModule, AuthModule],
  controllers: [
    HealthController,
    ChatsController,
    ChannelsController,
    ConversationsController,
    InboxesController,
    MessagesController,
    SessionsController,
    OutboxController,
    SyncController,
    TagsController,
    UsersController,
    WahaWebhookController,
  ],
  providers: [RealtimeGateway],
})
export class ApiModule {}
