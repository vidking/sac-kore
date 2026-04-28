import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ChannelsService } from '../channels/channels.service';
import { ConversationService } from '../conversations/conversation.service';
import { MediaService } from '../media/media.service';
import { MessageIngestionService } from '../messages/message-ingestion.service';
import { OutboxService } from '../outbox/outbox.service';
import { PrismaModule } from '../prisma/prisma.module';
import { QueueProducerService } from '../queues/queue-producer.service';
import { QUEUE_NAMES } from '../queues/queue.constants';
import { RealtimeEventsService } from '../realtime/realtime-events.service';
import { RedisService } from '../realtime/redis.service';
import { ResyncService } from '../resync/resync.service';
import { SyncLifecycleService } from '../sync/sync-lifecycle.service';
import { TagsService } from '../tags/tags.service';
import { UsersService } from '../users/users.service';
import { WahaAdapterService } from '../waha/waha-adapter.service';
import { WahaService } from '../waha/waha.service';
import { RuntimeHeartbeatService } from './runtime-heartbeat.service';

const COMMON_REQUIRED_PROD_ENV_VARS = [
  'DATABASE_URL',
  'REDIS_URL',
  'JWT_SECRET',
] as const;

const REQUIRED_PROD_ENV_VARS_BY_SERVICE = {
  backend: [
    'WAHA_API_KEY',
    'WAHA_API_KEY_PLAIN',
    'WAHA_WEBHOOK_HMAC_KEY',
    'FRONTEND_ORIGIN',
  ],
  worker: [
    'WAHA_API_KEY',
    'WAHA_API_KEY_PLAIN',
    'WAHA_WEBHOOK_HMAC_KEY',
  ],
  seed: ['SEED_ADMIN_EMAIL', 'SEED_ADMIN_PASSWORD'],
} as const;

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate: (env) => {
        if (env.NODE_ENV === 'production') {
          const serviceName = normalizeServiceName(env.SERVICE_NAME);
          const required = [
            ...COMMON_REQUIRED_PROD_ENV_VARS,
            ...(REQUIRED_PROD_ENV_VARS_BY_SERVICE[serviceName] ?? []),
          ];
          const missing = required.filter((key) => {
            const value = env[key];
            return value === undefined || String(value).trim() === '';
          });

          if (missing.length > 0) {
            throw new Error(`Missing required production env vars: ${missing.join(', ')}`);
          }
        }

        return env;
      },
    }),
    PrismaModule,
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        connection: redisConnectionOptions(
          config.get<string>('REDIS_URL') ?? 'redis://localhost:6379',
        ),
        defaultJobOptions: {
          removeOnComplete: 500,
          removeOnFail: 1000,
          attempts: 3,
          backoff: { type: 'exponential', delay: 2000 },
        },
      }),
    }),
    BullModule.registerQueue(
      { name: QUEUE_NAMES.inbound },
      { name: QUEUE_NAMES.outbox },
      { name: QUEUE_NAMES.resync },
      { name: QUEUE_NAMES.media },
    ),
  ],
  providers: [
    ChannelsService,
    ConversationService,
    MediaService,
    MessageIngestionService,
    OutboxService,
    QueueProducerService,
    RealtimeEventsService,
    RedisService,
    ResyncService,
    RuntimeHeartbeatService,
    SyncLifecycleService,
    TagsService,
    UsersService,
    WahaAdapterService,
    WahaService,
  ],
  exports: [
    BullModule,
    ChannelsService,
    ConversationService,
    MediaService,
    MessageIngestionService,
    OutboxService,
    QueueProducerService,
    RealtimeEventsService,
    RedisService,
    ResyncService,
    RuntimeHeartbeatService,
    SyncLifecycleService,
    TagsService,
    UsersService,
    WahaAdapterService,
    WahaService,
  ],
})
export class CoreModule {}

function normalizeServiceName(value: unknown) {
  const normalized = String(value ?? 'backend').trim().toLowerCase();
  return normalized in REQUIRED_PROD_ENV_VARS_BY_SERVICE
    ? (normalized as keyof typeof REQUIRED_PROD_ENV_VARS_BY_SERVICE)
    : 'backend';
}

function redisConnectionOptions(redisUrl: string) {
  const parsed = new URL(redisUrl);
  return {
    host: parsed.hostname,
    port: Number(parsed.port || 6379),
    username: parsed.username || undefined,
    password: parsed.password || undefined,
    db: parsed.pathname ? Number(parsed.pathname.replace('/', '') || 0) : 0,
  };
}
