# WAHA CRM Inbox

CRM conversacional tipo shared inbox para WhatsApp usando WAHA como gateway, PostgreSQL como fuente de verdad, Redis/BullMQ para desacoplar flujos y Socket.IO para realtime.

## Servicios

- `waha`: gateway WhatsApp. No es fuente de verdad.
- `backend`: API NestJS, auth, webhooks, REST y Socket.IO.
- `worker`: consumidores BullMQ para inbound, outbox, resync y media.
- `postgres`: historial persistente y auditoria.
- `redis`: colas, pub/sub realtime y desacople.
- `frontend`: React/Vite, inbox operacional.

## Arranque local

1. Copia variables:

```bash
cp .env.example .env
```

2. Ajusta secretos en `.env`, especialmente `JWT_SECRET`, `WAHA_API_KEY_PLAIN` y `WAHA_WEBHOOK_HMAC_KEY`.

3. Levanta todo:

```bash
docker compose up --build
```

4. Si necesitas migraciones o seed manual, usa el perfil ops:

```bash
docker compose --profile ops run --rm migrate
docker compose --profile ops run --rm seed
```

5. Abre:

- Frontend: http://localhost:5173
- Backend health: http://localhost:3001/api/health
- WAHA dashboard/API: http://localhost:3000

Credenciales seed por defecto:

- Email: `admin@example.com`
- Password: `admin123456`

## Flujo WAHA

Compose configura WAHA con webhook global hacia:

```text
http://backend:3001/api/webhooks/waha
```

Eventos configurados:

```text
session.status,message,message.ack
```

El backend valida HMAC si `WAHA_WEBHOOK_HMAC_KEY` esta definido. WAHA debe usar el mismo valor en `WHATSAPP_HOOK_HMAC_KEY`.

## Desarrollo sin Docker

Backend:

```bash
cd apps/backend
npm install
npx prisma generate
npx prisma migrate deploy
npm run backfill:conversation-names
npm run start:dev
```

Worker:

```bash
cd apps/backend
npm run worker:dev
```

Frontend:

```bash
cd apps/frontend
npm install
npm run dev
```

## Produccion

- Usa `docker compose up -d --build` para levantar el stack.
- No ejecutes `prisma db push` en arranque normal.
- Ejecuta migraciones con `docker compose --profile ops run --rm migrate`.
- El backfill de nombres se puede correr con `npm run backfill:conversation-names -- --apply`.
- Para reconciliar outbox viejo usa `npm run outbox:reconcile:failed`.

## Documentacion

El diseno tecnico completo esta en [docs/architecture.md](docs/architecture.md).
La validacion viva de cierre esta en [docs/qa-live-validation.md](docs/qa-live-validation.md).
