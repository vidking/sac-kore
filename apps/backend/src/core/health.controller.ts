import {
  Controller,
  Get,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Public } from '../auth/public.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../realtime/redis.service';

@Controller('health')
export class HealthController {
  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  @Public()
  @Get()
  async health() {
    const checks = {
      database: false,
      redis: false,
    };

    const errors: string[] = [];

    try {
      await this.prisma.$queryRawUnsafe('SELECT 1');
      checks.database = true;
    } catch (error) {
      errors.push(`database:${String(error)}`);
    }

    try {
      await this.redis.publisher.ping();
      checks.redis = true;
    } catch (error) {
      errors.push(`redis:${String(error)}`);
    }

    const payload = {
      ok: checks.database && checks.redis,
      service: this.config.get<string>('SERVICE_NAME') ?? 'backend',
      checks,
      timestamp: new Date().toISOString(),
    };

    if (!payload.ok) {
      throw new ServiceUnavailableException({
        ...payload,
        errors,
      });
    }

    return payload;
  }
}
