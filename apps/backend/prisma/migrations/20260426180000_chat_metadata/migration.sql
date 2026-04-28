DO $$ BEGIN
  CREATE TYPE "ConversationType" AS ENUM ('direct', 'group', 'newsletter', 'broadcast', 'status', 'system', 'unknown');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "ChatSyncStatus" AS ENUM ('pending', 'syncing', 'synced', 'failed');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "conversations"
  ADD COLUMN IF NOT EXISTS "type" "ConversationType" NOT NULL DEFAULT 'unknown',
  ADD COLUMN IF NOT EXISTS "display_name" TEXT,
  ADD COLUMN IF NOT EXISTS "push_name" TEXT,
  ADD COLUMN IF NOT EXISTS "subject" TEXT,
  ADD COLUMN IF NOT EXISTS "avatar_url" TEXT,
  ADD COLUMN IF NOT EXISTS "is_archived" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "is_pinned" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "sync_status" "ChatSyncStatus" NOT NULL DEFAULT 'pending';

ALTER TABLE "messages"
  ADD COLUMN IF NOT EXISTS "client_message_id" TEXT,
  ADD COLUMN IF NOT EXISTS "sender_name" TEXT,
  ADD COLUMN IF NOT EXISTS "participant_jid" TEXT;

UPDATE "conversations"
SET "type" = CASE
  WHEN "chat_jid" = 'status@broadcast' THEN 'status'::"ConversationType"
  WHEN "chat_jid" LIKE '%@c.us' THEN 'direct'::"ConversationType"
  WHEN "chat_jid" LIKE '%@g.us' THEN 'group'::"ConversationType"
  WHEN "chat_jid" LIKE '%@newsletter' THEN 'newsletter'::"ConversationType"
  WHEN "chat_jid" LIKE '%@broadcast' THEN 'broadcast'::"ConversationType"
  WHEN "chat_jid" LIKE '%@lid' THEN 'system'::"ConversationType"
  ELSE "type"
END
WHERE "type" = 'unknown'::"ConversationType";

CREATE SEQUENCE IF NOT EXISTS "messages_sequence_seq";

ALTER TABLE "messages"
  ADD COLUMN IF NOT EXISTS "sequence" INTEGER;

UPDATE "messages"
SET "sequence" = nextval('"messages_sequence_seq"')
WHERE "sequence" IS NULL;

ALTER TABLE "messages"
  ALTER COLUMN "sequence" SET DEFAULT nextval('"messages_sequence_seq"'),
  ALTER COLUMN "sequence" SET NOT NULL;

CREATE TABLE IF NOT EXISTS "chat_participants" (
  "id" TEXT NOT NULL,
  "channel_id" TEXT NOT NULL,
  "conversation_id" TEXT NOT NULL,
  "chat_jid" TEXT NOT NULL,
  "participant_jid" TEXT NOT NULL,
  "display_name" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "chat_participants_pkey" PRIMARY KEY ("id")
);

DO $$ BEGIN
  ALTER TABLE "chat_participants"
    ADD CONSTRAINT "chat_participants_conversation_id_fkey"
    FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "chat_participants_channel_id_chat_jid_participant_jid_key"
  ON "chat_participants"("channel_id", "chat_jid", "participant_jid");

CREATE INDEX IF NOT EXISTS "chat_participants_conversation_id_idx"
  ON "chat_participants"("conversation_id");

CREATE INDEX IF NOT EXISTS "conversations_channel_id_type_last_message_at_idx"
  ON "conversations"("channel_id", "type", "last_message_at");

CREATE INDEX IF NOT EXISTS "conversations_chat_jid_idx"
  ON "conversations"("chat_jid");

CREATE INDEX IF NOT EXISTS "messages_client_message_id_idx"
  ON "messages"("client_message_id");

CREATE INDEX IF NOT EXISTS "messages_channel_id_sender_jid_idx"
  ON "messages"("channel_id", "sender_jid");

CREATE INDEX IF NOT EXISTS "messages_participant_jid_idx"
  ON "messages"("participant_jid");
