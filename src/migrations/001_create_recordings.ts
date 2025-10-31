import type { Kysely } from "kysely";
import { sql } from "kysely";

const STATUSES = ["uploading", "uploaded", "analyzing", "ready", "failed"] as const;

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable("recordings")
    .addColumn("id", "varchar", (col) => col.primaryKey())
    .addColumn("user_id", "varchar", (col) => col.notNull())
    .addColumn("started_at", "timestamptz")
    .addColumn("ended_at", "timestamptz")
    .addColumn("status", "varchar", (col) => col.notNull().defaultTo(STATUSES[0]))
    .addColumn("s3_bucket", "varchar", (col) => col.notNull())
    .addColumn("s3_key", "varchar", (col) => col.notNull())
    .addColumn("content_type", "varchar", (col) => col.notNull().defaultTo("audio/mp4"))
    .addColumn("size_bytes", "bigint")
    .addColumn("etag", "varchar")
    .addColumn("checksum_md5", "varchar")
    .addColumn("lang", "varchar")
    .addColumn("codec", "varchar", (col) => col.notNull().defaultTo("aac"))
    .addColumn("bitrate_kbps", "integer")
    .addColumn("created_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn("updated_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn("client_request_id", "varchar")
    .execute();

  await sql`
    ALTER TABLE recordings
    ADD CONSTRAINT recordings_status_check
    CHECK (status IN ('uploading', 'uploaded', 'analyzing', 'ready', 'failed'))
  `.execute(db);

  await sql`
    CREATE INDEX recordings_user_created_at_idx
    ON recordings (user_id, created_at DESC)
  `.execute(db);

  await db.schema
    .createIndex("recordings_status_idx")
    .on("recordings")
    .column("status")
    .execute();

  await sql`
    CREATE UNIQUE INDEX recordings_user_client_request_id_uniq
    ON recordings (user_id, client_request_id)
    WHERE client_request_id IS NOT NULL
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP INDEX IF EXISTS recordings_user_client_request_id_uniq`.execute(db);
  await db.schema.dropIndex("recordings_status_idx").ifExists().execute();
  await db.schema.dropIndex("recordings_user_created_at_idx").ifExists().execute();
  await db.schema.dropTable("recordings").ifExists().execute();
}
