import { Injectable } from '@nestjs/common';
import { ConversationType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  formatHumanPhone,
  getBestDisplayName,
  isGenericDisplayName,
  normalizeJid,
  normalizeWahaChat,
  phoneFromJid,
} from '../common/waha-normalize';
import { WahaService } from './waha.service';

type WahaAdapterContext = {
  type?: ConversationType;
  rawChat?: Record<string, any>;
  rawContact?: Record<string, any>;
  participantJid?: string | null;
  fallbackLabel?: string | null;
};

@Injectable()
export class WahaAdapterService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly waha: WahaService,
  ) {}

  async getSessionHealth(sessionId: string) {
    const [sessionResult, meResult] = await Promise.allSettled([
      this.waha.getJson<Record<string, any>>(`/api/sessions/${encodeURIComponent(sessionId)}`),
      this.waha.getJson<Record<string, any>>(`/api/sessions/${encodeURIComponent(sessionId)}/me`),
    ]);

    const session = sessionResult.status === 'fulfilled' ? sessionResult.value : null;
    const me = meResult.status === 'fulfilled' ? meResult.value : null;
    const sessionStatus = firstText(
      session?.status,
      session?.state,
      session?.connectionStatus,
      session?.sessionStatus,
      session?.health?.status,
    );

    return {
      sessionId,
      session,
      me,
      sessionStatus,
      sessionConnected: isLiveSessionStatus(sessionStatus, session),
      raw: session,
    };
  }

  async listChats(
    sessionId: string,
    params: { limit?: number; offset?: number; sortBy?: string; sortOrder?: 'asc' | 'desc' } = {},
  ) {
    return this.waha.getJson<Record<string, any>[]>(
      `/api/${encodeURIComponent(sessionId)}/chats`,
      {
        limit: params.limit,
        offset: params.offset,
        sortBy: params.sortBy ?? 'conversationTimestamp',
        sortOrder: params.sortOrder ?? 'desc',
      },
    );
  }

  async getChat(sessionId: string, chatJid: string) {
    const jid = normalizeJid(chatJid);
    if (!jid) return null;

    const chats = await this.listChats(sessionId, { limit: 500, offset: 0 });
    const chat = chats.find((item) => normalizeJid(item?.id?._serialized ?? item?.id ?? item?.chatId ?? item?.jid) === jid);
    if (chat) {
      return chat;
    }

    return null;
  }

  async getGroupMetadata(sessionId: string, groupJid: string) {
    const jid = normalizeJid(groupJid);
    if (!jid) return null;

    const metadata = await this.waha.getJson<Record<string, any>>(
      `/api/${encodeURIComponent(sessionId)}/groups/${encodeURIComponent(jid)}`,
    );

    let participants: Record<string, any>[] = [];
    try {
      participants = await this.waha.getJson<Record<string, any>[]>(
        `/api/${encodeURIComponent(sessionId)}/groups/${encodeURIComponent(jid)}/participants`,
      );
    } catch {
      participants = [];
    }

    return {
      ...metadata,
      participants,
    };
  }

  async listMessages(
    sessionId: string,
    chatJid: string,
    limit = 50,
    cursor?: number | string | { offset?: number },
  ) {
    const params: Record<string, unknown> = {
      limit,
      downloadMedia: false,
    };

    if (typeof cursor === 'number') {
      params.offset = cursor;
    } else if (typeof cursor === 'string' && /^\d+$/.test(cursor)) {
      params.offset = Number(cursor);
    } else if (cursor && typeof cursor === 'object' && cursor.offset !== undefined) {
      params.offset = cursor.offset;
    }

    return this.waha.getJson<Record<string, any>[]>(
      `/api/${encodeURIComponent(sessionId)}/chats/${encodeURIComponent(chatJid)}/messages`,
      params,
    );
  }

  async getContact(sessionId: string, jid: string) {
    const normalized = normalizeJid(jid);
    if (!normalized) return null;

    const attempts = normalized.endsWith('@lid')
      ? [
          `/api/${encodeURIComponent(sessionId)}/lids/${encodeURIComponent(normalized.replace('@lid', ''))}`,
          `/api/${encodeURIComponent(sessionId)}/contacts/${encodeURIComponent(normalized)}`,
        ]
      : [
          `/api/${encodeURIComponent(sessionId)}/contacts/${encodeURIComponent(normalized)}`,
          `/api/${encodeURIComponent(sessionId)}/contacts/${encodeURIComponent(normalized.split('@')[0])}`,
        ];

    for (const path of attempts) {
      try {
        return await this.waha.getJson<Record<string, any>>(path);
      } catch {
        continue;
      }
    }

    return null;
  }

  async resolveDisplayName(sessionId: string, jid: string, context: WahaAdapterContext = {}) {
    const normalizedJid = normalizeJid(jid);
    if (!normalizedJid) {
      return context.fallbackLabel ?? null;
    }

    const type = context.type ?? inferType(normalizedJid);

    const [conversation, contact, rawChat] = await Promise.all([
      this.prisma.conversation.findFirst({
        where: {
          chatJid: normalizedJid,
          channel: { sessionName: sessionId },
        },
        include: { contact: true },
      }),
      this.prisma.contact.findFirst({
        where: { whatsappJid: normalizedJid },
      }),
      context.rawChat ? Promise.resolve(context.rawChat) : this.getChat(sessionId, normalizedJid),
    ]);

    const normalizedConversation = rawChat
      ? normalizeWahaChat(rawChat, contact ?? conversation?.contact ?? {})
      : null;

    const directCandidate =
      normalizedConversation?.displayName ??
      conversation?.displayName ??
      contact?.displayName ??
      getBestDisplayName(rawChat ?? { id: normalizedJid }, contact ?? {});

    if (
      directCandidate &&
      !isGenericDisplayName(directCandidate, type) &&
      directCandidate !== normalizedJid
    ) {
      return directCandidate;
    }

    if (type === ConversationType.group) {
      const groupMetadata = await this.getGroupMetadata(sessionId, normalizedJid).catch(() => null);
      const groupName = firstText(
        groupMetadata?.subject,
        groupMetadata?.name,
        groupMetadata?.title,
        groupMetadata?.formattedTitle,
        rawChat?.groupMetadata?.subject,
        rawChat?.groupMetadata?.name,
        rawChat?.groupMetadata?.title,
      );

      if (groupName && !isGenericDisplayName(groupName, type)) {
        return groupName;
      }
    }

    if (type === ConversationType.newsletter || type === ConversationType.broadcast) {
      const channelName = firstText(
        rawChat?.name,
        rawChat?.title,
        rawChat?.caption,
        rawChat?.subject,
        rawChat?.groupMetadata?.subject,
        rawChat?.groupMetadata?.name,
        rawChat?.groupMetadata?.title,
        contact?.displayName,
      );

      if (channelName && !isGenericDisplayName(channelName, type)) {
        return channelName;
      }
    }

    if (type === ConversationType.direct) {
      return (
        formatHumanPhone(phoneFromJid(normalizedJid)) ??
        contact?.displayName ??
        conversation?.displayName ??
        context.fallbackLabel ??
        normalizedJid
      );
    }

    if (type === ConversationType.status) {
      return 'Estados';
    }

    if (type === ConversationType.system) {
      const suffix = trailingDigits(normalizedJid);
      return suffix ? `Sistema ${suffix}` : 'Sistema';
    }

    if (type === ConversationType.group) {
      const suffix = trailingDigits(normalizedJid);
      return suffix ? `Grupo ${suffix}` : 'Grupo';
    }

    if (type === ConversationType.newsletter || type === ConversationType.broadcast) {
      const suffix = trailingDigits(normalizedJid);
      return suffix ? `Canal ${suffix}` : 'Canal';
    }

    return context.fallbackLabel ?? normalizedJid;
  }

  async downloadMedia(sessionId: string, messageIdOrMediaId: string) {
    const resolved = await this.resolveMediaSource(sessionId, messageIdOrMediaId);
    if (!resolved?.url) {
      return null;
    }

    const stream = await this.waha.downloadMedia(resolved.url);
    return {
      ...resolved,
      ...stream,
    };
  }

  private async resolveMediaSource(sessionId: string, messageIdOrMediaId: string) {
    const media = await this.prisma.media.findFirst({
      where: {
        OR: [
          { id: messageIdOrMediaId },
          { messageId: messageIdOrMediaId },
          { message: { externalMessageId: messageIdOrMediaId } },
        ],
      },
      include: {
        message: {
          include: {
            conversation: {
              include: {
                channel: true,
              },
            },
          },
        },
      },
    });

    if (!media || media.message.conversation.channel.sessionName !== sessionId) {
      return null;
    }

    return {
      mediaId: media.id,
      messageId: media.messageId,
      conversationId: media.message.conversationId,
      url: media.pathOrUrl ?? media.thumbnailPathOrUrl ?? null,
      mime: media.mime ?? undefined,
      fileName: media.fileName ?? undefined,
      fetchStatus: media.fetchStatus,
      fetchError: media.fetchError ?? null,
    };
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

function trailingDigits(value?: string | null) {
  if (!value) return null;
  const digits = String(value).replace(/[^\d]/g, '');
  if (!digits) return null;
  return digits.slice(-4);
}

function inferType(jid?: string | null) {
  const normalized = normalizeJid(jid);
  if (!normalized) return ConversationType.unknown;
  if (normalized === 'status@broadcast') return ConversationType.status;
  if (normalized.endsWith('@c.us')) return ConversationType.direct;
  if (normalized.endsWith('@g.us')) return ConversationType.group;
  if (normalized.endsWith('@newsletter')) return ConversationType.newsletter;
  if (normalized.endsWith('@broadcast')) return ConversationType.broadcast;
  if (normalized.includes('@lid')) return ConversationType.system;
  return ConversationType.unknown;
}

function isLiveSessionStatus(status?: string | null, raw?: Record<string, any> | null) {
  const normalized = String(status ?? raw?.status ?? raw?.state ?? '').toLowerCase();
  return (
    normalized.includes('working') ||
    normalized.includes('connected') ||
    normalized.includes('ready') ||
    normalized.includes('online') ||
    normalized.includes('open')
  );
}
