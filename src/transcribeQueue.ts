import type { S3Client } from "@aws-sdk/client-s3";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { logger } from "./lib/logger";
import { createPresignedDownloadUrl } from "./lib/s3";
import type { AppConfig } from "./config";
import type { Database, TranscriptStatus } from "./db";
import type { Recording } from "./modules/recordings/types";

interface TranscribeQueueDeps {
  config: AppConfig;
  db: Database;
  s3Client: S3Client;
}

interface TranscriptPatch {
  transcript_status?: TranscriptStatus;
  transcript_summary?: string | null;
  transcript_json?: string | null;
  transcript_error?: string | null;
  transcribed_at?: Date | null;
}

const DEEPGRAM_REMOTE_URL = "https://api.deepgram.com/v1/listen";

function buildSummary(utterances: any[]): string | null {
  if (!Array.isArray(utterances)) return null;

  const fragments = utterances
    .map((item) => (typeof item?.transcript === "string" ? item.transcript.trim() : ""))
    .filter((value) => value.length > 0);

  if (!fragments.length) return null;

  const summary = fragments.slice(0, 3).join(" ").trim();
  return summary.length > 0 ? summary : null;
}

function countWords(utterances: any[]): number {
  if (!Array.isArray(utterances)) return 0;

  return utterances.reduce((acc: number, item: any) => {
    if (typeof item?.transcript !== "string") return acc;
    const words = item.transcript.trim().split(/\s+/).filter(Boolean);
    return acc + words.length;
  }, 0);
}

export class TranscribeQueue {
  private readonly db: Database;
  private readonly config: AppConfig;
  private readonly s3Client: S3Client;
  private readonly enabled: boolean;
  private readonly maxConcurrency: number;
  private readonly deepgramApiKey: string;
  private queue: Recording[] = [];
  private active = 0;

  constructor({ config, db, s3Client }: TranscribeQueueDeps) {
    this.db = db;
    this.config = config;
    this.s3Client = s3Client;
    this.deepgramApiKey = config.transcription.deepgramApiKey;
    this.enabled = Boolean(this.deepgramApiKey);
    this.maxConcurrency = Math.max(1, config.transcription.maxConcurrency);
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  enqueue(recording: Recording) {
    if (!this.enabled) {
      logger.info("[transcribe] skipped_missing_api_key", {
        recording: recording.id,
        user: recording.userId,
      });
      return;
    }

    this.queue.push(recording);
    this.process();
  }

  private process() {
    if (!this.enabled) return;

    while (this.active < this.maxConcurrency) {
      const next = this.queue.shift();
      if (!next) {
        break;
      }

      this.active += 1;
      this.runTask(next)
        .catch((error) => {
          logger.error("[transcribe][error]", {
            recording: next.id,
            user: next.userId,
            step: "unexpected",
            msg: error instanceof Error ? error.message : String(error),
          });
        })
        .finally(() => {
          this.active -= 1;
          this.process();
        });
    }
  }

  private async runTask(recording: Recording) {
    const startedAt = Date.now();
    await this.patchTranscript(recording, {
      transcript_status: "processing",
      transcript_error: null,
    });

    // мы все равно можем сгенерить presigned url и залогировать его — полезно для отладки
    const expires = this.config.s3.presignExpiresSeconds;
    let downloadUrl: string | null = null;
    try {
      downloadUrl = await createPresignedDownloadUrl(this.s3Client, {
        bucket: recording.s3Bucket,
        key: recording.s3Key,
        expiresIn: expires,
        responseContentType: recording.contentType,
      });
    } catch (error: any) {
      // не фейлим из-за этого — мы сейчас будем качать через s3Client
      logger.warn("[transcribe] presign-failed-debug-only", {
        recording: recording.id,
        user: recording.userId,
        error: error?.message ?? String(error),
      });
    }

    // 1) качаем объект из S3/idrivee2
    let s3Object: any;
    try {
      logger.info("[transcribe] s3-get", {
        recording: recording.id,
        user: recording.userId,
        bucket: recording.s3Bucket,
        key: recording.s3Key,
      });

      s3Object = await this.s3Client.send(
        new GetObjectCommand({
          Bucket: recording.s3Bucket,
          Key: recording.s3Key,
        })
      );
    } catch (error: any) {
      await this.fail(recording, {
        step: "s3-get",
        message: error?.message ?? "failed to get object from s3",
      });
      return;
    }

    // 2) готовим URL для Deepgram c query
    const dgUrl = new URL(DEEPGRAM_REMOTE_URL);
    dgUrl.searchParams.set("model", "general");
    dgUrl.searchParams.set("language", "ru");
    dgUrl.searchParams.set("utterances", "true");
    dgUrl.searchParams.set("smart_format", "true");

    const contentType = recording.contentType || "audio/mp4";

    logger.info("[transcribe] deepgram-request", {
  recording: recording.id,
  user: recording.userId,
  mode: "stream",
  dg_endpoint: dgUrl.toString(),
  content_type: contentType,
});

    logger.info("[transcribe] deepgram-request", {
      recording: recording.id,
      user: recording.userId,
      mode: "stream",
      dg_endpoint: dgUrl.toString(),
      content_type: contentType,
    });

    // 3) стримим в DG
    const deepgramStartedAt = Date.now();
    let response: Response;
try {
  response = await fetch(dgUrl, {
    method: "POST",
    // вот ЭТО главное:
    duplex: "half",
    headers: {
      Authorization: `Token ${this.deepgramApiKey}`,
      "Content-Type": contentType,
    },
    body: s3Object.Body as any,
  });
} catch (error: any) {
  await this.fail(recording, {
    step: "deepgram-stream",
    message: error?.message ?? "failed to reach deepgram",
  });
  return;
}

    const rawBody = await response.text();
    const deepgramDurationMs = Date.now() - deepgramStartedAt;
    const bodyLength = rawBody.length;
    const snippetLimit = 800;
    const bodySnippet =
      rawBody.length > snippetLimit ? `${rawBody.slice(0, snippetLimit)}…` : rawBody;

    if (!response.ok) {
      logger.error("[transcribe] deepgram-response", {
        recording: recording.id,
        user: recording.userId,
        status: response.status,
        duration_ms: deepgramDurationMs,
        body_len: bodyLength,
        mode: "stream",
        body: rawBody.length > 2000 ? `${rawBody.slice(0, 2000)}…` : rawBody,
      });
      await this.fail(recording, {
        step: "deepgram-stream",
        status: response.status,
        message: rawBody || `HTTP ${response.status}`,
      });
      return;
    }

    logger.info("[transcribe] deepgram-response", {
      recording: recording.id,
      user: recording.userId,
      status: response.status,
      duration_ms: deepgramDurationMs,
      body_len: bodyLength,
      mode: "stream",
      body_snippet: bodySnippet,
    });

    // 4) разбираем JSON как раньше
    let parsed: any;
    try {
      parsed = rawBody ? JSON.parse(rawBody) : null;
    } catch (error: any) {
      await this.fail(recording, {
        step: "parse",
        message: error?.message ?? "failed to parse deepgram response",
      });
      return;
    }

    const utterances = Array.isArray(parsed?.results?.utterances) ? parsed.results.utterances : [];
    const summary =
      buildSummary(utterances) ?? "Встреча: краткое описание недоступно";
    const durationSeconds =
      typeof parsed?.metadata?.duration === "number" ? parsed.metadata.duration : null;
    const durationMs = durationSeconds != null ? Math.round(durationSeconds * 1000) : null;

    const firstAlternative = parsed?.results?.channels?.[0]?.alternatives?.[0];
    const transcriptText =
      typeof firstAlternative?.transcript === "string" ? firstAlternative.transcript.trim() : "";
    const wordsList = Array.isArray(firstAlternative?.words) ? firstAlternative.words : [];

    if (!transcriptText && wordsList.length === 0) {
      logger.warn("[transcribe] empty-result", {
        recording: recording.id,
        user: recording.userId,
        duration: durationSeconds,
        note: "Deepgram вернул пустой transcript и слова — проверьте исходный файл / формат",
      });
    }

    logger.info("[transcribe] deepgram-ok", {
      recording: recording.id,
      user: recording.userId,
      duration_ms: durationMs,
      utterances: utterances.length,
    });

    await this.patchTranscript(recording, {
      transcript_status: "ready",
      transcript_summary: summary,
      transcript_json: rawBody,
      transcript_error: null,
      transcribed_at: new Date(),
    });

    const words = countWords(utterances);
    logger.info("[transcribe] done", {
      recording: recording.id,
      user: recording.userId,
      duration_ms: durationMs,
      words,
      elapsed_ms: Date.now() - startedAt,
    });
  }

  private async patchTranscript(recording: Recording, patch: TranscriptPatch) {
    const update: Record<string, unknown> = { updated_at: new Date() };

    if (Object.prototype.hasOwnProperty.call(patch, "transcript_status")) {
      update.transcript_status = patch.transcript_status;
    }
    if (Object.prototype.hasOwnProperty.call(patch, "transcript_summary")) {
      update.transcript_summary = patch.transcript_summary ?? null;
    }
    if (Object.prototype.hasOwnProperty.call(patch, "transcript_json")) {
      update.transcript_json = patch.transcript_json ?? null;
    }
    if (Object.prototype.hasOwnProperty.call(patch, "transcript_error")) {
      update.transcript_error = patch.transcript_error ?? null;
    }
    if (Object.prototype.hasOwnProperty.call(patch, "transcribed_at")) {
      update.transcribed_at = patch.transcribed_at ?? null;
    }

    await this.db
      .updateTable("recordings")
      .set(update)
      .where("id", "=", recording.id)
      .where("user_id", "=", recording.userId)
      .execute();
  }

  private async fail(
    recording: Recording,
    {
      step,
      message,
      status,
    }: {
      step: string;
      message: string;
      status?: number;
    }
  ) {
    await this.patchTranscript(recording, {
      transcript_status: "failed",
      transcript_error: message,
      transcript_json: null,
      transcript_summary: null,
      transcribed_at: new Date(),
    });

    logger.error("[transcribe][error]", {
      recording: recording.id,
      user: recording.userId,
      step,
      status,
      msg: message,
    });
  }
}
