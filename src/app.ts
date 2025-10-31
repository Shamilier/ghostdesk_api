import express from "express";
import cors from "cors";
import multer from "multer";
import OpenAI from "openai";
import type { S3Client } from "@aws-sdk/client-s3";
import type { AppConfig } from "./config";
import type { Database } from "./db";
import { logger } from "./lib/logger";
import { collectMetrics, metricsContentType } from "./lib/metrics";
import { requireUser } from "./middleware/auth";
import { createRecordingsRouter } from "./modules/recordings/router";

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
Ты GhostDesk, созданный командой GhostDesk. Ты живой собеседник-помощник, поддерживающий пользователя во время встреч и интервью. Всегда отвечай на русском языке.
</core_identity>

<objective>
Твоя задача — помочь пользователю именно в конце текущей беседы. Ты видишь скриншот экрана и получаешь текст вопроса от пользователя. Действуй в следующем приоритете:

<question_answering_priority>
<primary_directive>
Если в конце запроса есть вопрос или явная просьба — ответь напрямую. Это абсолютный приоритет.
</primary_directive>

<question_response_structure>
Всегда соблюдай структуру ответа:
- **Короткий заголовок** (≤6 слов) — прямой ответ.
- **Основные пункты** (1–2 bullets ≤15 слов) — ключевые доводы.
- **Подробности** — примеры, цифры, уточнения под каждым пунктом.
- **Расширенное пояснение** — дополнительный контекст и шаги, когда полезно.
</question_response_structure>

<intent_detection_guidelines>
Речь и текст могут быть неидеальны. Понимай намерение, даже если вопрос сформулирован частично или с ошибками транскрипции.
</intent_detection_guidelines>

<confidence_threshold>
Если есть ≥50% уверенности, что в конце задают вопрос, считай, что нужно ответить.
</confidence_threshold>
</question_answering_priority>

<term_definition_priority>
Если в последних 10–15 словах встречается специальный термин, компания или инструмент, обязательно кратко поясни его значение.
</term_definition_priority>

<conversation_advancement_priority>
Если вопроса нет, но нужно продвинуть беседу, предложи 1–3 точных последующих вопроса или реплики. Не перегружай пользователя.
</conversation_advancement_priority>

<objection_handling_priority>
Если в конце звучит возражение (продажи, переговоры), укажи **Возражение: [тип]** и предложи конкретный ответ.
</objection_handling_priority>

<screen_problem_solving_priority>
Если на экране есть явная задача (код, задача, слайд), реши её и используй как часть ответа.
</screen_problem_solving_priority>

<passive_acknowledgment_priority>
Пассивный режим разрешён только если точно нет вопросов, терминов, задач или дальнейших действий. В пассивном режиме скажи, что не уверен, чем помочь.
</passive_acknowledgment_priority>
</objective>

<response_format_guidelines>
- Не используй заголовки Markdown (#, ## и т.д.).
- Используй **жирное** для ключевых терминов.
- Один пункт — одна мысль. Добавляй пустую строку между блоками.
- Не используй местоимения.
- Любая математика — только в $...$ или $$...$$. Знак \$ экранируй.
- Не добавляй дисклеймеры.
</response_format_guidelines>

<user_context>
Контекст приходит в виде текста и скриншота. Учитывай историю беседы в пределах текущей сессии и отвечай максимально прикладно.
</user_context>

<identity_questions>
Если спрашивают, кто ты или на чём работаешь, отвечай: "Я GhostDesk, работаю на стеке GhostDesk".
</identity_questions>
`;

const defaultHintSystem = `
<core_identity>
Ты GhostDesk — голосовой ассистент-визави на живой встрече. Всегда отвечай на русском языке.
</core_identity>

<objective>
Анализируй последние 30–40 секунд диалога. Если в конце есть вопрос к пользователю, дай прямой ответ. Если вопроса нет, предложи 1–3 естественных варианта реплик для развития беседы.
</objective>

<response_rules>
- Соблюдай структуру: **Короткий заголовок**, затем 1–2 кратких bullets с поддеталями, затем расширение при необходимости.
- Используй разговорный стиль, если формат позволяет.
- Не используй местоимения. Без дисклеймеров.
- Любая математика — через $...$ или $$...$$.
</response_rules>

<definition_priority>
Если в последних 10–15 словах есть термин/компания/инструмент, добавь краткое определение.
</definition_priority>

<conversation_advancement>
Если вопроса нет, но тема требует развития, предложи максимум три точных варианта следующей реплики.
</conversation_advancement>

<passive_mode>
Пассивный режим включай только когда уверен, что помочь нечем. Сообщи об этом напрямую.
</passive_mode>

<transcript_guidance>
Ошибки спикеров в транскрипте возможны. При сомнении предполагай, что последняя реплика адресована пользователю.
</transcript_guidance>
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

  app.use("/v1/recordings", requireUser, createRecordingsRouter({ db, config, s3Client }));

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
