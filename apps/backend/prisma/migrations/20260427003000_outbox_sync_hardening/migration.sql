DO $$ BEGIN
  ALTER TYPE "OutboxStatus" ADD VALUE IF NOT EXISTS 'retryable_failed';
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TYPE "OutboxStatus" ADD VALUE IF NOT EXISTS 'permanently_failed';
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TYPE "OutboxStatus" ADD VALUE IF NOT EXISTS 'reconciled';
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TYPE "SyncStatus" ADD VALUE IF NOT EXISTS 'stale';
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "messages"
  ADD CONSTRAINT "messages_conversation_id_client_message_id_key"
  UNIQUE ("conversation_id", "client_message_id");

ALTER TABLE "outbox_messages"
  ADD COLUMN IF NOT EXISTS "idempotency_key" TEXT,
  ADD COLUMN IF NOT EXISTS "locked_at" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "locked_by" TEXT,
  ADD COLUMN IF NOT EXISTS "last_attempt_at" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "next_retry_at" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "reconciled_at" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "resolved_at" TIMESTAMP(3);

ALTER TABLE "sync_runs"
  ADD COLUMN IF NOT EXISTS "heartbeat_at" TIMESTAMP(3);

UPDATE "sync_runs"
SET "heartbeat_at" = COALESCE("heartbeat_at", "started_at")
WHERE "heartbeat_at" IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "outbox_messages_idempotency_key_key"
  ON "outbox_messages"("idempotency_key");

CREATE UNIQUE INDEX IF NOT EXISTS "messages_sequence_key"
  ON "messages"("sequence");

CREATE INDEX IF NOT EXISTS "outbox_messages_status_next_retry_at_idx"
  ON "outbox_messages"("status", "next_retry_at");
