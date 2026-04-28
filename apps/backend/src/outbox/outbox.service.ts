import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  AckStatus,
  MessageDirection,
  MessageType,
  OutboxMessage,
  OutboxStatus,
  Prisma,
} from '@prisma/client';
import { PrismaClientKnownRequestError } from '@prisma/client/runtime/library';
import { createHash, randomUUID } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { QueueProducerService } from '../queues/queue-producer.service';
import { RealtimeEventsService } from '../realtime/realtime-events.service';
import { RedisService } from '../realtime/redis.service';
import { WahaService } from '../waha/waha.service';

const OUTBOX_LOCK_TTL_SECONDS = 120;
const OUTBOX_STALE_MINUTES = 5;
const MAX_OUTBOX_ATTEMPTS = 6;

@Injectable()
export class OutboxService {
  private readonly logger = new Logger(OutboxService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly queues: QueueProducerService,
    private readonly realtime: RealtimeEventsService,
    private readonly redis: RedisService,
    private readonly waha: WahaService,
  ) {}

  async createTextMessage(
    conversationId: string,
    userId: string,
    text: string,
    clientMessageId?: string,
  ) {
    const conversation = await this.prisma.conversation.findUnique({
      where: { id: conversationId },
      include: { channel: true },
    });

    if (!conversation) {
      throw new NotFoundException('Conversation not found');
    }

    const dedupeClientMessageId = clientMessageId?.trim() || randomUUID();
    const idempotencyKey = createOutboxIdempotencyKey(
      conversation.id,
      conversation.chatJid,
      dedupeClientMessageId,
      text,
    );

    const existing = await this.findExistingOutgoingMessage({
      conversationId,
      clientMessageId: dedupeClientMessageId,
      idempotencyKey,
    });
    if (existing) {
      return existing;
    }

    try {
      const message = await this.prisma.$transaction(async (tx) => {
        const created = await tx.message.create({
          data: {
            externalMessageId: `local:${randomUUID()}`,
            clientMessageId: dedupeClientMessageId,
            channelId: conversation.channelId,
            conversationId: conversation.id,
            direction: MessageDirection.outbound,
            senderJid: conversation.channel.sessionName,
            body: text,
            type: MessageType.text,
            providerTimestamp: new Date(),
            ackStatus: AckStatus.pending,
            createdById: userId,
            rawPayload: {
              source: 'ui',
              clientMessageId: dedupeClientMessageId,
            },
          },
          include: {
            createdBy: { select: { id: true, name: true, email: true } },
          },
        });

        await tx.outboxMessage.create({
          data: {
            messageId: created.id,
            channelId: conversation.channelId,
            conversationId: conversation.id,
            sessionName: conversation.channel.sessionName,
            chatJid: conversation.chatJid,
            text,
            idempotencyKey,
            createdById: userId,
          },
        });

        await tx.conversation.update({
          where: { id: conversation.id },
          data: {
            lastMessageAt: created.providerTimestamp,
            events: {
              create: {
                userId,
                eventType: 'message.outbound.queued',
                payload: { messageId: created.id },
              },
            },
          },
        });

        return tx.message.findUniqueOrThrow({
          where: { id: created.id },
          include: {
            outbox: {
              select: {
                id: true,
                status: true,
                attempts: true,
                lastError: true,
                nextRetryAt: true,
              },
            },
            createdBy: { select: { id: true, name: true, email: true } },
          },
        });
      });

      await this.queues.enqueueOutbox(message.outbox!.id);
      await this.realtime.publish(
        'message.created',
        { message },
        { rooms: this.realtimeRoomsForConversation(conversation.id) },
      );
      return message;
    } catch (error) {
      if (isUniqueViolation(error)) {
        const conflicted = await this.findExistingOutgoingMessage({
          conversationId,
          clientMessageId: dedupeClientMessageId,
          idempotencyKey,
        });
        if (conflicted) {
          return conflicted;
        }
      }

      throw error;
    }
  }

  async sendOutbox(outboxId: string) {
    const lockToken = randomUUID();
    const lockKey = `kore:outbox:lock:${outboxId}`;
    const lock = await this.redis.publisher.set(
      lockKey,
      lockToken,
      'EX',
      OUTBOX_LOCK_TTL_SECONDS,
      'NX',
    );

    if (lock !== 'OK') {
      return { skipped: true, reason: 'outbox is already locked', outboxId };
    }

    try {
      const outbox = await this.prisma.outboxMessage.findUnique({
        where: { id: outboxId },
        include: {
          message: {
            include: {
              outbox: {
                select: {
                  id: true,
                  status: true,
                  attempts: true,
                  lastError: true,
                  nextRetryAt: true,
                },
              },
              createdBy: { select: { id: true, name: true, email: true } },
            },
          },
        },
      });

      if (!outbox) throw new NotFoundException('Outbox message not found');

      if (
        outbox.status === OutboxStatus.sent ||
        outbox.status === OutboxStatus.reconciled ||
        outbox.status === OutboxStatus.permanently_failed ||
        outbox.status === OutboxStatus.canceled
      ) {
        return outbox;
      }

      const claimed = await this.prisma.outboxMessage.update({
        where: { id: outboxId },
        data: {
          status: OutboxStatus.sending,
          attempts: { increment: 1 },
          lastAttemptAt: new Date(),
          nextRetryAt: null,
          lastError: null,
          lockedAt: new Date(),
          lockedBy: lockToken,
        },
        include: {
          message: {
            include: {
              outbox: {
                select: {
                  id: true,
                  status: true,
                  attempts: true,
                  lastError: true,
                  nextRetryAt: true,
                },
              },
              createdBy: { select: { id: true, name: true, email: true } },
            },
          },
        },
      });

      try {
        const result = await this.waha.sendText(
          claimed.sessionName,
          claimed.chatJid,
          claimed.text,
        );
        return await this.finalizeOutboxSuccess(claimed, result);
      } catch (error) {
        return await this.finalizeOutboxFailure(claimed, error);
      }
    } finally {
      await this.releaseLock(lockKey, lockToken);
    }
  }

  async listPending() {
    return this.prisma.outboxMessage.findMany({
      where: {
        status: {
          in: [
            OutboxStatus.queued,
            OutboxStatus.sending,
            OutboxStatus.retryable_failed,
            OutboxStatus.failed,
            OutboxStatus.permanently_failed,
          ],
        },
      },
      orderBy: [{ updatedAt: 'desc' }, { createdAt: 'desc' }],
      take: 200,
      include: {
        conversation: { include: { contact: true } },
        message: {
          include: {
            createdBy: { select: { id: true, name: true, email: true } },
          },
        },
      },
    });
  }

  async retryPending() {
    const now = new Date();
    const retryable = await this.prisma.outboxMessage.findMany({
      where: {
        status: {
          in: [OutboxStatus.queued, OutboxStatus.retryable_failed],
        },
        OR: [{ nextRetryAt: null }, { nextRetryAt: { lte: now } }],
      },
      orderBy: { createdAt: 'asc' },
      take: 200,
      select: { id: true },
    });

    for (const item of retryable) {
      await this.queues.enqueueOutbox(item.id);
    }

    const needsReview = await this.prisma.outboxMessage.count({
      where: {
        status: {
          in: [OutboxStatus.failed, OutboxStatus.permanently_failed],
        },
      },
    });

    return { queued: retryable.length, needsReview };
  }

  async retryOne(outboxId: string) {
    const outbox = await this.prisma.outboxMessage.findUnique({
      where: { id: outboxId },
    });

    if (!outbox) throw new NotFoundException('Outbox message not found');

    if (outbox.status === OutboxStatus.failed) {
      throw new ConflictException(
        'Legacy failed outbox requires reconciliation before retry',
      );
    }

    if (
      outbox.status === OutboxStatus.sent ||
      outbox.status === OutboxStatus.reconciled ||
      outbox.status === OutboxStatus.canceled
    ) {
      return outbox;
    }

    const updated = await this.prisma.outboxMessage.update({
      where: { id: outboxId },
      data: {
        status: OutboxStatus.queued,
        nextRetryAt: null,
        resolvedAt: null,
        lastError: null,
        lockedAt: null,
        lockedBy: null,
      },
    });

    await this.queues.enqueueOutbox(outboxId);
    return updated;
  }

  async recoverStaleOutbox() {
    const staleBefore = new Date(Date.now() - OUTBOX_STALE_MINUTES * 60_000);

    const stale = await this.prisma.outboxMessage.findMany({
      where: {
        status: OutboxStatus.sending,
        OR: [{ lockedAt: null }, { lockedAt: { lt: staleBefore } }],
      },
      select: { id: true },
      take: 200,
    });

    for (const item of stale) {
      await this.prisma.outboxMessage.update({
        where: { id: item.id },
        data: {
          status: OutboxStatus.retryable_failed,
          lastError: 'Recovered stale sending outbox',
          nextRetryAt: new Date(),
          lockedAt: null,
          lockedBy: null,
        },
      });

      await this.queues.enqueueOutbox(item.id);
    }

    return stale.length;
  }

  private async finalizeOutboxSuccess(
    outbox: OutboxMessage & {
      message: {
        id: string;
        createdAt: Date;
        createdBy: { id: string; name: string; email: string } | null;
      };
    },
    result: unknown,
  ) {
    const providerId = extractProviderMessageId(result);
    const providerMessage =
      providerId
        ? await this.prisma.message.findFirst({
            where: {
              channelId: outbox.channelId,
              externalMessageId: providerId,
            },
            include: {
              outbox: {
                select: {
                  id: true,
                  status: true,
                  attempts: true,
                  lastError: true,
                  nextRetryAt: true,
                },
              },
              createdBy: { select: { id: true, name: true, email: true } },
              media: true,
            },
          })
        : null;

    if (providerMessage && providerMessage.id !== outbox.messageId) {
      if (!providerMessage.outbox) {
        await this.prisma.$transaction(async (tx) => {
          await tx.outboxMessage.update({
            where: { id: outbox.id },
            data: {
              messageId: providerMessage.id,
              status: OutboxStatus.reconciled,
              resultPayload: result as Prisma.JsonObject,
              sentAt: new Date(),
              reconciledAt: new Date(),
              resolvedAt: new Date(),
              lastError: 'Reconciled with existing provider message',
              lockedAt: null,
              lockedBy: null,
            },
          });

          await tx.message.delete({
            where: { id: outbox.messageId },
          });
        });

        await this.realtime.publish(
          'message.updated',
          {
            message: providerMessage,
            reconciliation: true,
          },
          { rooms: this.realtimeRoomsForConversation(outbox.conversationId) },
        );

        return this.prisma.outboxMessage.findUniqueOrThrow({
          where: { id: outbox.id },
          include: {
            message: {
              include: {
                outbox: {
                  select: {
                    id: true,
                    status: true,
                    attempts: true,
                    lastError: true,
                    nextRetryAt: true,
                  },
                },
              },
            },
          },
        });
      }

      this.logger.warn(
        `Outbox ${outbox.id} matched provider message ${providerMessage.id} already owned by another outbox`,
      );
      return this.prisma.outboxMessage.update({
        where: { id: outbox.id },
        data: {
          status: OutboxStatus.failed,
          resultPayload: result as Prisma.JsonObject,
          lastError: 'Provider message already linked to another outbox row',
          lockedAt: null,
          lockedBy: null,
        },
      });
    }

    const message = await this.prisma.message.update({
      where: { id: outbox.messageId },
      data: {
        ackStatus: AckStatus.server,
        providerTimestamp: providerMessage?.providerTimestamp ?? outbox.message.createdAt,
        rawPayload: result as Prisma.JsonObject,
        ...(providerId ? { externalMessageId: providerId } : {}),
      },
      include: {
        outbox: {
          select: {
            id: true,
            status: true,
            attempts: true,
            lastError: true,
            nextRetryAt: true,
          },
        },
        media: true,
        createdBy: { select: { id: true, name: true, email: true } },
      },
    });

    const updatedOutbox = await this.prisma.outboxMessage.update({
      where: { id: outbox.id },
      data: {
        status: OutboxStatus.sent,
        resultPayload: result as Prisma.JsonObject,
        sentAt: new Date(),
        resolvedAt: new Date(),
        lockedAt: null,
        lockedBy: null,
      },
      include: { message: true },
    });

    await this.prisma.conversation.update({
      where: { id: outbox.conversationId },
      data: {
        lastMessageAt: message.providerTimestamp ?? message.createdAt,
      },
    });

    await this.realtime.publish(
      'message.updated',
      { message },
      { rooms: this.realtimeRoomsForConversation(outbox.conversationId) },
    );
    return updatedOutbox;
  }

  private async finalizeOutboxFailure(
    outbox: OutboxMessage & {
      message: {
        id: string;
        createdBy: { id: string; name: string; email: string } | null;
      };
    },
    error: unknown,
  ) {
    const reason = error instanceof Error ? error.message : 'Unknown WAHA send error';
    const attempts = outbox.attempts;
    const retryable = isRetryableOutboxError(reason);
    const canRetry = retryable && attempts < MAX_OUTBOX_ATTEMPTS;
    const nextRetryAt = canRetry ? new Date(Date.now() + retryDelayMs(attempts)) : null;

    const message = await this.prisma.message.update({
      where: { id: outbox.messageId },
      data: { ackStatus: AckStatus.error },
      include: {
        outbox: {
          select: {
            id: true,
            status: true,
            attempts: true,
            lastError: true,
            nextRetryAt: true,
          },
        },
        media: true,
        createdBy: { select: { id: true, name: true, email: true } },
      },
    });

    const updatedOutbox = await this.prisma.outboxMessage.update({
      where: { id: outbox.id },
      data: {
        status: canRetry
          ? OutboxStatus.retryable_failed
          : retryable
            ? OutboxStatus.permanently_failed
            : OutboxStatus.failed,
        lastError: reason,
        nextRetryAt,
        resolvedAt: canRetry ? null : new Date(),
        lockedAt: null,
        lockedBy: null,
      },
    });

    if (canRetry && nextRetryAt) {
      await this.queues.enqueueOutbox(outbox.id, Math.max(nextRetryAt.getTime() - Date.now(), 0));
    }

    await this.realtime.publish(
      'message.updated',
      {
        message,
        error: reason,
        outboxStatus: updatedOutbox.status,
      },
      { rooms: this.realtimeRoomsForConversation(outbox.conversationId) },
    );

    return updatedOutbox;
  }

  private realtimeRoomsForConversation(conversationId: string) {
    return ['inbox', `conversation:${conversationId}`];
  }

  private async findExistingOutgoingMessage(input: {
    conversationId: string;
    clientMessageId: string;
    idempotencyKey: string;
  }) {
    const existingByClientId = await this.prisma.message.findFirst({
      where: {
        conversationId: input.conversationId,
        clientMessageId: input.clientMessageId,
      },
      include: {
        outbox: {
          select: {
            id: true,
            status: true,
            attempts: true,
            lastError: true,
            nextRetryAt: true,
          },
        },
        createdBy: { select: { id: true, name: true, email: true } },
      },
    });

    if (existingByClientId) {
      return existingByClientId;
    }

    const existingOutbox = await this.prisma.outboxMessage.findUnique({
      where: { idempotencyKey: input.idempotencyKey },
      include: {
        message: {
          include: {
            outbox: {
              select: {
                id: true,
                status: true,
                attempts: true,
                lastError: true,
                nextRetryAt: true,
              },
            },
            createdBy: { select: { id: true, name: true, email: true } },
          },
        },
      },
    });

    return existingOutbox?.message ?? null;
  }

  private async releaseLock(lockKey: string, lockToken: string) {
    const current = await this.redis.publisher.get(lockKey);
    if (current === lockToken) {
      await this.redis.publisher.del(lockKey);
    }
  }
}

function createOutboxIdempotencyKey(
  conversationId: string,
  chatJid: string,
  clientMessageId: string,
  text: string,
) {
  return createHash('sha256')
    .update(`${conversationId}:${chatJid}:${clientMessageId}:${text}`)
    .digest('hex');
}

function extractProviderMessageId(result: any): string | null {
  const value =
    result?.id?._serialized ??
    result?._data?.id?._serialized ??
    (typeof result?.id === 'string' ? result.id : null) ??
    result?.id?.id ??
    result?._data?.id?.id ??
    result?.key?.id ??
    null;

  return value ? String(value) : null;
}

function isRetryableOutboxError(message: string) {
  const normalized = message.toLowerCase();

  if (normalized.includes('status code 4') && !normalized.includes('429')) {
    return false;
  }

  if (normalized.includes('unique constraint failed on the fields: (`message_id`)')) {
    return false;
  }

  return true;
}

function retryDelayMs(attempt: number) {
  const base = Math.min(2 ** Math.max(attempt - 1, 0), 32);
  return base * 1000;
}

function isUniqueViolation(error: unknown) {
  return (
    error instanceof PrismaClientKnownRequestError &&
    error.code === 'P2002'
  );
}
