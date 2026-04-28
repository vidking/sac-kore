export const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3001/api';

export type AuthUser = {
  sub: string;
  email: string;
  role: string;
  name: string;
};

export type Tag = {
  id: string;
  name: string;
  color: string;
};

export type Operator = {
  id: string;
  name: string;
  email: string;
  role: string;
};

export type Conversation = {
  id: string;
  chatJid: string;
  type: 'direct' | 'group' | 'newsletter' | 'broadcast' | 'status' | 'system' | 'unknown';
  displayName?: string;
  pushName?: string;
  subject?: string;
  avatarUrl?: string;
  syncStatus?: 'pending' | 'syncing' | 'synced' | 'failed';
  isArchived?: boolean;
  isPinned?: boolean;
  status: 'open' | 'pending' | 'closed';
  unreadCount: number;
  lastMessageAt?: string;
  contact: {
    id: string;
    phone?: string;
    displayName?: string;
    whatsappJid: string;
  };
  channel: {
    id: string;
    sessionName: string;
    status: string;
  };
  assignedTo?: string | null;
  assignedUser?: Operator | null;
  participants?: ConversationParticipant[];
  tags: { tag: Tag }[];
  messages?: Message[];
  messagesPageInfo?: PageInfo;
};

export type ConversationParticipant = {
  id: string;
  chatJid: string;
  participantJid: string;
  displayName?: string | null;
  createdAt?: string;
  updatedAt?: string;
};

export type OutboxState = {
  id: string;
  status:
    | 'queued'
    | 'sending'
    | 'sent'
    | 'failed'
    | 'retryable_failed'
    | 'permanently_failed'
    | 'reconciled'
    | 'canceled';
  attempts: number;
  lastError?: string | null;
  nextRetryAt?: string | null;
};

export type Message = {
  id: string;
  externalMessageId: string;
  clientMessageId?: string;
  conversationId?: string;
  direction: 'inbound' | 'outbound';
  senderJid?: string;
  senderName?: string;
  participantJid?: string;
  body?: string;
  caption?: string;
  type: string;
  reactionEmoji?: string | null;
  reactionTargetExternalMessageId?: string | null;
  ackStatus: string;
  providerTimestamp?: string;
  createdAt: string;
  sequence?: number;
  createdBy?: { id: string; name: string; email: string };
  outbox?: OutboxState | null;
  media?: {
    id: string;
    status: string;
    mediaType?: string;
    caption?: string;
    mime?: string;
    fileName?: string;
    pathOrUrl?: string;
    thumbnailPathOrUrl?: string;
    thumbnailBase64?: string | null;
    providerMessageId?: string | null;
    providerMediaId?: string | null;
    mediaKey?: string | null;
    fetchStatus?: string | null;
    fetchError?: string | null;
    sha256?: string | null;
    size?: number;
  };
};

export type PageInfo = {
  nextCursor: string | null;
  hasMore: boolean;
  direction?: 'before' | 'after';
};

export type PagedResult<T> = {
  items: T[];
  pageInfo: PageInfo;
};

export type SyncSessionStatus = {
  channel: {
    id: string;
    sessionName: string;
    status: string;
    lastSyncAt?: string | null;
  } | null;
  activeRun: {
    id: string;
    status: string;
    startedAt: string;
    heartbeatAt?: string | null;
    error?: string | null;
  } | null;
  latestRun: {
    id: string;
    status: string;
    startedAt: string;
    finishedAt?: string | null;
    heartbeatAt?: string | null;
    error?: string | null;
  } | null;
  recentRuns: Array<{
    id: string;
    status: string;
    startedAt: string;
    finishedAt?: string | null;
    heartbeatAt?: string | null;
    error?: string | null;
  }>;
  sessionName: string;
  status: 'idle' | 'running' | 'completed' | 'failed' | 'stale';
  healthStatus?: 'healthy' | 'syncing' | 'degraded' | 'offline' | 'stale' | 'error';
  sessionConnected?: boolean;
  lastSuccessfulSyncAt?: string | null;
  lastError?: string | null;
  retryCount?: number;
};

export type SyncStatusResponse = {
  sessions: SyncSessionStatus[];
};

export type InboxHealthResponse = {
  inbox: {
    id: string;
    sessionName: string;
    status: string;
    lastSyncAt?: string | null;
    _count?: {
      conversations: number;
      messages: number;
    };
  };
  health: SyncSessionStatus;
};

export type ConversationDebug = {
  conversation: Conversation;
  stats: {
    messageCount: number;
    noteCount: number;
    eventCount: number;
    participantCount: number;
  };
  recentMessages: Message[];
  recentEvents: Array<{
    id: string;
    eventType: string;
    payload: unknown;
    createdAt: string;
    user?: { id: string; name: string; email: string } | null;
  }>;
  recentNotes: Note[];
  syncStatus: SyncSessionStatus;
};

export type Note = {
  id: string;
  body: string;
  createdAt: string;
  user: { id: string; name: string; email: string };
};

export async function apiFetch<T>(
  path: string,
  options: RequestInit = {},
  token?: string | null,
): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, {
    ...options,
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers ?? {}),
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || response.statusText);
  }

  return response.json() as Promise<T>;
}

export async function apiFetchBlob(
  path: string,
  options: RequestInit = {},
  token?: string | null,
): Promise<Blob> {
  const response = await fetch(`${API_URL}${path}`, {
    ...options,
    credentials: 'include',
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers ?? {}),
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || response.statusText);
  }

  return response.blob();
}
