import { Pool } from "pg";
import { Kysely, PostgresDialect, Generated } from "kysely";
import type { AppConfig } from "./config";

export type RecordingStatus =
  | "uploading"
  | "uploaded"
  | "analyzing"
  | "ready"
  | "failed";

export interface RecordingsTable {
  id: string;
  user_id: string;
  started_at: Date | null;
  ended_at: Date | null;
  status: RecordingStatus;
  s3_bucket: string;
  s3_key: string;
  content_type: string;
  size_bytes: number | null;
  etag: string | null;
  checksum_md5: string | null;
  lang: string | null;
  codec: string;
  bitrate_kbps: number | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  client_request_id: string | null;
}

export interface DatabaseSchema {
  recordings: RecordingsTable;
}

export type Database = Kysely<DatabaseSchema>;

export function createDatabase(config: AppConfig, poolOverride?: Pool): Database {
  const pool =
    poolOverride ??
    new Pool({
      connectionString: config.databaseUrl,
      max: 10,
    });

  const dialect = new PostgresDialect({ pool });
  return new Kysely<DatabaseSchema>({ dialect });
}
