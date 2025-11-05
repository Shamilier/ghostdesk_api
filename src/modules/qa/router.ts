import { Router } from "express";
import { z } from "zod";
import OpenAI from "openai";
import { sql } from "kysely";
import type { Database } from "../../db";
import type { AppConfig } from "../../config";
import { logger } from "../../lib/logger";
import { findRecordingById } from "../recordings/repository";
import type { Recording } from "../recordings/types";

const ASK_SCHEMA = z.object({
  recording_id: z.string().min(1),
  question: z.string().min(1),
});

interface QaRouterDeps {
  db: Database;
  config: AppConfig;
  openAiClient: OpenAI | null;
}

interface RetrievedChunk {
  id: number;
  chunk_index: number;
  start_sec: number;
  end_sec: number;
  text: string;
  distance?: number | null;
  rank?: number | null;
}

interface RankedChunk {
  id: number;
  chunkIndex: number;
  startSec: number;
  endSec: number;
  text: string;
  score: number;
}

type EmbeddingStorage = "vector" | "json";
type TsvStorage = "tsvector" | "text";

function normalizeQuestion(question: string): string {
  return question.toLowerCase();
}

function isSummaryQuestion(question: string): boolean {
  const normalized = normalizeQuestion(question);
  return (
    normalized.includes("о чём была встреча") ||
    normalized.includes("о чем была встреча") ||
    normalized.includes("о чем была встреча") ||
    normalized.includes("о чем говорили") ||
    normalized.includes("о чём говорили") ||
    normalized.includes("краткое содержание")
  );
}

function isActionItemsQuestion(question: string): boolean {
  const normalized = normalizeQuestion(question);
  return (
    normalized.includes("задач") ||
    normalized.includes("договор") ||
    normalized.includes("action items") ||
    normalized.includes("next step") ||
    normalized.includes("что нужно сделать") ||
    normalized.includes("какие задачи")
  );
}

function sanitizeEmbedding(values: number[]): number[] {
  return values.map((value) => (Number.isFinite(value) ? Number(value) : 0));
}

function toVectorLiteral(values: number[]): string {
  const body = sanitizeEmbedding(values).map((value) => value.toString()).join(",");
  return `'[${body}]'`;
}

function secondsToTimestamp(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const hh = hours.toString().padStart(2, "0");
  const mm = minutes.toString().padStart(2, "0");
  const ss = secs.toString().padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

function formatChunkSummary(chunk: RankedChunk): string {
  const from = secondsToTimestamp(chunk.startSec);
  const to = secondsToTimestamp(chunk.endSec);
  return `Отрывок ${chunk.chunkIndex + 1} [${from}–${to}]:\n${chunk.text}`;
}

function renderActionItems(actionItems: unknown): string | null {
  if (!actionItems) return null;
  if (Array.isArray(actionItems)) {
    const parts = actionItems
      .map((item) => {
        if (item && typeof item === "object") {
          const who = typeof (item as any).who === "string" ? (item as any).who.trim() : null;
          const what = typeof (item as any).what === "string" ? (item as any).what.trim() : null;
          const when = typeof (item as any).when === "string" ? (item as any).when.trim() : null;
          const time = typeof (item as any).timecode === "number" ? secondsToTimestamp((item as any).timecode) : null;
          const fragments = [who, what, when].filter((v) => v && v.length > 0);
          if (!fragments.length) return null;
          const suffix = time ? ` (${time})` : "";
          return `• ${fragments.join(" — ")}${suffix}`;
        }
        if (typeof item === "string") {
          return `• ${item}`;
        }
        return null;
      })
      .filter((v): v is string => Boolean(v));
    if (parts.length) {
      return parts.join("\n");
    }
    return null;
  }
  if (typeof actionItems === "string") {
    return actionItems;
  }
  try {
    return JSON.stringify(actionItems, null, 2);
  } catch {
    return String(actionItems);
  }
}

async function detectEmbeddingStorage(db: Database): Promise<EmbeddingStorage> {
  try {
    const result = await sql<{ data_type: string }>`
      SELECT data_type
      FROM information_schema.columns
      WHERE table_name = 'recording_chunks'
        AND column_name = 'embedding'
      LIMIT 1
    `.execute(db);
    const type = result.rows?.[0]?.data_type ?? "vector";
    if (typeof type === "string" && type.toLowerCase().includes("json")) {
      return "json";
    }
    return "vector";
  } catch {
    return "vector";
  }
}

async function detectTsvStorage(db: Database): Promise<TsvStorage> {
  try {
    const result = await sql<{ data_type: string }>`
      SELECT data_type
      FROM information_schema.columns
      WHERE table_name = 'recording_chunks'
        AND column_name = 'tsv'
      LIMIT 1
    `.execute(db);
    const type = result.rows?.[0]?.data_type ?? "tsvector";
    if (typeof type === "string" && type.toLowerCase().includes("text")) {
      return "text";
    }
    return "tsvector";
  } catch {
    return "tsvector";
  }
}

async function vectorSearch(
  db: Database,
  recordingId: string,
  embedding: number[],
  limit: number,
  storage: EmbeddingStorage
): Promise<RetrievedChunk[]> {
  if (storage !== "vector") {
    return [];
  }
  const literal = toVectorLiteral(embedding);
  const query = await sql<RetrievedChunk>`
    SELECT id, chunk_index, start_sec, end_sec, text,
           embedding <=> ${sql.raw(`${literal}::vector(1536)`)} AS distance
    FROM recording_chunks
    WHERE recording_id = ${recordingId}
    ORDER BY embedding <=> ${sql.raw(`${literal}::vector(1536)`)}
    LIMIT ${limit}
  `.execute(db);
  return query.rows ?? [];
}

async function textSearch(
  db: Database,
  recordingId: string,
  question: string,
  limit: number,
  storage: TsvStorage
): Promise<RetrievedChunk[]> {
  if (storage !== "tsvector") {
    return [];
  }
  const query = await sql<RetrievedChunk>`
    SELECT id, chunk_index, start_sec, end_sec, text,
           ts_rank(tsv, plainto_tsquery('russian', ${question})) AS rank
    FROM recording_chunks
    WHERE recording_id = ${recordingId}
      AND tsv @@ plainto_tsquery('russian', ${question})
    ORDER BY rank DESC
    LIMIT ${limit}
  `.execute(db);
  return query.rows ?? [];
}

function mergeChunks(vector: RetrievedChunk[], text: RetrievedChunk[]): RankedChunk[] {
  const map = new Map<number, RankedChunk>();
  const vectorScores = vector.map((item) => ({ id: item.id, score: item.distance != null ? 1 / (1 + Number(item.distance)) : 0 }));
  const maxVectorScore = vectorScores.reduce((acc, item) => Math.max(acc, item.score), 0) || 1;
  const textScores = text.map((item) => ({ id: item.id, score: item.rank != null ? Number(item.rank) : 0 }));
  const maxTextScore = textScores.reduce((acc, item) => Math.max(acc, item.score), 0) || 1;

  const vectorWeight = vectorScores.length ? 0.6 : 0;
  const textWeight = textScores.length ? 0.4 : 0;
  const fallbackWeight = !vectorWeight && !textWeight ? 1 : 0;

  for (const source of vector) {
    const base = map.get(source.id) ?? {
      id: source.id,
      chunkIndex: source.chunk_index,
      startSec: Number(source.start_sec) || 0,
      endSec: Number(source.end_sec) || 0,
      text: source.text,
      score: 0,
    };
    const normalized = vectorScores.find((item) => item.id === source.id)?.score ?? 0;
    base.score += vectorWeight * (normalized / maxVectorScore);
    map.set(source.id, base);
  }

  for (const source of text) {
    const base = map.get(source.id) ?? {
      id: source.id,
      chunkIndex: source.chunk_index,
      startSec: Number(source.start_sec) || 0,
      endSec: Number(source.end_sec) || 0,
      text: source.text,
      score: 0,
    };
    const normalized = textScores.find((item) => item.id === source.id)?.score ?? 0;
    base.score += textWeight * (normalized / maxTextScore);
    map.set(source.id, base);
  }

  const results = Array.from(map.values());
  if (!vectorWeight && !textWeight) {
    for (const item of results) {
      item.score = fallbackWeight;
    }
  }

  return results.sort((a, b) => b.score - a.score);
}

async function buildAnswer(
  client: OpenAI,
  question: string,
  chunks: RankedChunk[]
): Promise<string> {
  const context = chunks.map(formatChunkSummary).join("\n\n");
  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    {
      role: "system",
      content:
        "Ты помощник по аналитике встреч. Отвечай только на основе предоставленных отрывков. Если информации недостаточно, ответь 'не найдено'. В ответе укажи ссылки на таймкоды формата 00:MM:SS–00:MM:SS для каждого факта.",
    },
    {
      role: "user",
      content: `Вопрос: ${question}\n\nКонтекст:\n${context}`,
    },
  ];

  const completion = await client.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0.2,
    max_tokens: 500,
    messages,
  });

  const content = completion.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error("LLM did not return a response");
  }
  return content.trim();
}

export function createQaRouter({ db, config, openAiClient }: QaRouterDeps) {
  const router = Router();
  let storagePromise: Promise<EmbeddingStorage> | null = null;
  let tsvStoragePromise: Promise<TsvStorage> | null = null;

  router.post("/", async (req, res) => {
    if (!req.user) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const parseResult = ASK_SCHEMA.safeParse(req.body ?? {});
    if (!parseResult.success) {
      return res.status(400).json({ error: "Invalid payload", details: parseResult.error.flatten() });
    }

    if (!openAiClient) {
      return res.status(503).json({ error: "OpenAI client is not configured" });
    }

    if (!config.embeddings.enabled) {
      return res.status(503).json({ error: "Embeddings pipeline is disabled" });
    }

    const { recording_id: recordingId, question } = parseResult.data;

    let recording: Recording | null = null;
    try {
      recording = await findRecordingById(db, recordingId, req.user.id);
    } catch (error: any) {
      logger.error("[qa] fetch_recording_failed", {
        recording_id: recordingId,
        user_id: req.user.id,
        message: error?.message ?? String(error),
      });
      return res.status(500).json({ error: "Failed to load recording" });
    }

    if (!recording) {
      return res.status(404).json({ error: "Recording not found" });
    }

    logger.info("[qa] question", {
      recording_id: recordingId,
      user_id: req.user.id,
      question,
    });

    if (isSummaryQuestion(question)) {
      return res.json({
        answer: recording.transcriptSummary ?? "Краткое содержание недоступно.",
        sources: [],
      });
    }

    if (isActionItemsQuestion(question)) {
      const formatted = renderActionItems(recording.actionItemsJson);
      return res.json({
        answer: formatted ?? "Action items недоступны для этой записи.",
        sources: [],
      });
    }

    try {
      if (!storagePromise) {
        storagePromise = detectEmbeddingStorage(db);
      }
      if (!tsvStoragePromise) {
        tsvStoragePromise = detectTsvStorage(db);
      }
      const storage = await storagePromise;
      const tsvStorage = await tsvStoragePromise;

      const embeddingResponse = await openAiClient.embeddings.create({
        model: config.embeddings.model,
        input: [`query: ${question}`],
      });
      const queryEmbedding = sanitizeEmbedding(embeddingResponse.data[0]?.embedding as number[]);

      const [vectorResults, textResults] = await Promise.all([
        vectorSearch(db, recordingId, queryEmbedding, 8, storage),
        textSearch(db, recordingId, question, 8, tsvStorage),
      ]);

      let merged = mergeChunks(vectorResults, textResults);
      if (!merged.length && vectorResults.length === 0 && textResults.length === 0) {
        const vectorFallback = await vectorSearch(db, recordingId, queryEmbedding, 16, storage);
        const textFallback = await textSearch(db, recordingId, question, 16, tsvStorage);
        merged = mergeChunks(vectorFallback, textFallback);
      }

      const topChunks = merged.slice(0, 5);
      if (!topChunks.length) {
        return res.json({ answer: "не найдено", sources: [] });
      }

      const answer = await buildAnswer(openAiClient, question, topChunks);

      return res.json({
        answer,
        sources: topChunks.map((chunk) => ({
          chunk_id: chunk.id,
          start_sec: chunk.startSec,
          end_sec: chunk.endSec,
        })),
      });
    } catch (error: any) {
      logger.error("[qa] failed", {
        recording_id: recordingId,
        user_id: req.user.id,
        message: error?.message ?? String(error),
      });
      return res.status(500).json({ error: "Failed to process question" });
    }
  });

  return router;
}
