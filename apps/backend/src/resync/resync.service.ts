import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChatSyncStatus, ConversationType, Prisma, SyncStatus } from '@prisma/client';
import { randomUUID } from 'crypto';
import {
  normalizeWahaChat,
  phoneFromJid,
  pickChatJid,
  providerTimestampToDate,
  isGenericDisplayName,
} from '../common/waha-normalize';
import { MessageIngestionService } from '../messages/message-ingestion.service';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeEventsService } from '../realtime/realtime-events.service';
import { RedisService } from '../realtime/redis.service';
import { SyncLifecycleService } from '../sync/sync-lifecycle.service';
import { WahaAdapterService } from '../waha/waha-adapter.service';

@Injectable()
export class ResyncService {
  constructor(
    private readonly config: ConfigService,
    private readonly ingestion: MessageIngestionService,
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeEventsService,
    private readonly redis: RedisService,
    private readonly syncLifecycle: SyncLifecycleService,
    private readonly waha: WahaAdapterService,
  ) {}

  async resyncSession(sessionName: string, reason = 'manual') {
    const lockKey = `kore:sync:${sessionName}`;
    const lockToken = randomUUID();
    const lock = await this.redis.publisher.set(lockKey, lockToken, 'EX', 900, 'NX');
    if (lock !== 'OK') {
      return {
        skipped: true,
        reason: 'sync already running',
        sessionName,
      };
    }

    const channel = await this.prisma.channel.upsert({
      where: { sessionName },
      update: {},
      create: { sessionName },
    });

    await this.syncLifecycle.markStaleRuns(sessionName);

    const syncRun = await this.prisma.syncRun.create({
      data: {
        channelId: channel.id,
        sessionName,
        status: SyncStatus.running,
        heartbeatAt: new Date(),
      },
    });

    let chatsScanned = 0;
    let messagesSeen = 0;
    let messagesNew = 0;

    try {
      const chatLimit = Number(this.config.get<string>('RESYNC_CHAT_LIMIT') ?? 10);
      const messageLimit = Number(this.config.get<string>('RESYNC_MESSAGES_PER_CHAT') ?? 20);

      for (let offset = 0; ; offset += chatLimit) {
        const chats = await this.waha.listChats(sessionName, {
          limit: chatLimit,
          offset,
        });

        if (!chats.length) break;
        await this.syncLifecycle.heartbeat(syncRun.id);
        await this.redis.publisher.expire(lockKey, 900);
        chatsScanned += chats.length;

        for (const chat of chats) {
          const chatId = chat.id?._serialized ?? chat.id ?? chat.chatId ?? pickChatJid(chat);
          if (!chatId) continue;

          const normalizedChat = normalizeWahaChat({ ...chat, id: chatId });
          const conversation = await this.upsertChatMetadata(
            sessionName,
            channel.id,
            String(chatId),
            chat,
            normalizedChat,
          );
          await this.cacheConversationPreview(sessionName, conversation);

          if (normalizedChat.type === ConversationType.group) {
            const metadata = await this.waha.getGroupMetadata(sessionName, String(chatId));
            await this.upsertGroupParticipants(
              channel.id,
              conversation.id,
              String(chatId),
              metadata?.participants ?? [],
            );
          }

          const messages = await this.waha.listMessages(sessionName, String(chatId), messageLimit, {
            offset: 0,
          });

          messagesSeen += messages.length;

          for (const message of messages) {
            const result = await this.ingestion.ingestWahaEvent(
              {
                event: 'message.any',
                session: sessionName,
                payload: {
                  ...message,
                  chatId: message.chatId ?? chatId,
                  timestamp:
                    message.timestamp ??
                    Number(providerTimestampToDate(message.messageTimestamp)?.getTime() ?? 0) /
                      1000,
                },
              },
              { source: 'resync', syncRunId: syncRun.id, reason },
            );

            if ((result as any)?.inserted) messagesNew += 1;
          }
        }

        if (chats.length < chatLimit) break;
      }

      const finished = await this.prisma.syncRun.update({
        where: { id: syncRun.id },
        data: {
          status: SyncStatus.completed,
          heartbeatAt: new Date(),
          finishedAt: new Date(),
          chatsScanned,
          messagesSeen,
          messagesNew,
        },
      });

      await this.prisma.channel.update({
        where: { id: channel.id },
        data: { lastSyncAt: new Date() },
      });

      await this.realtime.publish('sync.completed', { syncRun: finished }, { rooms: ['inbox'] });
      return finished;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown resync error';
      const failed = await this.prisma.syncRun.update({
        where: { id: syncRun.id },
        data: {
          status: SyncStatus.failed,
          heartbeatAt: new Date(),
          finishedAt: new Date(),
          chatsScanned,
          messagesSeen,
          messagesNew,
          error: message,
        },
      });

      await this.realtime.publish('sync.completed', { syncRun: failed }, { rooms: ['inbox'] });
      throw error;
    } finally {
      const current = await this.redis.publisher.get(lockKey);
      if (current === lockToken) {
        await this.redis.publisher.del(lockKey);
      }
    }
  }

  private async upsertChatMetadata(
    sessionName: string,
    channelId: string,
    chatId: string,
    rawChat: Record<string, any>,
    normalized = normalizeWahaChat({ ...rawChat, id: chatId }),
  ) {
    const jid = normalized.jid ?? chatId;
    const displayName = await this.resolveConversationDisplayName(
      sessionName,
      jid,
      rawChat,
      normalized,
    );

    const contact = await this.prisma.contact.upsert({
      where: { whatsappJid: jid },
      update: {
        phone: phoneFromJid(jid),
        displayName,
        profileMetadata: rawChat as Prisma.JsonObject,
      },
      create: {
        whatsappJid: jid,
        phone: phoneFromJid(jid),
        displayName,
        profileMetadata: rawChat as Prisma.JsonObject,
      },
    });

    return this.prisma.conversation.upsert({
      where: {
        channelId_chatJid: {
          channelId,
          chatJid: jid,
        },
      },
      update: {
        contactId: contact.id,
        type: normalized.type,
        displayName,
        pushName: normalized.pushName,
        subject: normalized.subject,
        avatarUrl: normalized.avatarUrl,
        isArchived: normalized.isArchived,
        isPinned: normalized.isPinned,
        syncStatus: ChatSyncStatus.synced,
      },
      create: {
        channelId,
        contactId: contact.id,
        chatJid: jid,
        type: normalized.type,
        displayName,
        pushName: normalized.pushName,
        subject: normalized.subject,
        avatarUrl: normalized.avatarUrl,
        isArchived: normalized.isArchived,
        isPinned: normalized.isPinned,
        syncStatus: ChatSyncStatus.synced,
      },
      include: {
        channel: true,
        contact: true,
        tags: { include: { tag: true } },
        messages: {
          orderBy: [{ providerTimestamp: 'desc' }, { sequence: 'desc' }],
          take: 1,
          select: {
            id: true,
            externalMessageId: true,
            clientMessageId: true,
            conversationId: true,
            direction: true,
            body: true,
            type: true,
            ackStatus: true,
            providerTimestamp: true,
            createdAt: true,
            sequence: true,
          },
        },
      },
    });
  }

  private async resolveConversationDisplayName(
    sessionName: string,
    jid: string,
    rawChat: Record<string, any>,
    normalized: ReturnType<typeof normalizeWahaChat>,
  ) {
    if (!isGenericDisplayName(normalized.displayName, normalized.type)) {
      return normalized.displayName;
    }

    const liveName = await this.waha.resolveDisplayName(sessionName, jid, {
      type: normalized.type,
      rawChat,
      fallbackLabel: normalized.displayName,
    });

    return liveName ?? normalized.displayName ?? jid;
  }

  private async upsertGroupParticipants(
    channelId: string,
    conversationId: string,
    chatJid: string,
    participants: Record<string, any>[],
  ) {
    for (const participant of participants) {
      const participantJid = normalizeParticipantJid(participant);
      if (!participantJid) continue;

      const displayName = firstText(
        participant.displayName,
        participant.name,
        participant.pushName,
        participant.notifyName,
        participant.formattedName,
        participant.profileName,
        participant._data?.displayName,
        participant._data?.name,
        participant._data?.pushName,
        participant._data?.notifyName,
      );

      await this.prisma.chatParticipant.upsert({
        where: {
          channelId_chatJid_participantJid: {
            channelId,
            chatJid,
            participantJid,
          },
        },
        update: {
          conversationId,
          displayName,
        },
        create: {
          channelId,
          conversationId,
          chatJid,
          participantJid,
          displayName,
        },
      });
    }
  }

  private async cacheConversationPreview(sessionName: string, conversation: Record<string, any>) {
    await this.redis.publisher.hset(
      `kore:chats:${sessionName}`,
      conversation.chatJid,
      JSON.stringify({
        id: conversation.id,
        jid: conversation.chatJid,
        type: conversation.type,
        displayName: conversation.displayName ?? conversation.contact?.displayName,
        lastMessageAt: conversation.lastMessageAt,
        unreadCount: conversation.unreadCount,
        syncStatus: conversation.syncStatus,
      }),
    );
  }
}

function firstText(...values: unknown[]) {
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

function normalizeParticipantJid(participant: Record<string, any>) {
  const raw =
    participant.id?._serialized ??
    participant.id ??
    participant.jid?._serialized ??
    participant.jid ??
    participant.whatsappJid ??
    participant.participantJid ??
    null;

  return raw ? normalizeWahaChat({ id: raw }).jid : null;
}
