# QA Live Validation - KORE CRM

Fecha: 2026-04-27

Referencia de arquitectura: [Chatwoot](https://github.com/chatwoot/chatwoot)

## Estado final

- WAHA `default` en estado `WORKING / CONNECTED`.
- `GET /api/health` saludable, con DB y Redis OK.
- `GET /api/sessions/default/health` en `completed / healthy`.
- `GET /api/sync/status` en `completed / healthy`.
- Inbox separado por `Chats`, `Grupos` y `Canales`.
- `status@broadcast` oculto del inbox principal.
- Resync desbloqueado y operativo.
- Socket.IO validado con replay de webhook firmado sobre el stack real.

## Evidencia realtime

- Eventos observados en Socket.IO:
  - `conversation.upserted`
  - `message.created`
- El thread activo se actualiza sin reload manual.
- La sidebar reordena por `last_activity_at`.
- `unread_count` cambia cuando la conversacion no esta activa.
- No se observo duplicacion de mensajes ni de conversaciones durante la validacion.

## IDs de QA

### Conversacion directa

- `conversationId`: `cmogncygd000rn3rmipgac5kq`
- `messageId`: `cmohui08j0003su4tf8s2uacu`
- `externalMessageId`: `qa-direct-log-1777333539574`
- `chatJid`: `50685380882@c.us`

### Conversacion de grupo

- `conversationId`: `cmohr039k06yk2xnzamda98av`
- `messageId`: `cmohui0be0009su4tmh0gqsar`
- `externalMessageId`: `qa-group-log-1777333539716`
- `chatJid`: `120363422908757727@g.us`

## Comandos ejecutados

```powershell
docker compose up -d --build backend worker
docker compose exec -T waha sh -lc 'curl -sS -H "X-Api-Key: local-waha-secret" http://localhost:3000/api/sessions/default'
```

Health checks y validacion live:

```powershell
Invoke-WebRequest http://localhost:3001/api/health
Invoke-WebRequest http://localhost:3001/api/sessions/default/health
Invoke-WebRequest http://localhost:3001/api/sync/status
Invoke-WebRequest http://localhost:3001/api/inboxes/cmogm9qem0000jcgoyu07284y/sync-status
Invoke-WebRequest http://localhost:3001/api/conversations/cmohj65zp007o8zu18vw2hilc/debug
```

Replay de webhook firmado contra el backend real:

- `POST /api/webhooks/waha`
- HMAC: `local-webhook-hmac`
- Payloads de QA:
  - `qa-direct-log-1777333539574`
  - `qa-group-log-1777333539716`

Validacion visual y Socket.IO:

- Browser real sobre `http://localhost:5173`
- Cookie de sesion `crm_session`
- WebSocket observado en `ws://localhost:3001/socket.io/?EIO=4&transport=websocket`

## Archivos cambiados

### Este cierre

- `README.md`
- `docs/qa-live-validation.md`

### Fase completa de validacion y realtime

- `apps/backend/src/queues/queue-producer.service.ts`
- `apps/backend/src/webhooks/waha-webhook.controller.ts`
- `apps/backend/src/messages/message-ingestion.service.ts`
- `apps/frontend/src/App.tsx`
- `apps/frontend/src/api.ts`
- `apps/frontend/src/socket.ts`

## Pendiente explicito

- Prueba con un segundo dispositivo WhatsApp fisico para generar un inbound real no sintetico.

## Criterio de cierre

- [x] backend compila
- [x] frontend build/lint OK
- [x] health healthy
- [x] sync completed
- [x] websocket live emite eventos
- [x] UI actualiza sin reload
- [x] no hay mezcla chat/grupo/canal
- [x] no hay `failed` generico

## Veredicto

La fase queda cerrada para el flujo actual del stack real. El unico pendiente no bloqueante es la prueba con un segundo dispositivo WhatsApp fisico.
