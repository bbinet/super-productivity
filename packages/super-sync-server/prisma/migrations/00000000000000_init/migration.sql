-- Baseline initial schema.
--
-- The repository previously shipped no migration that creates the base
-- tables, so the earliest migration (20251212000000_add_is_payload_encrypted)
-- failed with "relation \"operations\" does not exist" on a fresh database.
-- This file recreates the schema as it existed immediately before that
-- migration. The subsequent 14 migrations then apply additively.
--
-- The DDL is idempotent (CREATE ... IF NOT EXISTS, DO/EXCEPTION on foreign
-- keys) so it can also be applied to databases that were deployed before
-- this baseline existed. Prisma will record it in _prisma_migrations and
-- nothing in the live schema changes.

CREATE TABLE IF NOT EXISTS "users" (
    "id" SERIAL NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "is_verified" INTEGER NOT NULL DEFAULT 0,
    "verification_token" TEXT,
    "verification_token_expires_at" BIGINT,
    "verification_resend_count" INTEGER NOT NULL DEFAULT 0,
    "login_token" TEXT,
    "login_token_expires_at" BIGINT,
    "failed_login_attempts" INTEGER NOT NULL DEFAULT 0,
    "locked_until" BIGINT,
    "token_version" INTEGER NOT NULL DEFAULT 0,
    "terms_accepted_at" BIGINT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "users_email_key" ON "users"("email");
CREATE INDEX IF NOT EXISTS "users_verification_token_idx" ON "users"("verification_token");
CREATE INDEX IF NOT EXISTS "users_login_token_idx" ON "users"("login_token");

CREATE TABLE IF NOT EXISTS "operations" (
    "id" TEXT NOT NULL,
    "user_id" INTEGER NOT NULL,
    "client_id" TEXT NOT NULL,
    "server_seq" INTEGER NOT NULL,
    "action_type" TEXT NOT NULL,
    "op_type" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT,
    "payload" JSONB NOT NULL,
    "vector_clock" JSONB NOT NULL,
    "schema_version" INTEGER NOT NULL,
    "client_timestamp" BIGINT NOT NULL,
    "received_at" BIGINT NOT NULL,

    CONSTRAINT "operations_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "operations_user_id_server_seq_key" ON "operations"("user_id", "server_seq");
-- Two legacy indexes that existed pre-20251212 are intentionally NOT created
-- here: operations_user_id_entity_type_entity_id_idx and
-- operations_user_id_server_seq_idx. Migration 20260512000000 drops both with
-- `IF EXISTS`, so omitting them keeps the fresh-DB end state identical to
-- schema.prisma without leaving stale indexes on databases that were
-- deployed before this baseline was authored (where 20260512000000 already
-- removed them).
CREATE INDEX IF NOT EXISTS "operations_user_id_client_id_idx" ON "operations"("user_id", "client_id");
CREATE INDEX IF NOT EXISTS "operations_user_id_received_at_idx" ON "operations"("user_id", "received_at");

CREATE TABLE IF NOT EXISTS "user_sync_state" (
    "user_id" INTEGER NOT NULL,
    "last_seq" INTEGER NOT NULL DEFAULT 0,
    "last_snapshot_seq" INTEGER,
    "snapshot_data" BYTEA,
    "snapshot_at" BIGINT,
    "snapshot_schema_version" INTEGER DEFAULT 1,

    CONSTRAINT "user_sync_state_pkey" PRIMARY KEY ("user_id")
);

CREATE TABLE IF NOT EXISTS "sync_devices" (
    "client_id" TEXT NOT NULL,
    "user_id" INTEGER NOT NULL,
    "device_name" TEXT,
    "user_agent" TEXT,
    "last_seen_at" BIGINT NOT NULL,
    "last_acked_seq" INTEGER NOT NULL DEFAULT 0,
    "created_at" BIGINT NOT NULL,

    CONSTRAINT "sync_devices_pkey" PRIMARY KEY ("user_id", "client_id")
);

-- Foreign keys. Postgres has no ADD CONSTRAINT IF NOT EXISTS, so swallow the
-- duplicate_object error so the migration is idempotent on legacy databases.
DO $$ BEGIN
    ALTER TABLE "operations" ADD CONSTRAINT "operations_user_id_fkey"
        FOREIGN KEY ("user_id") REFERENCES "users"("id")
        ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    ALTER TABLE "user_sync_state" ADD CONSTRAINT "user_sync_state_user_id_fkey"
        FOREIGN KEY ("user_id") REFERENCES "users"("id")
        ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    ALTER TABLE "sync_devices" ADD CONSTRAINT "sync_devices_user_id_fkey"
        FOREIGN KEY ("user_id") REFERENCES "users"("id")
        ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
