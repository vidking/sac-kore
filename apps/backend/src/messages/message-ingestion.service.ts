import { Injectable, Logger } from '@nestjs/common';
import {
  AckStatus,
  ChatSyncStatus,
  ChannelStatus,
  MediaStatus,
  MessageDirection,
  Prisma,
} from '@prisma/client';
import {
  mapAckStatus,
  mapChannelStatus,
  extractWahaMessageId,
  getDedupeKey,
  isGenericDisplayName,
  isHiddenConversationType,
  normalizeWahaChat,
  normalizeWahaEvent,
  normalizeWahaMessage,
  phoneFromJid,
} from '../common/waha-normalize';
import { PrismaService } from '../prisma/prisma.service';
import { QueueProducerService } from '../queues/queue-producer.service';
import { RealtimeEventsService } from '../realtime/realtime-events.service';
import { RedisService } from '../realtime/redis.service';
import { WahaAdapterService } from '../waha/waha-adapter.service';
import { WahaWebhookEvent } from '../waha/waha.types';

const realtimeConversationPreviewInclude = {
  channel: true,
  contact: {
    select: {
      id: true,
      phone: true,
      whatsappJid: true,
      displayName: true,
      createdAt: true,
      updatedAt: true,
    },
  },
  assignedUser: { select: { id: true, name: true, email: true, role: true } },
  tags: { include: { tag: true } },
  messages: {
    orderBy: [{ providerTimestamp: 'desc' }, { sequence: 'desc' }],
    take: 1,
    select: {
      id: true,
      clientMessageId: true,
      externalMessageId: true,
      conversationId: true,
      direction: true,
      senderJid: true,
      senderName: true,
      participantJid: true,
      body: true,
      caption: true,
      type: true,
      reactionEmoji: true,
      reactionTargetExternalMessageId: true,
      ackStatus: true,
      providerTimestamp: true,
      createdAt: true,
      sequence: true,
      createdBy: { select: { id: true, name: true, email: true } },
      outbox: {
        select: {
          id: true,
          status: true,
          attempts: true,
          lastError: true,
          nextRetryAt: true,
        },
      },
      media: {
        select: {
          id: true,
          status: true,
          mediaType: true,
          caption: true,
          mime: true,
          fileName: true,
          pathOrUrl: true,
          thumbnailPathOrUrl: true,
          thumbnailBase64: true,
          providerMessageId: true,
          providerMediaId: true,
          mediaKey: true,
          fetchStatus: true,
          fetchError: true,
          sha256: true,
          size: true,
        },
      },
    },
  },
} satisfies Prisma.ConversationInclude;

const richMessageSelect = {
  id: true,
  status: true,
  mediaType: true,
  caption: true,
  mime: true,
  fileName: true,
  pathOrUrl: true,
  thumbnailPathOrUrl: true,
  thumbnailBase64: true,
  providerMessageId: true,
  providerMediaId: true,
  mediaKey: true,
  fetchStatus: true,
  fetchError: true,
  sha256: true,
  size: true,
} satisfies Prisma.MediaSelect;

@Injectable()
export class MessageIngestionService {
  private readonly logger = new Logger(MessageIngestionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly queues: QueueProducerService,
    private readonly realtime: RealtimeEventsService,
    private readonly redis: RedisService,
    private readonly waha: WahaAdapterService,
  ) {}

  async ingestWahaEvent(event: WahaWebhookEvent, metadata: Record<string, any> = {}) {
    if (event.event === 'session.status') {
      return this.ingestSessionStatus(event);
    }

    if (event.event === 'message.ack') {
      return this.ingestAck(event);
    }

    if (event.event === 'message' || event.event === 'message.any') {
      return this.withEventLock(event, () => this.ingestMessage(event, metadata));
    }

    return { ignored: true, event: event.event };
  }

  private async ingestSessionStatus(event: WahaWebhookEvent) {
    const sessionName = event.session;
    const status = mapChannelStatus(event.payload?.status);
    this.logger.log(
      JSON.stringify({
        action: 'session.status',
        sessionName,
        status,
      }),
    );
    const channel = await this.prisma.channel.upsert({
      where: { sessionName },
      update: { status },
      create: { sessionName, status },
    });

    await this.realtime.publish('channel.status', { channel }, { rooms: ['inbox'] });

    if (status === ChannelStatus.working) {
      await this.queues.enqueueResync(sessionName, 'session.status.WORKING');
    }

    return { channel };
  }

  private async ingestAck(event: WahaWebhookEvent) {
    const payload = event.payload ?? {};
    const externalMessageId = extractWahaMessageId(payload);
    if (!externalMessageId) return { ignored: true, reason: 'ack without message id' };

    const channel = await this.ensureChannel(event.session);
    const ackStatus = mapAckStatus(payload.ackName ?? payload.ack);

    const message = await this.prisma.message.findFirst({
      where: {
        channelId: channel.id,
        externalMessageId,
      },
    });

    if (!message) {
      this.logger.warn(
        JSON.stringify({
          action: 'message.ack.miss',
          channelId: channel.id,
          externalMessageId,
          ackStatus,
        }),
      );
      return { ignored: true, reason: 'ack message not found', externalMessageId };
    }

    const updated = await this.prisma.message.update({
      where: { id: message.id },
      data: {
        ackStatus,
        rawPayload: event as unknown as Prisma.JsonObject,
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
      },
    });

    await this.realtime.publish(
      'message.ack',
      {
        messageId: updated.id,
        conversationId: updated.conversationId,
        ackStatus,
      },
      { rooms: this.realtimeRoomsForConversation(updated.conversationId) },
    );

    this.logger.log(
      JSON.stringify({
        action: 'message.ack',
        channelId: channel.id,
        messageId: updated.id,
        conversationId: updated.conversationId,
        externalMessageId,
        ackStatus,
      }),
    );

    return { message: updated };
  }

  private async ingestMessage(event: WahaWebhookEvent, metadata: Record<string, any>) {
    const payload = event.payload ?? {};
    const normalizedMessage = normalizeWahaMessage(payload);
    const externalMessageId = normalizedMessage.wahaMessageId;
    if (!externalMessageId) {
      return { ignored: true, reason: 'message without id' };
    }

    const chatJid = normalizedMessage.chatJid;
    if (!chatJid) {
      return { ignored: true, reason: 'message without chat jid', externalMessageId };
    }

    this.logger.log(
      JSON.stringify({
        action: 'message.received',
        session: event.session,
        event: event.event,
        externalMessageId,
        chatJid,
        type: normalizedMessage.type,
        direction: normalizedMessage.direction,
      }),
    );

    const channel = await this.ensureChannel(event.session);
    const existing = await this.prisma.message.findUnique({
      where: {
        channelId_externalMessageId: {
          channelId: channel.id,
          externalMessageId,
        },
      },
    });

    const direction = normalizedMessage.direction as MessageDirection;
    const providerTimestamp = normalizedMessage.providerTimestamp;
    const senderJid =
      direction === MessageDirection.outbound
        ? event.me?.id ?? channel.sessionName
        : normalizedMessage.senderJid;
    const ackStatus = normalizedMessage.ackStatus;
    const body = normalizedMessage.body;
    const type = normalizedMessage.type;
    const chatMetadata = normalizeWahaChat({
      ...payload,
      id: chatJid,
    });
    const enrichedChatMetadata = await this.enrichChatMetadata(
      event.session,
      chatJid,
      payload,
      chatMetadata,
    );
    const resolvedSenderName = await this.resolveSenderDisplayName({
      sessionName: event.session,
      channelId: channel.id,
      chatJid,
      participantJid: normalizedMessage.participantJid,
      rawPayload: payload,
      chatType: enrichedChatMetadata.type,
      currentSenderName: normalizedMessage.senderName,
    });

    const contact = await this.upsertContact(chatJid, payload, enrichedChatMetadata);
    const conversation = await this.upsertConversation({
      channelId: channel.id,
      contactId: contact.id,
      chatJid,
      type: enrichedChatMetadata.type,
      displayName: enrichedChatMetadata.displayName,
      pushName: enrichedChatMetadata.pushName,
      subject: enrichedChatMetadata.subject,
      avatarUrl: enrichedChatMetadata.avatarUrl,
      isArchived: enrichedChatMetadata.isArchived,
      isPinned: enrichedChatMetadata.isPinned,
      providerTimestamp,
      incrementUnread:
        !existing &&
        direction === MessageDirection.inbound &&
        normalizedMessage.type !== 'reaction',
    });

    if (existing) {
      const updated = await this.prisma.message.update({
        where: { id: existing.id },
        data: {
          body,
          caption: normalizedMessage.caption,
          ackStatus: ackStatus === AckStatus.unknown ? existing.ackStatus : ackStatus,
          providerTimestamp,
          senderJid,
          senderName: normalizedMessage.senderName,
          participantJid: normalizedMessage.participantJid,
          reactionEmoji: normalizedMessage.reaction.emoji,
          reactionTargetExternalMessageId: normalizedMessage.reaction.targetExternalMessageId,
          deletedAt: normalizedMessage.deletedAt,
          editedAt: normalizedMessage.editedAt,
          senderName: resolvedSenderName,
          rawPayload: event as unknown as Prisma.JsonObject,
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
          media: {
            select: richMessageSelect,
          },
          createdBy: { select: { id: true, name: true, email: true } },
        },
      });

      this.logger.log(
        JSON.stringify({
          action: 'message.deduped',
          channelId: channel.id,
          conversationId: updated.conversationId,
          messageId: updated.id,
          externalMessageId,
          chatJid,
        }),
      );

      if (normalizedMessage.media) {
        await this.createOrUpdateMediaReference(updated.id, normalizedMessage.media, {
          mediaType: type,
          caption: normalizedMessage.caption,
          providerMessageId: normalizedMessage.wahaMessageId,
          providerMediaId: normalizedMessage.media.providerMediaId,
          mediaKey: normalizedMessage.media.mediaKey,
          thumbnailBase64: normalizedMessage.media.thumbnailBase64,
        });
      }

      await this.realtime.publish(
        'message.updated',
        { message: updated },
        { rooms: this.realtimeRoomsForMessage(updated.conversationId, conversation.type) },
      );
      return { message: updated, inserted: false };
    }

    const reconciled = await this.reconcileOutboundMessage({
      channelId: channel.id,
      conversationId: conversation.id,
      externalMessageId,
      direction,
      body,
      type,
      providerTimestamp,
      ackStatus,
      event,
      metadata,
    });

    if (reconciled) {
      this.logger.log(
        JSON.stringify({
          action: 'message.reconciled',
          channelId: channel.id,
          conversationId: reconciled.conversationId,
          messageId: reconciled.id,
          externalMessageId,
          chatJid,
        }),
      );
      await this.realtime.publish(
        'message.updated',
        { message: reconciled },
        { rooms: this.realtimeRoomsForMessage(reconciled.conversationId, conversation.type) },
      );
      return { message: reconciled, inserted: false, reconciled: true };
    }

    const message = await this.prisma.message.create({
      data: {
        externalMessageId,
        channelId: channel.id,
        conversationId: conversation.id,
        direction,
        senderJid,
        senderName: resolvedSenderName,
        participantJid: normalizedMessage.participantJid,
        body,
        caption: normalizedMessage.caption,
        type,
        reactionEmoji: normalizedMessage.reaction.emoji,
        reactionTargetExternalMessageId: normalizedMessage.reaction.targetExternalMessageId,
        providerTimestamp,
        ackStatus,
        deletedAt: normalizedMessage.deletedAt,
        editedAt: normalizedMessage.editedAt,
        rawPayload: {
          ...event,
          metadata,
        } as Prisma.JsonObject,
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
        media: {
          select: richMessageSelect,
        },
        createdBy: { select: { id: true, name: true, email: true } },
      },
    });

    if (normalizedMessage.participantJid) {
      const participantDisplayName = await this.resolveSenderDisplayName({
        sessionName: event.session,
        channelId: channel.id,
        chatJid,
        participantJid: normalizedMessage.participantJid,
        rawPayload: payload,
        chatType: enrichedChatMetadata.type,
        currentSenderName: resolvedSenderName,
      });
      await this.upsertParticipant({
        channelId: channel.id,
        conversationId: conversation.id,
        chatJid,
        participantJid: normalizedMessage.participantJid,
        displayName: participantDisplayName,
      });
    }

    await this.prisma.conversationEvent.create({
      data: {
        conversationId: conversation.id,
        eventType: direction === MessageDirection.inbound ? 'message.inbound' : 'message.outbound',
        payload: { messageId: message.id, externalMessageId },
      },
    });

    if (normalizedMessage.media) {
      await this.createOrUpdateMediaReference(message.id, normalizedMessage.media, {
        mediaType: type,
        caption: normalizedMessage.caption,
        providerMessageId: normalizedMessage.wahaMessageId,
        providerMediaId: normalizedMessage.media.providerMediaId,
        mediaKey: normalizedMessage.media.mediaKey,
        thumbnailBase64: normalizedMessage.media.thumbnailBase64,
      });
    }

    const freshConversation = await this.prisma.conversation.findUnique({
      where: { id: conversation.id },
      include: realtimeConversationPreviewInclude,
    });

    if (freshConversation && !isHiddenConversationType(freshConversation.type)) {
      await this.realtime.publish(
        'conversation.upserted',
        {
          conversation: freshConversation,
        },
        { rooms: this.realtimeRoomsForConversation(freshConversation.id) },
      );
      await this.cacheConversationPreview(event.session, freshConversation);
      this.logger.log(
        JSON.stringify({
          action: 'conversation.upserted',
          channelId: channel.id,
          conversationId: freshConversation.id,
          chatJid,
          externalMessageId,
          type: freshConversation.type,
          unreadCount: freshConversation.unreadCount,
          lastActivityAt: freshConversation.lastMessageAt,
        }),
      );
    }
    if (type === 'reaction') {
      await this.realtime.publish(
        'message.reaction',
        {
          message,
          conversationId: conversation.id,
          targetExternalMessageId: normalizedMessage.reaction.targetExternalMessageId,
          emoji: normalizedMessage.reaction.emoji,
        },
        { rooms: this.realtimeRoomsForConversation(conversation.id) },
      );
    } else if (!isHiddenConversationType(conversation.type)) {
      await this.realtime.publish(
        'message.created',
        { message },
        { rooms: this.realtimeRoomsForConversation(conversation.id) },
      );
      this.logger.log(
        JSON.stringify({
          action: 'message.created',
          channelId: channel.id,
          conversationId: conversation.id,
          messageId: message.id,
          externalMessageId,
          chatJid,
          direction,
          type,
        }),
      );
    }
    return { message, inserted: true };
  }

  private realtimeRoomsForConversation(conversationId: string) {
    return ['inbox', `conversation:${conversationId}`];
  }

  private realtimeRoomsForMessage(
    conversationId: string,
    type: ReturnType<typeof normalizeWahaChat>['type'],
  ) {
    return isHiddenConversationType(type)
      ? [`conversation:${conversationId}`]
      : this.realtimeRoomsForConversation(conversationId);
  }

  private ensureChannel(sessionName: string) {
    return this.prisma.channel.upsert({
      where: { sessionName },
      update: {},
      create: { sessionName },
    });
  }

  private upsertContact(
    chatJid: string,
    payload: Record<string, any>,
    chatMetadata = normalizeWahaChat({ ...payload, id: chatJid }),
  ) {
    const displayName =
      chatMetadata.displayName ??
      payload.notifyName ??
      payload.pushName ??
      payload._data?.notifyName ??
      payload._data?.pushName ??
      'Contacto sin nombre';

    return this.prisma.contact.upsert({
      where: { whatsappJid: chatJid },
      update: {
        phone: phoneFromJid(chatJid),
        displayName,
        profileMetadata: payload._data
          ? ({ _data: payload._data } as Prisma.JsonObject)
          : undefined,
      },
      create: {
        whatsappJid: chatJid,
        phone: phoneFromJid(chatJid),
        displayName,
        profileMetadata: payload._data
          ? ({ _data: payload._data } as Prisma.JsonObject)
          : undefined,
      },
    });
  }

  private async upsertConversation(input: {
    channelId: string;
    contactId: string;
    chatJid: string;
    type: ReturnType<typeof normalizeWahaChat>['type'];
    displayName: string | null;
    pushName: string | null;
    subject: string | null;
    avatarUrl: string | null;
    isArchived: boolean;
    isPinned: boolean;
    providerTimestamp: Date;
    incrementUnread: boolean;
  }) {
    const existing = await this.prisma.conversation.findUnique({
      where: {
        channelId_chatJid: {
          channelId: input.channelId,
          chatJid: input.chatJid,
        },
      },
    });

    if (!existing) {
      return this.prisma.conversation.create({
        data: {
          channelId: input.channelId,
          contactId: input.contactId,
          chatJid: input.chatJid,
          type: input.type,
          displayName: input.displayName,
          pushName: input.pushName,
          subject: input.subject,
          avatarUrl: input.avatarUrl,
          isArchived: input.isArchived,
          isPinned: input.isPinned,
          syncStatus: ChatSyncStatus.synced,
          lastMessageAt: input.providerTimestamp,
          unreadCount: input.incrementUnread ? 1 : 0,
        },
      });
    }

    const shouldMoveLastMessage =
      !existing.lastMessageAt || existing.lastMessageAt < input.providerTimestamp;

    return this.prisma.conversation.update({
      where: { id: existing.id },
      data: {
        contactId: input.contactId,
        type: input.type,
        displayName: input.displayName,
        pushName: input.pushName,
        subject: input.subject,
        avatarUrl: input.avatarUrl,
        isArchived: input.isArchived,
        isPinned: input.isPinned,
        syncStatus: ChatSyncStatus.synced,
        lastMessageAt: shouldMoveLastMessage ? input.providerTimestamp : existing.lastMessageAt,
        unreadCount: input.incrementUnread ? { increment: 1 } : undefined,
      },
    });
  }

  private async createOrUpdateMediaReference(
    messageId: string,
    mediaInput: {
      mime: string | null;
      fileName: string | null;
      url: string | null;
      size: number | null;
      thumbnailUrl: string | null;
      thumbnailBase64: string | null;
      providerMessageId: string | null;
      providerMediaId: string | null;
      mediaKey: string | null;
      mediaType: string | null;
      caption: string | null;
      error: string | null;
    },
  ) {
    const fetchStatus = mediaInput.url
      ? 'pending'
      : /protect|secure|phone/i.test(mediaInput.error ?? '')
        ? 'protected'
        : /expired|gone|missing|404/i.test(mediaInput.error ?? '')
          ? 'expired'
          : mediaInput.error
            ? 'failed'
            : 'pending';

    const media = await this.prisma.media.upsert({
      where: { messageId },
      update: {
        mediaType: mediaInput.mediaType,
        caption: mediaInput.caption,
        mime: mediaInput.mime,
        fileName: mediaInput.fileName,
        pathOrUrl: mediaInput.url,
        thumbnailPathOrUrl: mediaInput.thumbnailUrl,
        thumbnailBase64: mediaInput.thumbnailBase64,
        providerMessageId: mediaInput.providerMessageId,
        providerMediaId: mediaInput.providerMediaId,
        mediaKey: mediaInput.mediaKey,
        fetchStatus,
        fetchError: mediaInput.error,
        size: mediaInput.size,
        status: mediaInput.url ? MediaStatus.pending : MediaStatus.failed,
      },
      create: {
        messageId,
        mediaType: mediaInput.mediaType,
        caption: mediaInput.caption,
        mime: mediaInput.mime,
        fileName: mediaInput.fileName,
        pathOrUrl: mediaInput.url,
        thumbnailPathOrUrl: mediaInput.thumbnailUrl,
        thumbnailBase64: mediaInput.thumbnailBase64,
        providerMessageId: mediaInput.providerMessageId,
        providerMediaId: mediaInput.providerMediaId,
        mediaKey: mediaInput.mediaKey,
        fetchStatus,
        fetchError: mediaInput.error,
        size: mediaInput.size,
        status: mediaInput.url ? MediaStatus.pending : MediaStatus.failed,
      },
    });

    await this.prisma.message.update({
      where: { id: messageId },
      data: { mediaId: media.id },
    });

    if (mediaInput.url) {
      await this.queues.enqueueMedia(media.id);
    }

    return media;
  }

  private upsertParticipant(input: {
    channelId: string;
    conversationId: string;
    chatJid: string;
    participantJid: string;
    displayName: string | null;
  }) {
    return this.prisma.chatParticipant.upsert({
      where: {
        channelId_chatJid_participantJid: {
          channelId: input.channelId,
          chatJid: input.chatJid,
          participantJid: input.participantJid,
        },
      },
      update: {
        conversationId: input.conversationId,
        displayName: input.displayName,
      },
      create: input,
    });
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

  private async withEventLock<T>(event: WahaWebhookEvent, work: () => Promise<T>) {
    const key = `kore:waha:event-lock:${getDedupeKey(event)}`;
    const acquired = await this.redis.publisher.set(key, '1', 'EX', 15, 'NX');
    if (!acquired) {
      return {
        ignored: true,
        duplicate: true,
        event: normalizeWahaEvent(event),
      } as T;
    }

    try {
      return await work();
    } finally {
      await this.redis.publisher.del(key);
    }
  }

  private async reconcileOutboundMessage(input: {
    channelId: string;
    conversationId: string;
    externalMessageId: string;
    direction: MessageDirection;
    body: string | null;
    type: Prisma.MessageCreateInput['type'];
    providerTimestamp: Date;
    ackStatus: AckStatus;
    event: WahaWebhookEvent;
    metadata: Record<string, any>;
  }) {
    if (input.direction !== MessageDirection.outbound || !input.body) {
      return null;
    }

    const createdAfter = new Date(input.providerTimestamp.getTime() - 5 * 60 * 1000);
    const candidate = await this.prisma.message.findFirst({
      where: {
        channelId: input.channelId,
        conversationId: input.conversationId,
        direction: MessageDirection.outbound,
        body: input.body,
        type: input.type,
        externalMessageId: { startsWith: 'local:' },
        createdAt: { gte: createdAfter },
      },
      orderBy: [{ createdAt: 'desc' }, { sequence: 'desc' }],
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
        media: {
          select: richMessageSelect,
        },
        createdBy: { select: { id: true, name: true, email: true } },
      },
    });

    if (!candidate) {
      return null;
    }

    return this.prisma.message.update({
      where: { id: candidate.id },
      data: {
        externalMessageId: input.externalMessageId,
        providerTimestamp: input.providerTimestamp,
        ackStatus:
          input.ackStatus === AckStatus.unknown ? candidate.ackStatus : input.ackStatus,
        rawPayload: {
          ...input.event,
          metadata: input.metadata,
        } as Prisma.JsonObject,
      },
      include: {
        media: {
          select: richMessageSelect,
        },
        createdBy: { select: { id: true, name: true, email: true } },
      },
    });
  }

  private async enrichChatMetadata(
    sessionName: string,
    chatJid: string,
    rawPayload: Record<string, any>,
    chatMetadata: ReturnType<typeof normalizeWahaChat>,
  ) {
    if (!isGenericDisplayName(chatMetadata.displayName, chatMetadata.type)) {
      return chatMetadata;
    }

    const displayName = await this.waha.resolveDisplayName(sessionName, chatJid, {
      type: chatMetadata.type,
      rawChat: rawPayload,
      fallbackLabel: chatMetadata.displayName,
    });

    return {
      ...chatMetadata,
      displayName,
      subject: chatMetadata.subject ?? displayName,
    };
  }

  private async resolveSenderDisplayName(input: {
    sessionName: string;
    channelId: string;
    chatJid: string;
    participantJid: string | null;
    rawPayload: Record<string, any>;
    chatType: ReturnType<typeof normalizeWahaChat>['type'];
    currentSenderName: string | null;
  }) {
    if (!input.participantJid) {
      return input.currentSenderName;
    }

    if (input.currentSenderName && !isGenericDisplayName(input.currentSenderName, input.chatType)) {
      return input.currentSenderName;
    }

    const existingParticipant = await this.prisma.chatParticipant.findFirst({
      where: {
        channelId: input.channelId,
        chatJid: input.chatJid,
        participantJid: input.participantJid,
      },
      select: { displayName: true },
    });

    if (existingParticipant?.displayName && !isGenericDisplayName(existingParticipant.displayName, input.chatType)) {
      return existingParticipant.displayName;
    }

    const liveName = await this.waha.resolveDisplayName(input.sessionName, input.participantJid, {
      type: input.chatType,
      rawChat: input.rawPayload,
      participantJid: input.participantJid,
      fallbackLabel: existingParticipant?.displayName ?? input.currentSenderName,
    });

    if (liveName && !isGenericDisplayName(liveName, input.chatType)) {
      return liveName;
    }

    return (
      existingParticipant?.displayName ??
      input.currentSenderName ??
      humanizeParticipantJid(input.participantJid)
    );
  }
}

function humanizeParticipantJid(jid: string) {
  const normalized = jid.trim();
  if (!normalized) return null;

  const digits = normalized.replace(/[^\d]/g, '');
  if (digits.length >= 4) {
    return `Participante ${digits.slice(-4)}`;
  }

  return 'Participante';
}
