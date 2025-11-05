import type { Kysely } from "kysely";
import { sql } from "kysely";

function isExtensionError(error: unknown): boolean {
  if (!error) return false;
  const message = (error as any)?.message ?? "";
  return typeof message === "string" && message.toLowerCase().includes("extension") && message.includes("vector");
}

function isVectorTypeError(error: unknown): boolean {
  if (!error) return false;
  const message = (error as any)?.message ?? "";
  if (typeof message !== "string") return false;
  return message.toLowerCase().includes("vector") &&
    (message.toLowerCase().includes("type") || message.toLowerCase().includes("datatype"));
}

function isTsvectorError(error: unknown): boolean {
  if (!error) return false;
  const message = (error as any)?.message ?? "";
  return typeof message === "string" && message.toLowerCase().includes("tsvector");
}

export async function up(db: Kysely<any>): Promise<void> {
  try {
    await sql`CREATE EXTENSION IF NOT EXISTS vector`.execute(db);
  } catch (error) {
    if (!isExtensionError(error)) {
      throw error;
    }
  }

  let createdWithVector = true;
  try {
    await sql`
      CREATE TABLE IF NOT EXISTS recording_chunks (
        id            BIGSERIAL PRIMARY KEY,
        recording_id  VARCHAR NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
        chunk_index   INT  NOT NULL,
        start_sec     DOUBLE PRECISION NOT NULL,
        end_sec       DOUBLE PRECISION NOT NULL,
        text          TEXT NOT NULL,
        embedding     VECTOR(1536) NOT NULL,
        tsv           TSVECTOR
      )
    `.execute(db);
  } catch (error) {
    if (isVectorTypeError(error)) {
      createdWithVector = false;
    } else {
      throw error;
    }
  }

  if (!createdWithVector) {
    try {
      await sql`
        CREATE TABLE IF NOT EXISTS recording_chunks (
          id            BIGSERIAL PRIMARY KEY,
          recording_id  VARCHAR NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
          chunk_index   INT  NOT NULL,
          start_sec     DOUBLE PRECISION NOT NULL,
          end_sec       DOUBLE PRECISION NOT NULL,
          text          TEXT NOT NULL,
          embedding     JSONB NOT NULL,
          tsv           TSVECTOR
        )
      `.execute(db);
    } catch (error) {
      if (!isTsvectorError(error)) {
        throw error;
      }
      await sql`
        CREATE TABLE IF NOT EXISTS recording_chunks (
          id            BIGSERIAL PRIMARY KEY,
          recording_id  VARCHAR NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
          chunk_index   INT  NOT NULL,
          start_sec     DOUBLE PRECISION NOT NULL,
          end_sec       DOUBLE PRECISION NOT NULL,
          text          TEXT NOT NULL,
          embedding     JSONB NOT NULL,
          tsv           TEXT
        )
      `.execute(db);
    }
  }

  try {
    await sql`
      CREATE INDEX IF NOT EXISTS idx_recording_chunks_embedding
        ON recording_chunks USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100)
    `.execute(db);
  } catch (error) {
    if (!isVectorTypeError(error)) {
      // pg-mem and other environments without vector/ivfflat will throw; ignore those cases only
      throw error;
    }
  }

  try {
    await sql`
      CREATE INDEX IF NOT EXISTS idx_recording_chunks_tsv
        ON recording_chunks USING GIN (tsv)
    `.execute(db);
  } catch (error) {
    // pg-mem might not support GIN; ignore in tests
    const message = (error as any)?.message ?? "";
    if (typeof message !== "string" || !message.toLowerCase().includes("gin")) {
      throw error;
    }
  }

  await db.schema
    .alterTable("recordings")
    .addColumn("action_items_json", "jsonb")
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable("recordings")
    .dropColumn("action_items_json")
    .execute();

  await sql`DROP INDEX IF EXISTS idx_recording_chunks_embedding`.execute(db);
  await sql`DROP INDEX IF EXISTS idx_recording_chunks_tsv`.execute(db);
  await sql`DROP TABLE IF EXISTS recording_chunks`.execute(db);
}
