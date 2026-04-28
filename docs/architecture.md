# Diseno tecnico: CRM conversacional sobre WAHA

## Principios

- WAHA es gateway/conector de WhatsApp. La fuente de verdad operativa es PostgreSQL.
- Todo evento entrante pasa por una cola antes de tocar datos de dominio.
- Toda escritura de mensajes es idempotente con `channel_id + external_message_id`.
- Los mensajes se ordenan por `provider_timestamp` y se auditan con `raw_payload`.
- La UI consume REST para snapshots y Socket.IO para cambios en vivo.
- La arquitectura queda lista para multiples sesiones WAHA mediante `channels.session_name`.

## Diagrama textual de servicios

```text
WhatsApp
  -> WAHA
    -> POST /api/webhooks/waha
      -> backend NestJS
        -> BullMQ queue:waha-inbound
          -> worker inbound
            -> PostgreSQL
            -> Redis pub/sub crm-realtime-events
              -> backend Socket.IO
                -> frontend inbox

frontend
  -> POST /api/conversations/:id/messages
    -> backend OutboxService
      -> PostgreSQL message outbound pending + outbox_messages
      -> BullMQ queue:waha-outbox
        -> worker outbox
          -> WAHA POST /api/sendText
          -> PostgreSQL ack/external id
          -> Redis pub/sub
            -> Socket.IO

WAHA session.status WORKING o job programado
  -> BullMQ queue:waha-resync
    -> worker ResyncService
      -> WAHA GET /api/{session}/chats
      -> WAHA GET /api/{session}/chats/{chatId}/messages
      -> MessageIngestionService idempotente
      -> PostgreSQL + Redis pub/sub
```

## Componentes

- `backend`: controllers REST, auth JWT, webhook WAHA, gateway Socket.IO, publicacion y suscripcion realtime.
- `worker`: consumidores BullMQ. Ejecuta ingestion, outbox, media y resync fuera del request path.
- `postgres`: entidades de negocio, auditoria y deduplicacion persistente.
- `redis`: BullMQ, cache temporal, pub/sub hacia backend y locks operativos.
- `frontend`: CRM inbox, no clon de WhatsApp Web; esta orientado a operacion, asignacion, tags, notas y estado.

## Modelo de datos

Entidades solicitadas:

- `channels`: canal WhatsApp/WAHA por sesion.
- `contacts`: identidad del cliente, telefono, JID y metadata.
- `conversations`: conversacion CRM por canal y chat JID.
- `messages`: historial persistente con direccion, ack, timestamp proveedor y `raw_payload`.
- `media`: referencia inicial y estado de descarga asincrona.
- `users`: operadores internos.
- `tags` y `conversation_tags`: clasificacion.
- `conversation_events`: auditoria de acciones y cambios.

Entidades adicionales del MVP:

- `internal_notes`: notas internas consultables sin mezclar con mensajes de WhatsApp.
- `outbox_messages`: recuperacion y auditoria de envios pendientes/fallidos.
- `webhook_receipts`: idempotencia y debugging de entregas webhook.
- `sync_runs`: trazabilidad de resync.

Indices criticos:

- `messages(channel_id, external_message_id)` unico.
- `conversations(channel_id, chat_jid)` unico.
- `contacts(whatsapp_jid)` unico.
- `outbox_messages(message_id)` unico.
- indices por `conversation_id`, `provider_timestamp`, `last_message_at`, `status`, `assigned_to`.

## Flujos obligatorios

### Inbound realtime

1. WAHA emite webhook `message` o `message.any`.
2. Backend valida HMAC y registra receipt por `X-Webhook-Request-Id`.
3. Backend encola `waha-inbound` con `jobId` estable.
4. Worker normaliza:
   - `session` -> `channel`
   - `from/to/chatId` -> `chat_jid`
   - `fromMe` -> `direction`
   - `payload.id` -> `external_message_id`
5. Worker upsert de contacto, conversacion y mensaje.
6. Si `hasMedia`, crea `media` pending y encola `waha-media`.
7. Worker publica evento Redis. Backend lo emite por Socket.IO.

### Outbound

1. UI envia `POST /api/conversations/:id/messages`.
2. Backend crea mensaje outbound `pending` con id local y fila `outbox_messages`.
3. Backend encola `waha-outbox`.
4. Worker llama `POST /api/sendText` en WAHA.
5. Si WAHA responde con id proveedor, reemplaza `external_message_id`.
6. Actualiza ack/status y publica realtime.
7. Webhooks `message.ack` posteriores refinan ack a `server/device/read/played/error`.

### Resync

1. `session.status` con `WORKING` o endpoint manual `POST /api/channels/:id/resync`.
2. Worker toma `last_sync_at` y aplica ventana de lookback.
3. Consulta chats recientes paginados.
4. Consulta mensajes por chat con `filter.timestamp.gte` cuando sea posible.
5. Reusa `MessageIngestionService`; la unique constraint elimina duplicados.
6. Actualiza `last_sync_at` al cierre exitoso y registra `sync_runs`.

### Media

1. Ingestion guarda `media.url`, mime y filename si WAHA los entrega.
2. Job `waha-media` descarga con `X-Api-Key`.
3. Guarda archivo en `MEDIA_STORAGE_PATH`.
4. Calcula `sha256`, size y cambia status a `downloaded`.
5. Si falla, status `failed`, con retry BullMQ.

## Riesgos y mitigaciones

- Duplicados por reconexion: unique `channel_id + external_message_id`, jobs con `jobId` estable y ingestion idempotente.
- Mensajes fuera de orden: `provider_timestamp` y actualizacion de `last_message_at` solo si el nuevo timestamp es mayor.
- Webhook caido: reintentos WAHA configurados; resync periodico repara gaps.
- Media faltante: referencia `pending/failed`, retries y raw payload preservado.
- WAHA reconectado sin backlog: resync consulta chats/mensajes recientes con lookback.
- Outbound enviado pero DB sin ack final: `outbox_messages` conserva respuesta; `message.ack` y resync reconcilian.
- Sesion desconectada: `channels.status` refleja `session.status`; outbox queda en cola/falla reintentable.
- Auditoria: `messages.created_by_id`, `conversation_events` y `outbox_messages` trazan quien respondio.

## REST

- `POST /api/auth/login`
- `GET /api/auth/me`
- `GET /api/health`
- `GET /api/channels`
- `POST /api/channels/bootstrap-default`
- `POST /api/channels/:id/resync`
- `GET /api/users`
- `GET /api/outbox/pending`
- `POST /api/outbox/retry-pending`
- `GET /api/conversations`
- `GET /api/conversations/:id`
- `PATCH /api/conversations/:id`
- `POST /api/conversations/:id/read`
- `POST /api/conversations/:id/messages`
- `GET /api/conversations/:id/events`
- `GET /api/conversations/:id/notes`
- `POST /api/conversations/:id/notes`
- `POST /api/conversations/:id/tags`
- `DELETE /api/conversations/:id/tags/:tagId`
- `GET /api/tags`
- `POST /api/webhooks/waha`

## Socket.IO

Eventos servidor -> cliente:

- `conversation.upserted`
- `conversation.updated`
- `message.created`
- `message.updated`
- `message.ack`
- `channel.status`
- `sync.completed`
- `media.updated`
- `note.created`
- `tag.updated`

Eventos cliente -> servidor:

- `conversation.join`
- `conversation.leave`

## Jobs BullMQ

- `waha-inbound:process-event`
- `waha-outbox:send-text`
- `waha-resync:session`
- `waha-media:download`

## Autenticacion MVP

- Login local con email/password.
- Password hash con bcrypt.
- JWT Bearer para REST.
- Socket.IO recibe token en `auth.token`.
- Roles `admin` y `agent`; el MVP valida autenticacion y deja autorizacion fina como extension.

## Checklist E2E

1. Recibir mensaje: enviar WhatsApp al numero conectado y verificar conversacion/mensaje/unread.
2. Responder: enviar desde UI y verificar mensaje pending -> server -> ack por webhook.
3. Reiniciar WAHA: `docker compose restart waha`; confirmar `channel.status`.
4. Reconectar sesion: al volver `WORKING`, confirmar job `waha-resync`.
5. Resync: ejecutar `POST /api/channels/:id/resync` y verificar `sync_runs`.
6. Deduplicacion: reenviar mismo webhook o correr resync dos veces; no debe duplicar mensajes.
7. Caida backend: detener backend, enviar mensaje, levantar backend; WAHA debe reintentar y resync cubre gaps.
8. Cola pendiente: detener WAHA, enviar desde UI, verificar outbox failed/retry; levantar WAHA y reintentar.

## Produccion

- Exponer solo frontend y backend detras de Traefik/Nginx; WAHA no debe ser publico.
- Usar HTTPS, HMAC webhooks, API keys WAHA con hash `sha512:...` y secretos fuera del repo.
- Backups PITR de Postgres y persistencia de `.sessions` WAHA.
- Redis con AOF si se requiere durabilidad de colas ante caidas.
- Observabilidad: logs estructurados, metricas de BullMQ, alertas por queue depth, WAHA status y fallas de media.
- Rate limiting y controles anti-spam por canal.
- Separar worker horizontalmente por colas cuando crezca el volumen.
- Implementar RBAC fino, auditoria exportable y retencion de datos por politica.

## Fuentes WAHA usadas

- Webhooks, eventos, HMAC y `session.status`: https://waha.devlike.pro/docs/how-to/events/
- Recepcion, payload y media: https://waha.devlike.pro/docs/how-to/receive-messages/
- Chats y mensajes para resync: https://waha.devlike.pro/docs/how-to/chats/
- Envio `POST /api/sendText`: https://waha.devlike.pro/docs/how-to/send-messages/
- Docker y `.sessions`: https://waha.devlike.pro/docs/how-to/install/
- Seguridad `X-Api-Key`: https://waha.devlike.pro/docs/how-to/security/
