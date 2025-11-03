import type { Kysely } from "kysely";
import { sql } from "kysely";

const TRANSCRIPT_STATUSES = ["none", "queued", "processing", "ready", "failed"] as const;

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable("recordings")
    .addColumn("transcript_status", "varchar", (col) => col.notNull().defaultTo(TRANSCRIPT_STATUSES[0]))
    .addColumn("transcript_summary", "text")
    .addColumn("transcript_json", "text")
    .addColumn("transcript_error", "text")
    .addColumn("transcribed_at", "timestamptz")
    .execute();

  await sql`
    ALTER TABLE recordings
    ADD CONSTRAINT recordings_transcript_status_check
    CHECK (transcript_status IN ('none', 'queued', 'processing', 'ready', 'failed'))
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE recordings DROP CONSTRAINT IF EXISTS recordings_transcript_status_check`.execute(db);

  await db.schema
    .alterTable("recordings")
    .dropColumn("transcript_status")
    .dropColumn("transcript_summary")
    .dropColumn("transcript_json")
    .dropColumn("transcript_error")
    .dropColumn("transcribed_at")
    .execute();
}
