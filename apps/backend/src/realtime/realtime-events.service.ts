import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RedisService } from './redis.service';

export type RealtimeEvent = {
  type: string;
  payload: Record<string, unknown>;
};

export type RealtimeAudience = {
  rooms?: string[];
  userIds?: string[];
};

@Injectable()
export class RealtimeEventsService {
  private readonly channel: string;

  constructor(
    config: ConfigService,
    private readonly redis: RedisService,
  ) {
    this.channel = config.get<string>('REALTIME_REDIS_CHANNEL') ?? 'crm-realtime-events';
  }

  async publish(
    type: string,
    payload: Record<string, unknown>,
    audience: RealtimeAudience = {},
  ) {
    await this.redis.publisher.publish(
      this.channel,
      JSON.stringify({ type, payload, audience }),
    );
  }

  getChannel() {
    return this.channel;
  }
}
