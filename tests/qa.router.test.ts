import express from "express";
import request from "supertest";
import { describe, it, beforeEach, afterEach, expect, vi } from "vitest";
import { sql } from "kysely";
import type OpenAI from "openai";
import { createQaRouter } from "../src/modules/qa/router";
import type { AppConfig } from "../src/config";
import type { Database } from "../src/db";
import { createTestConfig, createTestDatabase } from "./helpers";

interface TestCtx {
  db: Database;
  destroy: () => Promise<void>;
  config: AppConfig;
}

function createOpenAiMock(answer: string): OpenAI {
  return {
    embeddings: {
      create: vi.fn().mockResolvedValue({
        data: [
          {
            embedding: Array.from({ length: 1536 }).map((_, idx) => (idx % 3) / 10),
          },
        ],
      }),
    },
    chat: {
      completions: {
        create: vi.fn().mockResolvedValue({
          choices: [
            {
              message: {
                content: answer,
              },
            },
          ],
        }),
      },
    },
  } as unknown as OpenAI;
}

async function createRecording(db: Database, values: Partial<{ summary: string | null; actionItems: unknown }>) {
  await db
    .insertInto("recordings")
    .values({
      id: "rec-1",
      user_id: "user-1",
      status: "ready",
      s3_bucket: "bucket",
      s3_key: "key",
      content_type: "audio/mp4",
      codec: "aac",
      transcript_status: "ready",
      transcript_summary: values.summary ?? null,
      transcript_json: null,
      transcript_error: null,
      transcribed_at: new Date(),
      action_items_json: values.actionItems ?? null,
    })
    .execute();
}

function createApp(db: Database, config: AppConfig, client: OpenAI) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).user = { id: "user-1", email: "user@example.com" };
    next();
  });
  app.use("/v1/ask", createQaRouter({ db, config, openAiClient: client }));
  return app;
}

describe("/v1/ask routing", () => {
  let ctx: TestCtx;

  beforeEach(async () => {
    const { db, destroy } = await createTestDatabase();
    const baseConfig = createTestConfig();
    ctx = {
      db,
      destroy,
      config: {
        ...baseConfig,
        embeddings: { ...baseConfig.embeddings, enabled: true },
      },
    };
  });

  afterEach(async () => {
    await ctx.destroy();
    vi.resetAllMocks();
  });

  it("returns grounded answers with sources when support is sufficient", async () => {
    await createRecording(ctx.db, { summary: "Краткое резюме встречи" });

    await sql`
      INSERT INTO recording_chunks (recording_id, chunk_index, start_sec, end_sec, text, embedding, tsv)
      VALUES
        ('rec-1', 0, 0, 20, 'Мы обсудили маркетинговую стратегию', '[]'::jsonb, NULL),
        ('rec-1', 1, 21, 40, 'Планируем запустить кампанию в мае', '[]'::jsonb, NULL)
    `.execute(ctx.db);

    const answerText = "Кампания стартует в мае. [S2, 00:00:21–00:00:40]";
    const openAi = createOpenAiMock(answerText);
    const app = createApp(ctx.db, ctx.config, openAi);

    const response = await request(app)
      .post("/v1/ask")
      .send({ recording_id: "rec-1", question: "Когда стартует кампания?" })
      .expect(200);

    expect(response.body.speculative).toBe(false);
    expect(response.body.answer).toBe(answerText);
    expect(response.body.sources).toHaveLength(2);
    expect(openAi.embeddings.create).not.toHaveBeenCalled();
    expect(openAi.chat.completions.create).toHaveBeenCalledTimes(1);
  });

  it("falls back to speculative mode when support is insufficient", async () => {
    await createRecording(ctx.db, { summary: null });

    await sql`
      INSERT INTO recording_chunks (recording_id, chunk_index, start_sec, end_sec, text, embedding, tsv)
      VALUES
        ('rec-1', 0, 0, 10, 'Приветственное слово', '[]'::jsonb, NULL),
        ('rec-1', 1, 11, 20, 'Обсуждение погоды', '[]'::jsonb, NULL),
        ('rec-1', 2, 21, 30, 'Небольшой оффтоп', '[]'::jsonb, NULL),
        ('rec-1', 3, 31, 40, 'Разговор ни о чём', '[]'::jsonb, NULL)
    `.execute(ctx.db);

    const speculativeText = "Я не уверен, что это звучало в разговоре. По контексту записи могу предположить: деталей не было.";
    const openAi = createOpenAiMock(speculativeText);
    const app = createApp(ctx.db, ctx.config, openAi);

    const response = await request(app)
      .post("/v1/ask")
      .send({ recording_id: "rec-1", question: "Какие условия сделки?" })
      .expect(200);

    expect(response.body.speculative).toBe(true);
    expect(response.body.sources).toEqual([]);
    expect(response.body.answer.startsWith("Я не уверен")).toBe(true);
    expect(openAi.embeddings.create).toHaveBeenCalledTimes(1);
    expect(openAi.chat.completions.create).toHaveBeenCalledTimes(1);
  });
});
