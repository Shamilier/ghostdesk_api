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

interface SupportEvaluation {
  maxScore: number;
  supportCount: number;
  ok: boolean;
}

type EmbeddingStorage = "vector" | "json";
type TsvStorage = "tsvector" | "text";

const SUMMARY_REGEX = /(о ч(?:е|ё)м|итог|резюме|summary|overall)/i;
const ACTION_REGEX = /(задач|договорен|следующ(?:ие|\sшаги)|todo|next steps?)/i;

function normalizeQuestion(question: string): string {
  return question.toLowerCase();
}

function isSummaryQuestion(question: string): boolean {
  return SUMMARY_REGEX.test(normalizeQuestion(question));
}

function isActionItemsQuestion(question: string): boolean {
  return ACTION_REGEX.test(normalizeQuestion(question));
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

function formatGroundedExcerpt(chunk: RankedChunk, index: number): string {
  const from = secondsToTimestamp(chunk.startSec);
  const to = secondsToTimestamp(chunk.endSec);
  return `S${index + 1}: ${chunk.text}\n(start=${from}, end=${to})`;
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
  if (!question.trim()) {
    return [];
  }

  if (storage === "tsvector") {
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

  const likePattern = `%${question.trim().replace(/\s+/g, "%")}%`;
  const query = await sql<RetrievedChunk>`
    SELECT id, chunk_index, start_sec, end_sec, text,
           CASE WHEN text ILIKE ${likePattern} THEN 1 ELSE 0 END AS rank
    FROM recording_chunks
    WHERE recording_id = ${recordingId}
      AND text ILIKE ${likePattern}
    ORDER BY chunk_index ASC
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

async function expandWithNeighbors(
  db: Database,
  recordingId: string,
  base: RankedChunk[],
  limit: number
): Promise<RankedChunk[]> {
  if (!base.length) {
    return [];
  }

  const scoreByIndex = new Map<number, number>();
  for (const chunk of base.slice(0, 3)) {
    scoreByIndex.set(chunk.chunkIndex, Math.max(scoreByIndex.get(chunk.chunkIndex) ?? 0, chunk.score));
    const neighborScore = chunk.score * 0.9;
    const prevIndex = chunk.chunkIndex - 1;
    const nextIndex = chunk.chunkIndex + 1;
    if (neighborScore > 0) {
      scoreByIndex.set(prevIndex, Math.max(scoreByIndex.get(prevIndex) ?? 0, neighborScore));
      scoreByIndex.set(nextIndex, Math.max(scoreByIndex.get(nextIndex) ?? 0, neighborScore));
    }
  }

  const resultByIndex = new Map<number, RankedChunk>();
  for (const chunk of base) {
    resultByIndex.set(chunk.chunkIndex, chunk);
  }

  const missingIndexes = Array.from(scoreByIndex.keys()).filter((index) => !resultByIndex.has(index));
  if (missingIndexes.length) {
    const placeholders = sql.join(missingIndexes.map((idx) => sql`${idx}`), sql`, `);
    const neighbors = await sql<RetrievedChunk>`
      SELECT id, chunk_index, start_sec, end_sec, text
      FROM recording_chunks
      WHERE recording_id = ${recordingId}
        AND chunk_index IN (${placeholders})
    `.execute(db);
    for (const neighbor of neighbors.rows ?? []) {
      const score = scoreByIndex.get(neighbor.chunk_index) ?? 0;
      resultByIndex.set(neighbor.chunk_index, {
        id: neighbor.id,
        chunkIndex: neighbor.chunk_index,
        startSec: Number(neighbor.start_sec) || 0,
        endSec: Number(neighbor.end_sec) || 0,
        text: neighbor.text,
        score,
      });
    }
  }

  const expanded = Array.from(resultByIndex.values());
  expanded.sort((a, b) => {
    if (b.score !== a.score) {
      return b.score - a.score;
    }
    return a.chunkIndex - b.chunkIndex;
  });

  return expanded.slice(0, Math.max(1, limit));
}

function evaluateSupport(
  chunks: RankedChunk[],
  minCombined: number,
  minSupport: number
): SupportEvaluation {
  const maxScore = chunks.reduce((max, chunk) => Math.max(max, chunk.score), 0);
  const supportCount = chunks.length;
  const ok = supportCount >= minSupport && maxScore >= minCombined;
  return { maxScore, supportCount, ok };
}

async function answerGrounded(
  client: OpenAI,
  question: string,
  chunks: RankedChunk[]
): Promise<string> {
  const context = chunks.map((chunk, idx) => formatGroundedExcerpt(chunk, idx)).join("\n\n");
  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    {
      role: "system",
      content:
        "Ты помощник, отвечай ТОЛЬКО по отрывкам (S1..Sn). Если факта нет в них — не придумывай.\nФормат:\n- Короткий ответ по делу.\n- Указывай источники в конце каждого пункта в виде [S#, 00:MM:SS–00:MM:SS].",
    },
    {
      role: "user",
      content: `Отрывки:\n${context}\n\nВопрос: "${question}"`,
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

interface SpeculativeContext {
  summary: string | null;
  near: RankedChunk[];
}

async function answerSpeculative(
  client: OpenAI,
  question: string,
  ctx: SpeculativeContext
): Promise<string> {
  const summary = ctx.summary?.trim() ?? "нет доступного резюме";
  const fragments = ctx.near.slice(0, 2);
  const fragmentsBlock = fragments.length
    ? [
        "- фрагменты:",
        ...fragments.map((chunk, idx) => {
          const from = secondsToTimestamp(chunk.startSec);
          const to = secondsToTimestamp(chunk.endSec);
          return `  S${idx + 1}: ${chunk.text} (start=${from}, end=${to})`;
        }),
      ].join("\n")
    : "- фрагменты: нет релевантных отрывков";

  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    {
      role: "system",
      content:
        "Ты помощник. В отрывках нет достаточных оснований для точного ответа. Дай осторожное предположение по общему контексту записи (если уместно), начиная фразой:\n\"Я не уверен, что это звучало в разговоре. По контексту записи могу предположить: ...\"\nНе ссылайся на источники и не выдавай выдуманные детали.",
    },
    {
      role: "user",
      content: `Контекст (краткое резюме и/или близкие по смыслу фрагменты, если есть):\n- summary: "${summary}"\n${fragmentsBlock}\nВопрос: "${question}"`,
    },
  ];

  const completion = await client.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0.3,
    max_tokens: 400,
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

    const summaryText = typeof recording.transcriptSummary === "string" ? recording.transcriptSummary.trim() : "";
    if (isSummaryQuestion(question) && summaryText) {
      return res.json({
        answer: summaryText,
        sources: [],
        speculative: false,
      });
    }

    const formattedActionItems = isActionItemsQuestion(question)
      ? renderActionItems(recording.actionItemsJson)
      : null;
    if (formattedActionItems) {
      return res.json({
        answer: formattedActionItems,
        sources: [],
        speculative: false,
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

      const countRow = await db
        .selectFrom("recording_chunks")
        .select(({ fn }) => fn.countAll().as("count"))
        .where("recording_id", "=", recordingId)
        .executeTakeFirst();
      const chunkCount = Number(countRow?.count ?? 0);

      const maxChunks = config.qa.response.maxChunks;
      const retrievalCfg = config.qa.retrieval;

      if (chunkCount > 0 && chunkCount <= 3) {
        const rawChunks = await sql<RetrievedChunk>`
          SELECT id, chunk_index, start_sec, end_sec, text
          FROM recording_chunks
          WHERE recording_id = ${recordingId}
          ORDER BY chunk_index ASC
        `.execute(db);
        const direct = (rawChunks.rows ?? []).map((row) => ({
          id: row.id,
          chunkIndex: row.chunk_index,
          startSec: Number(row.start_sec) || 0,
          endSec: Number(row.end_sec) || 0,
          text: row.text,
          score: 1,
        }));

        if (!direct.length) {
          const speculativeAnswer = await answerSpeculative(openAiClient, question, {
            summary: summaryText || null,
            near: [],
          });
          logger.info("[qa] retrieval_metrics", {
            recording_id: recordingId,
            user_id: req.user.id,
            mode: "speculative",
            max_score: 0,
            support_count: 0,
            rewritten: false,
          });
          return res.json({ answer: speculativeAnswer, sources: [], speculative: true });
        }

        const used = direct.slice(0, maxChunks);
        const answer = await answerGrounded(openAiClient, question, used);
        logger.info("[qa] retrieval_metrics", {
          recording_id: recordingId,
          user_id: req.user.id,
          mode: "grounded",
          max_score: 1,
          support_count: used.length,
          rewritten: false,
        });
        return res.json({
          answer,
          sources: used.map((chunk) => ({
            chunk_id: chunk.id,
            start_sec: chunk.startSec,
            end_sec: chunk.endSec,
          })),
          speculative: false,
        });
      }

      const embeddingResponse = await openAiClient.embeddings.create({
        model: config.embeddings.model,
        input: [`query: ${question}`],
      });
      const queryEmbedding = sanitizeEmbedding(embeddingResponse.data[0]?.embedding as number[]);

      const [vectorResults, textResults] = await Promise.all([
        vectorSearch(db, recordingId, queryEmbedding, retrievalCfg.topKVector, storage),
        textSearch(db, recordingId, question, retrievalCfg.topKBm25, tsvStorage),
      ]);

      let merged = mergeChunks(vectorResults, textResults);
      if (!merged.length && vectorResults.length === 0 && textResults.length === 0) {
        const vectorFallback = await vectorSearch(
          db,
          recordingId,
          queryEmbedding,
          Math.max(retrievalCfg.topKVector * 2, retrievalCfg.topKVector + 4),
          storage
        );
        const textFallback = await textSearch(
          db,
          recordingId,
          question,
          Math.max(retrievalCfg.topKBm25 * 2, retrievalCfg.topKBm25 + 4),
          tsvStorage
        );
        merged = mergeChunks(vectorFallback, textFallback);
      }

      const expanded = await expandWithNeighbors(db, recordingId, merged, maxChunks);
      const support = evaluateSupport(expanded, retrievalCfg.minCombinedScore, retrievalCfg.minSupport);
      const mode = expanded.length && support.ok ? "grounded" : "speculative";

      logger.info("[qa] retrieval_metrics", {
        recording_id: recordingId,
        user_id: req.user.id,
        mode,
        max_score: support.maxScore,
        support_count: support.supportCount,
        rewritten: false,
      });

      if (expanded.length && support.ok) {
        const answer = await answerGrounded(openAiClient, question, expanded);
        return res.json({
          answer,
          sources: expanded.map((chunk) => ({
            chunk_id: chunk.id,
            start_sec: chunk.startSec,
            end_sec: chunk.endSec,
          })),
          speculative: false,
        });
      }

      const speculativeAnswer = await answerSpeculative(openAiClient, question, {
        summary: summaryText || null,
        near: expanded.slice(0, 2),
      });
      return res.json({ answer: speculativeAnswer, sources: [], speculative: true });
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
