import { AckStatus, ChannelStatus, ConversationType, MessageType } from '@prisma/client';

type JsonRecord = Record<string, any>;

type MediaDescriptor = {
  url: string | null;
  mime: string | null;
  fileName: string | null;
  size: number | null;
  thumbnailUrl: string | null;
  thumbnailBase64: string | null;
  providerMessageId: string | null;
  providerMediaId: string | null;
  mediaKey: string | null;
  error: string | null;
  isVoice: boolean;
};

type ReactionDescriptor = {
  emoji: string | null;
  targetExternalMessageId: string | null;
};

export function normalizeJid(jid?: string | null) {
  if (!jid) return null;
  return String(jid).replace('@s.whatsapp.net', '@c.us').trim();
}

export function phoneFromJid(jid?: string | null) {
  const normalized = normalizeJid(jid);
  if (!normalized?.endsWith('@c.us')) return null;
  return normalized.split('@')[0];
}

export function formatHumanPhone(phone?: string | null) {
  if (!phone) return null;
  const digits = String(phone).replace(/[^\d]/g, '');
  if (!digits) return null;

  if (digits.length === 11 && digits.startsWith('506')) {
    return `+506 ${digits.slice(3, 7)} ${digits.slice(7)}`;
  }

  if (digits.length === 11 && digits.startsWith('1')) {
    return `+1 (${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
  }

  if (digits.length === 8) {
    return `${digits.slice(0, 4)} ${digits.slice(4)}`;
  }

  if (digits.length <= 4) {
    return digits;
  }

  return `+${digits.slice(0, Math.max(1, digits.length - 8))} ${digits.slice(-8, -4)} ${digits.slice(-4)}`.trim();
}

export function detectJidType(jid?: string | null): ConversationType {
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

export function isPrimaryInboxChatType(type: ConversationType) {
  return (
    type === ConversationType.direct ||
    type === ConversationType.group ||
    type === ConversationType.newsletter
  );
}

export function isHiddenConversationType(type: ConversationType) {
  return (
    type === ConversationType.status ||
    type === ConversationType.broadcast ||
    type === ConversationType.system ||
    type === ConversationType.unknown
  );
}

export function isUserFacingChatType(type: ConversationType) {
  return isPrimaryInboxChatType(type);
}

export function formatPhoneNumber(phone?: string | null) {
  if (!phone) return null;
  const compact = phone.replace(/[^\d+]/g, '');
  if (compact.length <= 4) return compact;
  return compact.replace(/(\d{3})(?=\d)/g, '$1 ').trim();
}

function firstText(...values: unknown[]) {
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

function asNumber(value: unknown) {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function asBoolean(...values: unknown[]) {
  for (const value of values) {
    if (typeof value === 'boolean') return value;
  }
  return false;
}

function extractNestedType(payload: JsonRecord) {
  return String(
    payload.type ??
      payload.messageType ??
      payload.media?.type ??
      payload._data?.type ??
      payload._data?.messageType ??
      '',
  ).toLowerCase();
}

export function getBestDisplayName(rawChat: JsonRecord = {}, rawContact: JsonRecord = {}) {
  const jid = normalizeJid(
    rawChat.id?._serialized ??
      rawChat.id ??
      rawChat.chatId ??
      rawChat.jid ??
      rawChat._serialized ??
      rawContact.whatsappJid,
  );
  const type = detectJidType(jid);

  if (type === ConversationType.group) {
    const groupSubject = extractGroupSubject(rawChat, rawContact);
    return groupSubject ?? humanizeConversationFallback(type, jid);
  }

  if (type === ConversationType.newsletter || type === ConversationType.broadcast) {
    const channelName = extractChannelName(rawChat, rawContact);
    return channelName ?? humanizeConversationFallback(type, jid);
  }

  const phone = phoneFromJid(jid);
  const directName = firstText(
    rawChat.name,
    rawChat.pushName,
    rawChat.notifyName,
    rawChat.formattedName,
    rawChat._data?.name,
    rawChat._data?.pushName,
    rawChat._data?.notifyName,
    rawContact.displayName,
    rawContact.name,
    rawContact.pushName,
    rawContact.notifyName,
  );

  if (directName && !isGenericDisplayName(directName, type)) {
    return directName;
  }

  return (
    formatHumanPhone(phone) ??
    (type === ConversationType.status
      ? 'Estados'
      : type === ConversationType.system
        ? 'Sistema'
        : type === ConversationType.unknown
          ? 'Conversación desconocida'
          : humanizeConversationFallback(type, jid))
  );
}

export function normalizeWahaChat(rawChat: JsonRecord = {}, rawContact: JsonRecord = {}) {
  const jid = normalizeJid(
    rawChat.id?._serialized ??
      rawChat.id ??
      rawChat.chatId ??
      rawChat.jid ??
      rawChat._serialized ??
      rawContact.whatsappJid,
  );
  const type = detectJidType(jid);
  const displayName = getBestDisplayName(rawChat, rawContact);
  const subject = firstText(
    rawChat.subject,
    rawChat.groupMetadata?.subject,
    rawChat.groupMetadata?.name,
    rawChat.groupMetadata?.title,
    rawChat._data?.subject,
    rawChat._data?.groupMetadata?.subject,
    rawChat._data?.groupMetadata?.name,
    rawChat._data?.groupMetadata?.title,
    rawContact.subject,
  );

  return {
    jid,
    type,
    displayName,
    pushName: firstText(rawChat.pushName, rawChat._data?.pushName, rawContact.pushName),
    subject,
    phoneNumber: phoneFromJid(jid),
    avatarUrl: firstText(
      rawChat.profilePicUrl,
      rawChat.picture,
      rawChat.avatarUrl,
      rawChat._data?.profilePicUrl,
      rawChat.groupMetadata?.profilePicUrl,
      rawContact.avatarUrl,
    ),
    isArchived: Boolean(rawChat.archived ?? rawChat.isArchived ?? rawChat._data?.archive),
    isPinned: Boolean(rawChat.pinned ?? rawChat.isPinned ?? rawChat._data?.pin),
    isHidden: isHiddenConversationType(type),
    isSystem: type === ConversationType.system || type === ConversationType.unknown,
  };
}

export function getSenderName(payload: JsonRecord = {}) {
  return firstText(
    payload.senderName,
    payload.notifyName,
    payload.pushName,
    payload.authorName,
    payload._data?.notifyName,
    payload._data?.pushName,
    payload._data?.author?.name,
    payload._data?.authorName,
  );
}

export function pickChatJid(payload: JsonRecord) {
  return normalizeJid(
    payload.chatId ??
      payload.id?.remote ??
      payload._data?.id?.remote ??
      payload.key?.remoteJid ??
      (payload.fromMe ? payload.to : payload.from),
  );
}

export function pickParticipantJid(payload: JsonRecord = {}) {
  const chatJid = pickChatJid(payload);
  const participant = normalizeJid(
    payload.participant ??
      payload.author ??
      payload._data?.author ??
      payload.id?.participant ??
      payload._data?.id?.participant ??
      payload.key?.participant,
  );

  if (detectJidType(chatJid) === ConversationType.group) {
    return participant;
  }

  return null;
}

export function providerTimestampToDate(timestamp?: number | string | null) {
  if (timestamp === undefined || timestamp === null) return null;
  const value = Number(timestamp);
  if (!Number.isFinite(value)) return null;
  return new Date(value < 10_000_000_000 ? value * 1000 : value);
}

export function mapAckStatus(ack?: number | string | null): AckStatus {
  if (typeof ack === 'string') {
    const value = ack.toLowerCase();
    if (value === 'pending') return AckStatus.pending;
    if (value === 'server') return AckStatus.server;
    if (value === 'device') return AckStatus.device;
    if (value === 'read') return AckStatus.read;
    if (value === 'played') return AckStatus.played;
    if (value === 'error') return AckStatus.error;
  }

  switch (Number(ack)) {
    case -1:
      return AckStatus.error;
    case 0:
      return AckStatus.pending;
    case 1:
      return AckStatus.server;
    case 2:
      return AckStatus.device;
    case 3:
      return AckStatus.read;
    case 4:
      return AckStatus.played;
    default:
      return AckStatus.unknown;
  }
}

export function extractWahaMessageId(payload: JsonRecord = {}) {
  const value =
    payload.id?._serialized ??
    payload._data?.id?._serialized ??
    payload.messageId?._serialized ??
    (typeof payload.id === 'string' ? payload.id : null) ??
    (typeof payload.messageId === 'string' ? payload.messageId : null) ??
    payload.id?.id ??
    payload._data?.id?.id ??
    payload.key?.id ??
    null;

  return value ? String(value) : null;
}

export function extractReaction(payload: JsonRecord = {}): ReactionDescriptor {
  const emoji = firstText(
    payload.reaction?.text,
    payload.reaction?.emoji,
    payload.reactionText,
    payload.reactionEmoji,
    payload._data?.reactionText,
    payload._data?.reaction?.text,
  );

  const targetExternalMessageId = firstText(
    payload.reaction?.messageId?._serialized,
    payload.reaction?.messageId,
    payload.reactionMessageId?._serialized,
    payload.reactionMessageId,
    payload._data?.reactionParentKey?.id,
    payload._data?.reactionMessageId,
    payload._data?.msgKey?.id,
  );

  return {
    emoji,
    targetExternalMessageId,
  };
}

export function extractCaption(payload: JsonRecord = {}) {
  return firstText(
    payload.caption,
    payload.media?.caption,
    payload.media?.text,
    payload._data?.caption,
    payload._data?.body,
  );
}

export function extractMessageText(payload: JsonRecord = {}) {
  const nestedType = extractNestedType(payload);
  const rawBody = firstText(payload.body, payload._data?.body);

  if (
    nestedType.includes('sticker') ||
    nestedType.includes('reaction') ||
    nestedType.includes('image') ||
    nestedType.includes('video') ||
    nestedType.includes('audio') ||
    nestedType.includes('document')
  ) {
    return null;
  }

  if (rawBody && rawBody.length < 10_000) {
    return rawBody;
  }

  return null;
}

export function extractMediaDescriptor(payload: JsonRecord = {}): MediaDescriptor | null {
  const nestedMedia = payload.media ?? payload._data?.mediaData ?? {};
  const url = firstText(
    nestedMedia.url,
    nestedMedia.staticUrl,
    nestedMedia.directPath,
    payload.mediaUrl,
    payload.staticUrl,
    payload.directPath,
    payload._data?.mediaData?.url,
    payload._data?.mediaData?.staticUrl,
    payload._data?.mediaData?.directPath,
    payload._data?.deprecatedMms3Url,
  );
  const mime = firstText(
    nestedMedia.mimetype,
    nestedMedia.mime,
    payload.media?.mimetype,
    payload.mimetype,
    payload.mimeType,
    payload._data?.mimetype,
    payload._data?.mimeType,
  );
  const fileName = firstText(
    nestedMedia.filename,
    nestedMedia.fileName,
    payload.media?.filename,
    payload.fileName,
    payload.filename,
    payload._data?.filename,
    payload._data?.mediaData?.filename,
  );
  const thumbnailUrl = firstText(
    nestedMedia.thumbnailUrl,
    nestedMedia.thumbnail,
    nestedMedia.preview,
    nestedMedia.thumbnailPath,
    payload.media?.thumbnailUrl,
    payload.thumbnailUrl,
    payload.thumbnail,
    payload.preview,
    payload._data?.thumbnailUrl,
    payload._data?.thumbnail,
    payload._data?.preview,
    payload._data?.mediaData?.thumbnailUrl,
  );
  const thumbnailBase64 = firstText(
    nestedMedia.thumbnailBase64,
    payload.media?.thumbnailBase64,
    payload.thumbnailBase64,
    payload._data?.thumbnailBase64,
    payload._data?.thumbnail,
    payload._data?.preview,
  );
  const error = firstText(payload.media?.error, payload._data?.mediaError, payload.error);
  const providerMessageId = extractWahaMessageId(payload);
  const providerMediaId = firstText(
    nestedMedia.id,
    nestedMedia.mediaId,
    payload.media?.id,
    payload.mediaId,
    payload._data?.mediaData?.id,
    payload._data?.mediaData?.mediaId,
    payload._data?.mediaId,
  );
  const mediaKey = firstText(
    nestedMedia.mediaKey,
    payload.media?.mediaKey,
    payload.mediaKey,
    payload._data?.mediaData?.mediaKey,
    payload._data?.mediaKey,
  );
  const size = asNumber(
    nestedMedia.filesize ??
      nestedMedia.size ??
      payload.media?.filesize ??
      payload.media?.size ??
      payload.size ??
      payload._data?.size ??
      payload._data?.mediaData?.size,
  );
  const isVoice = asBoolean(payload.ptt, payload._data?.isPtt, payload._data?.ptt);

  if (!url && !mime && !fileName && !payload.hasMedia && !payload._data?.hasMedia) {
    return null;
  }

  return {
    url,
    mime,
    fileName,
    size,
    thumbnailUrl,
    thumbnailBase64,
    providerMessageId,
    providerMediaId,
    mediaKey,
    error,
    isVoice,
  };
}

export function mapMessageType(payload: JsonRecord): MessageType {
  const type = extractNestedType(payload);
  const media = extractMediaDescriptor(payload);
  const reaction = extractReaction(payload);

  if (reaction.emoji && reaction.targetExternalMessageId) return MessageType.reaction;
  if (type.includes('reaction')) return MessageType.reaction;
  if (type.includes('sticker')) return MessageType.sticker;
  if (type.includes('ptt') || media?.isVoice) return MessageType.voice;
  if (type.includes('image') || media?.mime?.startsWith('image/')) return MessageType.image;
  if (type.includes('audio') || media?.mime?.startsWith('audio/')) return MessageType.audio;
  if (type.includes('video') || media?.mime?.startsWith('video/')) return MessageType.video;
  if (type.includes('document') || media?.mime?.startsWith('application/')) return MessageType.document;
  if (type.includes('chat') || type.includes('text') || extractMessageText(payload)) return MessageType.text;
  if (type.includes('notification') || type.includes('system')) return MessageType.system;
  return MessageType.unknown;
}

export function mapChannelStatus(status?: string | null): ChannelStatus {
  switch (String(status ?? '').toUpperCase()) {
    case 'STOPPED':
      return ChannelStatus.stopped;
    case 'STARTING':
      return ChannelStatus.starting;
    case 'SCAN_QR_CODE':
      return ChannelStatus.scan_qr_code;
    case 'WORKING':
      return ChannelStatus.working;
    case 'FAILED':
      return ChannelStatus.failed;
    case 'DISCONNECTED':
      return ChannelStatus.disconnected;
    default:
      return ChannelStatus.unknown;
  }
}

export function normalizeWahaMessage(payload: JsonRecord = {}) {
  const chatJid = pickChatJid(payload);
  const participantJid = pickParticipantJid(payload);
  const fromMe = Boolean(payload.fromMe);
  const type = mapMessageType(payload);
  const media = extractMediaDescriptor(payload);
  const reaction = extractReaction(payload);
  const senderJid = fromMe
    ? normalizeJid(payload.to ?? chatJid)
    : participantJid ?? normalizeJid(payload.from);
  const senderName =
    getSenderName(payload) ??
    resolveFallbackSenderName({
      senderJid,
      participantJid,
      chatJid,
      chatType: detectJidType(chatJid),
    });

  return {
    wahaMessageId: extractWahaMessageId(payload),
    chatJid,
    chatType: detectJidType(chatJid),
    senderJid,
    senderName,
    participantJid,
    direction: fromMe ? 'outbound' : 'inbound',
    body: extractMessageText(payload),
    caption: extractCaption(payload),
    type,
    media,
    reaction,
    providerTimestamp: providerTimestampToDate(payload.timestamp) ?? new Date(),
    ackStatus: mapAckStatus(payload.ackName ?? payload.ack),
    deletedAt: asBoolean(payload.isDeleted, payload._data?.isDeleted) ? new Date() : null,
    editedAt: asBoolean(payload.isEdited, payload._data?.isEdited) ? new Date() : null,
  };
}

export function normalizeWahaEvent(
  event: { event: string; session: string; payload?: JsonRecord },
) {
  const payload = event.payload ?? {};
  const messageId = extractWahaMessageId(payload);
  const chatJid = pickChatJid(payload);

  return {
    event: event.event,
    session: event.session,
    messageId,
    chatJid,
    eventFamily:
      event.event === 'message' || event.event === 'message.any'
        ? 'message'
        : event.event === 'message.ack'
          ? 'ack'
          : event.event,
  };
}

export function getExternalMessageId(payload: JsonRecord = {}) {
  return extractWahaMessageId(payload);
}

export function getDedupeKey(event: { event: string; session: string; payload?: JsonRecord }) {
  const normalized = normalizeWahaEvent(event);
  const scope = normalized.messageId ?? normalized.chatJid ?? 'unknown';
  return `${normalized.session}:${normalized.eventFamily}:${scope}`;
}

export function isGenericDisplayName(value?: string | null, type?: ConversationType) {
  if (!value) return true;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return true;
  if (looksLikeTechnicalJid(value)) return true;
  if (/^(grupo|canal|contacto|conversaci[oó]n)\s+sin\s+nombre$/i.test(value)) return true;
  if (normalized === 'sistema' || normalized === 'estados' || normalized === 'desconocido') {
    return true;
  }
  if (type === ConversationType.group && /sin nombre/i.test(normalized)) return true;
  return false;
}

function extractGroupSubject(rawChat: JsonRecord, rawContact: JsonRecord) {
  const candidate = firstText(
    rawChat.groupMetadata?.subject,
    rawChat.groupMetadata?.name,
    rawChat.groupMetadata?.title,
    rawChat.subject,
    rawChat.name,
    rawChat.formattedTitle,
    rawChat.title,
    rawChat._data?.groupMetadata?.subject,
    rawChat._data?.groupMetadata?.name,
    rawChat._data?.groupMetadata?.title,
    rawChat._data?.subject,
    rawChat._data?.name,
    rawChat._data?.formattedTitle,
    rawChat._data?.title,
    rawContact.subject,
  );

  if (!candidate || isGenericDisplayName(candidate, ConversationType.group)) {
    return null;
  }

  return candidate;
}

function extractChannelName(rawChat: JsonRecord, rawContact: JsonRecord) {
  const candidate = firstText(
    rawChat.name,
    rawChat.title,
    rawChat.caption,
    rawChat.subject,
    rawChat.groupMetadata?.subject,
    rawChat.groupMetadata?.name,
    rawChat.groupMetadata?.title,
    rawChat._data?.name,
    rawChat._data?.title,
    rawChat._data?.caption,
    rawContact.displayName,
  );

  if (!candidate || isGenericDisplayName(candidate, ConversationType.newsletter)) {
    return null;
  }

  return candidate;
}

function resolveFallbackSenderName(input: {
  senderJid: string | null;
  participantJid: string | null;
  chatJid: string | null;
  chatType: ConversationType;
}) {
  const participantDigits = phoneFromJid(input.participantJid);
  const senderDigits = phoneFromJid(input.senderJid);
  const chatDigits = phoneFromJid(input.chatJid);

  if (input.chatType === ConversationType.group) {
    const suffix = trailingDigits(input.participantJid ?? input.senderJid ?? input.chatJid);
    return suffix ? `Participante ${suffix}` : 'Participante';
  }

  if (input.chatType === ConversationType.direct) {
    return formatHumanPhone(participantDigits ?? senderDigits ?? chatDigits);
  }

  if (input.chatType === ConversationType.newsletter || input.chatType === ConversationType.broadcast) {
    const suffix = trailingDigits(input.chatJid);
    return suffix ? `Canal ${suffix}` : 'Canal';
  }

  if (input.chatType === ConversationType.status) {
    return 'Estados';
  }

  if (input.chatType === ConversationType.system) {
    const suffix = trailingDigits(input.participantJid ?? input.senderJid ?? input.chatJid);
    return suffix ? `Sistema ${suffix}` : 'Sistema';
  }

  return (
    formatHumanPhone(participantDigits ?? senderDigits ?? chatDigits) ??
    trailingDigits(input.participantJid ?? input.senderJid ?? input.chatJid) ??
    null
  );
}

function humanizeConversationFallback(type: ConversationType, jid?: string | null) {
  const suffix = trailingDigits(jid);
  if (type === ConversationType.group) return suffix ? `Grupo ${suffix}` : 'Grupo';
  if (type === ConversationType.newsletter || type === ConversationType.broadcast) {
    return suffix ? `Canal ${suffix}` : 'Canal';
  }
  return suffix ?? null;
}

function trailingDigits(value?: string | null) {
  if (!value) return null;
  const digits = String(value).replace(/[^\d]/g, '');
  if (!digits) return null;
  return digits.slice(-4);
}

function looksLikeTechnicalJid(value: string) {
  return /@(?:c\.us|g\.us|newsletter|broadcast|lid)$/i.test(value.trim());
}
