import {
  AlertCircle,
  Check,
  Circle,
  Clock3,
  Inbox,
  LogOut,
  Megaphone,
  MessageSquareText,
  Radio,
  RefreshCw,
  Search,
  Send,
  Sparkles,
  Tag as TagIcon,
  UserRound,
  UsersRound,
  Wifi,
  WifiOff,
} from 'lucide-react';
import { FormEvent, KeyboardEvent, useEffect, useMemo, useRef, useState } from 'react';
import {
  apiFetch,
  apiFetchBlob,
  AuthUser,
  Conversation,
  ConversationParticipant,
  Message,
  Note,
  Operator,
  OutboxState,
  PagedResult,
  SyncSessionStatus,
  SyncStatusResponse,
  Tag,
} from './api';
import { connectSocket } from './socket';

type Session = {
  token?: string;
  user: AuthUser;
};

type ChatFilter = 'all' | 'direct' | 'group' | 'newsletter' | 'unread';
type OwnershipFilter = 'all' | 'mine' | 'unassigned';
type NoticeTone = 'error' | 'warning' | 'info';
type AppNotice = {
  scope: 'meta' | 'list' | 'conversation' | 'composer';
  tone: NoticeTone;
  message: string;
};

const CHAT_PAGE_SIZE = 30;
const MESSAGE_PAGE_SIZE = 40;

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [authReady, setAuthReady] = useState(false);

  useEffect(() => {
    let cancelled = false;

    apiFetch<AuthUser>('/auth/me')
      .then((user) => {
        if (!cancelled) {
          setSession({ user });
        }
      })
      .catch(() => {
        if (!cancelled) {
          setSession(null);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setAuthReady(true);
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  if (!authReady) {
    return <main className="login-shell">Cargando sesión...</main>;
  }

  if (!session) {
    return <Login onLogin={setSession} />;
  }

  return (
    <InboxApp
      session={session}
      onLogout={async () => {
        try {
          await apiFetch('/auth/logout', { method: 'POST' });
        } finally {
          setSession(null);
        }
      }}
    />
  );
}

function Login({ onLogin }: { onLogin: (session: Session) => void }) {
  const [email, setEmail] = useState('admin@example.com');
  const [password, setPassword] = useState('admin123456');
  const [error, setError] = useState('');

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError('');

    try {
      const response = await apiFetch<{ user: AuthUser }>('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email, password }),
      });
      onLogin({ user: response.user });
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Login failed');
    }
  }

  return (
    <main className="login-shell">
      <form className="login-panel" onSubmit={submit}>
        <div className="login-mark">
          <Inbox size={24} />
        </div>
        <h1>WAHA CRM Inbox</h1>
        <label>
          Email
          <input value={email} onChange={(event) => setEmail(event.target.value)} />
        </label>
        <label>
          Password
          <input
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            type="password"
          />
        </label>
        {error ? <p className="error">{error}</p> : null}
        <button className="primary-button" type="submit">
          <UserRound size={17} />
          Entrar
        </button>
      </form>
    </main>
  );
}

function InboxApp({
  session,
  onLogout,
}: {
  session: Session;
  onLogout: () => void;
}) {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [conversationsPage, setConversationsPage] = useState<{
    nextCursor: string | null;
    hasMore: boolean;
  }>({
    nextCursor: null,
    hasMore: false,
  });
  const [activeId, setActiveId] = useState<string | null>(null);
  const [active, setActive] = useState<Conversation | null>(null);
  const [tags, setTags] = useState<Tag[]>([]);
  const [operators, setOperators] = useState<Operator[]>([]);
  const [notes, setNotes] = useState<Note[]>([]);
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [chatFilter, setChatFilter] = useState<ChatFilter>('all');
  const [ownershipFilter, setOwnershipFilter] = useState<OwnershipFilter>('all');
  const [composer, setComposer] = useState('');
  const [note, setNote] = useState('');
  const [connected, setConnected] = useState(false);
  const [outboxPending, setOutboxPending] = useState(0);
  const [loadingList, setLoadingList] = useState(false);
  const [loadingMoreChats, setLoadingMoreChats] = useState(false);
  const [loadingConversation, setLoadingConversation] = useState(false);
  const [loadingOlderMessages, setLoadingOlderMessages] = useState(false);
  const [loadingMeta, setLoadingMeta] = useState(true);
  const [newMessages, setNewMessages] = useState(0);
  const [sending, setSending] = useState(false);
  const [syncSummary, setSyncSummary] = useState<SyncStatusResponse | null>(null);
  const [syncingNow, setSyncingNow] = useState(false);
  const [notice, setNotice] = useState<AppNotice | null>(null);
  const messagesRef = useRef<HTMLDivElement | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const conversationListRef = useRef<HTMLDivElement | null>(null);
  const isReadingBottomRef = useRef(true);
  const activeIdRef = useRef<string | null>(null);
  const activeRequestRef = useRef(0);
  const listRequestRef = useRef(0);
  const suppressAutoScrollRef = useRef(false);
  const socketRef = useRef<ReturnType<typeof connectSocket> | null>(null);
  const joinedConversationIdRef = useRef<string | null>(null);

  useEffect(() => {
    activeIdRef.current = activeId;
  }, [activeId]);

  function setScopedNotice(
    scope: AppNotice['scope'],
    message: string,
    tone: NoticeTone = 'error',
  ) {
    setNotice({ scope, message, tone });
  }

  function clearScopedNotice(scope: AppNotice['scope']) {
    setNotice((current) => (current?.scope === scope ? null : current));
  }

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebouncedQuery(query.trim());
    }, 250);
    return () => window.clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    let cancelled = false;

    Promise.all([
      apiFetch<Tag[]>('/tags', {}, session.token),
      apiFetch<Operator[]>('/users', {}, session.token),
      loadPendingOutbox(session.token),
      loadSyncStatus(session.token),
    ])
      .then(([nextTags, nextOperators, nextPending, nextSync]) => {
        if (cancelled) return;
        setTags(nextTags);
        setOperators(nextOperators);
        setOutboxPending(nextPending);
        setSyncSummary(nextSync);
        clearScopedNotice('meta');
      })
      .catch((error) => {
        if (cancelled) return;
        setScopedNotice(
          'meta',
          error instanceof Error
            ? error.message
            : 'No fue posible cargar tags, operadores o estado de sync.',
        );
      })
      .finally(() => {
        if (!cancelled) setLoadingMeta(false);
      });

    const interval = window.setInterval(() => {
      loadPendingOutbox(session.token)
        .then((value) => {
          setOutboxPending(value);
          clearScopedNotice('meta');
        })
        .catch((error) => {
          setScopedNotice(
            'meta',
            error instanceof Error ? error.message : 'No fue posible actualizar el outbox.',
          );
        });
      loadSyncStatus(session.token)
        .then((value) => {
          setSyncSummary(value);
          clearScopedNotice('meta');
        })
        .catch((error) => {
          setScopedNotice(
            'meta',
            error instanceof Error ? error.message : 'No fue posible actualizar el sync.',
          );
        });
    }, 15000);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [session.token]);

  useEffect(() => {
    void loadConversations(true);
  }, [session.token, debouncedQuery, chatFilter, ownershipFilter]);

  useEffect(() => {
    if (!activeId) return;
    void loadActiveConversation(activeId);
  }, [activeId]);

  useEffect(() => {
    const nextSocket = connectSocket(session.token);
    socketRef.current = nextSocket;
    nextSocket.on('connect', () => {
      setConnected(true);
      const activeConversationId = activeIdRef.current;
      if (activeConversationId) {
        nextSocket.emit('conversation.join', { conversationId: activeConversationId });
        joinedConversationIdRef.current = activeConversationId;
      }
    });
    nextSocket.on('disconnect', () => setConnected(false));

    nextSocket.on('conversation.upserted', ({ conversation }) => {
      if (!conversation || shouldHideConversation(conversation)) return;
      setConversations((current) => upsertConversation(current, conversation));
      if (conversation.id === activeIdRef.current) {
        setActive((current) => (current ? mergeConversation(current, conversation) : current));
      }
    });

    nextSocket.on('conversation.updated', ({ conversation }) => {
      if (!conversation || shouldHideConversation(conversation)) return;
      setConversations((current) => upsertConversation(current, conversation));
      if (conversation.id === activeIdRef.current) {
        setActive((current) => (current ? mergeConversation(current, conversation) : current));
      }
    });

    nextSocket.on('message.created', ({ message }) => {
      if (!message) return;
      const isActiveConversation = activeIdRef.current === message.conversationId;

      setActive((current) => {
        if (!current || current.id !== message.conversationId) return current;
        const hadMessage = (current.messages ?? []).some((item) => isSameMessage(item, message));
        const nextMessages = upsertMessage(current.messages ?? [], message);
        if (!hadMessage && !isReadingBottomRef.current) {
          setNewMessages((value) => value + 1);
        }
        return { ...current, messages: nextMessages };
      });

      setConversations((current) =>
        applyMessageToConversationList(current, message, activeIdRef.current),
      );

      if (isActiveConversation && isReadingBottomRef.current) {
        queueMicrotask(() => {
          messagesEndRef.current?.scrollIntoView({ block: 'end', behavior: 'smooth' });
        });
      }
    });

    nextSocket.on('message.reaction', ({ message }) => {
      if (!message) return;
      setActive((current) =>
        current && current.id === message.conversationId
          ? { ...current, messages: upsertMessage(current.messages ?? [], message) }
          : current,
      );
      setConversations((current) =>
        applyMessageToConversationList(current, message, activeIdRef.current),
      );
    });

    nextSocket.on('message.updated', ({ message }) => {
      if (!message) return;
      setActive((current) =>
        current && current.id === message.conversationId
          ? { ...current, messages: upsertMessage(current.messages ?? [], message) }
          : current,
      );
      setConversations((current) =>
        applyMessageToConversationList(current, message, activeIdRef.current),
      );
    });

    nextSocket.on('message.ack', ({ messageId, conversationId, ackStatus }) => {
      setActive((current) =>
        current && current.id === conversationId
          ? {
              ...current,
              messages: patchMessage(current.messages ?? [], messageId, { ackStatus }),
            }
          : current,
      );
      setConversations((current) =>
        patchConversationPreviewMessage(current, conversationId, messageId, { ackStatus }),
      );
    });

    nextSocket.on('media.updated', ({ media, messageId, conversationId }) => {
      if (!media || !messageId) return;
      setActive((current) =>
        current && current.id === conversationId
          ? {
              ...current,
              messages: patchMessage(current.messages ?? [], messageId, { media }),
            }
          : current,
      );
      setConversations((current) =>
        patchConversationPreviewMessage(current, conversationId, messageId, { media }),
      );
    });

    nextSocket.on('note.created', ({ conversationId, note: nextNote }) => {
      if (conversationId === activeIdRef.current) {
        setNotes((current) => upsertNote(current, nextNote));
      }
    });

    nextSocket.on('channel.status', ({ channel }) => {
      if (!channel) return;
      setConversations((current) =>
        current.map((conversation) =>
          conversation.channel.id === channel.id
            ? { ...conversation, channel: { ...conversation.channel, status: channel.status } }
            : conversation,
        ),
      );
      setActive((current) =>
        current && current.channel.id === channel.id
          ? { ...current, channel: { ...current.channel, status: channel.status } }
          : current,
      );
      loadSyncStatus(session.token)
        .then((value) => {
          setSyncSummary(value);
          clearScopedNotice('meta');
        })
        .catch((error) => {
          setScopedNotice(
            'meta',
            error instanceof Error ? error.message : 'No fue posible actualizar el estado del canal.',
          );
        });
    });

    nextSocket.on('tag.updated', ({ conversationId }) => {
      if (conversationId && conversationId === activeIdRef.current) {
        void loadActiveConversation(conversationId);
      }
    });

    return () => {
      socketRef.current = null;
      joinedConversationIdRef.current = null;
      nextSocket.close();
    };
  }, [session.token]);

  useEffect(() => {
    if (suppressAutoScrollRef.current) {
      suppressAutoScrollRef.current = false;
      return;
    }

    if (isReadingBottomRef.current) {
      messagesEndRef.current?.scrollIntoView({ block: 'end' });
      setNewMessages(0);
    }
  }, [active?.id, active?.messages?.length]);

  useEffect(() => {
    const socket = socketRef.current;
    if (!socket) return;

    const previousConversationId = joinedConversationIdRef.current;
    if (previousConversationId && previousConversationId !== activeId) {
      socket.emit('conversation.leave', { conversationId: previousConversationId });
      joinedConversationIdRef.current = null;
    }

    if (activeId && previousConversationId !== activeId) {
      socket.emit('conversation.join', { conversationId: activeId });
      joinedConversationIdRef.current = activeId;
    }

    if (!activeId) {
      joinedConversationIdRef.current = null;
    }
  }, [activeId]);

  async function loadConversations(reset: boolean) {
    const requestId = listRequestRef.current + 1;
    listRequestRef.current = requestId;

    if (reset) {
      setLoadingList(true);
    } else {
      setLoadingMoreChats(true);
    }

    try {
      const params = new URLSearchParams();
      params.set('limit', String(CHAT_PAGE_SIZE));

      if (!reset && conversationsPage.nextCursor) {
        params.set('cursor', conversationsPage.nextCursor);
      }

      if (debouncedQuery) {
        params.set('q', debouncedQuery);
      }

      if (chatFilter === 'unread') {
        params.set('unread', '1');
      } else if (chatFilter !== 'all') {
        params.set('type', chatFilter);
      }

      if (ownershipFilter === 'mine') {
        params.set('assignedTo', session.user.sub);
      } else if (ownershipFilter === 'unassigned') {
        params.set('assignedTo', '__unassigned__');
      }

      const response = await apiFetch<PagedResult<Conversation>>(
        `/chats?${params.toString()}`,
        {},
        session.token,
      );

      if (listRequestRef.current !== requestId) {
        return;
      }

      const visibleItems = response.items.filter((item) => !shouldHideConversation(item));
      const nextConversations = reset
        ? visibleItems
        : mergeConversationPages(conversations, response.items);
      setConversations(nextConversations);
      setConversationsPage(response.pageInfo);
      clearScopedNotice('list');

      const firstVisible = visibleItems[0] ?? null;
      const stillVisible = nextConversations.some((item) => item.id === activeIdRef.current);
      if (!stillVisible) {
        activeIdRef.current = firstVisible?.id ?? null;
        setActiveId(firstVisible?.id ?? null);
        setActive(null);
        setNotes([]);
      } else if (!activeIdRef.current && firstVisible) {
        activeIdRef.current = firstVisible.id;
        setActiveId(firstVisible.id);
      }
    } catch (error) {
      setScopedNotice(
        'list',
        error instanceof Error ? error.message : 'No fue posible cargar la lista de conversaciones.',
      );
    } finally {
      if (listRequestRef.current === requestId) {
        setLoadingList(false);
        setLoadingMoreChats(false);
      }
    }
  }

  async function refreshInbox() {
    if (loadingList || loadingMoreChats) {
      return;
    }

    setLoadingList(true);
    try {
      await loadConversations(true);
      if (activeIdRef.current) {
        await loadActiveConversation(activeIdRef.current);
      }
      setSyncSummary(await loadSyncStatus(session.token));
      clearScopedNotice('list');
      clearScopedNotice('conversation');
    } catch (error) {
      setScopedNotice(
        'list',
        error instanceof Error ? error.message : 'No fue posible refrescar el inbox.',
      );
    } finally {
      setLoadingList(false);
    }
  }

  async function loadActiveConversation(id: string) {
    const requestId = activeRequestRef.current + 1;
    activeRequestRef.current = requestId;
    setLoadingConversation(true);
    setNewMessages(0);
    isReadingBottomRef.current = true;

    try {
      const [conversation, conversationNotes] = await Promise.all([
        apiFetch<Conversation>(
          `/conversations/${id}?limit=${MESSAGE_PAGE_SIZE}`,
          {},
          session.token,
        ),
        apiFetch<Note[]>(`/conversations/${id}/notes`, {}, session.token),
      ]);

      if (activeRequestRef.current !== requestId || activeIdRef.current !== id) {
        return;
      }

      setActive(stripConversationForView(conversation));
      setNotes(conversationNotes);
      clearScopedNotice('conversation');

      if (conversation.unreadCount > 0) {
        try {
          await apiFetch(`/conversations/${id}/read`, { method: 'POST' }, session.token);
          setConversations((current) =>
            current.map((item) => (item.id === id ? { ...item, unreadCount: 0 } : item)),
          );
          setActive((current) => (current?.id === id ? { ...current, unreadCount: 0 } : current));
        } catch (error) {
          setScopedNotice(
            'conversation',
            error instanceof Error
              ? error.message
              : 'No fue posible marcar la conversacion como leida.',
            'warning',
          );
        }
      }
    } catch (error) {
      if (activeRequestRef.current === requestId && activeIdRef.current === id) {
        setActive(null);
        setNotes([]);
        setScopedNotice(
          'conversation',
          error instanceof Error
            ? error.message
            : 'No fue posible cargar la conversacion seleccionada.',
        );
      }
    } finally {
      if (activeRequestRef.current === requestId) {
        setLoadingConversation(false);
      }
    }
  }

  async function loadOlderMessages() {
    if (!active || loadingOlderMessages || !active.messagesPageInfo?.hasMore) {
      return;
    }

    const cursor = active.messagesPageInfo.nextCursor;
    if (!cursor) return;

    const element = messagesRef.current;
    const snapshot = element
      ? {
          height: element.scrollHeight,
          top: element.scrollTop,
        }
      : null;

    setLoadingOlderMessages(true);
    try {
      const response = await apiFetch<PagedResult<Message>>(
        `/chats/${encodeURIComponent(active.chatJid)}/messages?before=${cursor}&limit=${MESSAGE_PAGE_SIZE}&channelId=${encodeURIComponent(active.channel.id)}&session=${encodeURIComponent(active.channel.sessionName)}`,
        {},
        session.token,
      );

      if (activeIdRef.current !== active.id) return;

      suppressAutoScrollRef.current = true;
      setActive((current) => {
        if (!current || current.id !== active.id) return current;
        return {
          ...current,
          messages: prependMessages(current.messages ?? [], response.items),
          messagesPageInfo: response.pageInfo,
        };
      });

      if (element && snapshot) {
        requestAnimationFrame(() => {
          const nextHeight = element.scrollHeight;
          element.scrollTop = nextHeight - snapshot.height + snapshot.top;
        });
      }
      clearScopedNotice('conversation');
    } catch (error) {
      setScopedNotice(
        'conversation',
        error instanceof Error ? error.message : 'No fue posible cargar mensajes anteriores.',
      );
    } finally {
      setLoadingOlderMessages(false);
    }
  }

  async function retryPendingOutbox() {
    if (!outboxPending) return;
    const confirmed = window.confirm(
      `Esto reintentara enviar ${outboxPending} mensajes pendientes o reintentables por WAHA. Continua?`,
    );
    if (!confirmed) return;

    await apiFetch('/outbox/retry-pending', { method: 'POST' }, session.token);
    setOutboxPending(await loadPendingOutbox(session.token));
    clearScopedNotice('composer');
  }

  async function retryMessage(outbox: OutboxState) {
    await apiFetch(`/outbox/${outbox.id}/retry`, { method: 'POST' }, session.token);
    setActive((current) =>
      current
        ? {
            ...current,
            messages: patchMessageByOutbox(current.messages ?? [], outbox.id, {
              ackStatus: 'pending',
              outbox: {
                ...outbox,
                status: 'queued',
                lastError: null,
                nextRetryAt: null,
              },
            }),
          }
        : current,
    );
    setOutboxPending(await loadPendingOutbox(session.token));
    clearScopedNotice('composer');
  }

  async function updateStatus(status: Conversation['status']) {
    if (!active) return;
    const updated = await apiFetch<Conversation>(
      `/conversations/${active.id}`,
      {
        method: 'PATCH',
        body: JSON.stringify({ status }),
      },
      session.token,
    );
    setConversations((current) => upsertConversation(current, updated));
    setActive((current) => (current ? mergeConversation(current, updated) : current));
  }

  async function assignOperator(assignedTo: string) {
    if (!active) return;
    const updated = await apiFetch<Conversation>(
      `/conversations/${active.id}`,
      {
        method: 'PATCH',
        body: JSON.stringify({ assignedTo: assignedTo || null }),
      },
      session.token,
    );
    setConversations((current) => upsertConversation(current, updated));
    setActive((current) => (current ? mergeConversation(current, updated) : current));
  }

  async function addNote(event: FormEvent) {
    event.preventDefault();
    if (!active || !note.trim()) return;
    const created = await apiFetch<Note>(
      `/conversations/${active.id}/notes`,
      {
        method: 'POST',
        body: JSON.stringify({ body: note.trim() }),
      },
      session.token,
    );
    setNotes((current) => [created, ...current]);
    setNote('');
  }

  async function toggleTag(tag: Tag) {
    if (!active) return;
    const hasTag = active.tags.some((item) => item.tag.id === tag.id);
    if (hasTag) {
      await apiFetch(`/conversations/${active.id}/tags/${tag.id}`, { method: 'DELETE' }, session.token);
    } else {
      await apiFetch(
        `/conversations/${active.id}/tags`,
        {
          method: 'POST',
          body: JSON.stringify({ tagId: tag.id }),
        },
        session.token,
      );
    }

    await loadActiveConversation(active.id);
    setConversations((current) =>
      current.map((conversation) =>
        conversation.id === active.id
          ? {
              ...conversation,
              tags: hasTag
                ? conversation.tags.filter((item) => item.tag.id !== tag.id)
                : [...conversation.tags, { tag }],
            }
          : conversation,
      ),
    );
  }

  async function resyncActiveChannel() {
    if (!active || syncingNow) return;
    setSyncingNow(true);
    try {
      await apiFetch(`/sync/waha`, { method: 'POST' }, session.token);
      await refreshInbox();
      setScopedNotice('meta', 'Sincronización en cola', 'info');
    } catch (error) {
      setScopedNotice(
        'meta',
        error instanceof Error ? error.message : 'No fue posible ejecutar la sincronizacion.',
      );
    } finally {
      setSyncingNow(false);
    }
  }

  async function sendMessage(event?: FormEvent) {
    event?.preventDefault();
    const text = composer.trim();
    if (!active || !text || sending) return;

    const clientMessageId = createClientMessageId();
    const timestamp = new Date().toISOString();
    const optimistic: Message = {
      id: clientMessageId,
      clientMessageId,
      externalMessageId: `local:${clientMessageId}`,
      conversationId: active.id,
      direction: 'outbound',
      body: text,
      type: 'text',
      ackStatus: 'pending',
      createdAt: timestamp,
      providerTimestamp: timestamp,
      createdBy: { id: session.user.sub, name: session.user.name, email: session.user.email },
      outbox: {
        id: clientMessageId,
        status: 'queued',
        attempts: 0,
      },
    };

    setSending(true);
    setComposer('');
    isReadingBottomRef.current = true;
    setActive((current) =>
      current?.id === active.id
        ? { ...current, messages: upsertMessage(current.messages ?? [], optimistic) }
        : current,
    );
    setConversations((current) => applyMessageToConversationList(current, optimistic, active.id));

    try {
      const saved = await apiFetch<Message>(
        `/conversations/${active.id}/messages`,
        {
          method: 'POST',
          body: JSON.stringify({ body: text, clientMessageId }),
        },
        session.token,
      );

      setActive((current) =>
        current?.id === active.id
          ? { ...current, messages: upsertMessage(current.messages ?? [], saved) }
          : current,
      );
      setConversations((current) => applyMessageToConversationList(current, saved, active.id));
      setOutboxPending(await loadPendingOutbox(session.token));
      clearScopedNotice('composer');
    } catch (error) {
      setActive((current) =>
        current?.id === active.id
          ? {
              ...current,
              messages: patchMessage(current.messages ?? [], optimistic.id, {
                ackStatus: 'error',
                outbox: {
                  id: optimistic.outbox!.id,
                  status: 'failed',
                  attempts: 1,
                  lastError: error instanceof Error ? error.message : 'Error enviando mensaje',
                },
              }),
            }
          : current,
      );
      setConversations((current) =>
        patchConversationPreviewMessage(current, active.id, optimistic.id, {
          ackStatus: 'error',
          outbox: {
            id: optimistic.outbox!.id,
            status: 'failed',
            attempts: 1,
            lastError: error instanceof Error ? error.message : 'Error enviando mensaje',
          },
        }),
      );
      setComposer(text);
      setScopedNotice(
        'composer',
        error instanceof Error ? error.message : 'No fue posible enviar el mensaje.',
      );
    } finally {
      setSending(false);
    }
  }

  function selectConversation(conversation: Conversation) {
    if (conversation.id === activeIdRef.current) return;
    activeIdRef.current = conversation.id;
    setActiveId(conversation.id);
    setActive(null);
    setNotes([]);
    setNewMessages(0);
    isReadingBottomRef.current = true;
    setLoadingConversation(true);
    clearScopedNotice('conversation');
  }

  function handleMessagesScroll() {
    const element = messagesRef.current;
    if (!element) return;

    if (element.scrollTop <= 120) {
      void loadOlderMessages();
    }

    const distanceFromBottom = element.scrollHeight - element.scrollTop - element.clientHeight;
    isReadingBottomRef.current = distanceFromBottom < 96;
    if (isReadingBottomRef.current) {
      setNewMessages(0);
    }
  }

  function handleConversationListScroll() {
    const element = conversationListRef.current;
    if (!element || loadingMoreChats || !conversationsPage.hasMore) return;
    const nearBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 220;
    if (nearBottom) {
      void loadConversations(false);
    }
  }

  function jumpToLatest() {
    isReadingBottomRef.current = true;
    messagesEndRef.current?.scrollIntoView({ block: 'end', behavior: 'smooth' });
    setNewMessages(0);
  }

  function handleComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      sendMessage();
    }
  }

  const activeSession = active
    ? syncSummary?.sessions.find((item) => item.sessionName === active.channel.sessionName) ?? null
    : null;
  const connectionState = resolveConnectionState(connected, active?.channel.status, activeSession);
  const reactionIndex = useMemo(
    () => buildReactionIndex(active?.messages ?? []),
    [active?.messages],
  );
  const visibleMessages = useMemo(
    () => (active?.messages ?? []).filter((message) => message.type !== 'reaction'),
    [active?.messages],
  );

  return (
    <div className="app-shell">
      <aside className="conversation-rail">
        <header className="rail-header">
          <div className="rail-brand">
            <div className="brand-mark">K</div>
            <div>
              <p className="eyebrow">Kore CRM</p>
              <strong>Atencion WhatsApp</strong>
            </div>
          </div>
          <button
            className="icon-button"
            onClick={() => void refreshInbox()}
            title={loadingList || loadingMoreChats ? 'Actualizando inbox...' : 'Actualizar inbox'}
            disabled={loadingList || loadingMoreChats}
          >
            <RefreshCw size={18} className={loadingList || loadingMoreChats ? 'spinning' : undefined} />
          </button>
        </header>

        {notice?.scope === 'list' || notice?.scope === 'meta' ? (
          <div className={`panel-notice ${notice.tone}`}>{notice.message}</div>
        ) : null}

        <div className="search-box">
          <Search size={16} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Buscar nombre, telefono o JID tecnico"
          />
        </div>

        <div className="chat-tabs">
          {chatFilters.map((filter) => {
            const Icon = filter.icon;
            return (
              <button
                key={filter.value}
                className={chatFilter === filter.value ? 'selected' : ''}
                onClick={() => setChatFilter(filter.value)}
              >
                <Icon size={14} />
                {filter.label}
                <span>{countForFilter(conversations, filter.value)}</span>
              </button>
            );
          })}
        </div>

        <div className="ownership-tabs">
          {ownershipFilters.map((filter) => (
            <button
              key={filter.value}
              className={ownershipFilter === filter.value ? 'selected' : ''}
              onClick={() => setOwnershipFilter(filter.value)}
            >
              {filter.label}
            </button>
          ))}
        </div>

        <div
          className="conversation-list"
          ref={conversationListRef}
          onScroll={handleConversationListScroll}
        >
          {loadingList ? <ConversationSkeletons /> : null}
          {!loadingList && conversations.length === 0 ? (
            <div className="empty-state compact">
              <Inbox size={18} />
              <p>No hay conversaciones para este filtro.</p>
            </div>
          ) : null}
          {conversations.map((conversation) => (
            <ConversationListItem
              key={conversation.id}
              conversation={conversation}
              activeId={activeId}
              onSelect={selectConversation}
            />
          ))}
          {loadingMoreChats ? (
            <div className="rail-loader">
              <RefreshCw size={15} className="spinning" />
              Cargando mas chats...
            </div>
          ) : null}
        </div>
      </aside>

      <section className="message-pane">
        <header className="message-header">
          <div>
            <p className="eyebrow">
              {active?.channel.sessionName ?? 'default'} /{' '}
              {active ? labelForType(getEffectiveConversationType(active)) : 'inbox'} /{' '}
              {active ? formatConversationSyncStatus(active) : 'en espera'}
            </p>
            <h2>{active ? getConversationTitle(active) : 'Selecciona una conversacion'}</h2>
          </div>
          <div className="header-actions">
            <span className={`live-pill ${connectionState.tone}`}>
              {connectionState.icon === 'online' ? <Wifi size={15} /> : <WifiOff size={15} />}
              {connectionState.label}
            </span>
            {activeSession ? (
              <span className={`live-pill sync-${activeSession.status}`}>
                {activeSession.status === 'running' ? (
                  <RefreshCw size={15} className="spinning" />
                ) : (
                  <Sparkles size={15} />
                )}
                {labelForSync(activeSession.status, activeSession.healthStatus)}
              </span>
            ) : null}
            {outboxPending > 0 ? (
              <button
                className="queue-button"
                onClick={retryPendingOutbox}
                title="Reintentar outbox pendiente"
              >
                <RefreshCw size={16} />
                Cola {outboxPending}
              </button>
            ) : (
              <span className="live-pill clean">
                <Sparkles size={15} />
                cola limpia
              </span>
            )}
            {active ? (
              <button
                className="icon-button"
                onClick={() => void loadActiveConversation(active.id)}
                title={loadingConversation ? 'Recargando conversación...' : 'Recargar conversación'}
                disabled={loadingConversation}
              >
                <RefreshCw size={18} className={loadingConversation ? 'spinning' : undefined} />
              </button>
            ) : null}
            <button
              className="icon-button"
              onClick={resyncActiveChannel}
              title={syncingNow ? 'Sincronizando...' : 'Sincronizar ahora'}
              disabled={syncingNow}
            >
              <RefreshCw size={18} className={syncingNow ? 'spinning' : undefined} />
            </button>
            <button className="icon-button" onClick={onLogout} title="Salir">
              <LogOut size={18} />
            </button>
          </div>
        </header>

        {notice?.scope === 'conversation' || notice?.scope === 'composer' ? (
          <div className={`panel-notice ${notice.tone}`}>{notice.message}</div>
        ) : null}

        <div className="messages" ref={messagesRef} onScroll={handleMessagesScroll}>
          {loadingConversation ? (
            <div className="loading-line">Cargando conversacion...</div>
          ) : null}
          {!loadingConversation && !active ? (
            <div className="empty-state">
              <MessageSquareText size={22} />
              <h3>Inbox persistente y en tiempo real</h3>
              <p>Selecciona un chat para ver los ultimos mensajes, cargar historial por cursor y responder sin recargar toda la pantalla.</p>
            </div>
          ) : null}
          {loadingOlderMessages ? (
            <div className="older-loader">
              <RefreshCw size={14} className="spinning" />
              Cargando mensajes anteriores...
            </div>
          ) : null}
          {visibleMessages.map((message) => (
            <MessageBubble
              key={message.id}
              conversation={active}
              message={message}
              mediaToken={session.token}
              onRetry={retryMessage}
              reactions={reactionIndex.get(message.externalMessageId) ?? []}
            />
          ))}
          <div ref={messagesEndRef} />
          {newMessages > 0 ? (
            <button className="new-messages-button" onClick={jumpToLatest}>
              {newMessages} nuevos mensajes
            </button>
          ) : null}
        </div>

        <form className="composer" onSubmit={sendMessage}>
          <MessageSquareText size={19} />
          <textarea
            value={composer}
            onChange={(event) => setComposer(event.target.value)}
            onKeyDown={handleComposerKeyDown}
            placeholder="Escribe una respuesta. Enter envia, Shift+Enter agrega linea."
            disabled={!active || sending}
          />
          <button
            className="primary-button compact"
            disabled={!active || !composer.trim() || sending}
            type="submit"
          >
            <Send size={17} />
            {sending ? 'Enviando' : 'Enviar'}
          </button>
        </form>
      </section>

      <aside className="detail-panel">
        <section className="contact-card">
          <p className="eyebrow">Contacto</p>
          <div className="contact-avatar">{initials(active ? getConversationTitle(active) : 'K')}</div>
          <h3>{active ? getConversationTitle(active) : 'Selecciona una conversacion'}</h3>
          <dl>
            <dt>Tipo</dt>
            <dd>{active ? labelForType(getEffectiveConversationType(active)) : '-'}</dd>
            <dt>Canal</dt>
            <dd>{active?.channel.sessionName ?? '-'}</dd>
            <dt>Estado live</dt>
            <dd>{connectionState.label}</dd>
            <dt>Sync</dt>
            <dd>
              {activeSession
                ? labelForSync(activeSession.status, activeSession.healthStatus)
                : active
                  ? formatConversationSyncStatus(active)
                  : '-'}
            </dd>
            <dt>JID tecnico</dt>
            <dd className="technical-jid">{active?.chatJid ?? '-'}</dd>
          </dl>
        </section>

        <section>
          <p className="eyebrow">Estado</p>
          <div className="segmented">
            {(['open', 'pending', 'closed'] as const).map((status) => (
              <button
                key={status}
                className={active?.status === status ? 'selected' : ''}
                onClick={() => updateStatus(status)}
                disabled={!active}
              >
                {status}
              </button>
            ))}
          </div>
        </section>

        <section>
          <p className="eyebrow">Operador</p>
          <select
            value={active?.assignedTo ?? ''}
            onChange={(event) => assignOperator(event.target.value)}
            disabled={!active}
          >
            <option value="">Sin asignar</option>
            {operators.map((operator) => (
              <option key={operator.id} value={operator.id}>
                {operator.name}
              </option>
            ))}
          </select>
        </section>

        <section>
          <p className="eyebrow">Tags</p>
          <div className="tag-cloud">
            {tags.map((tag) => {
              const selected = active?.tags.some((item) => item.tag.id === tag.id);
              return (
                <button
                  key={tag.id}
                  className={selected ? 'tag selected' : 'tag'}
                  onClick={() => toggleTag(tag)}
                  disabled={!active}
                >
                  <TagIcon size={14} />
                  <span style={{ background: tag.color }} />
                  {tag.name}
                </button>
              );
            })}
          </div>
        </section>

        <section>
          <p className="eyebrow">Resumen operativo</p>
          <div className="summary-grid">
            <div>
              <strong>{active?.unreadCount ?? 0}</strong>
              <span>No leidos</span>
            </div>
            <div>
              <strong>{active?.messages?.length ?? 0}</strong>
              <span>Mensajes visibles</span>
            </div>
            <div>
              <strong>{outboxPending}</strong>
              <span>Outbox</span>
            </div>
            <div>
              <strong>{loadingMeta ? '...' : syncSummary?.sessions.length ?? 0}</strong>
              <span>Sesiones</span>
            </div>
          </div>
        </section>

        <section className="notes-section">
          <p className="eyebrow">Notas internas</p>
          <form className="note-form" onSubmit={addNote}>
            <textarea
              value={note}
              onChange={(event) => setNote(event.target.value)}
              disabled={!active}
            />
            <button className="primary-button compact" disabled={!active || !note.trim()} type="submit">
              Agregar
            </button>
          </form>
          <div className="notes-list">
            {notes.map((item) => (
              <article key={item.id} className="note-item">
                <p>{item.body}</p>
                <span>
                  {item.user.name} - {formatTime(item.createdAt)}
                </span>
              </article>
            ))}
          </div>
        </section>
      </aside>
    </div>
  );
}

function MessageBubble({
  conversation,
  message,
  mediaToken,
  onRetry,
  reactions,
}: {
  conversation: Conversation | null;
  message: Message;
  mediaToken?: string;
  onRetry: (outbox: OutboxState) => Promise<void>;
  reactions: string[];
}) {
  const retryable = Boolean(
    message.outbox &&
      ['retryable_failed', 'permanently_failed'].includes(message.outbox.status),
  );

  return (
    <article className={`message-bubble ${message.direction}`}>
      {message.direction === 'inbound' && resolveMessageSenderLabel(conversation, message) ? (
        <strong className="message-sender">{resolveMessageSenderLabel(conversation, message)}</strong>
      ) : null}
      <MessageBody message={message} token={mediaToken} />
      {message.outbox?.lastError ? (
        <div className="message-alert">
          <AlertCircle size={13} />
          <span>{message.outbox.lastError}</span>
        </div>
      ) : null}
      {reactions.length ? (
        <div className="reaction-bar">
          {collapseReactions(reactions).map(([emoji, count]) => (
            <span className="reaction-pill" key={`${message.id}-${emoji}`}>
              {emoji} {count > 1 ? count : ''}
            </span>
          ))}
        </div>
      ) : null}
      <footer>
        <span>{formatMessageMeta(message)}</span>
        {retryable && message.outbox ? (
          <button className="retry-inline" onClick={() => onRetry(message.outbox!)} type="button">
            Reintentar
          </button>
        ) : null}
        <AckIcon ack={message.ackStatus} />
      </footer>
    </article>
  );
}

function ConversationListItem({
  conversation,
  activeId,
  onSelect,
}: {
  conversation: Conversation;
  activeId: string | null;
  onSelect: (conversation: Conversation) => void;
}) {
  const type = getEffectiveConversationType(conversation);
  const preview = conversation.messages?.[0];
  const previewOutbox = preview?.outbox;

  return (
    <button
      className={`conversation-item ${conversation.id === activeId ? 'active' : ''}`}
      onClick={() => onSelect(conversation)}
    >
      <div className={`avatar ${type}`}>
        {conversation.avatarUrl ? (
          <img src={conversation.avatarUrl} alt="" />
        ) : (
          initials(getConversationTitle(conversation))
        )}
      </div>
      <div className="conversation-copy">
        <div className="row">
          <strong>{getConversationTitle(conversation)}</strong>
          <span>{formatTime(conversation.lastMessageAt)}</span>
        </div>
        <p>{getConversationPreview(conversation)}</p>
        <div className="tag-row">
          <span className={`type-badge ${type}`}>{labelForType(type)}</span>
          {conversation.assignedUser ? (
            <span className="meta-pill">{conversation.assignedUser.name}</span>
          ) : (
            <span className="meta-pill muted">sin asignar</span>
          )}
          {previewOutbox?.status === 'retryable_failed' ||
          previewOutbox?.status === 'permanently_failed' ? (
            <span className="meta-pill error">error</span>
          ) : null}
          {conversation.tags.slice(0, 2).map(({ tag }) => (
            <span key={tag.id} className="tag-dot" style={{ background: tag.color }} />
          ))}
          <span className={`status-pill ${conversation.status}`}>{conversation.status}</span>
        </div>
      </div>
      {conversation.unreadCount ? <span className="unread">{conversation.unreadCount}</span> : null}
    </button>
  );
}

function ConversationSkeletons() {
  return (
    <>
      {[0, 1, 2].map((item) => (
        <div className="conversation-skeleton" key={item}>
          <span />
          <div>
            <strong />
            <p />
          </div>
        </div>
      ))}
    </>
  );
}

function MessageBody({ message, token }: { message: Message; token?: string }) {
  const mediaPath = `/messages/${message.id}/media`;
  const thumbnailPath = `/messages/${message.id}/thumbnail`;
  const [assetError, setAssetError] = useState<string | null>(null);
  const needsMediaUrl = ['image', 'video', 'audio', 'voice', 'sticker'].includes(message.type);
  const needsThumbnail = message.type === 'image' || message.type === 'sticker';
  const mediaAsset = useAuthorizedAssetUrl(mediaPath, needsMediaUrl, token);
  const thumbnailAsset = useAuthorizedAssetUrl(thumbnailPath, needsThumbnail, token);
  const inlineThumbnail = buildInlineThumbnailSource(message.media?.thumbnailBase64, message.media?.mime);
  const mediaFallbackText = getMediaFallbackText(message, assetError);

  const openMedia = () => {
    setAssetError(null);
    void openAuthorizedAsset(mediaPath, token, message.media?.fileName).catch((error) => {
      setAssetError(
        error instanceof Error ? error.message : 'No fue posible abrir la media protegida.',
      );
    });
  };

  if (message.type === 'image') {
    if (thumbnailAsset.url || inlineThumbnail) {
      return (
        <div className="media-stack">
          <button className="media-card image" onClick={openMedia} type="button">
            <img
              src={thumbnailAsset.url ?? inlineThumbnail ?? undefined}
              alt={message.caption ?? message.body ?? 'Imagen'}
              loading="lazy"
            />
          </button>
          {message.caption ? <p>{message.caption}</p> : null}
          {assetError ? <p className="document-meta">{assetError}</p> : null}
        </div>
      );
    }

    return (
      <MediaFallback
        loading={thumbnailAsset.loading}
        onOpen={openMedia}
        text={mediaFallbackText ?? 'Imagen no disponible'}
      />
    );
  }

  if (message.type === 'sticker') {
    if (thumbnailAsset.url || inlineThumbnail) {
      return (
        <div className="media-stack">
          <button className="sticker-card" onClick={openMedia} type="button">
            <img src={thumbnailAsset.url ?? inlineThumbnail ?? undefined} alt="Sticker" loading="lazy" />
          </button>
        </div>
      );
    }

    return (
      <MediaFallback
        loading={thumbnailAsset.loading}
        onOpen={openMedia}
        text={mediaFallbackText ?? 'Sticker no disponible'}
      />
    );
  }

  if (message.type === 'video') {
    if (mediaAsset.url) {
      return (
        <div className="media-stack">
          <video className="media-video" controls preload="metadata" src={mediaAsset.url} />
          <p>{message.caption ?? 'Video'}</p>
        </div>
      );
    }

    return (
      <MediaFallback
        loading={mediaAsset.loading}
        onOpen={openMedia}
        text={mediaFallbackText ?? 'Video no descargado'}
      />
    );
  }

  if (message.type === 'audio' || message.type === 'voice') {
    if (mediaAsset.url) {
      return (
        <div className="media-stack">
          <audio controls preload="metadata" src={mediaAsset.url} />
          <p>{message.type === 'voice' ? 'Nota de voz' : message.caption ?? 'Audio'}</p>
        </div>
      );
    }

    return (
      <MediaFallback
        loading={mediaAsset.loading}
        onOpen={openMedia}
        text={
          mediaFallbackText ??
          (message.type === 'voice' ? 'Nota de voz no descargada' : 'Audio no descargado')
        }
      />
    );
  }

  if (message.type === 'document') {
    return (
      <button className="document-card" onClick={openMedia} type="button">
        <span className="document-title">{message.media?.fileName ?? 'Documento'}</span>
        <span className="document-meta">
          {message.media?.mime ?? 'archivo'}{' '}
          {message.media?.size ? `· ${formatBytes(message.media.size)}` : ''}
        </span>
        {assetError ? <span className="document-meta">{assetError}</span> : null}
      </button>
    );
  }

  if (message.type === 'unknown' && message.media) {
    return (
      <button className="document-card ghost" onClick={openMedia} type="button">
        <span className="document-title">Media no descargada</span>
        <span className="document-meta">{mediaFallbackText ?? 'Abrir en WhatsApp / abrir archivo'}</span>
        {assetError ? <span className="document-meta">{assetError}</span> : null}
      </button>
    );
  }

  if (mediaAsset.error || thumbnailAsset.error) {
    return (
      <MediaFallback
        loading={false}
        onOpen={openMedia}
        text={mediaFallbackText ?? 'Media protegida no disponible'}
      />
    );
  }

  return <p>{message.body || message.caption || previewTextForMessage(message)}</p>;
}

function MediaFallback({
  loading,
  onOpen,
  text,
}: {
  loading: boolean;
  onOpen: () => void;
  text: string;
}) {
  return (
    <button className="document-card ghost" onClick={onOpen} type="button">
      <span className="document-title">{loading ? 'Cargando media...' : text}</span>
      <span className="document-meta">Abrir archivo protegido</span>
    </button>
  );
}

function AckIcon({ ack }: { ack: string }) {
  if (ack === 'pending') return <Clock3 size={14} />;
  if (ack === 'server' || ack === 'device') return <Check size={14} />;
  if (ack === 'read' || ack === 'played') return <Check size={14} className="ack-read" />;
  if (ack === 'error') return <AlertCircle size={14} className="ack-error" />;
  return <Circle size={12} />;
}

const chatFilters: Array<{
  value: ChatFilter;
  label: string;
  icon: typeof Inbox;
}> = [
  { value: 'all', label: 'Todos', icon: Inbox },
  { value: 'direct', label: 'Chats', icon: UserRound },
  { value: 'group', label: 'Grupos', icon: UsersRound },
  { value: 'newsletter', label: 'Canales', icon: Megaphone },
  { value: 'unread', label: 'No leidos', icon: Radio },
];

const ownershipFilters: Array<{ value: OwnershipFilter; label: string }> = [
  { value: 'all', label: 'Todo el equipo' },
  { value: 'mine', label: 'Asignados a mi' },
  { value: 'unassigned', label: 'Sin asignar' },
];

function upsertConversation(current: Conversation[], conversation: Conversation) {
  if (shouldHideConversation(conversation)) {
    return current.filter((item) => item.id !== conversation.id);
  }
  const next = current.filter((item) => item.id !== conversation.id);
  return [conversation, ...next].sort(sortConversations);
}

function mergeConversation(current: Conversation, incoming: Conversation) {
  return {
    ...current,
    ...incoming,
    messages: current.messages?.length ? current.messages : incoming.messages,
    messagesPageInfo: current.messagesPageInfo ?? incoming.messagesPageInfo,
  };
}

function mergeConversationPages(current: Conversation[], incoming: Conversation[]) {
  const map = new Map<string, Conversation>();
  [...current, ...incoming]
    .filter((conversation) => !shouldHideConversation(conversation))
    .forEach((conversation) => {
      const previous = map.get(conversation.id);
      map.set(conversation.id, previous ? mergeConversation(previous, conversation) : conversation);
    });
  return [...map.values()].sort(sortConversations);
}

function upsertMessage(current: Message[], message: Message) {
  const index = current.findIndex((item) => isSameMessage(item, message));
  if (index === -1) {
    return [...current, message].sort(compareMessages);
  }

  const next = [...current];
  next[index] = {
    ...next[index],
    ...message,
    outbox: message.outbox ?? next[index].outbox,
  };
  return next.sort(compareMessages);
}

function prependMessages(current: Message[], incoming: Message[]) {
  const next = [...incoming, ...current];
  const unique: Message[] = [];
  for (const message of next) {
    if (!unique.some((item) => isSameMessage(item, message))) {
      unique.push(message);
    }
  }
  return unique.sort(compareMessages);
}

function patchMessage(current: Message[], messageId: string, patch: Partial<Message>) {
  return current.map((item) => (item.id === messageId ? { ...item, ...patch } : item));
}

function patchMessageByOutbox(current: Message[], outboxId: string, patch: Partial<Message>) {
  return current.map((item) =>
    item.outbox?.id === outboxId ? { ...item, ...patch, outbox: patch.outbox ?? item.outbox } : item,
  );
}

function applyMessageToConversationList(
  current: Conversation[],
  message: Message,
  activeConversationId: string | null,
) {
  return current
    .map((conversation) => {
      if (conversation.id !== message.conversationId) {
        return conversation;
      }

      const alreadyPresent = (conversation.messages ?? []).some((item) => isSameMessage(item, message));
      const messages = upsertMessage(conversation.messages ?? [], message);
      const preview = latestPreviewMessages(messages);
      const isActive = conversation.id === activeConversationId;
      const unreadCount =
        message.direction === 'inbound' &&
        !isActive &&
        !alreadyPresent &&
        message.type !== 'reaction'
          ? conversation.unreadCount + 1
          : isActive
            ? 0
            : conversation.unreadCount;

      return {
        ...conversation,
        lastMessageAt: message.providerTimestamp ?? message.createdAt,
        unreadCount,
        messages: preview,
      };
    })
    .sort(sortConversations);
}

function patchConversationPreviewMessage(
  current: Conversation[],
  conversationId: string,
  messageId: string,
  patch: Partial<Message>,
) {
  return current.map((conversation) => {
    if (conversation.id !== conversationId || !conversation.messages?.length) {
      return conversation;
    }

    return {
      ...conversation,
      messages: patchMessage(conversation.messages, messageId, patch),
    };
  });
}

function upsertNote(current: Note[], note: Note) {
  return current.some((item) => item.id === note.id) ? current : [note, ...current];
}

function isSameMessage(left: Message, right: Message) {
  return Boolean(
    left.id === right.id ||
      (left.clientMessageId && right.clientMessageId && left.clientMessageId === right.clientMessageId) ||
      (left.externalMessageId &&
        right.externalMessageId &&
        left.externalMessageId === right.externalMessageId),
  );
}

function compareMessages(left: Message, right: Message) {
  const leftTime = new Date(left.providerTimestamp ?? left.createdAt).getTime();
  const rightTime = new Date(right.providerTimestamp ?? right.createdAt).getTime();
  if (leftTime !== rightTime) return leftTime - rightTime;

  const leftSequence = left.sequence ?? 0;
  const rightSequence = right.sequence ?? 0;
  if (leftSequence !== rightSequence) return leftSequence - rightSequence;

  return left.id.localeCompare(right.id);
}

function sortConversations(left: Conversation, right: Conversation) {
  const leftPinned = left.isPinned ? 1 : 0;
  const rightPinned = right.isPinned ? 1 : 0;
  if (leftPinned !== rightPinned) return rightPinned - leftPinned;

  const leftTime = left.lastMessageAt ? new Date(left.lastMessageAt).getTime() : 0;
  const rightTime = right.lastMessageAt ? new Date(right.lastMessageAt).getTime() : 0;
  return rightTime - leftTime;
}

function formatMessageMeta(message: Message) {
  const timestamp = formatTime(message.providerTimestamp ?? message.createdAt);
  if (message.direction === 'outbound' && message.createdBy?.name) {
    return `${message.createdBy.name} · ${timestamp}`;
  }
  return timestamp;
}

function isVisibleForFilter(conversation: Conversation, filter: ChatFilter) {
  if (shouldHideConversation(conversation)) {
    return false;
  }

  const type = getEffectiveConversationType(conversation);
  if (filter === 'all') return true;
  if (filter === 'unread') return conversation.unreadCount > 0;
  return type === filter;
}

function countForFilter(conversations: Conversation[], filter: ChatFilter) {
  return conversations.filter((conversation) => isVisibleForFilter(conversation, filter)).length;
}

function getConversationTitle(conversation: Conversation) {
  const candidate =
    conversation.displayName ??
    conversation.subject ??
    conversation.pushName ??
    conversation.contact.displayName ??
    formatHumanPhone(conversation.contact.phone) ??
    null;

  if (candidate && !looksLikeTechnicalJid(candidate) && candidate !== conversation.chatJid) {
    return candidate;
  }

  return fallbackConversationTitle(
    getEffectiveConversationType(conversation),
    conversation.chatJid,
  );
}

function getConversationPreview(conversation: Conversation) {
  const message = latestPreviewMessages(conversation.messages ?? [])[0];
  const type = getEffectiveConversationType(conversation);
  if (!message) return labelForType(type);

  if (message.type === 'reaction') {
    return `Reacciono con ${message.reactionEmoji ?? 'emoji'}`;
  }

  const prefix =
    type === 'group' && message.direction === 'inbound'
      ? `${resolveMessageSenderLabel(conversation, message) ?? 'Participante'}: `
      : '';

  return `${prefix}${previewTextForMessage(message)}`;
}

function getEffectiveConversationType(conversation: Conversation): Conversation['type'] {
  if (conversation.type !== 'unknown') return conversation.type;

  const jid = conversation.chatJid.toLowerCase();
  if (jid === 'status@broadcast') return 'status';
  if (jid.endsWith('@c.us')) return 'direct';
  if (jid.endsWith('@g.us')) return 'group';
  if (jid.endsWith('@newsletter')) return 'newsletter';
  if (jid.endsWith('@broadcast')) return 'broadcast';
  if (jid.endsWith('@lid')) return 'system';
  return 'unknown';
}

function labelForType(type: Conversation['type']) {
  switch (type) {
    case 'direct':
      return 'chat';
    case 'group':
      return 'grupo';
    case 'newsletter':
      return 'canal';
    case 'broadcast':
      return 'broadcast';
    case 'status':
      return 'estado';
    case 'system':
      return 'sistema';
    default:
      return 'desconocido';
  }
}

function shouldHideConversation(conversation: Conversation) {
  const type = getEffectiveConversationType(conversation);
  return type === 'status' || type === 'broadcast' || type === 'system' || type === 'unknown';
}

function stripConversationForView(conversation: Conversation) {
  return {
    ...conversation,
    messages: (conversation.messages ?? []).sort(compareMessages),
  };
}

function latestPreviewMessages(messages: Message[]) {
  const latest = [...messages]
    .filter((message) => message.type !== 'reaction')
    .sort(compareMessages)
    .slice(-1);
  return latest.length ? latest : messages.slice(-1);
}

function labelForSync(status: SyncSessionStatus['status'], healthStatus?: SyncSessionStatus['healthStatus']) {
  if (healthStatus === 'syncing') {
    return 'sincronizando';
  }
  if (healthStatus === 'healthy') {
    return status === 'running' ? 'sincronizando' : 'sincronizado';
  }
  if (healthStatus === 'degraded') {
    return 'sync parcial';
  }
  if (healthStatus === 'stale') {
    return 'sync caducado';
  }
  if (healthStatus === 'offline') {
    return 'WAHA desconectado';
  }
  if (healthStatus === 'error') {
    return 'error de sesión';
  }

  switch (status) {
    case 'running':
      return 'sincronizando';
    case 'completed':
      return 'sincronizado';
    case 'failed':
      return 'sincronización fallida';
    case 'stale':
      return 'sincronización caducada';
    default:
      return 'en espera';
  }
}

function formatConversationSyncStatus(conversation: Conversation) {
  switch (conversation.syncStatus) {
    case 'synced':
      return 'sincronizado';
    case 'syncing':
      return 'sincronizando';
    case 'failed':
      return 'sincronización fallida';
    case 'pending':
    default:
      return 'en espera';
  }
}

function buildReactionIndex(messages: Message[]) {
  const index = new Map<string, string[]>();
  for (const message of messages) {
    if (message.type !== 'reaction' || !message.reactionTargetExternalMessageId || !message.reactionEmoji) {
      continue;
    }
    const current = index.get(message.reactionTargetExternalMessageId) ?? [];
    current.push(message.reactionEmoji);
    index.set(message.reactionTargetExternalMessageId, current);
  }
  return index;
}

function collapseReactions(reactions: string[]) {
  const counts = new Map<string, number>();
  for (const reaction of reactions) {
    counts.set(reaction, (counts.get(reaction) ?? 0) + 1);
  }
  return [...counts.entries()];
}

function previewTextForMessage(message: Message) {
  if (message.type === 'image') return message.caption ?? mediaFallbackPreviewText(message);
  if (message.type === 'video') return message.caption ?? mediaFallbackPreviewText(message);
  if (message.type === 'audio') return message.caption ?? mediaFallbackPreviewText(message);
  if (message.type === 'voice') return message.caption ?? mediaFallbackPreviewText(message, 'Nota de voz');
  if (message.type === 'document') return message.media?.fileName ?? mediaFallbackPreviewText(message, 'Documento');
  if (message.type === 'sticker') return message.caption ?? mediaFallbackPreviewText(message, 'Sticker');
  if (message.type === 'reaction') return `Reacciono con ${message.reactionEmoji ?? 'emoji'}`;
  if (message.type === 'system') return message.body ?? '[sistema]';
  if (message.type === 'unknown') return message.body ?? message.caption ?? '[media]';
  return message.body ?? message.caption ?? '[mensaje]';
}

function resolveConnectionState(
  connected: boolean,
  channelStatus?: string,
  session?: SyncSessionStatus | null,
) {
  if (!connected) {
    return { label: 'socket desconectado', tone: 'offline', icon: 'offline' as const };
  }

  if (session?.healthStatus === 'syncing' || session?.status === 'running') {
    return { label: 'sincronizando', tone: 'online', icon: 'online' as const };
  }

  if (session?.healthStatus === 'healthy') {
    return { label: 'WAHA conectado', tone: 'online', icon: 'online' as const };
  }

  if (session?.healthStatus === 'degraded') {
    return { label: 'sync parcial', tone: 'warning', icon: 'offline' as const };
  }

  if (session?.healthStatus === 'stale') {
    return { label: 'sync caducado', tone: 'warning', icon: 'offline' as const };
  }

  if (session?.healthStatus === 'error' || session?.status === 'failed' || channelStatus === 'failed') {
    return { label: 'error de sesión', tone: 'warning', icon: 'offline' as const };
  }

  if (channelStatus && channelStatus !== 'working') {
    return { label: 'reconectando WAHA', tone: 'warning', icon: 'offline' as const };
  }

  return { label: 'WAHA conectado', tone: 'online', icon: 'online' as const };
}

async function loadPendingOutbox(token?: string) {
  const pending = await apiFetch<unknown[]>('/outbox/pending', {}, token);
  return pending.length;
}

async function loadSyncStatus(token?: string) {
  return apiFetch<SyncStatusResponse>('/sync/status', {}, token);
}

function looksLikeTechnicalJid(value: string) {
  return /@(?:c\.us|g\.us|newsletter|broadcast|lid)$/i.test(value.trim());
}

function fallbackConversationTitle(type: Conversation['type'], jid?: string | null) {
  const suffix = humanizeConversationSuffix(jid);
  switch (type) {
    case 'direct':
      return suffix ? `Contacto ${suffix}` : 'Contacto';
    case 'group':
      return suffix ? `Grupo ${suffix}` : 'Grupo';
    case 'newsletter':
      return suffix ? `Canal ${suffix}` : 'Canal';
    case 'broadcast':
      return 'Difusión';
    case 'status':
      return 'Estados';
    case 'system':
      return 'Sistema';
    default:
      return 'Conversación';
  }
}

function resolveMessageSenderLabel(conversation: Conversation | null, message: Message) {
  const candidate = message.senderName ?? message.participantJid ?? message.senderJid ?? null;
  if (candidate && !looksLikeTechnicalJid(candidate)) {
    return candidate;
  }

  const participant = conversation?.participants?.find(
    (item) =>
      normalizeJidForComparison(item.participantJid) ===
      normalizeJidForComparison(message.participantJid ?? message.senderJid ?? undefined),
  );

  if (participant?.displayName && !looksLikeTechnicalJid(participant.displayName)) {
    return participant.displayName;
  }

  return humanizeConversationSuffix(message.participantJid ?? message.senderJid);
}

function mediaFallbackPreviewText(message: Message, fallbackLabel = 'Media') {
  const status = message.media?.fetchStatus;
  if (status === 'pending') return 'Multimedia pendiente de descarga';
  if (status === 'protected') return 'Archivo protegido por WhatsApp';
  if (status === 'expired') return 'No disponible en WAHA';
  if (status === 'failed') return 'Error descargando, reintentar';
  return fallbackLabel;
}

function getMediaFallbackText(message: Message, assetError?: string | null, fallbackLabel = 'Media') {
  return assetError ?? mediaFallbackPreviewText(message, fallbackLabel);
}

function buildInlineThumbnailSource(thumbnailBase64?: string | null, mime?: string | null) {
  if (!thumbnailBase64) return null;
  const raw = thumbnailBase64.trim();
  if (!raw) return null;

  if (/^data:/i.test(raw)) {
    return raw;
  }

  const normalized = raw.replace(/\s+/g, '');
  if (!normalized) return null;

  return `data:${mime ?? 'image/jpeg'};base64,${normalized}`;
}

function humanizeConversationSuffix(jid?: string | null) {
  if (!jid) return null;
  const normalized = String(jid).trim();
  const digits = normalized.replace(/[^\d]/g, '');
  if (!digits) return null;

  if (normalized.endsWith('@c.us')) {
    return formatHumanPhone(digits) ?? digits;
  }

  return digits.slice(-4);
}

function normalizeJidForComparison(jid?: string | null) {
  return String(jid ?? '').trim().toLowerCase().replace('@s.whatsapp.net', '@c.us');
}

function formatHumanPhone(phone?: string | null) {
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

function createClientMessageId() {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }

  return `tmp-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function initials(value: string) {
  return value
    .split(/\s+/)
    .map((part) => part[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();
}

function formatTime(value?: string) {
  if (!value) return '';
  return new Intl.DateTimeFormat('es', {
    hour: '2-digit',
    minute: '2-digit',
    day: '2-digit',
    month: '2-digit',
  }).format(new Date(value));
}

function formatBytes(value: number) {
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let size = value;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  return `${size.toFixed(size >= 10 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

function useAuthorizedAssetUrl(path: string, enabled: boolean, token?: string) {
  const [state, setState] = useState<{
    url: string | null;
    loading: boolean;
    error: string | null;
  }>({
    url: null,
    loading: enabled,
    error: null,
  });

  useEffect(() => {
    if (!enabled) {
      setState({ url: null, loading: false, error: null });
      return;
    }

    let revokedUrl: string | null = null;
    let cancelled = false;
    const controller = new AbortController();

    setState((current) => ({ ...current, loading: true, error: null }));

    apiFetchBlob(path, { signal: controller.signal }, token)
      .then((blob) => {
        if (cancelled) return;
        revokedUrl = URL.createObjectURL(blob);
        setState({ url: revokedUrl, loading: false, error: null });
      })
      .catch((error) => {
        if (cancelled || controller.signal.aborted) return;
        setState({
          url: null,
          loading: false,
          error: error instanceof Error ? error.message : 'No fue posible cargar la media.',
        });
      });

    return () => {
      cancelled = true;
      controller.abort();
      if (revokedUrl) {
        URL.revokeObjectURL(revokedUrl);
      }
    };
  }, [enabled, path, token]);

  return state;
}

async function openAuthorizedAsset(path: string, token?: string, fileName?: string) {
  const blob = await apiFetchBlob(path, {}, token);
  const objectUrl = URL.createObjectURL(blob);
  const nextWindow = window.open(objectUrl, '_blank', 'noopener,noreferrer');

  if (!nextWindow) {
    const link = document.createElement('a');
    link.href = objectUrl;
    link.download = fileName ?? 'media';
    link.click();
  }

  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
}
