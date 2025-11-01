import { newDb } from "pg-mem";
import { Kysely, PostgresDialect } from "kysely";
import type { DatabaseSchema, Database } from "../src/db";
import type { AppConfig } from "../src/config";
import { createApp } from "../src/app";
import type { S3Client } from "@aws-sdk/client-s3";
import { up as migrateRecordings } from "../src/migrations/001_create_recordings";

export async function createTestDatabase(): Promise<{ db: Database; destroy: () => Promise<void> }> {
  const mem = newDb({ autoCreateForeignKeyIndices: true });
  const adapter = mem.adapters.createPg();
  const pool = new adapter.Pool();
  const dialect = new PostgresDialect({ pool });
  const db = new Kysely<DatabaseSchema>({ dialect });

  await migrateRecordings(db);

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
    publicAppOrigin: "http://localhost:3000",
  } as const;
}

export function createTestApp(config: AppConfig, db: Database, s3Client: S3Client) {
  return createApp({ config, db, s3Client });
}
