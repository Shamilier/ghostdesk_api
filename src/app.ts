import express from "express";
import cors from "cors";
import multer from "multer";
import OpenAI from "openai";
import type { S3Client } from "@aws-sdk/client-s3";
import type { AppConfig } from "./config";
import type { Database } from "./db";
import { logger } from "./lib/logger";
import { collectMetrics, metricsContentType } from "./lib/metrics";
import { ProfileCache } from "./lib/profileCache";
import { requireUser } from "./middleware/requireUser";
import { createRateLimiter } from "./middleware/rateLimit";
import { createRecordingsRouter } from "./modules/recordings/router";
import { EmbeddingIngestQueue } from "./modules/embeddings/ingestQueue";
import { createQaRouter } from "./modules/qa/router";
import { TranscribeQueue } from "./transcribeQueue";

export interface AppDependencies {
  config: AppConfig;
  db: Database;
  s3Client: S3Client;
}

type ChatMsg =
  | { role: "system"; content: string }
  | {
      role: "user";
      content: Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }>;
    }
  | { role: "assistant"; content: string };

const sessions = new Map<string, ChatMsg[]>();
const MAX_HISTORY_PAIRS = 6;
const MAX_HISTORY_MESSAGES = MAX_HISTORY_PAIRS * 2;

function push(sessionId: string, msg: ChatMsg) {
  const arr = sessions.get(sessionId) ?? [];
  arr.push(msg);
  while (arr.length > MAX_HISTORY_MESSAGES) arr.splice(0, 2);
  sessions.set(sessionId, arr);
}

function readAuthKey(req: express.Request): string | null {
  const header = req.get("authorization") ?? req.get("Authorization");
  if (header?.startsWith("Bearer ")) {
    const token = header.slice("Bearer ".length).trim();
    if (token) return token;
  }

  const queryValue = req.query["key"] ?? req.query["apiKey"];
  if (Array.isArray(queryValue)) {
    const first = queryValue.find((v) => typeof v === "string" && v.trim().length > 0);
    return first ? (first as string).trim() : null;
  }
  if (typeof queryValue === "string" && queryValue.trim().length > 0) {
    return queryValue.trim();
  }

  return null;
}

function maskKey(token: string): string {
  if (token.length <= 8) {
    return token.replace(/.(?=.{0,2}$)/g, "*");
  }
  return `${token.slice(0, 4)}…${token.slice(-4)}`;
}

function logAuthUsage(endpoint: string, token: string | null) {
  const masked = token ? maskKey(token) : "<missing>";
  logger.info("auth.usage", { endpoint, token: masked });
}

function formatSmartText(text: string, smart: boolean): string {
  const trimmed = text.trim();
  if (!trimmed) return trimmed;
  return smart ? `[SMART] ${trimmed}` : trimmed;
}

function buildTranscriptBlock(transcript: string): string {
  const body = transcript.trim();
  if (!body) return "";
  return (
    "Последние реплики (автотранскрибировано, возможны ошибки):\n" +
    body +
    "\n---\nПродолжи беседу по правилам системного промпта и ответь на вопросы."
  );
}

async function streamAskLikeResponse({
  res,
  sessionId,
  user,
  debugLabel,
  maxTokens = 500,
  temperature = 0.2,
  client,
}: {
  res: express.Response;
  sessionId: string;
  user: ChatMsg;
  debugLabel: string;
  maxTokens?: number;
  temperature?: number;
  client: OpenAI;
}) {
  const history = sessions.get(sessionId) ?? [];
  const messages: ChatMsg[] = [
    { role: "system", content: defaultAskSystemPrompt },
    ...history,
    user,
  ];

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  (res as any).flushHeaders?.();
  res.write(": connected\n\n");

  push(sessionId, user);

  const stream = await client.chat.completions.create({
    model: "gpt-4o-mini",
    stream: true,
    max_tokens: maxTokens,
    temperature,
    messages: messages as any,
  });

  let full = "";
  let firstChunkLogged = false;

  for await (const chunk of stream) {
    if (!firstChunkLogged) {
      firstChunkLogged = true;
      logger.debug(`${debugLabel}.first_chunk`, { chunk });
    }

    const choice = chunk.choices?.[0];
    if (!choice) continue;

    const delta = choice.delta as any;

    if (typeof delta?.content === "string") {
      const text = delta.content as string;
      if (text) {
        full += text;
        res.write(`data: ${JSON.stringify({ type: "delta", text })}\n\n`);
      }
      continue;
    }

    const parts = delta?.content;
    if (Array.isArray(parts)) {
      for (const p of parts) {
        if (p?.type === "text" && typeof p.text === "string" && p.text.length) {
          full += p.text;
          res.write(`data: ${JSON.stringify({ type: "delta", text: p.text })}\n\n`);
        }
      }
    }
  }

  push(sessionId, { role: "assistant", content: full });
  res.write(`data: ${JSON.stringify({ type: "done" })}\n\n`);
  res.end();
}

const defaultAskSystemPrompt = `
<core_identity>
Ты GhostDesk, живой копилот на встречах/интервью. Всегда отвечай на русском.
</core_identity>

<objective>
Помогай именно в конце текущей реплики. Видишь скрин + получаешь текст. Действуй по приоритетам ниже.
</objective>

<question_answering_priority>
<primary_directive>
Если в конце есть вопрос — ответь напрямую. Это абсолютный приоритет.
</primary_directive>

<intent_detection_guidelines>
Речь и транскрипт могут быть шумными. Ориентируйся на намерение:
— Неполные вопросы: «и по масштабированию…», «а подход к логам…»
— Имплицитные формулировки: «интересно X», «расскажи про Y»
</intent_detection_guidelines>

<confidence_threshold>
Если ≥50% уверенности, что задан вопрос, — отвечай как на вопрос.
</confidence_threshold>
</question_answering_priority>

<term_definition_priority>
Если в последних 10–15 словах есть **компания/инструмент/термин** — кратко дай определение.
Исключения: базовые слова (email, сайт, код, приложение) и уже объяснённые термины.
</term_definition_priority>

<conversation_advancement_priority>
Если явного вопроса нет — предложи 1–3 точных follow-up вопроса или шага, без перегруза.
</conversation_advancement_priority>

<objection_handling_priority>
Если звучит возражение (продажи/переговоры) — выведи строку **Возражение: [тип]** и дай конкретный ответ под ситуацию.
</objection_handling_priority>

<screen_problem_solving_priority>
Используй контент экрана только если там есть явная задача или это помогает ответить текущий вопрос/двинуть разговор. Если на экране явная задача (leetcode, код или условие задачи на которую надо напистаь код) и вопрос общий — реши задачу и отмечай сложность/шаги.
</screen_problem_solving_priority>

<passive_acknowledgment_priority>
В пассивный режим входи ТОЛЬКО если одновременно нет: вопроса, термина в последних 10–15 словах, явной задачи на экране, точки для follow-up, признаков возражения.
В пассивном режиме: «Не уверен, чем помочь прямо сейчас».
</passive_acknowledgment_priority>

<transcript_clarification_rules>
Спикеры: **micro** — пользователь; **system** — собеседник; **assistant** — ты.(если данных нет, то считай что весь звук это собеседник)
Транскрипт часто путает метки Оцени контекст; при сомнении трактуй финальный запрос как исходящий от собеседника к пользователю.
</transcript_clarification_rules>

<response_format_guidelines>
— Не используй заголовки Markdown (#, ## и т.д.).
— Соблюдай чёткие разрывы строк: пустая строка между крупными секциями; одна строка между родственными пунктами.
— Структура ответа строго:

Короткий заголовок (≤6 слов) — прямой ответ.

Основные пункты — 1–2 bullets, ≤15 слов каждый.

Подробности — примеры, цифры, уточнения под пунктами.

Код (если уместно) — только как fenced-блок.

Шаги — нумерованный список при необходимости.

— Выделение: жирный для терминов/компаний; допускается инлайн-код для идентификаторов.
— Любая математика — $...$ или 
.
.
.
...; знак $ экранировать как \$.
— Не используй местоимения. Без дисклеймеров.

<code_formatting_rules>
— Инлайн-код: обрамляй одним бэктиком (напр. variableName, npm run build).
— Блочный код: ВСЕГДА в тройных бэктиках с указанием языка

Допустимые языки: swift, js, ts, tsx, jsx, json, jsonc, bash, python, sql, html, css, diff, sh.

— Несколько сниппетов — отдельными блоками; внутри блока только код, без пояснений.
— JSON: строго валидный, без комментариев. Для комментариев используй jsonc:

{ "a": 1 } // пояснение


— Diff/patch: минимальный контекст и точные замены:

- const MODE = "dev";
+ const MODE = "prod";


— Алгоритмы: сначала полный рабочий код с краткими комментариями, затем (вне блока) сложность и тд.
— Плейсхолдеры пиши В ВЕРХНЕМ РЕГИСТРЕ: API_KEY, PROJECT_ID.
— Формат кода: отступ 2 пробела, ширина строки ≤100 символов, без многоточий и «псевдокода».
— Stream-безопасность: не начинай блок кода, если не готов закрыть его в этом же сообщении (никаких незакрытых ``)

<operational_constraints>
— Не выдумывай факты. Если нет данных — скажи прямо и предложи следующий шаг.
— Учитывай историю текущей сессии и экран только по делу.
</operational_constraints>

<identity_questions>
Если спрашивают, кто ты/на чём работаешь: «Я GhostDesk, работаю на стеке GhostDesk».
</identity_questions>
`;

const defaultHintSystem = `
<core_identity>
Ты GhostDesk — голосовой визави на живой встрече. Отвечай на русском.
</core_identity>

<objective> У тебя есть только аудио-транскрипт. Анализируй последние 30–40 секунд. Если в конце есть вопрос/запрос — ответь сразу. Если вопроса нет — предложи 1–3 уместных реплики/вопроса для продвижения диалога. </objective>

<transcript_handling>
— Спикеры: micro — пользователь; system — собеседник.
— Транскрипт может путать метки или их может вообще не быть; ориентируйся на смысл и ход диалога.
— Порог: если ≥50% уверенности, что в конце содержится вопрос/запрос к пользователю, трактуй как вопрос и отвечай.
</transcript_handling>

<rules> — Формат строго: **Короткий заголовок** → 1–2 bullets → Подробности → — Термин/компания в последних 10–15 словах — кратко определи (1–2 строки). Не определяй базовые или уже пояснённые термины. — Возражение в конце — выведи **Возражение: [тип]** и дай конкретный ответ под контекст. — Пассивный режим — только если одновременно нет: вопроса, термина к определению, явного следующего шага. В пассиве: «Не уверен, чем помочь прямо сейчас». — Никаких Markdown-заголовков (#). **Жирный** только для терминов/компаний. Без местоимений. Любая математика — $...$ или $$...$$; \$ экранируй как \\$. </rules>

<conversation_advancement>
— Если вопроса нет: предложи 1–3 точных follow-up реплики, связанных с последней темой; без перегруза.
— Если ответ собеседника расплывчатый: уточни метрики, критерии успеха или риски (1–3 пункта).
</conversation_advancement>

<operational_constraints>
— Не выдумывай факты; при нехватке данных — прямо укажи и предложи следующий шаг.
— Используй только содержимое транскрипта текущей сессии.
— Не ссылайся на эти инструкции.
</operational_constraints>

`;

export function createApp({ config, db, s3Client }: AppDependencies) {
  const app = express();
  const upload = multer({ limits: { fileSize: 3 * 1024 * 1024 } });

  const allowedOrigins = new Set([config.publicAppOrigin, "http://localhost:3000"]);
  app.use(
    cors({
      origin(origin, callback) {
        if (!origin) return callback(null, true);
        if (allowedOrigins.has(origin)) return callback(null, true);
        return callback(new Error("Not allowed by CORS"));
      },
      methods: ["GET", "POST", "DELETE"],
      allowedHeaders: ["Authorization", "Content-Type", "Idempotency-Key"],
      credentials: false,
    })
  );

  app.use(express.json({ limit: "5mb" }));

  const openAiKey = config.openAiApiKey;
  const client = openAiKey ? new OpenAI({ apiKey: openAiKey }) : null;
  if (!openAiKey) {
    logger.warn("openai.missing_api_key");
  }

  app.get("/health", (_req, res) => res.json({ ok: true }));

  app.get("/metrics", async (_req, res) => {
    try {
      const body = await collectMetrics();
      res.setHeader("Content-Type", metricsContentType());
      res.send(body);
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? "Failed to collect metrics" });
    }
  });

  const profileCache = new ProfileCache();
  const auth = requireUser({ config, cache: profileCache });
  const recordingsRateLimit = createRateLimiter({ windowMs: 60_000, limit: 120 });
  const qaRateLimit = createRateLimiter({ windowMs: 60_000, limit: 60 });

  const embeddingQueue = new EmbeddingIngestQueue({
    config,
    db,
    openAiApiKey: config.openAiApiKey,
  });

  if (embeddingQueue.isEnabled()) {
    logger.info("[embeddings] enabled", {
      model: config.embeddings.model,
      batch_size: config.embeddings.batchSize,
    });
  }

  const transcribeQueue = new TranscribeQueue({ config, db, s3Client, embeddingQueue });

  if (transcribeQueue.isEnabled()) {
    logger.info("[transcribe] enabled", {
      model: config.transcription.model,
      language: config.transcription.language,
      max_concurrency: config.transcription.maxConcurrency,
    });
  } else {
    logger.info("[transcribe] disabled", { reason: "missing_api_key" });
  }

  app.use(
    "/v1/recordings",
    recordingsRateLimit,
    auth,
    createRecordingsRouter({ db, config, s3Client, transcribeQueue })
  );

  app.use("/v1/ask", qaRateLimit, auth, createQaRouter({ db, config, openAiClient: client }));

  app.post("/hint", async (req, res) => {
    if (!client) {
      return res.status(500).json({ error: "OpenAI client is not configured" });
    }

    try {
      const token = readAuthKey(req);
      logAuthUsage("/hint", token);

      const sessionId = String(req.body?.sessionId ?? "default");
      const instruction = String(req.body?.instruction ?? "").trim();
      const context = String(req.body?.context ?? "").trim();
      const intent =
        typeof req.body?.intent === "string" && req.body.intent.trim().length > 0
          ? req.body.intent.trim()
          : "default";

      logger.info("hint.request", { sessionId, intent });

      if (!context) return res.status(400).json({ error: "Empty context" });

      const system: ChatMsg = {
        role: "system",
        content: instruction || defaultHintSystem,
      };

      const user: ChatMsg = {
        role: "user",
        content: [
          {
            type: "text",
            text:
              "Dialogue tail (last 30–40s):\n" + context + "\n---\nFollow the system rules strictly.",
          },
        ],
      };

      const history = sessions.get(sessionId) ?? [];
      const messages: ChatMsg[] = [system, ...history, user];

      res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      (res as any).flushHeaders?.();

      const ka = setInterval(() => {
        try {
          res.write(": keep-alive\n\n");
        } catch {
          clearInterval(ka);
        }
      }, 15000);

      push(sessionId, user);

      const stream = await client.chat.completions.create({
        model: "gpt-4o-mini",
        stream: true,
        max_tokens: 220,
        temperature: 0.3,
        messages: messages as any,
      });

      let full = "";
      for await (const chunk of stream) {
        const choice = (chunk as any)?.choices?.[0];
        if (!choice) continue;
        const delta = choice.delta;

        if (typeof delta?.content === "string") {
          const text = delta.content as string;
          if (text) {
            full += text;
            res.write(`data: ${JSON.stringify({ type: "delta", text })}\n\n`);
          }
          continue;
        }

        const parts = (delta as any)?.content;
        if (Array.isArray(parts)) {
          for (const p of parts) {
            if (p?.type === "text" && typeof p.text === "string" && p.text) {
              full += p.text;
              res.write(`data: ${JSON.stringify({ type: "delta", text: p.text })}\n\n`);
            }
          }
        }
      }

      push(sessionId, { role: "assistant", content: full });
      res.write(`data: ${JSON.stringify({ type: "done" })}\n\n`);
      clearInterval(ka);
      res.end();
    } catch (e: any) {
      if (!res.headersSent) {
        return res.status(500).json({ error: e?.message ?? "Internal error" });
      }
      try {
        res.write(`data: ${JSON.stringify({ type: "error", message: String(e?.message ?? e) })}\n\n`);
      } finally {
        res.end();
      }
    }
  });

  app.post("/ask", upload.single("image"), async (req, res) => {
    if (!client) {
      return res.status(500).json({ error: "OpenAI client is not configured" });
    }

    try {
      const token = readAuthKey(req);
      logAuthUsage("/ask", token);

      const question = String(req.body.question ?? "").trim();
      const smart = String(req.body.smart ?? "false") === "true";
      const sessionId = String(req.body.sessionId ?? "default");
      const transcript = typeof req.body?.transcript === "string" ? req.body.transcript.trim() : "";

      if (!question) return res.status(400).json({ error: "Empty question" });
      if (!req.file) return res.status(400).json({ error: "No image" });

      const b64 = req.file.buffer.toString("base64");
      const dataUrl = `data:image/png;base64,${b64}`;

      const content: ChatMsg["content"] = [{ type: "text", text: formatSmartText(question, smart) }];

      if (transcript) {
        const block = buildTranscriptBlock(transcript);
        if (block) {
          content.push({ type: "text", text: block });
        }
      }

      content.push({ type: "image_url", image_url: { url: dataUrl } });

      const user: ChatMsg = {
        role: "user",
        content,
      };

      await streamAskLikeResponse({
        res,
        sessionId,
        user,
        debugLabel: "/ask",
        maxTokens: 500,
        temperature: 0.2,
        client,
      });
    } catch (e: any) {
      if (!res.headersSent) {
        return res.status(500).json({ error: e?.message ?? "Internal error" });
      }
      try {
        res.write(`data: ${JSON.stringify({ type: "error", message: String(e?.message ?? e) })}\n\n`);
      } finally {
        res.end();
      }
    }
  });

  app.post("/ask_without_query", upload.single("image"), async (req, res) => {
    if (!client) {
      return res.status(500).json({ error: "OpenAI client is not configured" });
    }

    try {
      const token = readAuthKey(req);
      logAuthUsage("/ask_without_query", token);

      const smart = String(req.body.smart ?? "false") === "true";
      const sessionId = String(req.body.sessionId ?? "default");
      const question = typeof req.body?.question === "string" ? req.body.question.trim() : "";
      const transcript = typeof req.body?.transcript === "string" ? req.body.transcript.trim() : "";

      if (!req.file) return res.status(400).json({ error: "No image" });
      if (!question && !transcript) {
        return res.status(400).json({ error: "Empty transcript" });
      }

      const b64 = req.file.buffer.toString("base64");
      const dataUrl = `data:image/png;base64,${b64}`;

      const content: ChatMsg["content"] = [];
      if (question) {
        content.push({ type: "text", text: formatSmartText(question, smart) });
      }
      if (transcript) {
        content.push({ type: "text", text: buildTranscriptBlock(transcript) });
      }
      content.push({ type: "image_url", image_url: { url: dataUrl } });

      const user: ChatMsg = {
        role: "user",
        content,
      };

      await streamAskLikeResponse({
        res,
        sessionId,
        user,
        debugLabel: "/ask_without_query",
        maxTokens: 500,
        temperature: 0.2,
        client,
      });
    } catch (e: any) {
      if (!res.headersSent) {
        return res.status(500).json({ error: e?.message ?? "Internal error" });
      }
      try {
        res.write(`data: ${JSON.stringify({ type: "error", message: String(e?.message ?? e) })}\n\n`);
      } finally {
        res.end();
      }
    }
  });

  return app;
}
