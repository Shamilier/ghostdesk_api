import OpenAI from "openai";
import { sql } from "kysely";
import type { AppConfig } from "../../config";
import type { Database } from "../../db";
import { logger } from "../../lib/logger";
import { splitTranscript, TranscriptChunk } from "./chunker";

interface EmbeddingQueueDeps {
  config: AppConfig;
  db: Database;
  openAiApiKey: string;
}

interface QueueItem {
  recordingId: string;
  attempts: number;
}

type EmbeddingStorage = "vector" | "json";

function sanitizeEmbedding(values: number[]): number[] {
  return values.map((value) => (Number.isFinite(value) ? Number(value) : 0));
}

function toVectorLiteral(values: number[]): string {
  const sanitized = sanitizeEmbedding(values);
  const body = sanitized.map((value) => value.toString()).join(",");
  return `'[${body}]'`;
}

function formatSeconds(seconds: number): number {
  return Math.max(0, Number.isFinite(seconds) ? Number(seconds) : 0);
}

function withPrefix(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return trimmed;
  return `passage: ${trimmed}`;
}

const DEFAULT_MIN_TOKENS = 400;
const DEFAULT_MAX_TOKENS = 600;
const DEFAULT_MAX_DURATION_SEC = 60;
const DEFAULT_OVERLAP_RATIO = 0.18;
const MAX_TASK_RETRIES = 5;

export class EmbeddingIngestQueue {
  private readonly enabled: boolean;
  private readonly db: Database;
  private readonly client: OpenAI | null;
  private readonly batchSize: number;
  private readonly maxRetries: number;
  private readonly model: string;
  private readonly queue: QueueItem[] = [];
  private processing = 0;
  private readonly maxConcurrency = 1;
  private storageMode: EmbeddingStorage | null = null;
  private storageModePromise: Promise<EmbeddingStorage> | null = null;
  private tableCheckPromise: Promise<boolean> | null = null;
  private tableExists: boolean | null = null;
  private tsvAsText: boolean | null = null;
  private tsvDetectionPromise: Promise<boolean> | null = null;

  constructor({ config, db, openAiApiKey }: EmbeddingQueueDeps) {
    this.db = db;
    this.enabled = Boolean(config.embeddings.enabled) && Boolean(openAiApiKey);
    this.client = this.enabled ? new OpenAI({ apiKey: openAiApiKey }) : null;
    this.batchSize = Math.max(1, config.embeddings.batchSize);
    this.maxRetries = Math.max(1, config.embeddings.maxRetries);
    this.model = config.embeddings.model || "text-embedding-3-small";

    if (!this.enabled) {
      logger.info("[embeddings] disabled", {
        reason: openAiApiKey ? "feature_flag" : "missing_api_key",
      });
    }
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  enqueue(recordingId: string) {
    if (!this.enabled) {
      logger.warn("[embeddings] enqueue_skipped_disabled", { recording_id: recordingId });
      return;
    }
    this.queue.push({ recordingId, attempts: 0 });
    this.process();
  }

  private process() {
    if (!this.enabled) return;

    while (this.processing < this.maxConcurrency) {
      const next = this.queue.shift();
      if (!next) break;
      this.processing += 1;
      this.runTask(next)
        .catch((error) => {
          logger.error("[embeddings] task_failed", {
            recording_id: next.recordingId,
            attempts: next.attempts,
            error: error instanceof Error ? error.message : String(error),
          });
          if (next.attempts + 1 < MAX_TASK_RETRIES) {
            setTimeout(() => {
              this.queue.push({ recordingId: next.recordingId, attempts: next.attempts + 1 });
              this.process();
            }, Math.pow(2, next.attempts) * 500);
          }
        })
        .finally(() => {
          this.processing -= 1;
          this.process();
        });
    }
  }

  private async resolveStorageMode(): Promise<EmbeddingStorage> {
    if (this.storageMode) {
      return this.storageMode;
    }
    if (!this.storageModePromise) {
      this.storageModePromise = (async () => {
        try {
          const result = await sql<{ data_type: string }>`
            SELECT data_type
            FROM information_schema.columns
            WHERE table_name = 'recording_chunks'
              AND column_name = 'embedding'
            LIMIT 1
          `.execute(this.db);
          const type = result.rows?.[0]?.data_type ?? "vector";
          if (typeof type === "string" && type.toLowerCase().includes("json")) {
            return "json";
          }
          return "vector";
        } catch (error) {
          logger.warn("[embeddings] detect_storage_mode_failed", {
            error: error instanceof Error ? error.message : String(error),
          });
          return "vector";
        }
      })();
    }
    this.storageMode = await this.storageModePromise;
    return this.storageMode;
  }

  private async isTsvStoredAsText(): Promise<boolean> {
    if (this.tsvAsText != null) {
      return this.tsvAsText;
    }
    if (!this.tsvDetectionPromise) {
      this.tsvDetectionPromise = (async () => {
        try {
          const result = await sql<{ data_type: string }>`
            SELECT data_type
            FROM information_schema.columns
            WHERE table_name = 'recording_chunks'
              AND column_name = 'tsv'
            LIMIT 1
          `.execute(this.db);
          const type = result.rows?.[0]?.data_type ?? "tsvector";
          const isText = typeof type === "string" && type.toLowerCase().includes("text");
          this.tsvAsText = isText;
          return isText;
        } catch (error) {
          logger.warn("[embeddings] detect_tsv_mode_failed", {
            error: error instanceof Error ? error.message : String(error),
          });
          this.tsvAsText = false;
          return false;
        }
      })();
    }
    const isText = await this.tsvDetectionPromise;
    this.tsvAsText = isText;
    return isText;
  }

  private async runTask(task: QueueItem) {
    if (!this.client) {
      throw new Error("Embedding client is not configured");
    }

    if (!(await this.ensureTableExists())) {
      logger.error("[embeddings] table_missing", { recording_id: task.recordingId });
      return;
    }

    const startedAt = Date.now();
    const recording = await this.db
      .selectFrom("recordings")
      .select(["id", "transcript_json", "transcript_status"])
      .where("id", "=", task.recordingId)
      .executeTakeFirst();

    if (!recording) {
      logger.warn("[embeddings] recording_missing", { recording_id: task.recordingId });
      return;
    }

    if (!recording.transcript_json) {
      logger.warn("[embeddings] transcript_missing", { recording_id: task.recordingId });
      return;
    }

    const chunks = splitTranscript(recording.transcript_json, {
      minTokens: DEFAULT_MIN_TOKENS,
      maxTokens: DEFAULT_MAX_TOKENS,
      maxDurationSec: DEFAULT_MAX_DURATION_SEC,
      overlapRatio: DEFAULT_OVERLAP_RATIO,
    });

    if (!chunks.length) {
      await this.clearRecordingChunks(task.recordingId);
      logger.warn("[embeddings] no_chunks", { recording_id: task.recordingId });
      return;
    }

    const inputs = chunks.map((chunk) => withPrefix(chunk.text));
    const embeddings: number[][] = [];

    for (let i = 0; i < inputs.length; i += this.batchSize) {
      const batch = inputs.slice(i, i + this.batchSize);
      const response = await this.fetchEmbeddings(batch);
      embeddings.push(...response);
    }

    if (embeddings.length !== chunks.length) {
      throw new Error(`Mismatch between chunks (${chunks.length}) and embeddings (${embeddings.length})`);
    }

    await this.persistChunks(task.recordingId, chunks, embeddings);

    logger.info("[embeddings] completed", {
      recording_id: task.recordingId,
      chunks: chunks.length,
      elapsed_ms: Date.now() - startedAt,
    });
  }

  private async ensureTableExists(): Promise<boolean> {
    if (this.tableExists != null) {
      return this.tableExists;
    }
    if (!this.tableCheckPromise) {
      this.tableCheckPromise = (async () => {
        try {
          const result = await sql<{ exists: boolean }>`
            SELECT to_regclass('public.recording_chunks') IS NOT NULL AS exists
          `.execute(this.db);
          const exists = Boolean(result.rows?.[0]?.exists);
          this.tableExists = exists;
          return exists;
        } catch (error) {
          logger.error("[embeddings] table_check_failed", {
            error: error instanceof Error ? error.message : String(error),
          });
          this.tableExists = false;
          return false;
        }
      })();
    }
    const exists = await this.tableCheckPromise;
    this.tableExists = exists;
    return exists;
  }

  private async clearRecordingChunks(recordingId: string) {
    await sql`DELETE FROM recording_chunks WHERE recording_id = ${recordingId}`.execute(this.db);
  }

  private async persistChunks(
    recordingId: string,
    chunks: TranscriptChunk[],
    embeddings: number[][]
  ) {
    const storageMode = await this.resolveStorageMode();
    const tsvAsText = await this.isTsvStoredAsText();
    await this.db.transaction().execute(async (trx) => {
      await sql`DELETE FROM recording_chunks WHERE recording_id = ${recordingId}`.execute(trx);
      if (!chunks.length) {
        return;
      }

      const values = chunks.map((chunk, index) => {
        const embedding = embeddings[index] ?? [];
        if (storageMode === "json") {
          return sql`(${recordingId}, ${chunk.index}, ${formatSeconds(
            chunk.startSec
          )}, ${formatSeconds(chunk.endSec)}, ${chunk.text}, ${JSON.stringify(
            embedding
          )}::jsonb, ${tsvAsText
            ? sql`to_tsvector('russian', ${chunk.text})::text`
            : sql`to_tsvector('russian', ${chunk.text})`})`;
        }
        const literal = toVectorLiteral(embedding);
        return sql`(${recordingId}, ${chunk.index}, ${formatSeconds(
          chunk.startSec
        )}, ${formatSeconds(chunk.endSec)}, ${chunk.text}, ${sql.raw(`${literal}::vector(1536)`)}, ${
          tsvAsText
            ? sql`to_tsvector('russian', ${chunk.text})::text`
            : sql`to_tsvector('russian', ${chunk.text})`
        })`;
      });

      const insertQuery = sql`
        INSERT INTO recording_chunks (recording_id, chunk_index, start_sec, end_sec, text, embedding, tsv)
        VALUES ${sql.join(values, sql`, `)}
      `;
      await insertQuery.execute(trx);
    });
  }

  private async fetchEmbeddings(batch: string[]): Promise<number[][]> {
    for (let attempt = 0; attempt < this.maxRetries; attempt += 1) {
      try {
        const response = await this.client!.embeddings.create({
          model: this.model,
          input: batch,
        });
        return response.data.map((item) => sanitizeEmbedding(item.embedding as number[]));
      } catch (error: any) {
        const status = error?.status ?? error?.response?.status;
        const requestId = error?.response?.headers?.get?.("x-request-id") ?? null;
        logger.warn("[embeddings] batch_failed", {
          attempt,
          status,
          request_id: requestId,
          message: error?.message ?? String(error),
        });
        if (attempt + 1 >= this.maxRetries) {
          throw error;
        }
        const delayMs = Math.min(5000, Math.pow(2, attempt) * 500);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
    return [];
  }
}
