import type { Database, RecordingStatus } from "../../db";
import type { Recording } from "./types";

interface CreateRecordingInput {
  id: string;
  userId: string;
  startedAt: Date | null;
  endedAt: Date | null;
  status: RecordingStatus;
  s3Bucket: string;
  s3Key: string;
  contentType: string;
  lang: string | null;
  codec: string;
  bitrateKbps: number | null;
  clientRequestId: string | null;
}

export async function insertRecording(db: Database, input: CreateRecordingInput): Promise<Recording> {
  const row = await db
    .insertInto("recordings")
    .values({
      id: input.id,
      user_id: input.userId,
      started_at: input.startedAt,
      ended_at: input.endedAt,
      status: input.status,
      s3_bucket: input.s3Bucket,
      s3_key: input.s3Key,
      content_type: input.contentType,
      lang: input.lang,
      codec: input.codec,
      bitrate_kbps: input.bitrateKbps,
      client_request_id: input.clientRequestId,
    })
    .returningAll()
    .executeTakeFirstOrThrow();

  return mapRow(row);
}

export async function findRecordingById(
  db: Database,
  id: string,
  userId: string
): Promise<Recording | null> {
  const row = await db
    .selectFrom("recordings")
    .selectAll()
    .where("id", "=", id)
    .where("user_id", "=", userId)
    .executeTakeFirst();
  return row ? mapRow(row) : null;
}

export async function findRecordingByClientRequestId(
  db: Database,
  userId: string,
  clientRequestId: string
): Promise<Recording | null> {
  const row = await db
    .selectFrom("recordings")
    .selectAll()
    .where("user_id", "=", userId)
    .where("client_request_id", "=", clientRequestId)
    .executeTakeFirst();
  return row ? mapRow(row) : null;
}

export interface UpdateRecordingInput {
  status?: RecordingStatus;
  sizeBytes?: number | null;
  etag?: string | null;
  checksumMd5?: string | null;
}

export async function updateRecording(
  db: Database,
  id: string,
  userId: string,
  input: UpdateRecordingInput
): Promise<Recording> {
  const patch: Record<string, unknown> = { updated_at: new Date() };
  if ("status" in input) {
    patch.status = input.status;
  }
  if ("sizeBytes" in input) {
    patch.size_bytes = input.sizeBytes;
  }
  if ("etag" in input) {
    patch.etag = input.etag;
  }
  if ("checksumMd5" in input) {
    patch.checksum_md5 = input.checksumMd5;
  }

  const row = await db
    .updateTable("recordings")
    .set(patch)
    .where("id", "=", id)
    .where("user_id", "=", userId)
    .returningAll()
    .executeTakeFirstOrThrow();

  return mapRow(row);
}

export interface ListRecordingsParams {
  userId: string;
  limit: number;
  status?: RecordingStatus;
  cursor?: {
    createdAt: Date;
    id: string;
  };
}

export async function listRecordings(
  db: Database,
  params: ListRecordingsParams
): Promise<Recording[]> {
  let query = db
    .selectFrom("recordings")
    .selectAll()
    .where("user_id", "=", params.userId);

  if (params.status) {
    query = query.where("status", "=", params.status);
  }

  if (params.cursor) {
    query = query.where((eb) =>
      eb.or([
        eb("created_at", "<", params.cursor!.createdAt),
        eb.and([
          eb("created_at", "=", params.cursor!.createdAt),
          eb("id", "<", params.cursor!.id),
        ]),
      ])
    );
  }

  const rows = await query
    .orderBy("created_at", "desc")
    .orderBy("id", "desc")
    .limit(params.limit)
    .execute();

  return rows.map(mapRow);
}

function mapRow(row: any): Recording {
  return {
    id: row.id,
    userId: row.user_id,
    startedAt: row.started_at ?? null,
    endedAt: row.ended_at ?? null,
    status: row.status,
    s3Bucket: row.s3_bucket,
    s3Key: row.s3_key,
    contentType: row.content_type,
    sizeBytes: row.size_bytes == null ? null : Number(row.size_bytes),
    etag: row.etag ?? null,
    checksumMd5: row.checksum_md5 ?? null,
    lang: row.lang ?? null,
    codec: row.codec,
    bitrateKbps: row.bitrate_kbps == null ? null : Number(row.bitrate_kbps),
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
    clientRequestId: row.client_request_id ?? null,
    transcriptStatus: row.transcript_status ?? "none",
    transcriptSummary: row.transcript_summary ?? null,
    transcriptJson: row.transcript_json ?? null,
    transcriptError: row.transcript_error ?? null,
    transcribedAt: row.transcribed_at ? new Date(row.transcribed_at) : null,
    actionItemsJson: row.action_items_json ?? null,
  };
}
