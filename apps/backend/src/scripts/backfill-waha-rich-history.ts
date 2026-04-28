import { ConversationType, MediaStatus, PrismaClient } from '@prisma/client';
import {
  getBestDisplayName,
  isGenericDisplayName,
  normalizeWahaChat,
  normalizeWahaMessage,
} from '../common/waha-normalize';

type CliOptions = {
  session: string;
  limit: number;
  conversationId?: string;
  apply: boolean;
};

type WahaClient = {
  chats: Record<string, any>[];
  contact: Record<string, any> | null;
  groupMetadata: Record<string, any> | null;
  messages: Record<string, any>[];
};

const prisma = new PrismaClient();

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const baseUrl = process.env.WAHA_URL ?? 'http://localhost:3000';
  const apiKey = process.env.WAHA_API_KEY_PLAIN ?? process.env.WAHA_API_KEY ?? '';

  const conversations = await prisma.conversation.findMany({
    where: {
      ...(options.conversationId ? { id: options.conversationId } : {}),
      channel: { sessionName: options.session },
    },
    include: {
      contact: true,
      channel: true,
    },
    orderBy: { createdAt: 'asc' },
  });

  const chats = await fetchWahaJson<Record<string, any>[]>(
    baseUrl,
    apiKey,
    `/api/${encodeURIComponent(options.session)}/chats`,
    {
      limit: 1000,
      offset: 0,
      sortBy: 'conversationTimestamp',
      sortOrder: 'desc',
    },
  ).catch(() => []);

  let reviewed = 0;
  let changed = 0;
  let mediaTouched = 0;
  let participantsTouched = 0;

  for (const conversation of conversations) {
    reviewed += 1;
    const rawChat = findChat(chats, conversation.chatJid);
    const rawContact = await fetchContact(baseUrl, apiKey, options.session, conversation.chatJid);
    const rawGroupMetadata =
      conversation.type === ConversationType.group
        ? await fetchGroupMetadata(baseUrl, apiKey, options.session, conversation.chatJid)
        : null;

    const normalizedChat = normalizeWahaChat(
      {
        ...(rawChat ?? {}),
        id: conversation.chatJid,
        groupMetadata: rawGroupMetadata ?? rawChat?.groupMetadata,
      },
      rawContact ?? conversation.contact,
    );

    const desiredDisplayName = getBestDisplayName(
      {
        ...(rawChat ?? {}),
        id: conversation.chatJid,
        groupMetadata: rawGroupMetadata ?? rawChat?.groupMetadata,
      },
      rawContact ?? conversation.contact,
    );

    const nextConversationName =
      desiredDisplayName &&
      shouldReplaceDisplayName(
        conversation.displayName,
        desiredDisplayName,
        conversation.type,
        conversation.chatJid,
      )
        ? desiredDisplayName
        : conversation.displayName;

    const nextContactName =
      desiredDisplayName &&
      shouldReplaceDisplayName(
        conversation.contact.displayName,
        desiredDisplayName,
        conversation.type,
        conversation.contact.whatsappJid,
      )
        ? desiredDisplayName
        : conversation.contact.displayName;

    const latestMessages = await prisma.message.findMany({
      where: { conversationId: conversation.id },
      orderBy: [{ providerTimestamp: 'desc' }, { sequence: 'desc' }],
      take: options.limit,
      select: {
        id: true,
        externalMessageId: true,
        clientMessageId: true,
        senderJid: true,
        senderName: true,
        participantJid: true,
        body: true,
        caption: true,
        type: true,
        providerTimestamp: true,
      },
    });

    const wahaMessages = await fetchMessages(baseUrl, apiKey, options.session, conversation.chatJid, options.limit);
    const normalizedMessages = wahaMessages.map((message) => normalizeWahaMessage(message));

    const participantChanges = buildParticipantChanges(
      conversation,
      normalizedMessages,
      latestMessages,
    );
    participantsTouched += participantChanges.length;

    const messageChanges = buildMessageChanges(latestMessages, normalizedMessages);
    mediaTouched += messageChanges.mediaCount;

    if (
      nextConversationName === conversation.displayName &&
      nextContactName === conversation.contact.displayName &&
      participantChanges.length === 0 &&
      messageChanges.patchCount === 0 &&
      messageChanges.mediaCount === 0
    ) {
      continue;
    }

    changed += 1;

    console.log(
      JSON.stringify(
        {
          conversationId: conversation.id,
          chatJid: conversation.chatJid,
          current: conversation.displayName,
          next: nextConversationName,
          contactCurrent: conversation.contact.displayName,
          contactNext: nextContactName,
          participantChanges: participantChanges.length,
          messageChanges: messageChanges.patchCount,
          mediaChanges: messageChanges.mediaCount,
        },
        null,
        2,
      ),
    );

    if (!options.apply) {
      continue;
    }

    await prisma.$transaction(async (tx) => {
      if (nextContactName !== conversation.contact.displayName) {
        await tx.contact.update({
          where: { id: conversation.contactId },
          data: { displayName: nextContactName ?? undefined },
        });
      }

      if (nextConversationName !== conversation.displayName) {
        await tx.conversation.update({
          where: { id: conversation.id },
          data: {
            displayName: nextConversationName ?? undefined,
            subject: normalizedChat.subject ?? conversation.subject,
            pushName: normalizedChat.pushName ?? conversation.pushName,
            avatarUrl: normalizedChat.avatarUrl ?? conversation.avatarUrl,
          },
        });
      }

      for (const participant of participantChanges) {
        await tx.chatParticipant.upsert({
          where: {
            channelId_chatJid_participantJid: {
              channelId: conversation.channelId,
              chatJid: conversation.chatJid,
              participantJid: participant.participantJid,
            },
          },
          update: {
            displayName: participant.displayName,
          },
          create: {
            channelId: conversation.channelId,
            conversationId: conversation.id,
            chatJid: conversation.chatJid,
            participantJid: participant.participantJid,
            displayName: participant.displayName,
          },
        });
      }

      for (const patch of messageChanges.patches) {
        await tx.message.update({
          where: { id: patch.id },
          data: patch.data,
        });
      }

      for (const mediaPatch of messageChanges.mediaPatches) {
        const media = await tx.media.upsert({
          where: { messageId: mediaPatch.messageId },
          update: mediaPatch.data,
          create: {
            messageId: mediaPatch.messageId,
            ...mediaPatch.data,
          },
        });

        await tx.message.update({
          where: { id: mediaPatch.messageId },
          data: { mediaId: media.id },
        });
      }
    });
  }

  console.log(
    JSON.stringify(
      {
        apply: options.apply,
        reviewed,
        changed,
        participantsTouched,
        mediaTouched,
        note: options.apply
          ? 'Backfill applied.'
          : 'Dry run only. Re-run with --apply to persist changes.',
      },
      null,
      2,
    ),
  );
}

function buildParticipantChanges(
  conversation: {
    type: ConversationType;
  },
  normalizedMessages: ReturnType<typeof normalizeWahaMessage>[],
  currentMessages: Array<{
    id: string;
    externalMessageId: string;
    senderName: string | null;
    participantJid: string | null;
    body: string | null;
    caption: string | null;
    type: string;
    providerTimestamp: Date | null;
  }>,
) {
  if (conversation.type !== ConversationType.group) {
    return [];
  }

  const changes: Array<{ participantJid: string; displayName: string | null }> = [];

  for (const message of normalizedMessages) {
    if (!message.participantJid || !message.senderName) continue;
    if (isGenericDisplayName(message.senderName, conversation.type)) continue;
    const current = currentMessages.find((item) => item.externalMessageId === message.wahaMessageId);
    if (current?.participantJid === message.participantJid && current.senderName === message.senderName) {
      continue;
    }
    changes.push({ participantJid: message.participantJid, displayName: message.senderName });
  }

  return dedupeParticipants(changes);
}

function buildMessageChanges(
  currentMessages: Array<{
    id: string;
    externalMessageId: string;
    clientMessageId: string | null;
    senderJid: string | null;
    senderName: string | null;
    participantJid: string | null;
    body: string | null;
    caption: string | null;
    type: string;
    providerTimestamp: Date | null;
  }>,
  normalizedMessages: ReturnType<typeof normalizeWahaMessage>[],
) {
  const patches: Array<{
    id: string;
    data: Record<string, any>;
  }> = [];
  const mediaPatches: Array<{
    messageId: string;
    data: Record<string, any>;
  }> = [];

  for (const message of normalizedMessages) {
    const current = currentMessages.find((item) => item.externalMessageId === message.wahaMessageId);
    if (!current) continue;

    const data: Record<string, any> = {};
    if (!current.senderName || isGenericDisplayName(current.senderName)) {
      data.senderName = message.senderName ?? current.senderName;
    }
    if (!current.participantJid && message.participantJid) {
      data.participantJid = message.participantJid;
    }
    if (!current.caption && message.caption) {
      data.caption = message.caption;
    }
    if (!current.body && message.body) {
      data.body = message.body;
    }
    if (current.type === 'unknown' && message.type) {
      data.type = message.type;
    }
    if (Object.keys(data).length) {
      patches.push({ id: current.id, data });
    }

    if (message.media) {
      mediaPatches.push({
        messageId: current.id,
        data: {
          mediaType: message.type,
          caption: message.caption ?? current.caption,
          mime: message.media.mime,
          fileName: message.media.fileName,
          pathOrUrl: message.media.url,
          thumbnailPathOrUrl: message.media.thumbnailUrl,
          thumbnailBase64: message.media.thumbnailBase64,
          providerMessageId: message.media.providerMessageId,
          providerMediaId: message.media.providerMediaId,
          mediaKey: message.media.mediaKey,
          fetchStatus: message.media.url
            ? 'pending'
            : message.media.error
              ? /protect|secure|phone/i.test(message.media.error)
                ? 'protected'
                : /expired|gone|missing|404/i.test(message.media.error)
                  ? 'expired'
                  : 'failed'
              : 'pending',
          fetchError: message.media.error,
          sha256: null,
          size: message.media.size,
          status: message.media.url ? MediaStatus.pending : MediaStatus.failed,
        },
      });
    }
  }

  return {
    patches: dedupeMessagePatches(patches),
    mediaPatches: dedupeMediaPatches(mediaPatches),
    patchCount: patches.length,
    mediaCount: mediaPatches.length,
  };
}

function dedupeParticipants(
  items: Array<{ participantJid: string; displayName: string | null }>,
) {
  const map = new Map<string, { participantJid: string; displayName: string | null }>();
  for (const item of items) {
    map.set(item.participantJid, item);
  }
  return [...map.values()];
}

function dedupeMessagePatches(
  items: Array<{ id: string; data: Record<string, any> }>,
) {
  const map = new Map<string, { id: string; data: Record<string, any> }>();
  for (const item of items) {
    map.set(item.id, item);
  }
  return [...map.values()];
}

function dedupeMediaPatches(
  items: Array<{ messageId: string; data: Record<string, any> }>,
) {
  const map = new Map<string, { messageId: string; data: Record<string, any> }>();
  for (const item of items) {
    map.set(item.messageId, item);
  }
  return [...map.values()];
}

function shouldReplaceDisplayName(
  current: string | null | undefined,
  next: string,
  type: ConversationType,
  jid?: string | null,
) {
  if (!current) return true;
  if (current.trim() === next.trim()) return false;
  if (isGenericDisplayName(current, type)) return true;
  if (jid && current.trim().toLowerCase() === jid.trim().toLowerCase()) return true;
  return /@(?:c\.us|g\.us|newsletter|broadcast|lid)$/i.test(current);
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    session: 'default',
    limit: 100,
    apply: argv.includes('--apply') && !argv.includes('--dry-run'),
  };

  const sessionIndex = argv.indexOf('--session');
  if (sessionIndex !== -1 && argv[sessionIndex + 1]) {
    options.session = argv[sessionIndex + 1];
  }

  const limitIndex = argv.indexOf('--limit');
  if (limitIndex !== -1 && argv[limitIndex + 1]) {
    const parsed = Number(argv[limitIndex + 1]);
    if (Number.isFinite(parsed) && parsed > 0) {
      options.limit = parsed;
    }
  }

  const conversationIndex = argv.indexOf('--conversation');
  if (conversationIndex !== -1 && argv[conversationIndex + 1]) {
    options.conversationId = argv[conversationIndex + 1];
  }

  if (argv.includes('--dry-run')) {
    options.apply = false;
  }

  return options;
}

async function fetchChats(baseUrl: string, apiKey: string, session: string) {
  return fetchWahaJson<Record<string, any>[]>(baseUrl, apiKey, `/api/${encodeURIComponent(session)}/chats`, {
    limit: 1000,
    offset: 0,
    sortBy: 'conversationTimestamp',
    sortOrder: 'desc',
  }).catch(() => []);
}

async function fetchContact(baseUrl: string, apiKey: string, session: string, jid: string) {
  return fetchWahaJson<Record<string, any>>(baseUrl, apiKey, `/api/${encodeURIComponent(session)}/contacts/${encodeURIComponent(jid)}`).catch(() => null);
}

async function fetchGroupMetadata(baseUrl: string, apiKey: string, session: string, jid: string) {
  return fetchWahaJson<Record<string, any>>(baseUrl, apiKey, `/api/${encodeURIComponent(session)}/groups/${encodeURIComponent(jid)}`).catch(() => null);
}

async function fetchMessages(baseUrl: string, apiKey: string, session: string, jid: string, limit: number) {
  return fetchWahaJson<Record<string, any>[]>(
    baseUrl,
    apiKey,
    `/api/${encodeURIComponent(session)}/chats/${encodeURIComponent(jid)}/messages`,
    { limit, downloadMedia: false },
  ).catch(() => []);
}

async function fetchWahaJson<T>(
  baseUrl: string,
  apiKey: string,
  path: string,
  params?: Record<string, unknown>,
) {
  const url = new URL(path, baseUrl);
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null) continue;
      url.searchParams.set(key, String(value));
    }
  }

  const response = await fetch(url, {
    headers: apiKey ? { 'X-Api-Key': apiKey } : undefined,
  });

  if (!response.ok) {
    throw new Error(`WAHA request failed: ${response.status} ${response.statusText} ${url.toString()}`);
  }

  return response.json() as Promise<T>;
}

function findChat(chats: Record<string, any>[], jid: string) {
  const normalized = jid.trim().toLowerCase();
  return chats.find((chat) => {
    const candidate = String(
      chat?.id?._serialized ?? chat?.id ?? chat?.chatId ?? chat?.jid ?? chat?._data?.id?._serialized ?? '',
    )
      .trim()
      .toLowerCase();
    return candidate === normalized;
  }) ?? null;
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
