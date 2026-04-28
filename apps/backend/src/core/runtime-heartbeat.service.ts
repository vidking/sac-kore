import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RedisService } from '../realtime/redis.service';

@Injectable()
export class RuntimeHeartbeatService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(RuntimeHeartbeatService.name);
  private interval: NodeJS.Timeout | null = null;

  constructor(
    private readonly config: ConfigService,
    private readonly redis: RedisService,
  ) {}

  async onApplicationBootstrap() {
    await this.writeHeartbeat();
    this.interval = setInterval(() => {
      this.writeHeartbeat().catch((error) => {
        this.logger.error(`Failed to write runtime heartbeat: ${String(error)}`);
      });
    }, this.heartbeatIntervalMs());
  }

  async onModuleDestroy() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }

    await this.redis.publisher.del(this.key());
  }

  private async writeHeartbeat() {
    await this.redis.publisher.set(
      this.key(),
      JSON.stringify({
        service: this.serviceName(),
        pid: process.pid,
        ts: Date.now(),
      }),
      'EX',
      Math.ceil(this.ttlMs() / 1000),
    );
  }

  private key() {
    return `kore:runtime:heartbeat:${this.serviceName()}`;
  }

  private serviceName() {
    return this.config.get<string>('SERVICE_NAME') ?? 'backend';
  }

  private heartbeatIntervalMs() {
    return Number(this.config.get<string>('RUNTIME_HEARTBEAT_INTERVAL_MS') ?? 15_000);
  }

  private ttlMs() {
    return Number(this.config.get<string>('RUNTIME_HEARTBEAT_TTL_MS') ?? 60_000);
  }
}
