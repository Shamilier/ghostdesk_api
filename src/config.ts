import { config as loadEnv } from "dotenv";
import { z } from "zod";

loadEnv();

const booleanFromEnv = z
  .union([z.string(), z.boolean()])
  .optional()
  .transform((value) => {
    if (typeof value === "boolean") return value;
    if (!value) return undefined;
    const normalized = value.toString().toLowerCase();
    return normalized === "1" || normalized === "true" || normalized === "yes";
  });

const envSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production", "staging"]) // allow extra stage for flexibility
    .default("development"),
  PORT: z.coerce.number().default(8787),
  DATABASE_URL: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  DEEPGRAM_API_KEY: z.string().optional(),
  DEEPGRAM_MODEL: z.string().default("nova-2"),
  DEEPGRAM_LANGUAGE: z.string().default("ru"),
  TRANSCRIBE_MAX_CONCURRENCY: z.coerce.number().int().min(1).default(3),
  AUTH_PROFILE_URL: z.string().optional(),
  AUTH_TIMEOUT_MS: z.coerce.number().default(3000),
  AUTH_CACHE_TTL_MS: z.coerce.number().default(5 * 60 * 1000),
  S3_ENDPOINT: z.string(),
  S3_REGION: z.string(),
  S3_BUCKET: z.string(),
  S3_ACCESS_KEY: z.string(),
  S3_SECRET_KEY: z.string(),
  S3_PRESIGN_EXPIRES_SEC: z.coerce.number().default(600),
  S3_FORCE_PATH_STYLE: booleanFromEnv.default(false),
  RECORDINGS_MAX_BYTES: z.coerce.number().optional(),
  PUBLIC_APP_ORIGIN: z.string(),
});

export type AppConfig = ReturnType<typeof loadConfig>;

export function loadConfig() {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const formatted = parsed.error.flatten();
    throw new Error(
      `Invalid configuration: ${JSON.stringify(formatted.fieldErrors, null, 2)}`
    );
  }

  const cfg = parsed.data;

  if (!cfg.AUTH_PROFILE_URL) {
    console.error("[config] AUTH_PROFILE_URL is required");
    process.exit(1);
  }

  if (!cfg.DATABASE_URL && cfg.NODE_ENV !== "test") {
    throw new Error("DATABASE_URL is required outside of test environment");
  }

  if (!cfg.OPENAI_API_KEY) {
    console.warn("[config] OPENAI_API_KEY is not set; OpenAI features may not work");
  }

  if (!cfg.DEEPGRAM_API_KEY) {
    console.warn("[config] DEEPGRAM_API_KEY is not set; transcription queue will be disabled");
  }

  return {
    nodeEnv: cfg.NODE_ENV,
    port: cfg.PORT,
    databaseUrl: cfg.DATABASE_URL ?? "",
    openAiApiKey: cfg.OPENAI_API_KEY ?? "",
    auth: {
      profileUrl: cfg.AUTH_PROFILE_URL,
      timeoutMs: cfg.AUTH_TIMEOUT_MS,
      cacheTtlMs: cfg.AUTH_CACHE_TTL_MS,
    },
    s3: {
      endpoint: cfg.S3_ENDPOINT,
      region: cfg.S3_REGION,
      bucket: cfg.S3_BUCKET,
      accessKeyId: cfg.S3_ACCESS_KEY,
      secretAccessKey: cfg.S3_SECRET_KEY,
      presignExpiresSeconds: cfg.S3_PRESIGN_EXPIRES_SEC,
      forcePathStyle: Boolean(cfg.S3_FORCE_PATH_STYLE),
    },
    recordings: {
      maxBytes: cfg.RECORDINGS_MAX_BYTES ?? null,
    },
    transcription: {
      deepgramApiKey: cfg.DEEPGRAM_API_KEY ?? "",
      model: cfg.DEEPGRAM_MODEL,
      language: cfg.DEEPGRAM_LANGUAGE,
      maxConcurrency: cfg.TRANSCRIBE_MAX_CONCURRENCY,
    },
    publicAppOrigin: cfg.PUBLIC_APP_ORIGIN,
  } as const;
}
