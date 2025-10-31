import type { RecordingStatus } from "../../db";

export interface Recording {
  id: string;
  userId: string;
  startedAt: Date | null;
  endedAt: Date | null;
  status: RecordingStatus;
  s3Bucket: string;
  s3Key: string;
  contentType: string;
  sizeBytes: number | null;
  etag: string | null;
  checksumMd5: string | null;
  lang: string | null;
  codec: string;
  bitrateKbps: number | null;
  createdAt: Date;
  updatedAt: Date;
  clientRequestId: string | null;
}

export interface RecordingListItem {
  id: string;
  started_at: string | null;
  ended_at: string | null;
  status: RecordingStatus;
  size_bytes: number | null;
  content_type: string;
  created_at: string;
}

export interface RecordingWithUrl extends Recording {
  downloadUrl?: string;
}
