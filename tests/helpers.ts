import { newDb } from "pg-mem";
import { Kysely, PostgresDialect } from "kysely";
import type { DatabaseSchema, Database } from "../src/db";
import type { AppConfig } from "../src/config";
import { createApp } from "../src/app";
import type { S3Client } from "@aws-sdk/client-s3";
import { up as migrateRecordings } from "../src/migrations/001_create_recordings";
import { up as migrateTranscriptFields } from "../src/migrations/002_add_transcript_fields";
import { up as migrateRecordingChunks } from "../src/migrations/003_create_recording_chunks";

export async function createTestDatabase(): Promise<{ db: Database; destroy: () => Promise<void> }> {
  const mem = newDb({ autoCreateForeignKeyIndices: true });
  const adapter = mem.adapters.createPg();
  const pool = new adapter.Pool();
  const dialect = new PostgresDialect({ pool });
  const db = new Kysely<DatabaseSchema>({ dialect });

  await migrateRecordings(db);
  await migrateTranscriptFields(db);
  await migrateRecordingChunks(db);

  return {
    db,
    destroy: async () => {
      await db.destroy();
      await pool.end();
    },
  };
}

export function createTestConfig(): AppConfig {
  return {
    nodeEnv: "test",
    port: 0,
    databaseUrl: "",
    openAiApiKey: "test",
    auth: {
      profileUrl: "https://auth.example.com/oauth/profile",
      timeoutMs: 3000,
      cacheTtlMs: 5 * 60 * 1000,
    },
    s3: {
      endpoint: "https://example.com",
      region: "us-east-1",
      bucket: "ghostai-test",
      accessKeyId: "test",
      secretAccessKey: "test",
      presignExpiresSeconds: 600,
      forcePathStyle: false,
    },
    recordings: {
      maxBytes: 209715200,
    },
    embeddings: {
      enabled: false,
      model: "text-embedding-3-small",
      batchSize: 64,
      maxRetries: 3,
    },
    transcription: {
      deepgramApiKey: "",
      model: "general",
      language: "ru",
      maxConcurrency: 3,
    },
    publicAppOrigin: "http://localhost:3000",
  } as const;
}

export function createTestApp(config: AppConfig, db: Database, s3Client: S3Client) {
  return createApp({ config, db, s3Client });
}
