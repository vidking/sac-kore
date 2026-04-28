import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { ConversationStatus, ConversationType, Prisma } from '@prisma/client';
import { AuthUser } from '../auth/current-user.decorator';
import {
  getBestDisplayName,
  isGenericDisplayName,
  normalizeWahaChat,
  normalizeWahaMessage,
} from '../common/waha-normalize';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeEventsService } from '../realtime/realtime-events.service';
import { SyncLifecycleService } from '../sync/sync-lifecycle.service';
import { WahaAdapterService } from '../waha/waha-adapter.service';

const richMediaSelect: any = {
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
};

const conversationPreviewInclude: any = {
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
  participants: {
    select: {
      id: true,
      chatJid: true,
      participantJid: true,
      displayName: true,
      createdAt: true,
      updatedAt: true,
    },
  },
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
      media: { select: richMediaSelect },
    },
  },
};

const messageDetailSelect: any = {
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
  media: { select: richMediaSelect },
};

@Injectable()
export class ConversationService {
  private legacyTypeBackfillDone = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeEventsService,
    private readonly syncLifecycle: SyncLifecycleService,
    private readonly waha: WahaAdapterService,
  ) {}

  async list(params: {
    actor?: AuthUser;
    status?: ConversationStatus;
    type?: ConversationType;
    assignedTo?: string;
    search?: string;
    take?: number;
    skip?: number;
    unreadOnly?: boolean;
  }) {
    const page = await this.listPage(params);
    return page.items;
  }

  async listPage(params: {
    actor?: AuthUser;
    status?: ConversationStatus;
    type?: ConversationType;
    assignedTo?: string;
    search?: string;
    take?: number;
    cursor?: string;
    channelId?: string;
    sessionName?: string;
    unreadOnly?: boolean;
  }) {
    await this.backfillLegacyConversationTypes();

    const take = clampLimit(params.take, 50, 100);
    const items = await this.prisma.conversation.findMany({
      where: this.buildListWhere(params),
      take: take + 1,
      ...(params.cursor ? { cursor: { id: params.cursor }, skip: 1 } : {}),
      orderBy: [{ isPinned: 'desc' }, { lastMessageAt: 'desc' }, { createdAt: 'desc' }],
      include: conversationPreviewInclude,
    });

    const hasMore = items.length > take;
    const pageItems = hasMore ? items.slice(0, take) : items;

    return {
      items: pageItems,
      pageInfo: {
        nextCursor: hasMore ? pageItems[pageItems.length - 1]?.id ?? null : null,
        hasMore,
      },
    };
  }

  private async backfillLegacyConversationTypes() {
    if (this.legacyTypeBackfillDone) return;

    await this.prisma.$transaction([
      this.prisma.conversation.updateMany({
        where: { type: ConversationType.unknown, chatJid: 'status@broadcast' },
        data: { type: ConversationType.status },
      }),
      this.prisma.conversation.updateMany({
        where: { type: ConversationType.unknown, chatJid: { endsWith: '@c.us' } },
        data: { type: ConversationType.direct },
      }),
      this.prisma.conversation.updateMany({
        where: { type: ConversationType.unknown, chatJid: { endsWith: '@g.us' } },
        data: { type: ConversationType.group },
      }),
      this.prisma.conversation.updateMany({
        where: { type: ConversationType.unknown, chatJid: { endsWith: '@newsletter' } },
        data: { type: ConversationType.newsletter },
      }),
      this.prisma.conversation.updateMany({
        where: { type: ConversationType.unknown, chatJid: { endsWith: '@broadcast' } },
        data: { type: ConversationType.broadcast },
      }),
      this.prisma.conversation.updateMany({
        where: { type: ConversationType.unknown, chatJid: { endsWith: '@lid' } },
        data: { type: ConversationType.system },
      }),
    ]);

    this.legacyTypeBackfillDone = true;
  }

  async getByJid(
    chatJid: string,
    params: {
      actor?: AuthUser;
      limit?: number;
      before?: string;
      after?: string;
      channelId?: string;
      sessionName?: string;
    } = {},
  ) {
    const conversation = await this.prisma.conversation.findFirst({
      where: {
        chatJid,
        ...(params.channelId ? { channelId: params.channelId } : {}),
        ...(params.sessionName ? { channel: { sessionName: params.sessionName } } : {}),
      },
      include: {
        channel: true,
        contact: conversationPreviewInclude.contact,
        assignedUser: { select: { id: true, name: true, email: true, role: true } },
        tags: { include: { tag: true } },
        participants: true,
      },
    });

    if (!conversation) return null;
    this.assertConversationAccess(conversation, params.actor);

    const messages = await this.getMessagesPage(conversation.id, params);
    return {
      ...conversation,
      messages: messages.items,
      messagesPageInfo: messages.pageInfo,
    };
  }

  async get(
    id: string,
    params: { actor?: AuthUser; limit?: number; before?: string; after?: string } = {},
  ) {
    const conversation = await this.prisma.conversation.findUnique({
      where: { id },
      include: {
        channel: true,
        contact: conversationPreviewInclude.contact,
        assignedUser: { select: { id: true, name: true, email: true, role: true } },
        tags: { include: { tag: true } },
        participants: true,
      },
    });

    if (!conversation) throw new NotFoundException('Conversation not found');
    this.assertConversationAccess(conversation, params.actor);
    const messages = await this.getMessagesPage(conversation.id, params);

    return {
      ...conversation,
      messages: messages.items,
      messagesPageInfo: messages.pageInfo,
    };
  }

  async debug(id: string, params: { actor?: AuthUser } = {}) {
    const conversation = await this.prisma.conversation.findUnique({
      where: { id },
      include: {
        channel: true,
        contact: conversationPreviewInclude.contact,
        assignedUser: { select: { id: true, name: true, email: true, role: true } },
        tags: { include: { tag: true } },
        participants: true,
      },
    });

    if (!conversation) {
      throw new NotFoundException('Conversation not found');
    }

    this.assertConversationAccess(conversation, params.actor);

    const [messageCount, noteCount, eventCount, recentEvents, recentNotes, recentMessages, syncStatus] =
      await Promise.all([
        this.prisma.message.count({ where: { conversationId: id } }),
        this.prisma.internalNote.count({ where: { conversationId: id } }),
        this.prisma.conversationEvent.count({ where: { conversationId: id } }),
        this.prisma.conversationEvent.findMany({
          where: { conversationId: id },
          orderBy: { createdAt: 'desc' },
          take: 20,
          include: { user: { select: { id: true, name: true, email: true } } },
        }),
        this.prisma.internalNote.findMany({
          where: { conversationId: id },
          orderBy: { createdAt: 'desc' },
          take: 10,
          include: { user: { select: { id: true, name: true, email: true } } },
        }),
        this.prisma.message.findMany({
          where: { conversationId: id },
          orderBy: [{ providerTimestamp: 'desc' }, { sequence: 'desc' }],
          take: 10,
          select: messageDetailSelect,
        }),
        this.syncLifecycle.getSessionStatus(conversation.channel.sessionName),
      ]);

    return {
      conversation,
      stats: {
        messageCount,
        noteCount,
        eventCount,
        participantCount: conversation.participants.length,
      },
      recentMessages: recentMessages.slice().reverse(),
      recentEvents,
      recentNotes,
      syncStatus,
    };
  }

  async compareWithWaha(
    id: string,
    params: { actor?: AuthUser; limit?: number } = {},
  ) {
    const limit = Math.max(10, Math.min(params.limit ?? 20, 100));
    const current = await this.get(id, {
      actor: params.actor,
      limit,
    });
    const sessionName = current.channel.sessionName;
    const [rawChat, rawContact, rawGroupMetadata, rawMessages, dbMessageCount] = await Promise.all([
      this.waha.getChat(sessionName, current.chatJid).catch(() => null),
      this.waha.getContact(sessionName, current.chatJid).catch(() => null),
      current.type === ConversationType.group
        ? this.waha.getGroupMetadata(sessionName, current.chatJid).catch(() => null)
        : Promise.resolve(null),
      this.waha.listMessages(sessionName, current.chatJid, limit).catch(() => []),
      this.prisma.message.count({ where: { conversationId: id } }),
    ]);

    const normalizedChat = rawChat
      ? normalizeWahaChat(
          {
            ...rawChat,
            groupMetadata: rawGroupMetadata ?? rawChat.groupMetadata,
          },
          rawContact ?? current.contact,
        )
      : normalizeWahaChat(
          {
            id: current.chatJid,
            subject: current.subject,
            name: current.displayName,
            pushName: current.pushName,
          },
          current.contact,
        );
    const normalizedMessages = ((rawMessages ?? []) as any[]).map((message) =>
      normalizeWahaMessage(message),
    );
    const currentMessages = (current.messages ?? []) as any[];

    const missingDisplayName =
      isGenericDisplayName(current.displayName, current.type) &&
      !isGenericDisplayName(normalizedChat.displayName, current.type)
        ? {
            current: current.displayName ?? null,
            waha: normalizedChat.displayName,
          }
        : null;

    const missingGroupSubject =
      current.type === ConversationType.group &&
      isGenericDisplayName(current.subject, current.type) &&
      !isGenericDisplayName(normalizedChat.subject ?? undefined, current.type)
        ? {
            current: current.subject ?? null,
            waha: normalizedChat.subject,
          }
        : null;

    const missingSenderNames = normalizedMessages
      .filter((message) => Boolean(message.participantJid))
      .map((message) => {
        const currentMessage =
          (currentMessages.find((item: any) => item.externalMessageId === message.wahaMessageId) ??
            currentMessages.find(
              (item: any) =>
                item.providerTimestamp?.getTime() === message.providerTimestamp.getTime() &&
                item.body === message.body,
            )) as any;

        if (!currentMessage) {
          return null;
        }

        const currentSender = currentMessage.senderName ?? currentMessage.participantJid;
        if (!isGenericDisplayName(currentSender, current.type)) {
          return null;
        }

        return {
          messageId: currentMessage.id,
          externalMessageId: currentMessage.externalMessageId,
          current: currentSender ?? null,
          waha: message.senderName ?? null,
          participantJid: message.participantJid,
        };
      })
      .filter(Boolean);

    const missingMedia: Array<{
      messageId: string;
      externalMessageId: string;
      wahaType: string;
    }> = [];
    const mediaFetchFailed: Array<{
      messageId: string;
      externalMessageId: string;
      fetchStatus?: string | null;
      fetchError?: string | null;
    }> = [];
    const timestampMismatch: Array<{
      messageId: string;
      externalMessageId: string;
      current: string;
      waha: string;
    }> = [];

    for (const message of normalizedMessages) {
      const currentMessage =
        currentMessages.find((item) => item.externalMessageId === message.wahaMessageId) ??
        currentMessages.find(
          (item) =>
            item.clientMessageId &&
            item.clientMessageId === message.wahaMessageId &&
            item.direction === message.direction,
        );

      if (!currentMessage) continue;

      if (message.media && !currentMessage.media) {
        missingMedia.push({
          messageId: currentMessage.id,
          externalMessageId: currentMessage.externalMessageId,
          wahaType: message.type,
        });
      }

      if (
        currentMessage.media &&
        ['failed', 'protected', 'expired'].includes(currentMessage.media.fetchStatus ?? '')
      ) {
        mediaFetchFailed.push({
          messageId: currentMessage.id,
          externalMessageId: currentMessage.externalMessageId,
          fetchStatus: currentMessage.media.fetchStatus,
          fetchError: currentMessage.media.fetchError,
        });
      }

      const currentTimestamp = (currentMessage.providerTimestamp ?? currentMessage.createdAt) as Date;
      const diffMs = Math.abs(currentTimestamp.getTime() - (message.providerTimestamp as Date).getTime());
      if (diffMs > 2000) {
        timestampMismatch.push({
          messageId: currentMessage.id,
          externalMessageId: currentMessage.externalMessageId,
          current: currentTimestamp.toISOString(),
          waha: message.providerTimestamp.toISOString(),
        });
      }
    }

    return {
      conversation: current,
      waha: {
        chat: rawChat,
        contact: rawContact,
        groupMetadata: rawGroupMetadata,
        messages: normalizedMessages,
      },
      differences: {
        missingDisplayName,
        missingGroupSubject,
        missingSenderNames,
        missingMedia,
        mediaFetchFailed,
        timestampMismatch,
        messageCountDifference: {
          database: dbMessageCount,
          wahaWindow: normalizedMessages.length,
          difference: dbMessageCount - normalizedMessages.length,
        },
      },
    };
  }

  async getMessagesPage(
    conversationId: string,
    params: { limit?: number; before?: string; after?: string } = {},
  ) {
    const take = clampLimit(params.limit, 30, 100);
    const before = parseSequenceCursor(params.before);
    const after = parseSequenceCursor(params.after);

    if (after) {
      const rows = await this.prisma.message.findMany({
        where: {
          conversationId,
          sequence: { gt: after },
        },
        take: take + 1,
        orderBy: { sequence: 'asc' },
        select: messageDetailSelect,
      });

      const hasMore = rows.length > take;
      const items = hasMore ? rows.slice(0, take) : rows;
      return {
        items,
        pageInfo: {
          nextCursor: hasMore ? String(items[items.length - 1]?.sequence ?? '') : null,
          hasMore,
          direction: 'after' as const,
        },
      };
    }

    const rows = await this.prisma.message.findMany({
      where: {
        conversationId,
        ...(before ? { sequence: { lt: before } } : {}),
      },
      take: take + 1,
      orderBy: { sequence: 'desc' },
      select: messageDetailSelect,
    });

    const hasMore = rows.length > take;
    const slice = hasMore ? rows.slice(0, take) : rows;
    const items = [...slice].reverse();

    return {
      items,
      pageInfo: {
        nextCursor: hasMore ? String(items[0]?.sequence ?? '') : null,
        hasMore,
        direction: 'before' as const,
      },
    };
  }

  async update(
    id: string,
    actor: { sub: string; role?: string },
    body: { status?: ConversationStatus; assignedTo?: string | null; unreadCount?: number },
  ) {
    const assignedTo = this.resolveAssignedTo(actor, body.assignedTo);
    const conversation = await this.prisma.conversation.update({
      where: { id },
      data: {
        status: body.status,
        assignedTo,
        unreadCount: body.unreadCount,
        events: {
          create: {
            userId: actor.sub,
            eventType: 'conversation.updated',
            payload: body as Prisma.JsonObject,
          },
        },
      },
      include: conversationPreviewInclude,
    });

    await this.realtime.publish(
      'conversation.updated',
      { conversation },
      { rooms: ['inbox', `conversation:${conversation.id}`] },
    );
    return conversation;
  }

  async markRead(id: string, userId: string) {
    return this.update(id, { sub: userId }, { unreadCount: 0 });
  }

  events(id: string) {
    return this.prisma.conversationEvent.findMany({
      where: { conversationId: id },
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: { user: { select: { id: true, name: true, email: true } } },
    });
  }

  notes(id: string) {
    return this.prisma.internalNote.findMany({
      where: { conversationId: id },
      orderBy: { createdAt: 'desc' },
      include: { user: { select: { id: true, name: true, email: true } } },
    });
  }

  async addNote(id: string, userId: string, body: string) {
    const note = await this.prisma.internalNote.create({
      data: {
        conversationId: id,
        userId,
        body,
      },
      include: { user: { select: { id: true, name: true, email: true } } },
    });

    await this.prisma.conversationEvent.create({
      data: {
        conversationId: id,
        userId,
        eventType: 'note.created',
        payload: { noteId: note.id },
      },
    });

    await this.realtime.publish(
      'note.created',
      { conversationId: id, note },
      { rooms: [`conversation:${id}`] },
    );
    return note;
  }

  async addTag(id: string, tagId: string, userId: string) {
    await this.prisma.conversationTag.upsert({
      where: {
        conversationId_tagId: {
          conversationId: id,
          tagId,
        },
      },
      update: {},
      create: {
        conversationId: id,
        tagId,
      },
    });

    await this.prisma.conversationEvent.create({
      data: {
        conversationId: id,
        userId,
        eventType: 'tag.added',
        payload: { tagId },
      },
    });

    const conversation = await this.get(id);
    await this.realtime.publish(
      'tag.updated',
      { conversationId: id, tags: conversation.tags },
      { rooms: [`conversation:${id}`] },
    );
    return conversation.tags;
  }

  async removeTag(id: string, tagId: string, userId: string) {
    await this.prisma.conversationTag.deleteMany({
      where: { conversationId: id, tagId },
    });

    await this.prisma.conversationEvent.create({
      data: {
        conversationId: id,
        userId,
        eventType: 'tag.removed',
        payload: { tagId },
      },
    });

    const conversation = await this.get(id);
    await this.realtime.publish(
      'tag.updated',
      { conversationId: id, tags: conversation.tags },
      { rooms: [`conversation:${id}`] },
    );
    return conversation.tags;
  }

  async assertAccessById(id: string, actor: AuthUser) {
    const conversation = await this.prisma.conversation.findUnique({
      where: { id },
      select: { id: true, assignedTo: true },
    });

    if (!conversation) throw new NotFoundException('Conversation not found');
    this.assertConversationAccess(conversation, actor);
    return conversation;
  }

  private buildListWhere(params: {
    actor?: AuthUser;
    status?: ConversationStatus;
    type?: ConversationType;
    assignedTo?: string;
    search?: string;
    channelId?: string;
    sessionName?: string;
    unreadOnly?: boolean;
  }): Prisma.ConversationWhereInput {
    const andClauses: Prisma.ConversationWhereInput[] = [];

    if (params.actor && params.actor.role !== 'admin') {
      andClauses.push({
        assignedTo: params.actor.sub,
      });
    }

    if (params.search) {
      andClauses.push({
        OR: [
          { chatJid: { contains: params.search, mode: 'insensitive' } },
          { displayName: { contains: params.search, mode: 'insensitive' } },
          { subject: { contains: params.search, mode: 'insensitive' } },
          { pushName: { contains: params.search, mode: 'insensitive' } },
          { contact: { displayName: { contains: params.search, mode: 'insensitive' } } },
          { contact: { phone: { contains: params.search, mode: 'insensitive' } } },
        ],
      });
    }

    return {
      status: params.status,
      channelId: params.channelId,
      channel: params.sessionName ? { sessionName: params.sessionName } : undefined,
      type: params.type
        ? params.type
        : {
            in: [
              ConversationType.direct,
              ConversationType.group,
              ConversationType.newsletter,
            ],
          },
      assignedTo:
        params.assignedTo === '__unassigned__'
          ? null
          : params.assignedTo || undefined,
      unreadCount: params.unreadOnly ? { gt: 0 } : undefined,
      AND: andClauses.length ? andClauses : undefined,
    };
  }

  private assertConversationAccess(
    conversation: { id: string; assignedTo?: string | null },
    actor?: AuthUser,
  ) {
    if (!actor || actor.role === 'admin') {
      return;
    }

    if (conversation.assignedTo !== actor.sub) {
      throw new ForbiddenException('You do not have access to this conversation');
    }
  }

  private resolveAssignedTo(
    actor: { sub: string; role?: string },
    requestedAssignedTo?: string | null,
  ) {
    if (requestedAssignedTo === undefined) {
      return undefined;
    }

    if (requestedAssignedTo === null) {
      return null;
    }

    if (actor.role === 'admin') {
      return requestedAssignedTo;
    }

    if (requestedAssignedTo !== actor.sub) {
      throw new ForbiddenException('You can only assign conversations to yourself');
    }

    return actor.sub;
  }
}

function clampLimit(value: number | undefined, fallback: number, max: number) {
  if (!value || Number.isNaN(value)) return fallback;
  return Math.max(1, Math.min(value, max));
}

function parseSequenceCursor(value?: string) {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}
