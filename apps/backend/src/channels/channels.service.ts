import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChannelStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { QueueProducerService } from '../queues/queue-producer.service';

@Injectable()
export class ChannelsService {
  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly queues: QueueProducerService,
  ) {}

  list() {
    return this.prisma.channel.findMany({
      orderBy: { createdAt: 'asc' },
      include: {
        _count: { select: { conversations: true, messages: true } },
      },
    });
  }

  async findById(id: string) {
    const channel = await this.prisma.channel.findUnique({
      where: { id },
      include: {
        _count: { select: { conversations: true, messages: true } },
      },
    });

    if (!channel) {
      throw new NotFoundException('Channel not found');
    }

    return channel;
  }

  async ensureBySession(sessionName: string) {
    return this.prisma.channel.upsert({
      where: { sessionName },
      update: {},
      create: {
        sessionName,
        status: ChannelStatus.unknown,
      },
    });
  }

  bootstrapDefault() {
    const sessionName = this.config.get<string>('WAHA_SESSION') ?? 'default';
    return this.ensureBySession(sessionName);
  }

  async updateStatus(sessionName: string, status: ChannelStatus) {
    return this.prisma.channel.upsert({
      where: { sessionName },
      update: { status },
      create: { sessionName, status },
    });
  }

  async enqueueResync(channelId: string, reason = 'manual') {
    const channel = await this.prisma.channel.findUnique({ where: { id: channelId } });
    if (!channel) {
      throw new NotFoundException('Channel not found');
    }
    await this.queues.enqueueResync(channel.sessionName, reason);
    return { queued: true, sessionName: channel.sessionName };
  }
}
