ALTER TYPE "MessageType" ADD VALUE IF NOT EXISTS 'voice';
ALTER TYPE "MessageType" ADD VALUE IF NOT EXISTS 'reaction';
ALTER TYPE "MessageType" ADD VALUE IF NOT EXISTS 'unknown';

ALTER TABLE "messages"
  ADD COLUMN IF NOT EXISTS "caption" TEXT,
  ADD COLUMN IF NOT EXISTS "reaction_emoji" TEXT,
  ADD COLUMN IF NOT EXISTS "reaction_target_external_message_id" TEXT,
  ADD COLUMN IF NOT EXISTS "deleted_at" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "edited_at" TIMESTAMP(3);

ALTER TABLE "media"
  ADD COLUMN IF NOT EXISTS "thumbnail_path_or_url" TEXT;

CREATE INDEX IF NOT EXISTS "messages_reaction_target_external_message_id_idx"
  ON "messages" ("reaction_target_external_message_id");
