# WAHA CRM QA Audit

## Executive summary

Auditoría QA tipo *dogfood* sobre el proyecto WAHA CRM.

### Cobertura
- Revisión de backend, frontend y runtime Docker Compose.
- Validaciones realizadas:
  - `docker compose ps`
  - `GET /api/health`
  - `GET /healthz`
  - `npm run build` y `npm run lint` en backend
  - `npm run build` y `npm run lint` en frontend
  - Login admin y consulta de `GET /api/chats`
  - Consulta de `GET /api/sync/status` con token admin

### Resultado general
- Estado runtime base: **OK**
- Salud de contenedores: **OK**
- Hallazgos QA: **7**
  - Críticos/Altos: **4**
  - Medios: **3**
- Bloqueo de QA visual: `browser_navigate` no pudo arrancar Chrome por falta de `libnspr4.so` en este entorno.

---

## Hallazgos

### 1) Bypass de acceso en WebSocket para conversaciones sin asignar

**Severidad:** Alta  
**Categoría:** Seguridad / RBAC / Realtime  
**Ubicación:** `apps/backend/src/realtime/realtime.gateway.ts:74-107`

**Descripción**  
El gateway de realtime permite `conversation.join` si la conversación no tiene `assignedTo`:

```ts
const canAccess =
  user?.role === 'admin' ||
  !conversation.assignedTo ||
  conversation.assignedTo === user?.sub;
```

Eso rompe la misma política de ownership que el HTTP path usa para usuarios normales.

**Impacto**  
Un usuario autenticado puede unirse al room de una conversación no asignada y recibir eventos/mensajes realtime aunque no deba verla.

**Estado**  
Confirmado por código.

---

### 2) Bootstrap de frontend roto para usuarios no-admin por `Promise.all()` con endpoints admin-only

**Severidad:** Alta  
**Categoría:** Funcional / UX / RBAC  
**Ubicación:** `apps/frontend/src/App.tsx:202-227`

**Descripción**  
La carga inicial hace:

```ts
Promise.all([
  apiFetch<Tag[]>('/tags', {}, session.token),
  apiFetch<Operator[]>('/users', {}, session.token),
  loadPendingOutbox(session.token),
  loadSyncStatus(session.token),
])
```

Pero el backend protege `users`, `outbox/pending` y `sync/status` como admin-only:
- `apps/backend/src/users/users.controller.ts:12-15`
- `apps/backend/src/outbox/outbox.controller.ts:12-21`
- `apps/backend/src/sync/sync.controller.ts:18-29`

Si el usuario no es admin, el primer 403 rompe el `Promise.all` y evita que se apliquen incluso los datos que sí podían cargarse.

**Impacto**  
Para usuarios no-admin, el dashboard queda degradado desde el arranque: tags/operadores/estado meta no terminan de hidratarse correctamente.

**Estado**  
Confirmado por código.

---

### 3) UI expone controles admin-only a todos los usuarios y no maneja bien los 403

**Severidad:** Media  
**Categoría:** UX / RBAC  
**Ubicación:** `apps/frontend/src/App.tsx:1038-1055`, `1141-1168`, `677-749`

**Descripción**  
La UI muestra a todos los usuarios:
- botón de reintento de outbox
- botón de sync manual
- selector de operador
- acciones de estado / tags / notas sin guardas de rol en el cliente

Los handlers `updateStatus`, `assignOperator`, `addNote` y `toggleTag` no tienen `try/catch`, así que un 403 o validación fallida puede terminar en mala experiencia o rechazo no manejado.

**Impacto**  
Los usuarios ven acciones que no pueden usar o que fallan sin feedback consistente.

**Estado**  
Confirmado por código.

---

### 4) Reasignación de conversación demasiado permisiva para usuarios con acceso

**Severidad:** Alta  
**Categoría:** Seguridad / Privilegios  
**Ubicación:** `apps/backend/src/conversations/conversations.controller.ts:64-72`  
**Servicio:** `apps/backend/src/conversations/conversation.service.ts:297-325`

**Descripción**  
El `PATCH /conversations/:id` solo verifica acceso a la conversación, pero no restringe el cambio de `assignedTo` a admins. El servicio aplica directamente:

```ts
assignedTo: body.assignedTo,
```

**Impacto**  
Un usuario con acceso a una conversación puede reasignarla o desasignarla, lo que rompe la política de ownership esperada.

**Estado**  
Confirmado por código.

---

### 5) Media serving acepta rutas locales arbitrarias no limitadas al storage root

**Severidad:** Alta  
**Categoría:** Seguridad / IDOR / File exposure  
**Ubicación:** `apps/backend/src/media/media.service.ts:80-123`, `193-195`  
**Ingesta relacionada:** `apps/backend/src/messages/message-ingestion.service.ts:516-545`

**Descripción**  
`isLocalFile()` trata cualquier valor que no empiece por `http(s)` como archivo local. Si existe, `resolveMessageMedia()` devuelve `sendFile()` para esa ruta sin comprobar que viva dentro de `MEDIA_STORAGE_PATH`.

**Impacto**  
Un valor malicioso o corrupto persistido en la DB podría acabar exponiendo archivos locales del sistema de archivos del contenedor.

**Estado**  
Confirmado por código.

---

### 6) Verificación HMAC de webhooks se desactiva silenciosamente si falta la clave

**Severidad:** Media  
**Categoría:** Seguridad / Configuración  
**Ubicación:** `apps/backend/src/webhooks/waha-webhook.controller.ts:77-98`

**Descripción**  
`verifyHmac()` hace `return` si no existe `WAHA_WEBHOOK_HMAC_KEY`:

```ts
const secret = this.config.get<string>('WAHA_WEBHOOK_HMAC_KEY');
if (!secret) return;
```

**Impacto**  
En un despliegue mal configurado, los webhooks pueden entrar sin autenticación efectiva.

**Estado**  
Confirmado por código.

---

### 7) Sync operativo falla por sesión WAHA detenida

**Severidad:** Alta  
**Categoría:** Funcional / Operativa  
**Evidencia runtime:** `docker compose logs waha`, `GET /api/sync/status`

**Descripción**  
La sesión `default` de WAHA aparece como `STOPPED` en logs, y el job de sync más reciente falló con `422`:

- `Request failed with status code 422`
- respuesta WAHA: `Session status is not as expected... status: STOPPED, expected: WORKING`

Consulta autenticada de `GET /api/sync/status` devuelve:
- `sessions[].status = failed`
- `latestRun.error = "Request failed with status code 422"`

**Impacto**  
La sincronización manual y/o automática con WAHA no está operando correctamente en este momento.

**Estado**  
Verificado en runtime.

---

## Resumen de pruebas ejecutadas

### OK
- `docker compose ps`
- `GET http://localhost:3001/api/health`
- `GET http://localhost:5173/healthz`
- `npm run build` backend
- `npm run lint` backend
- Login admin vía `/api/auth/login`
- `GET /api/chats?limit=1`

### Bloqueos / problemas de entorno
- Frontend host build/lint:
  - `sh: line 1: tsc: command not found`
- QA visual con browser:
  - Chrome no arranca en este entorno por falta de `libnspr4.so`

---

## Conclusión

El stack está levantado y la salud básica responde, pero todavía hay **fallos reales de producto** en ownership, realtime, RBAC de frontend y sincronización WAHA. La prioridad debe ser:

1. cerrar el bypass de realtime para conversaciones sin asignar,
2. limitar la reasignación de conversaciones a admin,
3. separar la carga inicial del frontend para que no dependa de endpoints admin-only,
4. corregir el estado de la sesión WAHA para restaurar sync,
5. endurecer el serving de media y la verificación HMAC.
