import { Router } from "express";
import { z } from "zod";
import { ulid } from "ulid";
import type { S3Client } from "@aws-sdk/client-s3";
import { buildRecordingKey } from "./s3-key";
import {
  insertRecording,
  findRecordingById,
  findRecordingByClientRequestId,
  updateRecording,
  listRecordings,
} from "./repository";
import type { AppConfig } from "../../config";
import type { Database, RecordingStatus } from "../../db";
import { logger } from "../../lib/logger";
import {
  createPresignedDownloadUrl,
  createPresignedUploadUrl,
  headObject,
} from "../../lib/s3";
import {
  recordingsBytesCounter,
  recordingsCompleteCounter,
  recordingsInitCounter,
} from "../../lib/metrics";
import type { Recording } from "./types";

const INIT_SCHEMA = z.object({
  started_at: z.string().datetime().optional(),
  ended_at: z.string().datetime().optional(),
  lang: z.string().optional(),
  codec: z.string().optional().default("aac"),
  bitrate_kbps: z.number().int().min(1).max(320).optional(),
  content_type: z
    .string()
    .optional()
    .default("audio/mp4")
    .refine((value) => value === "audio/mp4", "Unsupported content type"),
  client_request_id: z.string().max(255).optional(),
});

const COMPLETE_SCHEMA = z.object({
  recording_id: z.string().min(1),
  size_bytes: z.number().int().positive().optional(),
  checksum_md5: z.string().max(255).optional(),
});

const LIST_QUERY_SCHEMA = z.object({
  limit: z
    .string()
    .transform((value) => Number.parseInt(value, 10))
    .pipe(z.number().int().min(1).max(100))
    .optional(),
  cursor: z.string().optional(),
  status: z.string().optional(),
});

const GET_QUERY_SCHEMA = z.object({
  include_url: z.union([z.literal("1"), z.literal("true"), z.literal("0"), z.literal("false")]).optional(),
});

export interface RecordingsRouterDeps {
  db: Database;
  config: AppConfig;
  s3Client: S3Client;
}

function parseMaybeDate(value?: string) {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Invalid date: ${value}`);
  }
  return parsed;
}

function encodeCursor(recording: Recording): string {
  return Buffer.from(`${recording.createdAt.toISOString()}::${recording.id}`, "utf8").toString("base64url");
}

function decodeCursor(cursor: string) {
  try {
    const decoded = Buffer.from(cursor, "base64url").toString("utf8");
    const [createdAtRaw, id] = decoded.split("::");
    if (!createdAtRaw || !id) {
      return null;
    }
    const createdAt = new Date(createdAtRaw);
    if (Number.isNaN(createdAt.getTime())) {
      return null;
    }
    return { createdAt, id };
  } catch {
    return null;
  }
}

export function createRecordingsRouter({ db, config, s3Client }: RecordingsRouterDeps) {
  const router = Router();

  router.post("/init", async (req, res) => {
    if (!req.user) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const parseResult = INIT_SCHEMA.safeParse(req.body ?? {});
    if (!parseResult.success) {
      return res.status(400).json({ error: "Invalid payload", details: parseResult.error.flatten() });
    }

    const payload = parseResult.data;
    const contentType = payload.content_type ?? "audio/mp4";
    if (contentType !== "audio/mp4") {
      return res.status(400).json({ error: "Unsupported content_type" });
    }

    try {
      const startedAt = parseMaybeDate(payload.started_at ?? undefined);
      const endedAt = parseMaybeDate(payload.ended_at ?? undefined);
      const clientRequestId = payload.client_request_id ?? null;

      let recording: Recording | null = null;

      if (clientRequestId) {
        recording = await findRecordingByClientRequestId(db, req.user.id, clientRequestId);
      }

      let isNew = false;
      if (!recording) {
        const id = `rec_${ulid()}`;
        const s3Key = buildRecordingKey({ userId: req.user.id, recordingId: id });
        recording = await insertRecording(db, {
          id,
          userId: req.user.id,
          startedAt,
          endedAt,
          status: "uploading",
          s3Bucket: config.s3.bucket,
          s3Key,
          contentType,
          lang: payload.lang ?? null,
          codec: payload.codec ?? "aac",
          bitrateKbps: payload.bitrate_kbps ?? null,
          clientRequestId,
        });
        isNew = true;
      }

      const uploadUrl = await createPresignedUploadUrl(s3Client, {
        bucket: recording.s3Bucket,
        key: recording.s3Key,
        expiresIn: config.s3.presignExpiresSeconds,
        contentType,
        metadata: {
          "recording-id": recording.id,
          "user-id": req.user.id,
        },
      });

      recordingsInitCounter.inc();
      logger.info("recording.init", {
        recording_id: recording.id,
        user_id: req.user.id,
        s3_key: recording.s3Key,
        status: recording.status,
        new_recording: isNew,
        client_request_id: clientRequestId,
      });

      return res.json({
        recording_id: recording.id,
        s3_key: recording.s3Key,
        upload: {
          method: "PUT",
          url: uploadUrl,
          headers: {
            "Content-Type": contentType,
          },
          expires_in: config.s3.presignExpiresSeconds,
          max_bytes: config.recordings.maxBytes ?? null,
        },
      });
    } catch (error: any) {
      logger.error("recording.init_failed", {
        message: error?.message,
        user_id: req.user.id,
      });
      if (error?.code === "23505") {
        return res.status(409).json({ error: "client_request_id_conflict" });
      }
      return res.status(500).json({ error: "Failed to initialize recording" });
    }
  });

  router.post("/complete", async (req, res) => {
    if (!req.user) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const parseResult = COMPLETE_SCHEMA.safeParse(req.body ?? {});
    if (!parseResult.success) {
      return res.status(400).json({ error: "Invalid payload", details: parseResult.error.flatten() });
    }

    const payload = parseResult.data;

    try {
      const recording = await findRecordingById(db, payload.recording_id, req.user.id);
      if (!recording) {
        return res.status(404).json({ error: "Recording not found" });
      }

      if (recording.status === "uploaded") {
        return res.json({
          recording_id: recording.id,
          status: recording.status,
          size_bytes: recording.sizeBytes,
          etag: recording.etag,
        });
      }

      if (recording.status !== "uploading") {
        return res.status(409).json({ error: "Recording not in uploading state" });
      }

      let head;
      try {
        head = await headObject(s3Client, recording.s3Bucket, recording.s3Key);
      } catch (err: any) {
        logger.warn("recording.head_failed", {
          recording_id: recording.id,
          user_id: req.user.id,
          error: err?.name,
          message: err?.message,
        });
        return res.status(424).json({ error: "Object not found in storage" });
      }

      const effectiveSize = payload.size_bytes ?? head.contentLength ?? 0;
      if (!effectiveSize) {
        return res.status(424).json({ error: "Storage object has no size" });
      }

      const maxBytes = config.recordings.maxBytes;
      if (maxBytes && effectiveSize > maxBytes) {
        await updateRecording(db, recording.id, req.user.id, {
          status: "failed",
          sizeBytes: effectiveSize,
          etag: head.etag ?? null,
          checksumMd5: payload.checksum_md5 ?? null,
        });
        logger.warn("recording.too_large", {
          recording_id: recording.id,
          user_id: req.user.id,
          size: effectiveSize,
          max: maxBytes,
        });
        return res.status(413).json({ error: "Recording exceeds size limit" });
      }

      const updated = await updateRecording(db, recording.id, req.user.id, {
        status: "uploaded",
        sizeBytes: effectiveSize,
        etag: head.etag ?? null,
        checksumMd5: payload.checksum_md5 ?? null,
      });

      recordingsCompleteCounter.inc();
      recordingsBytesCounter.inc(effectiveSize);
      logger.info("recording.complete", {
        recording_id: recording.id,
        user_id: req.user.id,
        s3_key: recording.s3Key,
        size: effectiveSize,
        s3_request_id: head.requestId,
      });

      return res.json({
        recording_id: updated.id,
        status: updated.status,
        size_bytes: updated.sizeBytes,
        etag: updated.etag,
      });
    } catch (error: any) {
      logger.error("recording.complete_failed", {
        recording_id: payload.recording_id,
        user_id: req.user.id,
        message: error?.message,
      });
      return res.status(500).json({ error: "Failed to complete recording" });
    }
  });

  router.get("/", async (req, res) => {
    if (!req.user) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const parseResult = LIST_QUERY_SCHEMA.safeParse(req.query ?? {});
    if (!parseResult.success) {
      return res.status(400).json({ error: "Invalid query", details: parseResult.error.flatten() });
    }

    const { limit = 20, cursor, status } = parseResult.data;
    const cursorValue = cursor ? decodeCursor(cursor) : null;
    if (cursor && !cursorValue) {
      return res.status(400).json({ error: "Invalid cursor" });
    }

    if (status && !["uploading", "uploaded", "analyzing", "ready", "failed"].includes(status)) {
      return res.status(400).json({ error: "Invalid status" });
    }

    try {
      const statusFilter = status ? (status as RecordingStatus) : undefined;
      const recordings = await listRecordings(db, {
        userId: req.user.id,
        limit,
        status: statusFilter,
        cursor: cursorValue ?? undefined,
      });

      const items = recordings.map((recording) => ({
        id: recording.id,
        started_at: recording.startedAt ? recording.startedAt.toISOString() : null,
        ended_at: recording.endedAt ? recording.endedAt.toISOString() : null,
        status: recording.status,
        size_bytes: recording.sizeBytes,
        content_type: recording.contentType,
        created_at: recording.createdAt.toISOString(),
      }));

      const last = recordings.length === limit ? recordings[recordings.length - 1] : null;
      const nextCursor = last ? encodeCursor(last) : null;

      return res.json({ items, next_cursor: nextCursor });
    } catch (error: any) {
      logger.error("recording.list_failed", {
        user_id: req.user.id,
        message: error?.message,
      });
      return res.status(500).json({ error: "Failed to list recordings" });
    }
  });

  router.get("/:id", async (req, res) => {
    if (!req.user) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const queryParse = GET_QUERY_SCHEMA.safeParse(req.query ?? {});
    if (!queryParse.success) {
      return res.status(400).json({ error: "Invalid query", details: queryParse.error.flatten() });
    }

    const includeUrl = queryParse.data.include_url === "1" || queryParse.data.include_url === "true";

    try {
      const recording = await findRecordingById(db, req.params.id, req.user.id);
      if (!recording) {
        return res.status(404).json({ error: "Recording not found" });
      }

      const response: any = {
        id: recording.id,
        status: recording.status,
        size_bytes: recording.sizeBytes,
        etag: recording.etag,
        content_type: recording.contentType,
        created_at: recording.createdAt.toISOString(),
        updated_at: recording.updatedAt.toISOString(),
      };

      if (includeUrl) {
        response.download_url = await createPresignedDownloadUrl(s3Client, {
          bucket: recording.s3Bucket,
          key: recording.s3Key,
          expiresIn: config.s3.presignExpiresSeconds,
          responseContentType: recording.contentType,
        });
      }

      return res.json(response);
    } catch (error: any) {
      logger.error("recording.get_failed", {
        recording_id: req.params.id,
        user_id: req.user.id,
        message: error?.message,
      });
      return res.status(500).json({ error: "Failed to load recording" });
    }
  });

  return router;
}
